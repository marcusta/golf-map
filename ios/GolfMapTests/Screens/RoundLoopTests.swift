import XCTest
@testable import GolfMap

/// Capture drivetrain — the round-loop closing behaviours (round loop R5,
/// task T34): the GPS tee-geofence PROMPT that offers a hole advance when the
/// player walks onto the next tee without holing out. Auto hole advance on
/// hole-out and the end-to-end tap loop are view-level (CourseScreen) and are
/// exercised by the `-roundLoop` headless-verify hook; the geofence detection
/// + nag guard live in the model and are unit-tested here.
@MainActor
final class RoundLoopTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "RoundLoopTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    private let tee1 = LatLon(lat: 58.3600, lon: 15.7100)
    private let tee2 = LatLon(lat: 58.3660, lon: 15.7060)
    private let tee3 = LatLon(lat: 58.3690, lon: 15.7030)

    /// 3-hole synthetic course; every hole carries a tee + green so the
    /// geofence has a next-tee to test against.
    private func makeModel() -> OnCourseModel {
        let course = CourseRecord(
            id: "course-1", name: "Loopville GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 7),
            HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3, strokeIndex: 15),
            HoleRecord(id: "h3", courseId: "course-1", number: 3, par: 5, strokeIndex: 1),
        ]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: tee1.lat, lon: tee1.lon, sortOrder: 0),
            TeeRecord(id: "t2", holeId: "h2", name: "default", lat: tee2.lat, lon: tee2.lon, sortOrder: 0),
            TeeRecord(id: "t3", holeId: "h3", name: "default", lat: tee3.lat, lon: tee3.lon, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(id: "g1", holeId: "h1", centerLat: 58.3640, centerLon: 15.7080),
            GreenRecord(id: "g2", holeId: "h2", centerLat: 58.3675, centerLon: 15.7045),
            GreenRecord(id: "g3", holeId: "h3", centerLat: 58.3710, centerLon: 15.7010),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.38,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let furniture = CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
        return OnCourseModel(furniture: furniture, defaults: defaults)
    }

    /// A model on hole 1 with an active (empty) round.
    private func activeModel() -> OnCourseModel {
        let model = makeModel()
        model.setActiveRound(strokes: [])
        return model
    }

    // MARK: - Geofence detection

    func testNoPromptWithoutAnActiveRound() {
        let model = makeModel()
        model.updateUserLocation(tee2)
        XCTAssertNil(model.teeGeofencePrompt, "a walk-on without a round must never prompt")
    }

    func testPromptsWhenTheFixWalksOntoTheNextTee() {
        let model = activeModel()
        model.updateUserLocation(tee2)
        XCTAssertEqual(model.teeGeofencePrompt, 2, "on hole 1, standing on hole 2's tee → prompt")
    }

    func testNoPromptFarFromTheNextTee() {
        let model = activeModel()
        model.updateUserLocation(tee1) // still on hole 1's own tee
        XCTAssertNil(model.teeGeofencePrompt)
        XCTAssertGreaterThan(
            Distance.planarMeters(tee1, tee2), OnCourseModel.teeGeofenceRadiusM,
            "fixture sanity: hole 1's tee is well outside hole 2's geofence"
        )
    }

    func testNoPromptInBrowseMode() {
        let model = activeModel()
        model.setGPSEnabled(false) // browse mode → no gated fix
        model.updateUserLocation(tee2)
        XCTAssertNil(model.teeGeofencePrompt, "no live tracking in browse mode → no geofence")
    }

    func testNoNextTeeOnTheLastReachableHole() {
        let model = activeModel()
        model.goToHole(number: 3) // last hole → no next tee to walk onto
        model.updateUserLocation(tee3)
        XCTAssertNil(model.teeGeofencePrompt)
    }

    // MARK: - Answering the prompt

    func testConfirmingAdvancesTheHoleAndClearsThePrompt() {
        let model = activeModel()
        model.updateUserLocation(tee2)
        XCTAssertEqual(model.teeGeofencePrompt, 2)
        model.confirmTeeGeofenceAdvance()
        XCTAssertEqual(model.currentHoleNumber, 2, "accepting the prompt advances the card")
        XCTAssertNil(model.teeGeofencePrompt)
    }

    func testDecliningStaysPutAndDoesNotReNagWhileInsideTheRing() {
        let model = activeModel()
        model.updateUserLocation(tee2)
        XCTAssertEqual(model.teeGeofencePrompt, 2)

        model.dismissTeeGeofencePrompt()
        XCTAssertEqual(model.currentHoleNumber, 1, "declining keeps the card put")
        XCTAssertNil(model.teeGeofencePrompt)

        // A jittering fix still on the tee must not re-nag.
        model.updateUserLocation(LatLon(lat: tee2.lat + 0.00001, lon: tee2.lon))
        XCTAssertNil(model.teeGeofencePrompt, "no re-nag while still standing on the tee")
    }

    func testLeavingAndReEnteringTheRingPromptsAgain() {
        let model = activeModel()
        model.updateUserLocation(tee2)
        model.dismissTeeGeofencePrompt()

        model.updateUserLocation(tee1) // walk away (out of the ring)
        XCTAssertNil(model.teeGeofencePrompt)

        model.updateUserLocation(tee2) // come back
        XCTAssertEqual(model.teeGeofencePrompt, 2, "a genuine re-approach may prompt again")
    }

    func testHoleChangeClearsThePrompt() {
        let model = activeModel()
        model.updateUserLocation(tee2)
        XCTAssertEqual(model.teeGeofencePrompt, 2)
        model.goToHole(number: 2) // manual advance
        XCTAssertNil(model.teeGeofencePrompt, "the prompt is keyed to the hole we were on")
    }

    func testLeavingTheRingClearsAStalePrompt() {
        let model = activeModel()
        model.updateUserLocation(tee2)
        XCTAssertEqual(model.teeGeofencePrompt, 2)
        model.updateUserLocation(tee1) // walked away without answering
        XCTAssertNil(model.teeGeofencePrompt)
    }

    // MARK: - Constant lives in one place

    func testGeofenceRadiusConstant() {
        XCTAssertEqual(OnCourseModel.teeGeofenceRadiusM, 30)
    }
}
