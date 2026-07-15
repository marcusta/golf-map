import XCTest
@testable import GolfMap

/// `OnCourseModel`'s shot-visualisation surface (T2): the plan overlay's
/// dispersion ellipses / ghost aim / confidence tints, their bag dependency,
/// and the competition-mode gate that must hide ALL of them while leaving the
/// base plan line / nodes / gates intact.
@MainActor
final class ShotVizOverlayTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "ShotVizOverlayTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private let tee = LatLon(lat: 58.3500, lon: 15.7000)
    private let shot = LatLon(lat: 58.3520, lon: 15.7000)
    private let green = LatLon(lat: 58.3535, lon: 15.7000)

    private let bag = [
        ClubRecord(id: "dr", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0),
        ClubRecord(id: "7i", name: "7 iron", carryM: 150, dispersionM: 22, sortOrder: 1),
    ]

    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Vizville", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default",
                              lat: tee.lat, lon: tee.lon, elevation: 0, sortOrder: 0)]
        let greens = [GreenRecord(id: "g1", holeId: "h1",
                                  centerLat: green.lat, centerLon: green.lon, elevation: 0)]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.69, south: 58.34, east: 15.71, north: 58.36,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
    }

    private func makePlan() -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-1", courseId: "course-1",
                                     windSpeedMps: 4, windDirectionDeg: 45),
                holes: [GamePlanHoleRecord(id: "ph1", gamePlanId: "plan-1", holeNumber: 1, teeId: "t1")],
                shots: [PlanShotRecord(id: "s1", gamePlanHoleId: "ph1", sortOrder: 0,
                                       lat: shot.lat, lon: shot.lon, clubId: "7i")],
                gates: [PlanGateRecord(id: "gate1", gamePlanHoleId: "ph1", sortOrder: 0,
                                       lat: shot.lat, lon: shot.lon, directionDeg: 0,
                                       halfWidthLeftM: 15, halfWidthRightM: 15, source: "manual")]
            ),
            clubs: bag
        )
    }

    private func makeModel(withBag: Bool = true, withSurfaces: Bool = true) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setPlan(makePlan())
        if withBag { model.setClubs(bag) }
        if withSurfaces {
            // A green box under the target so the approach classifies as green.
            let c = Sweref99TM.fromWGS84(green)
            let r = 90.0
            let ring = FlatRing(points: [
                Vec2(x: c.x - r, y: c.y - r), Vec2(x: c.x + r, y: c.y - r),
                Vec2(x: c.x + r, y: c.y + r), Vec2(x: c.x - r, y: c.y + r),
            ], kind: "green")
            model.setSurfaces([ring])
        }
        return model
    }

    func testOverlayCarriesEllipsesAndGhostsWithABag() throws {
        let model = makeModel()
        let overlay = try XCTUnwrap(model.planOverlay)
        // Plan leg ellipses are selection-driven on-course: none without a
        // selected plan row (the default selection is the green row).
        XCTAssertTrue(overlay.ellipses.isEmpty, "no plan-row selection → no leg ellipses")
        XCTAssertEqual(overlay.ghosts.count, 2)
        XCTAssertEqual(overlay.legTints.count, 1, "the approach leg carries a confidence tint")

        // Selecting the plan row surfaces its incoming + outgoing leg ellipses
        // (the single shot's are the tee leg and the approach — both legs).
        let row = try XCTUnwrap(model.ladderRows.first { $0.kind == .plan })
        model.focusMap(on: try XCTUnwrap(row.position), ladderId: row.id)
        let selected = try XCTUnwrap(model.planOverlay)
        XCTAssertEqual(selected.ellipses.count, 2, "one ellipse per adjacent clubbed leg")
    }

    func testNoBagKeepsBasePlanButNoShotViz() throws {
        let overlay = try XCTUnwrap(makeModel(withBag: false).planOverlay)
        XCTAssertFalse(overlay.line.isEmpty, "base plan line still renders")
        XCTAssertEqual(overlay.nodes.count, 1, "landing node still renders")
        XCTAssertEqual(overlay.gates.count, 1, "gate still renders")
        XCTAssertTrue(overlay.ellipses.isEmpty, "no bag → no dispersion ellipses")
        XCTAssertTrue(overlay.ghosts.isEmpty)
        XCTAssertTrue(overlay.legTints.isEmpty)
    }

    func testCompetitionModeHidesAllShotVizButKeepsBasePlan() throws {
        let model = makeModel()
        XCTAssertFalse(model.planOverlay?.ghosts.isEmpty ?? true, "shot-viz shown normally")
        // Ellipses need a plan-row selection (selection-driven) — make one so
        // the competition gate below is what hides them, not the selection.
        let row = try XCTUnwrap(model.ladderRows.first { $0.kind == .plan })
        model.focusMap(on: try XCTUnwrap(row.position), ladderId: row.id)
        XCTAssertFalse(model.planOverlay?.ellipses.isEmpty ?? true, "selected → leg ellipses shown")

        model.competitionMode = true
        let overlay = try XCTUnwrap(model.planOverlay, "the base plan still shows in competition")
        XCTAssertFalse(overlay.line.isEmpty)
        XCTAssertEqual(overlay.nodes.count, 1)
        XCTAssertEqual(overlay.gates.count, 1)
        XCTAssertTrue(overlay.ellipses.isEmpty, "ellipses hidden in competition")
        XCTAssertTrue(overlay.ghosts.isEmpty, "ghost aim hidden in competition")
        XCTAssertTrue(overlay.legTints.isEmpty, "confidence tints hidden in competition")
    }

    func testPlanToggleOffHidesTheWholeOverlay() {
        let model = makeModel()
        model.setPlanVisible(false)
        XCTAssertNil(model.planOverlay)
    }

    func testMemoReusedUntilInputsChange() {
        let model = makeModel()
        let first = model.planOverlay
        let second = model.planOverlay
        XCTAssertEqual(first, second, "identical inputs → identical (memoised) geometry")
    }
}
