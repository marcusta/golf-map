import XCTest
@testable import GolfMap

/// `SurfaceFeatureStore` — the iOS lie-map adapter: every surface ring parsed
/// once, TOPMOST-FIRST by the server stack key (fallback to the type z-order),
/// ready to hand to `optimizeAim`.
final class SurfaceFeatureStoreTests: XCTestCase {

    private func store(_ json: String) throws -> SurfaceFeatureStore {
        try SurfaceFeatureStore(featuresGeoJSON: Data(json.utf8))
    }

    /// A square polygon feature of `type` at a small offset, with an optional
    /// explicit stackKey.
    private func feature(type: String, stackKey: Int?, at lonLat: (Double, Double)) -> String {
        let (lon, lat) = lonLat
        let props = stackKey.map { "\"type\":\"\(type)\",\"stackKey\":\($0)" } ?? "\"type\":\"\(type)\""
        return """
        {"type":"Feature","properties":{\(props)},
         "geometry":{"type":"Polygon","coordinates":[[
           [\(lon),\(lat)],[\(lon + 0.001),\(lat)],[\(lon + 0.001),\(lat + 0.001)],[\(lon),\(lat)]]]}}
        """
    }

    func testSurfacesSortedTopmostFirstByStackKey() throws {
        let json = """
        {"type":"FeatureCollection","features":[
          \(feature(type: "fairway", stackKey: 5, at: (15.70, 58.35))),
          \(feature(type: "green", stackKey: 10, at: (15.70, 58.35))),
          \(feature(type: "bunker", stackKey: 8, at: (15.70, 58.35)))
        ]}
        """
        let surfaces = try store(json).surfaces
        XCTAssertEqual(surfaces.map(\.kind), ["green", "bunker", "fairway"])
    }

    func testKeepsEverySurfaceType() throws {
        // Unlike HazardFeatureStore, ground types (fairway/rough/green) are kept.
        let json = """
        {"type":"FeatureCollection","features":[
          \(feature(type: "rough", stackKey: 2, at: (15.70, 58.35))),
          \(feature(type: "water", stackKey: 9, at: (15.71, 58.35)))
        ]}
        """
        let surfaces = try store(json).surfaces
        XCTAssertEqual(Set(surfaces.map(\.kind)), ["rough", "water"])
        XCTAssertEqual(surfaces.first?.kind, "water", "higher stack key first")
        // Rings are projected to EPSG:3006 meters, not left as lon/lat degrees.
        XCTAssertGreaterThan(surfaces[0].points[0].x, 100_000)
    }

    func testStackKeyFallsBackToTypeZOrderWhenMissing() throws {
        // No explicit stackKey → the fixed type z-order (bunker index 8 >
        // fairway index 4 in FeaturePalette.zOrder).
        let json = """
        {"type":"FeatureCollection","features":[
          \(feature(type: "fairway", stackKey: nil, at: (15.70, 58.35))),
          \(feature(type: "bunker", stackKey: nil, at: (15.70, 58.35)))
        ]}
        """
        let surfaces = try store(json).surfaces
        XCTAssertEqual(surfaces.map(\.kind), ["bunker", "fairway"])
    }

    func testDropsDegenerateAndNonPolygonFeatures() throws {
        let json = """
        {"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"type":"water_creek"},
           "geometry":{"type":"LineString","coordinates":[[15.70,58.35],[15.71,58.36]]}},
          {"type":"Feature","properties":{"type":"fairway"},
           "geometry":{"type":"Polygon","coordinates":[[[15.70,58.35],[15.701,58.35]]]}},
          \(feature(type: "green", stackKey: 1, at: (15.70, 58.35)))
        ]}
        """
        let surfaces = try store(json).surfaces
        XCTAssertEqual(surfaces.map(\.kind), ["green"], "line + <3-point ring dropped")
    }

    func testEmptyOnMalformedCollection() throws {
        XCTAssertEqual(try store("{}").surfaces.count, 0)
    }
}
