import Foundation

/// Every 'trees' feature of a course flattened once into `TreeFeatureInput`s
/// (outer ring in EPSG:3006 planar meters + the server's flat `attributes`),
/// ready for `treeClearance`. Sibling of `HazardFeatureStore` /
/// `SurfaceFeatureStore`: parsed from the same raw `features.geojson` the
/// bundle stores — the geojson file IS the on-device feature store, so the
/// canopy attributes (`heightMaxM`, `heightP90M`, `heightMeanM`, `areaM2`) and
/// `source` ride through it unchanged.
///
/// A lidar course carries ~2200 generated tree polygons, so the store also
/// keeps a planar bounding box per feature and exposes `candidates(...)`, a
/// cheap prefilter that drops every ring nowhere near a shot line before the
/// O(vertices) ray/ring intersection runs.
public struct TreeFeatureStore: Sendable {

    /// Planar axis-aligned bounding box, EPSG:3006 meters.
    public struct BBox: Equatable, Sendable {
        public var minX: Double
        public var minY: Double
        public var maxX: Double
        public var maxY: Double

        public func intersects(_ other: BBox) -> Bool {
            minX <= other.maxX && maxX >= other.minX && minY <= other.maxY && maxY >= other.minY
        }

        public func expanded(by pad: Double) -> BBox {
            BBox(minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad)
        }

        public static func of(_ points: [Vec2]) -> BBox {
            guard let first = points.first else {
                return BBox(minX: .infinity, minY: .infinity, maxX: -.infinity, maxY: -.infinity)
            }
            var b = BBox(minX: first.x, minY: first.y, maxX: first.x, maxY: first.y)
            for p in points.dropFirst() {
                b.minX = min(b.minX, p.x); b.minY = min(b.minY, p.y)
                b.maxX = max(b.maxX, p.x); b.maxY = max(b.maxY, p.y)
            }
            return b
        }
    }

    /// Every tree feature, outer ring only, in file order.
    public private(set) var features: [TreeFeatureInput]
    /// Generator per feature (parallel to `features`); nil = hand-drawn.
    public private(set) var sources: [String?]
    /// Owning hole id per feature (parallel); nil = course-level (generated trees always are).
    public private(set) var holeIds: [String?]
    /// Planar bbox per feature (parallel).
    public private(set) var bboxes: [BBox]

    public init(features: [TreeFeatureInput], sources: [String?]? = nil, holeIds: [String?]? = nil) {
        self.features = features
        self.sources = sources ?? Array(repeating: nil, count: features.count)
        self.holeIds = holeIds ?? Array(repeating: nil, count: features.count)
        self.bboxes = features.map {
            if let s = $0.stem {
                return BBox(minX: s.x-s.crownRadiusM, minY: s.y-s.crownRadiusM,
                            maxX: s.x+s.crownRadiusM, maxY: s.y+s.crownRadiusM)
            }
            return BBox.of($0.points)
        }
    }

    /// Parses every 'trees' Polygon/MultiPolygon feature. Throws only on
    /// unparseable JSON; individual malformed features are skipped.
    public init(featuresGeoJSON: Data) throws {
        let parsed = try JSONSerialization.jsonObject(with: featuresGeoJSON)
        guard
            let collection = parsed as? [String: Any],
            let rawFeatures = collection["features"] as? [[String: Any]]
        else {
            self.init(features: [])
            return
        }

        var features: [TreeFeatureInput] = []
        var sources: [String?] = []
        var holeIds: [String?] = []
        for feature in rawFeatures {
            guard
                let properties = feature["properties"] as? [String: Any],
                let type = properties["type"] as? String,
                type == "trees",
                let geometry = feature["geometry"] as? [String: Any],
                let geometryType = geometry["type"] as? String
            else { continue }
            let id = feature["id"] as? String
            let holeId = properties["holeId"] as? String
            let source = properties["source"] as? String
            let attributes = (properties["attributes"] as? [String: Any]).map(Self.parseAttributes)

            let ringSets: [[[Any]]]
            if geometryType == "Polygon", let raw = geometry["coordinates"] as? [[Any]] {
                ringSets = [raw]
            } else if geometryType == "MultiPolygon", let raw = geometry["coordinates"] as? [[[Any]]] {
                ringSets = raw
            } else {
                continue
            }

            for ringSet in ringSets {
                guard let outer = ringSet.first, let points = Self.parseRing(outer), points.count >= 3 else {
                    continue
                }
                features.append(TreeFeatureInput(type: type, points: points, attributes: attributes, id: id))
                sources.append(source)
                holeIds.append(holeId)
            }
        }
        self.init(features: features, sources: sources, holeIds: holeIds)
    }

    /// The features whose bbox meets the padded bbox of the segment
    /// origin→target — the only ones a ray along that segment (or a ring the
    /// ball could land in within `padM` of it) can touch. Order preserved.
    public func candidates(from origin: Vec2, to target: Vec2, padM: Double = 5) -> [TreeFeatureInput] {
        let scan = BBox.of([origin, target]).expanded(by: padM)
        var out: [TreeFeatureInput] = []
        for i in features.indices where bboxes[i].intersects(scan) {
            out.append(features[i])
        }
        return out
    }

    /// Flat attribute object → typed values. Nulls and nested values are
    /// dropped (the server never emits them; a stale bundle might).
    static func parseAttributes(_ raw: [String: Any]) -> [String: FeatureAttributeValue] {
        var out: [String: FeatureAttributeValue] = [:]
        for (key, value) in raw {
            if let n = value as? NSNumber {
                // NSNumber wraps both JSON numbers and JSON booleans.
                if CFGetTypeID(n) == CFBooleanGetTypeID() {
                    out[key] = .bool(n.boolValue)
                } else {
                    out[key] = .number(n.doubleValue)
                }
            } else if let s = value as? String {
                out[key] = .string(s)
            }
        }
        return out
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
