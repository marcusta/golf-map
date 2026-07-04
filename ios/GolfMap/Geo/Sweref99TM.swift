import Foundation

/// SWEREF 99 TM (EPSG:3006) ↔ WGS84 transform — Swift port of the web
/// `web/src/geo/transform.ts` (itself a port of the server's `geo.ts`). All
/// three implementations MUST stay numerically identical: feature geometry is
/// authored in projected meters and independently re-projected server-side, so
/// every port is verified against the same Lantmäteriet control points
/// (see GolfMapTests/Geo/Sweref99TMTests.swift).
///
/// Hand-rolled Transverse Mercator on GRS80 (Redfearn/Snyder truncated series —
/// Snyder, USGS Professional Paper 1395, eqs. 8-9..8-11 forward /
/// 8-17..8-21 inverse), specialized to SWEREF 99 TM's parameters. Accuracy
/// against Lantmäteriet's published control points: < 0.02 m forward,
/// < 2e-5 deg inverse across Sweden's full extent.
public enum Sweref99TM {

    /// A point on the SWEREF 99 TM grid: `x` = easting, `y` = northing (meters).
    public struct Point: Sendable, Equatable, Hashable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    // GRS80 ellipsoid parameters
    private static let grs80A = 6_378_137.0
    private static let grs80F = 1.0 / 298.257222101
    private static let grs80E2 = grs80F * (2 - grs80F) // first eccentricity squared
    private static let grs80EPrime2 = grs80E2 / (1 - grs80E2) // second eccentricity squared
    private static let grs80E1 = (1 - (1 - grs80E2).squareRoot()) / (1 + (1 - grs80E2).squareRoot())

    // SWEREF 99 TM projection parameters
    private static let centralMeridian = 15.0 // degrees
    private static let scale = 0.9996
    private static let falseEasting = 500_000.0
    private static let falseNorthing = 0.0

    private static func deg2rad(_ deg: Double) -> Double { deg * .pi / 180 }
    private static func rad2deg(_ rad: Double) -> Double { rad * 180 / .pi }

    /// Meridian arc length from the equator to latitude `phi` (radians), on GRS80.
    private static func meridianArcLength(_ phi: Double) -> Double {
        let e2 = grs80E2
        let e4 = e2 * e2
        let e6 = e4 * e2
        let a0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256
        let a2 = (3.0 / 8) * (e2 + e4 / 4 + (15 * e6) / 128)
        let a4 = (15.0 / 256) * (e4 + (3 * e6) / 4)
        let a6 = (35 * e6) / 3072
        return grs80A * (a0 * phi - a2 * sin(2 * phi) + a4 * sin(4 * phi) - a6 * sin(6 * phi))
    }

    /// Footpoint latitude for the inverse projection: approximate inverse of `meridianArcLength`.
    private static func footpointLatitude(_ m: Double) -> Double {
        let e2 = grs80E2
        let e1 = grs80E1
        let mu = m / (grs80A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256))
        return mu
            + ((3 * e1) / 2 - (27 * pow(e1, 3)) / 32) * sin(2 * mu)
            + ((21 * e1 * e1) / 16 - (55 * pow(e1, 4)) / 32) * sin(4 * mu)
            + ((151 * pow(e1, 3)) / 96) * sin(6 * mu)
            + ((1097 * pow(e1, 4)) / 512) * sin(8 * mu)
    }

    /// Geodetic (WGS84 lat/lon) → SWEREF 99 TM grid (EPSG:3006) forward projection.
    public static func fromWGS84(lat: Double, lon: Double) -> Point {
        let lon0 = deg2rad(centralMeridian)
        let k0 = scale
        let e2 = grs80E2
        let ePrime2 = grs80EPrime2

        let phi = deg2rad(lat)
        let lambda = deg2rad(lon)

        let sinPhi = sin(phi)
        let cosPhi = cos(phi)
        let tanPhi = tan(phi)

        let n = grs80A / (1 - e2 * sinPhi * sinPhi).squareRoot()
        let t = tanPhi * tanPhi
        let c = ePrime2 * cosPhi * cosPhi
        let aTerm = (lambda - lon0) * cosPhi
        let m = meridianArcLength(phi)

        let x = k0 * n
            * (aTerm
                + ((1 - t + c) * pow(aTerm, 3)) / 6
                + ((5 - 18 * t + t * t + 72 * c - 58 * ePrime2) * pow(aTerm, 5)) / 120)

        let y = k0
            * (m
                + n * tanPhi
                    * (pow(aTerm, 2) / 2
                        + ((5 - t + 9 * c + 4 * c * c) * pow(aTerm, 4)) / 24
                        + ((61 - 58 * t + t * t + 600 * c - 330 * ePrime2) * pow(aTerm, 6)) / 720))

        return Point(x: x + falseEasting, y: y + falseNorthing)
    }

    /// Convenience overload taking a `LatLon`.
    public static func fromWGS84(_ ll: LatLon) -> Point {
        fromWGS84(lat: ll.lat, lon: ll.lon)
    }

    /// SWEREF 99 TM grid (EPSG:3006) → geodetic (lat/lon) inverse projection.
    public static func toWGS84(x: Double, y: Double) -> LatLon {
        let lon0 = deg2rad(centralMeridian)
        let k0 = scale
        let e2 = grs80E2
        let ePrime2 = grs80EPrime2

        let xNorm = x - falseEasting
        let yNorm = y - falseNorthing

        let m = yNorm / k0
        let phi1 = footpointLatitude(m)

        let sinPhi1 = sin(phi1)
        let cosPhi1 = cos(phi1)
        let tanPhi1 = tan(phi1)

        let n1 = grs80A / (1 - e2 * sinPhi1 * sinPhi1).squareRoot()
        let t1 = tanPhi1 * tanPhi1
        let c1 = ePrime2 * cosPhi1 * cosPhi1
        let r1 = (grs80A * (1 - e2)) / pow(1 - e2 * sinPhi1 * sinPhi1, 1.5)
        let d = xNorm / (n1 * k0)

        let lat = phi1
            - ((n1 * tanPhi1) / r1)
                * (pow(d, 2) / 2
                    - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ePrime2) * pow(d, 4)) / 24
                    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ePrime2 - 3 * c1 * c1) * pow(d, 6)) / 720)

        let lon = lon0
            + (d
                - ((1 + 2 * t1 + c1) * pow(d, 3)) / 6
                + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ePrime2 + 24 * t1 * t1) * pow(d, 5)) / 120)
                / cosPhi1

        return LatLon(lat: rad2deg(lat), lon: rad2deg(lon))
    }

    /// Convenience overload taking a `Point`.
    public static func toWGS84(_ p: Point) -> LatLon {
        toWGS84(x: p.x, y: p.y)
    }
}
