import Foundation

/// Every course surface ring flattened once into `FlatRing`s, TOPMOST-FIRST —
/// the iOS equivalent of the web planner's `lie-map.ts` (`buildLieMap`). Where
/// `HazardFeatureStore` keeps only the carry-hazard subset, this keeps EVERY
/// polygon feature type (fairway, green, rough, bunker, water, …) because the
/// aim optimiser (`optimizeAim`) classifies the whole lie taxonomy, not just
/// hazards.
///
/// Ordering IS priority order (decision D23): the array is sorted by the
/// server-assigned global `stackKey` descending (course-group-then-hole-then-
/// sortOrder), so the FIRST containing ring wins nesting — the same order the
/// map renders (`FeaturePalette.stackSortKeyExpression`) and the web editor
/// hits. Bundles generated before the stack model shipped carry no `stackKey`;
/// those fall back to the fixed type z-order (`FeaturePalette.zOrder`), exactly
/// like the render fallback.
///
/// Outer rings only (holes/donuts dropped) — `FlatRing` has no hole concept,
/// the same v1 simplification `lie-map.ts` and `corridor.ts` already ship with.
public struct SurfaceFeatureStore: Sendable {

    /// All surface rings, EPSG:3006 planar meters, TOPMOST-FIRST — ready to
    /// hand straight to `optimizeAim`'s `surfaces` (D23 contract).
    public private(set) var surfaces: [FlatRing]

    public init(featuresGeoJSON: Data) throws {
        let parsed = try JSONSerialization.jsonObject(with: featuresGeoJSON)
        guard
            let collection = parsed as? [String: Any],
            let features = collection["features"] as? [[String: Any]]
        else {
            self.surfaces = []
            return
        }

        // (ring, stackKey) so we can sort topmost-first after collecting.
        var keyed: [(ring: FlatRing, stackKey: Double)] = []
        for feature in features {
            guard
                let properties = feature["properties"] as? [String: Any],
                let type = properties["type"] as? String,
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

            let stackKey = Self.stackKey(properties: properties, type: type)
            for ringSet in ringSets {
                guard let outer = ringSet.first,
                      let points = Self.parseRing(outer), points.count >= 3
                else { continue }
                keyed.append((FlatRing(points: points, kind: type), stackKey))
            }
        }

        // Highest stack key first (topmost renders on top → wins nesting).
        // Stable within equal keys (mergesort) so multipolygon parts of one
        // feature keep their emission order.
        keyed.sort { $0.stackKey > $1.stackKey }
        self.surfaces = keyed.map(\.ring)
    }

    /// Server-assigned global stack key when present, else the fixed type
    /// z-order (unknown types below everything, -1) — mirrors
    /// `FeaturePalette.stackSortKeyExpression`.
    static func stackKey(properties: [String: Any], type: String) -> Double {
        if let key = (properties["stackKey"] as? NSNumber)?.doubleValue {
            return key
        }
        if let featureType = CourseFeatureType(rawValue: type),
           let index = FeaturePalette.zOrder.firstIndex(of: featureType) {
            return Double(index)
        }
        return -1
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
