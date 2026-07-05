import XCTest
@testable import GolfMap

/// Green-polygon selection from features.geojson: holeId match, containment
/// of the hole's green center, nearest-vertex fallback, ring/hole parsing.
final class GreenPolygonsTests: XCTestCase {

    /// Two square greens around Landeryd-ish coordinates:
    ///  - green A: centered near (15.72, 58.358), holeId null, with a hole ring
    ///  - green B: centered near (15.73, 58.362), holeId "h2"
    /// plus a fairway feature that must be ignored.
    private func fixtureGeoJSON() -> Data {
        func square(lon: Double, lat: Double, d: Double) -> [[Double]] {
            [
                [lon - d, lat - d],
                [lon + d, lat - d],
                [lon + d, lat + d],
                [lon - d, lat + d],
                [lon - d, lat - d],
            ]
        }
        let collection: [String: Any] = [
            "type": "FeatureCollection",
            "features": [
                [
                    "type": "Feature",
                    "properties": ["courseId": "c1", "holeId": NSNull(), "type": "green"],
                    "geometry": [
                        "type": "Polygon",
                        "coordinates": [
                            square(lon: 15.72, lat: 58.358, d: 0.0002),
                            square(lon: 15.72, lat: 58.358, d: 0.00003), // hole ring
                        ],
                    ],
                ],
                [
                    "type": "Feature",
                    "properties": ["courseId": "c1", "holeId": "h2", "type": "green"],
                    "geometry": [
                        "type": "Polygon",
                        "coordinates": [square(lon: 15.73, lat: 58.362, d: 0.0002)],
                    ],
                ],
                [
                    "type": "Feature",
                    "properties": ["courseId": "c1", "holeId": NSNull(), "type": "fairway"],
                    "geometry": [
                        "type": "Polygon",
                        "coordinates": [square(lon: 15.725, lat: 58.36, d: 0.001)],
                    ],
                ],
            ],
        ]
        return try! JSONSerialization.data(withJSONObject: collection)
    }

    func testParsesOnlyGreenFeaturesWithProjectedRings() throws {
        let store = try GreenPolygonStore(featuresGeoJSON: fixtureGeoJSON())
        XCTAssertEqual(store.greens.count, 2) // fairway ignored
        let withHole = try XCTUnwrap(store.greens.first(where: { $0.holeId == nil }))
        XCTAssertEqual(withHole.rings.count, 2) // outer + hole ring survive
        XCTAssertEqual(withHole.wgs84Rings[0].count, 5)
        // Projected coordinates are plausible SWEREF99TM meters for Östergötland.
        let p = withHole.rings[0][0]
        XCTAssertEqual(p.x, 542_000, accuracy: 5_000)
        XCTAssertEqual(p.y, 6_468_000, accuracy: 8_000)
    }

    func testSelectsByHoleIdWhenPresent() throws {
        let store = try GreenPolygonStore(featuresGeoJSON: fixtureGeoJSON())
        let green = try XCTUnwrap(store.green(
            forHoleId: "h2",
            // A center inside green A — the holeId match must win anyway.
            greenCenter: LatLon(lat: 58.358, lon: 15.72)
        ))
        XCTAssertEqual(green.holeId, "h2")
    }

    func testSelectsContainingPolygonWhenHoleIdUnknown() throws {
        let store = try GreenPolygonStore(featuresGeoJSON: fixtureGeoJSON())
        let green = try XCTUnwrap(store.green(
            forHoleId: "h-not-in-file",
            greenCenter: LatLon(lat: 58.358, lon: 15.72)
        ))
        XCTAssertNil(green.holeId) // green A (the containing one)
    }

    func testFallsBackToNearestPolygonWhenCenterIsOutsideAll() throws {
        let store = try GreenPolygonStore(featuresGeoJSON: fixtureGeoJSON())
        // Just east of green B, outside both outlines.
        let green = try XCTUnwrap(store.green(
            forHoleId: nil,
            greenCenter: LatLon(lat: 58.362, lon: 15.7305)
        ))
        XCTAssertEqual(green.holeId, "h2")
    }

    func testReturnsNilWithoutCenterOrGreens() throws {
        let store = try GreenPolygonStore(featuresGeoJSON: fixtureGeoJSON())
        XCTAssertNil(store.green(forHoleId: nil, greenCenter: nil))

        let empty = try GreenPolygonStore(
            featuresGeoJSON: Data(#"{"type":"FeatureCollection","features":[]}"#.utf8)
        )
        XCTAssertNil(empty.green(
            forHoleId: "h1",
            greenCenter: LatLon(lat: 58.36, lon: 15.72)
        ))
    }
}
