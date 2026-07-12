import XCTest
@testable import GolfMap

/// Competition mode (DMD rule: distance-only): gating logic + setting
/// persistence.
@MainActor
final class CompetitionModeTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "CompetitionModeTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Gating: OnCourseDistances

    private func targets() -> HoleTargets {
        HoleTargets(
            greenCenter: LatLon(lat: 58.3640, lon: 15.7080),
            greenElevation: 25,
            activePin: LatLon(lat: 58.3641, lon: 15.7081),
            activePinName: "Back-right"
        )
    }

    func testPlaysLikePresentWhenCompetitionOff() {
        let d = OnCourseDistances.compute(
            from: LatLon(lat: 58.3600, lon: 15.7100),
            originElevation: 10,
            targets: targets(),
            competitionMode: false
        )
        // Straight distances present.
        XCTAssertNotNil(d.center)
        XCTAssertNotNil(d.pin)
        // Plays-like (slope-adjusted advice) present.
        XCTAssertNotNil(d.playsLikeCenter)
        XCTAssertNotNil(d.playsLikePin)
    }

    func testPlaysLikeOmittedWhenCompetitionOn() {
        let d = OnCourseDistances.compute(
            from: LatLon(lat: 58.3600, lon: 15.7100),
            originElevation: 10,
            targets: targets(),
            competitionMode: true
        )
        // Straight distances unchanged.
        XCTAssertNotNil(d.center)
        XCTAssertNotNil(d.pin)
        // Slope advice hidden.
        XCTAssertNil(d.playsLikeCenter)
        XCTAssertNil(d.playsLikePin)
    }

    func testStraightDistancesIdenticalRegardlessOfMode() {
        let origin = LatLon(lat: 58.3600, lon: 15.7100)
        let off = OnCourseDistances.compute(from: origin, originElevation: 10, targets: targets(), competitionMode: false)
        let on = OnCourseDistances.compute(from: origin, originElevation: 10, targets: targets(), competitionMode: true)
        XCTAssertEqual(off.center, on.center)
        XCTAssertEqual(off.pin, on.pin)
        XCTAssertEqual(off.front, on.front)
        XCTAssertEqual(off.back, on.back)
        XCTAssertEqual(off.aims, on.aims)
    }

    // MARK: - Gating through OnCourseModel

    func testModelGatesPlaysLikeWhenCompetitionOn() {
        let course = CourseRecord(
            id: "c1", name: "T", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "c1", number: 1, par: 4, strokeIndex: 1)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0)]
        let greens = [GreenRecord(id: "g1", holeId: "h1", centerLat: 58.3640, centerLon: 15.7080, elevation: 25)]
        let manifest = TileManifestRecord(
            courseId: "c1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let furniture = CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )

        let model = OnCourseModel(furniture: furniture, defaults: defaults)
        // Browse from tee (deterministic origin, no GPS).
        model.setGPSEnabled(false)

        model.competitionMode = false
        XCTAssertNotNil(model.distances?.playsLikeCenter, "plays-like shown in friendly mode")

        model.competitionMode = true
        XCTAssertNil(model.distances?.playsLikeCenter, "plays-like hidden in competition mode")
        XCTAssertNotNil(model.distances?.center, "straight distance still shown")
    }

    // MARK: - Part A: hazard carries are measured distances, NOT gated

    private func makeSingleHoleFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "c1", name: "T", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "c1", number: 1, par: 4, strokeIndex: 1)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0)]
        let greens = [GreenRecord(id: "g1", holeId: "h1", centerLat: 58.3640, centerLon: 15.7080, elevation: 25)]
        let manifest = TileManifestRecord(
            courseId: "c1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
    }

    func testHazardCarriesShownRegardlessOfMode() {
        let model = OnCourseModel(furniture: makeSingleHoleFurniture(), defaults: defaults)
        model.setGPSEnabled(false) // origin = tee, primary target = green center

        // A bunker straddling the tee→green midpoint, so the primary line crosses it.
        let tee = Sweref99TM.fromWGS84(LatLon(lat: 58.3600, lon: 15.7100))
        let green = Sweref99TM.fromWGS84(LatLon(lat: 58.3640, lon: 15.7080))
        let mid = Vec2(x: (tee.x + green.x) / 2, y: (tee.y + green.y) / 2)
        let bunker = FlatRing(
            points: [
                Vec2(x: mid.x - 12, y: mid.y - 12),
                Vec2(x: mid.x + 12, y: mid.y - 12),
                Vec2(x: mid.x + 12, y: mid.y + 12),
                Vec2(x: mid.x - 12, y: mid.y + 12),
            ],
            kind: "bunker"
        )
        model.setHazards([bunker])

        model.competitionMode = false
        XCTAssertFalse(model.hazardCarries.isEmpty, "hazard carries present in friendly mode")

        model.competitionMode = true
        XCTAssertFalse(
            model.hazardCarries.isEmpty,
            "hazard carries are RAW measured distances — allowed in competition mode"
        )
    }

    // MARK: - Setting persistence

    func testCompetitionModeDefaultsOff() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertFalse(settings.competitionMode)
    }

    func testCompetitionModePersists() {
        let settings = AppSettings(defaults: defaults)
        settings.competitionMode = true
        // A fresh instance over the same defaults reads it back.
        let reloaded = AppSettings(defaults: defaults)
        XCTAssertTrue(reloaded.competitionMode)
    }

    func testCompetitionModeToggleBackOffPersists() {
        let settings = AppSettings(defaults: defaults)
        settings.competitionMode = true
        settings.competitionMode = false
        let reloaded = AppSettings(defaults: defaults)
        XCTAssertFalse(reloaded.competitionMode)
    }
}
