import XCTest
@testable import GolfMap

/// `OnCourseModel`'s game-plan surface: per-hole plan lookup, the planned
/// route/legs, the next-planned-landing selection (GPS mode), the map
/// overlay, and the per-course visibility toggle persistence.
@MainActor
final class GamePlanModelTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "GamePlanModelTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    private let teeDefault = LatLon(lat: 58.3600, lon: 15.7100)
    private let teeBlue = LatLon(lat: 58.3590, lon: 15.7100)
    private let greenCenter = LatLon(lat: 58.3640, lon: 15.7080)
    private let shot1 = LatLon(lat: 58.3615, lon: 15.7092)
    private let shot2 = LatLon(lat: 58.3628, lon: 15.7086)

    /// Two-hole course; the plan covers hole 1 only, teeing off the BLUE tee
    /// (not the default) with two planned landings and one gate.
    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Planville GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 5),
            HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3),
        ]
        let tees = [
            TeeRecord(id: "t1d", holeId: "h1", name: "default",
                      lat: teeDefault.lat, lon: teeDefault.lon, sortOrder: 0),
            TeeRecord(id: "t1b", holeId: "h1", name: "Blue",
                      lat: teeBlue.lat, lon: teeBlue.lon, sortOrder: 1),
            TeeRecord(id: "t2d", holeId: "h2", name: "default",
                      lat: 58.3660, lon: 15.7060, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(id: "g1", holeId: "h1",
                        centerLat: greenCenter.lat, centerLon: greenCenter.lon),
            GreenRecord(id: "g2", holeId: "h2", centerLat: 58.3670, centerLon: 15.7050),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
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
                plan: GamePlanRecord(id: "plan-1", courseId: "course-1"),
                holes: [
                    GamePlanHoleRecord(
                        id: "ph1", gamePlanId: "plan-1", holeNumber: 1, teeId: "t1b"
                    ),
                ],
                shots: [
                    PlanShotRecord(id: "s1", gamePlanHoleId: "ph1", sortOrder: 0,
                                   lat: shot1.lat, lon: shot1.lon, clubId: "club-driver"),
                    PlanShotRecord(id: "s2", gamePlanHoleId: "ph1", sortOrder: 1,
                                   lat: shot2.lat, lon: shot2.lon,
                                   clubId: "club-7i", label: "Layup"),
                ],
                gates: [
                    PlanGateRecord(id: "gate1", gamePlanHoleId: "ph1", sortOrder: 0,
                                   lat: 58.3620, lon: 15.7090, directionDeg: 340,
                                   halfWidthLeftM: 15, halfWidthRightM: 20, source: "manual"),
                ]
            ),
            clubs: [
                ClubRecord(id: "club-driver", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0),
                ClubRecord(id: "club-7i", name: "7 iron", carryM: 145, dispersionM: 10, sortOrder: 1),
            ]
        )
    }

    private func makeModel(withPlan: Bool = true) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        if withPlan {
            model.setPlan(makePlan())
        }
        return model
    }

    private func meters(_ a: LatLon, _ b: LatLon) -> Int {
        Int(Distance.planarMeters(a, b).rounded())
    }

    // MARK: - Plan presence

    func testNoPlanMeansNoPlanUI() {
        let model = makeModel(withPlan: false)
        XCTAssertFalse(model.courseHasPlan)
        XCTAssertNil(model.currentHolePlan)
        XCTAssertNil(model.planOverlay)
        XCTAssertTrue(model.planLegs.isEmpty)
        XCTAssertNil(model.planTargetDistance)
        // Everything else keeps working.
        XCTAssertNotNil(model.currentHole)
    }

    func testPlanSurfacesOnPlannedHoleOnly() {
        let model = makeModel()
        XCTAssertTrue(model.courseHasPlan)
        XCTAssertNotNil(model.currentHolePlan)
        XCTAssertNotNil(model.planOverlay)

        model.nextHole() // hole 2 has no plan content
        XCTAssertTrue(model.courseHasPlan, "the toggle stays available")
        XCTAssertNil(model.currentHolePlan)
        XCTAssertNil(model.planOverlay, "overlay clears on a plan-less hole")
        XCTAssertTrue(model.planLegs.isEmpty)

        model.previousHole()
        XCTAssertNotNil(model.planOverlay, "overlay returns on the planned hole")
    }

    // MARK: - Planned route + legs

    func testPlanRouteStartsAtThePlansTeeAndEndsAtGreenCenter() {
        let model = makeModel()
        // Active tee is "default" (lowest sortOrder) — the PLAN says Blue.
        XCTAssertEqual(model.resolvedTeeName, "default")
        XCTAssertEqual(model.planRoute, [teeBlue, shot1, shot2, greenCenter])
    }

    func testPlanLegsCarryClubLabelAndPlanarMeters() {
        let model = makeModel()
        let legs = model.planLegs
        XCTAssertEqual(legs.count, 3)

        XCTAssertEqual(legs[0].index, 1)
        XCTAssertEqual(legs[0].clubName, "Driver")
        XCTAssertNil(legs[0].label)
        XCTAssertFalse(legs[0].toGreen)
        XCTAssertEqual(legs[0].meters, meters(teeBlue, shot1))

        XCTAssertEqual(legs[1].index, 2)
        XCTAssertEqual(legs[1].clubName, "7 iron")
        XCTAssertEqual(legs[1].label, "Layup")
        XCTAssertEqual(legs[1].meters, meters(shot1, shot2))

        XCTAssertEqual(legs[2].index, 3)
        XCTAssertNil(legs[2].clubName)
        XCTAssertTrue(legs[2].toGreen)
        XCTAssertEqual(legs[2].meters, meters(shot2, greenCenter))
    }

    // MARK: - Next planned landing (GPS mode)

    func testNextPlannedLandingWalksTheShotsAsTheyArePassed() {
        let model = makeModel()

        // On the tee: everything is ahead → shot 1.
        model.updateUserLocation(teeDefault)
        XCTAssertEqual(model.nextPlannedLanding?.id, "s1")

        // Past shot 1 (closer to the green than shot 1, but not shot 2) → shot 2.
        let betweenShots = LatLon(lat: 58.3620, lon: 15.7090)
        XCTAssertLessThan(
            Distance.planarMeters(betweenShots, greenCenter),
            Distance.planarMeters(shot1, greenCenter)
        )
        XCTAssertGreaterThan(
            Distance.planarMeters(betweenShots, greenCenter),
            Distance.planarMeters(shot2, greenCenter)
        )
        model.updateUserLocation(betweenShots)
        XCTAssertEqual(model.nextPlannedLanding?.id, "s2")

        // Past every planned landing → nil (the green is the target).
        model.updateUserLocation(LatLon(lat: 58.3636, lon: 15.7081))
        XCTAssertNil(model.nextPlannedLanding)
        XCTAssertNil(model.planTargetDistance)
    }

    func testPlanTargetDistanceIsPlanarMetersFromOrigin() throws {
        let model = makeModel()
        model.updateUserLocation(teeDefault)
        let target = try XCTUnwrap(model.planTargetDistance)
        XCTAssertEqual(target.clubName, "Driver")
        XCTAssertEqual(target.meters, meters(teeDefault, shot1))
    }

    func testBrowseModeHasNoPlanTarget() {
        let model = makeModel()
        model.updateUserLocation(teeDefault)
        model.setGPSEnabled(false)
        XCTAssertNil(model.nextPlannedLanding, "browse mode ignores the fix")
        XCTAssertNil(model.planTargetDistance)
        XCTAssertFalse(model.planLegs.isEmpty, "the plan strip stays useful in browse")
    }

    // MARK: - Overlay content + visibility toggle

    func testPlanOverlayCarriesLineNodesAndGateEndpoints() throws {
        let model = makeModel()
        let overlay = try XCTUnwrap(model.planOverlay)
        XCTAssertEqual(overlay.line, [teeBlue, shot1, shot2, greenCenter])
        XCTAssertEqual(overlay.nodes, [shot1, shot2])
        XCTAssertEqual(overlay.gates.count, 1)
        let gate = overlay.gates[0]
        XCTAssertEqual(Distance.planarMeters(gate.left, gate.right), 35, accuracy: 0.1)
        // The overlay rides along in the map overlay state.
        XCTAssertEqual(model.overlays.plan, overlay)
    }

    func testPlanVisibilityTogglePersistsPerCourse() {
        let model = makeModel()
        XCTAssertTrue(model.planVisible, "default ON")
        model.togglePlanVisible()
        XCTAssertFalse(model.planVisible)
        XCTAssertNil(model.planOverlay, "hidden overlay renders nothing")
        XCTAssertNil(model.overlays.plan)
        XCTAssertFalse(model.planLegs.isEmpty, "the card row follows the plan, not the toggle")

        // A fresh model over the same defaults (same course) restores OFF.
        let reloaded = makeModel()
        XCTAssertFalse(reloaded.planVisible)
        XCTAssertNil(reloaded.planOverlay)
        reloaded.setPlanVisible(true)
        XCTAssertNotNil(reloaded.planOverlay)
    }
}
