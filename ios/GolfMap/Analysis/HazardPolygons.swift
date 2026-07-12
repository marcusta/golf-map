import Foundation

/// Hazard outlines for the on-course carry distances + caddy, read from the
/// bundle's `features.geojson` (the same file the map style and
/// `GreenPolygonStore` use). Parses every hazard-type Polygon/MultiPolygon
/// feature (bunker / water / penalty …) once into flattened `FlatRing`s in
/// EPSG:3006 meters, ready for `hazardsAlongLine`.
///
/// Hazards are course-level in real bundles (their `holeId` is null), so this
/// keeps the whole set: the along-line query only ever returns rings the shot
/// line actually crosses within the target distance, so a bunker on another
/// hole is naturally filtered out by geometry.
public struct HazardFeatureStore: Sendable {

    /// Outer rings of every displayed hazard feature, EPSG:3006 planar meters.
    /// Holes/inner rings are dropped — a bunker's boundary is what a carry
    /// crosses.
    public private(set) var rings: [FlatRing]

    /// Parses every hazard-type Polygon/MultiPolygon feature. Throws only on
    /// unparseable JSON; individual malformed features are skipped.
    public init(featuresGeoJSON: Data) throws {
        let parsed = try JSONSerialization.jsonObject(with: featuresGeoJSON)
        guard
            let collection = parsed as? [String: Any],
            let features = collection["features"] as? [[String: Any]]
        else {
            self.rings = []
            return
        }

        var rings: [FlatRing] = []
        for feature in features {
            guard
                let properties = feature["properties"] as? [String: Any],
                let type = properties["type"] as? String,
                HazardCarries.displayedTypes.contains(type),
                let geometry = feature["geometry"] as? [String: Any],
                let geometryType = geometry["type"] as? String
            else { continue }

            let ringSets: [[[Any]]]
            if geometryType == "Polygon", let raw = geometry["coordinates"] as? [[Any]] {
                ringSets = [raw]
            } else if geometryType == "MultiPolygon", let raw = geometry["coordinates"] as? [[[Any]]] {
                ringSets = raw
            } else {
                continue
            }

            for ringSet in ringSets {
                // Only the outer ring (index 0) matters for a carry crossing.
                guard let outer = ringSet.first, let points = Self.parseRing(outer), points.count >= 3 else {
                    continue
                }
                rings.append(FlatRing(points: points, kind: type))
            }
        }
        self.rings = rings
    }

    /// GeoJSON positions are [lon, lat]; projected to EPSG:3006 {x east, y north}.
    private static func parseRing(_ raw: [Any]) -> [Vec2]? {
        var ring: [Vec2] = []
        for position in raw {
            guard
                let pair = position as? [Any], pair.count >= 2,
                let lon = (pair[0] as? NSNumber)?.doubleValue,
                let lat = (pair[1] as? NSNumber)?.doubleValue
            else { return nil }
            let p = Sweref99TM.fromWGS84(LatLon(lat: lat, lon: lon))
            ring.append(Vec2(x: p.x, y: p.y))
        }
        return ring
    }
}
