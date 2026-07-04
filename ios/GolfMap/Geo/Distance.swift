import Foundation

/// Distances and bearings between WGS84 points.
///
/// Planar distance is measured in projected SWEREF 99 TM (EPSG:3006) meters —
/// the same way the rest of the project measures (see the web `legMeters` in
/// `hole-length.ts` and the measurement tool, which work entirely in EPSG:3006).
/// Over a single golf-hole leg the grid-scale distortion is negligible.
public enum Distance {

    /// Planar distance in meters between two WGS84 points, via the SWEREF 99 TM
    /// projection. Matches the web `legMeters`.
    public static func planarMeters(_ a: LatLon, _ b: LatLon) -> Double {
        let pa = Sweref99TM.fromWGS84(a)
        let pb = Sweref99TM.fromWGS84(b)
        return (pow(pa.x - pb.x, 2) + pow(pa.y - pb.y, 2)).squareRoot()
    }

    /// Initial great-circle bearing from `a` to `b`, in degrees clockwise from
    /// true north, normalized to `[0, 360)`. For later use (aim direction, HUD).
    public static func bearingDegrees(_ a: LatLon, _ b: LatLon) -> Double {
        let phi1 = a.lat * .pi / 180
        let phi2 = b.lat * .pi / 180
        let dLambda = (b.lon - a.lon) * .pi / 180
        let y = sin(dLambda) * cos(phi2)
        let x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLambda)
        let theta = atan2(y, x) * 180 / .pi
        return theta.truncatingRemainder(dividingBy: 360) + (theta < 0 ? 360 : 0)
    }
}
