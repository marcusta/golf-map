import XCTest
@testable import GolfMap

/// The transient map-tool plumbing on `OnCourseModel` (Green view uses it
/// today; measure / elevation-profile tools plug into the same pattern) and
/// the `GreenAnalysisModel` state machine over a synthetic terrain sampler.
@MainActor
final class MapToolModeTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "MapToolModeTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    private func makeModel() -> OnCourseModel {
        let course = CourseRecord(
            id: "course-1", name: "Testville GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 7),
            HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3, strokeIndex: 15),
        ]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, sortOrder: 0),
            TeeRecord(id: "t2", holeId: "h2", name: "default", lat: 58.3660, lon: 15.7060, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(id: "g1", holeId: "h1", centerLat: 58.3640, centerLon: 15.7080),
            GreenRecord(id: "g2", holeId: "h2", centerLat: 58.3670, centerLon: 15.7050),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return OnCourseModel(
            furniture: CourseFurniture(
                course: course, holes: holes, tees: tees, greens: greens,
                pins: [], aimPoints: [], manifest: manifest
            ),
            defaults: defaults
        )
    }

    private let greenBounds = MapCoordinateBounds(
        west: 15.7075, south: 58.3637, east: 15.7085, north: 58.3643
    )

    // MARK: - OnCourseModel tool mode

    func testEnterToolTakesOverCameraWithTightFocusFit() throws {
        let model = makeModel()
        let before = try XCTUnwrap(model.cameraCommand)

        model.enterTool(.greenView, focusBounds: greenBounds)
        XCTAssertEqual(model.toolMode, .greenView)
        let command = try XCTUnwrap(model.cameraCommand)
        XCTAssertEqual(command.target, .bounds(greenBounds))
        XCTAssertEqual(command.padding, 40, "tool focus uses a tight fit")
        XCTAssertEqual(command.bearing, model.holeBearing, "keeps hole-direction-up")
        XCTAssertNotEqual(command.token, before.token, "token bump re-applies the camera")
    }

    func testExitToolRestoresHoleFramingWithFreshToken() throws {
        let model = makeModel()
        model.enterTool(.greenView, focusBounds: greenBounds)
        let during = try XCTUnwrap(model.cameraCommand)

        model.exitTool()
        XCTAssertEqual(model.toolMode, .none)
        let after = try XCTUnwrap(model.cameraCommand)
        XCTAssertEqual(after.target, .bounds(try XCTUnwrap(model.holeBounds)))
        XCTAssertEqual(after.padding, 70, "normal hole padding restored")
        XCTAssertNotEqual(after.token, during.token)

        // Exiting again is a no-op (no extra camera churn).
        let token = after.token
        model.exitTool()
        XCTAssertEqual(model.cameraCommand?.token, token)
    }

    func testHoleNavigationDismissesTheActiveTool() {
        let model = makeModel()
        model.enterTool(.greenView, focusBounds: greenBounds)
        model.nextHole()
        XCTAssertEqual(model.toolMode, .none)
        XCTAssertEqual(model.cameraCommand?.padding, 70, "camera back on hole framing")
    }

    func testEnteringNoneIsExit() {
        let model = makeModel()
        model.enterTool(.greenView, focusBounds: greenBounds)
        model.enterTool(.none)
        XCTAssertEqual(model.toolMode, .none)
    }

    func testRecenterWhileToolActiveReFitsTheToolBounds() throws {
        let model = makeModel()
        model.enterTool(.greenView, focusBounds: greenBounds)
        let before = try XCTUnwrap(model.cameraCommand)
        model.recenter()
        let after = try XCTUnwrap(model.cameraCommand)
        XCTAssertEqual(after.target, .bounds(greenBounds))
        XCTAssertNotEqual(after.token, before.token)
    }

    // MARK: - Measure tool mode

    func testMeasureToolKeepsHoleFramingWithFreshToken() throws {
        let model = makeModel()
        let before = try XCTUnwrap(model.cameraCommand)

        model.enterTool(.measure) // no focus bounds — camera stays on the hole
        XCTAssertEqual(model.toolMode, .measure)
        let during = try XCTUnwrap(model.cameraCommand)
        XCTAssertEqual(during.target, .bounds(try XCTUnwrap(model.holeBounds)))
        XCTAssertEqual(during.padding, 70, "measure keeps the normal hole fit")
        XCTAssertNotEqual(during.token, before.token)

        model.exitTool()
        XCTAssertEqual(model.toolMode, .none)
    }

    func testToolsAreMutuallyExclusive() {
        let model = makeModel()
        model.enterTool(.greenView, focusBounds: greenBounds)
        model.enterTool(.measure)
        XCTAssertEqual(model.toolMode, .measure, "entering measure exits green view")
        XCTAssertEqual(model.cameraCommand?.padding, 70, "green-view focus bounds dropped")

        model.enterTool(.greenView, focusBounds: greenBounds)
        XCTAssertEqual(model.toolMode, .greenView, "entering green view exits measure")
        XCTAssertEqual(model.cameraCommand?.padding, 40)
    }

    func testHoleNavigationDismissesMeasure() {
        let model = makeModel()
        model.enterTool(.measure)
        model.nextHole()
        XCTAssertEqual(model.toolMode, .none)
    }

    // MARK: - GreenAnalysisModel

    /// A green outline around (15.708, 58.364) + a plane sampler → the model
    /// activates, computes, and publishes a ready result with plausible stats.
    func testGreenAnalysisModelComputesResultForContainingPolygon() async throws {
        let center = LatLon(lat: 58.3640, lon: 15.7080)
        let model = GreenAnalysisModel(
            featuresGeoJSON: greenFixture(around: center, dLon: 0.0002, dLat: 0.0001),
            sampler: { coordinate in
                // 3% east-tilted plane in projected meters.
                let p = Sweref99TM.fromWGS84(coordinate)
                return 50 + 0.03 * (p.x - 540_000)
            }
        )

        let bounds = try XCTUnwrap(model.activate(holeId: "h1", greenCenter: center))
        XCTAssertEqual(bounds.west, center.lon - 0.0002, accuracy: 1e-9)
        XCTAssertEqual(bounds.north, center.lat + 0.0001, accuracy: 1e-9)
        XCTAssertTrue(model.isActive)

        // Wait for the async sample/compute to land.
        for _ in 0..<200 where model.result == nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let result = try XCTUnwrap(model.result)
        XCTAssertEqual(result.stats.green.maxSlopePct, 3, accuracy: 0.1)
        XCTAssertGreaterThan(result.grid.insideMask.filter { $0 }.count, 0)
        XCTAssertNotNil(model.mapState)
        XCTAssertEqual(model.mapState?.mode, .slope)

        // Mode toggle re-colors without recompute (same result identity).
        model.setMode(.relative)
        XCTAssertEqual(model.mapState?.mode, .relative)
        XCTAssertEqual(model.mapState?.result.identity, result.identity)

        // Deactivate drops everything.
        model.deactivate()
        XCTAssertFalse(model.isActive)
        XCTAssertNil(model.mapState)
    }

    func testGreenAnalysisModelActivateFailsWithoutMatchingGreen() {
        let model = GreenAnalysisModel(
            featuresGeoJSON: Data(#"{"type":"FeatureCollection","features":[]}"#.utf8),
            sampler: { _ in 1 }
        )
        XCTAssertNil(model.activate(holeId: "h1", greenCenter: LatLon(lat: 58.36, lon: 15.7)))
        XCTAssertFalse(model.isActive)
    }

    func testGreenAnalysisModelBufferChangeClampsAndRecomputes() async throws {
        let center = LatLon(lat: 58.3640, lon: 15.7080)
        let model = GreenAnalysisModel(
            featuresGeoJSON: greenFixture(around: center, dLon: 0.0002, dLat: 0.0001),
            sampler: { _ in 50 }
        )
        _ = model.activate(holeId: nil, greenCenter: center)
        for _ in 0..<200 where model.result == nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let first = try XCTUnwrap(model.result)

        model.setBuffer(120) // clamped to 50
        XCTAssertEqual(model.bufferM, 50)
        for _ in 0..<200 where model.result == nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let second = try XCTUnwrap(model.result)
        XCTAssertNotEqual(second.identity, first.identity, "buffer change re-samples")
        XCTAssertGreaterThan(
            second.grid.spec.width,
            first.grid.spec.width,
            "larger buffer grows the grid"
        )
    }

    private func greenFixture(around center: LatLon, dLon: Double, dLat: Double) -> Data {
        let ring = [
            [center.lon - dLon, center.lat - dLat],
            [center.lon + dLon, center.lat - dLat],
            [center.lon + dLon, center.lat + dLat],
            [center.lon - dLon, center.lat + dLat],
            [center.lon - dLon, center.lat - dLat],
        ]
        let collection: [String: Any] = [
            "type": "FeatureCollection",
            "features": [[
                "type": "Feature",
                "properties": ["courseId": "c1", "holeId": NSNull(), "type": "green"],
                "geometry": ["type": "Polygon", "coordinates": [ring]],
            ]],
        ]
        return try! JSONSerialization.data(withJSONObject: collection)
    }
}
