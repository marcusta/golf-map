import Foundation

/// Green outlines for the analysis tool, read from the bundle's
/// `features.geojson` (the same file the map style embeds).
///
/// The furniture database has `greens.boundaryJson`, but it is NULL for
/// real-world bundles (e.g. Landeryd) — the authored outline only exists as a
/// `"green"`-type Polygon feature in the GeoJSON. This parses those features
/// once and answers "which green polygon belongs to hole X":
///   1. a feature whose `properties.holeId` matches wins;
///   2. otherwise the polygon whose outer ring CONTAINS the hole's green
///      center point;
///   3. otherwise the polygon with the nearest vertex to that center.
/// Rings are converted to EPSG:3006 meters (ring 0 = outer, 1.. = holes),
/// ready for `GreenSampleGridBuilder`.
public struct GreenPolygonStore: Sendable {

    /// One green outline: projected rings + the original WGS84 rings.
    public struct GreenPolygon: Sendable {
        public var holeId: String?
        /// EPSG:3006 rings; ring 0 = outer boundary, rings 1.. = holes.
        public var rings: [[Sweref99TM.Point]]
        /// The same rings in WGS84 (for the map boundary outline).
        public var wgs84Rings: [[LatLon]]
    }

    public private(set) var greens: [GreenPolygon]

    /// Parses every `"green"`-type Polygon/MultiPolygon feature. Throws only
    /// on unparseable JSON; individual malformed features are skipped.
    public init(featuresGeoJSON: Data) throws {
        let parsed = try JSONSerialization.jsonObject(with: featuresGeoJSON)
        guard
            let collection = parsed as? [String: Any],
            let features = collection["features"] as? [[String: Any]]
        else {
            self.greens = []
            return
        }

        var greens: [GreenPolygon] = []
        for feature in features {
            guard
                let properties = feature["properties"] as? [String: Any],
                properties["type"] as? String == "green",
                let geometry = feature["geometry"] as? [String: Any],
                let geometryType = geometry["type"] as? String
            else { continue }
            let holeId = properties["holeId"] as? String

            // A Polygon is one ring set; a MultiPolygon contributes one
            // GreenPolygon per part (each part analysed separately).
            let ringSets: [[[Any]]]
            if geometryType == "Polygon", let rings = geometry["coordinates"] as? [[Any]] {
                ringSets = [rings]
            } else if geometryType == "MultiPolygon",
                      let parts = geometry["coordinates"] as? [[[Any]]] {
                ringSets = parts
            } else {
                continue
            }

            for ringSet in ringSets {
                let wgs84Rings = ringSet.compactMap(Self.parseRing)
                guard let outer = wgs84Rings.first, outer.count >= 3 else { continue }
                greens.append(GreenPolygon(
                    holeId: holeId,
                    rings: wgs84Rings.map { $0.map(Sweref99TM.fromWGS84) },
                    wgs84Rings: wgs84Rings
                ))
            }
        }
        self.greens = greens
    }

    /// GeoJSON positions are [lon, lat].
    private static func parseRing(_ raw: [Any]) -> [LatLon]? {
        var ring: [LatLon] = []
        for position in raw {
            guard
                let pair = position as? [Any], pair.count >= 2,
                let lon = Self.double(pair[0]), let lat = Self.double(pair[1])
            else { return nil }
            ring.append(LatLon(lat: lat, lon: lon))
        }
        return ring
    }

    private static func double(_ value: Any) -> Double? {
        (value as? NSNumber)?.doubleValue
    }

    /// The green polygon for a hole. `greenCenter` is the hole's stored green
    /// center (furniture); used when no feature carries the hole id.
    public func green(forHoleId holeId: String?, greenCenter: LatLon?) -> GreenPolygon? {
        if let holeId, let byId = greens.first(where: { $0.holeId == holeId }) {
            return byId
        }
        guard let greenCenter else { return nil }
        let center = Sweref99TM.fromWGS84(greenCenter)

        if let containing = greens.first(where: { polygon in
            guard let outer = polygon.rings.first else { return false }
            return AnalysisGridMath.pointInRing(x: center.x, y: center.y, ring: outer)
        }) {
            return containing
        }

        // Fallback: nearest by outer-ring vertex distance.
        return greens.min { lhs, rhs in
            Self.vertexDistanceSquared(from: center, to: lhs) <
                Self.vertexDistanceSquared(from: center, to: rhs)
        }
    }

    private static func vertexDistanceSquared(
        from point: Sweref99TM.Point,
        to polygon: GreenPolygon
    ) -> Double {
        guard let outer = polygon.rings.first else { return .infinity }
        return outer.reduce(Double.infinity) { best, vertex in
            let dx = vertex.x - point.x
            let dy = vertex.y - point.y
            return min(best, dx * dx + dy * dy)
        }
    }
}
