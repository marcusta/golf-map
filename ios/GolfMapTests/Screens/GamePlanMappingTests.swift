import XCTest
@testable import GolfMap

/// The game-plan viewer's pure pipeline: API JSON → `GamePlanSync` record
/// adapters → `CoursePlan.make` display assembly (club-name resolution, hole
/// lookup, gate endpoint geometry). Driven by hand-written fixtures matching
/// the `shared/api/*.gen.ts` shapes.
final class GamePlanMappingTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ type: T.Type, _ fixture: String) throws -> T {
        try decoder.decode(T.self, from: FixtureLoader.data(fixture))
    }

    // MARK: - Decoding

    func testGamePlanFixtureDecodes() throws {
        let plan = try decode(GamePlan.self, "game-plan-by-course.json")
        XCTAssertEqual(plan.id, "plan-1")
        XCTAssertEqual(plan.courseId, "26D37361-D79C-41AA-AA49-92F2C2277222")
        XCTAssertEqual(plan.windSpeedMps ?? 0, 4.5, accuracy: 1e-9)
        XCTAssertEqual(plan.windDirectionDeg ?? 0, 220, accuracy: 1e-9)
        XCTAssertEqual(plan.holes.count, 2)

        let hole1 = plan.holes[0]
        XCTAssertEqual(hole1.holeNumber, 1)
        XCTAssertEqual(hole1.teeId, "tee-yellow-1")
        XCTAssertNil(hole1.windSpeedMps, "JSON null decodes to nil")
        XCTAssertEqual(hole1.shots.count, 2)
        XCTAssertEqual(hole1.gates.count, 1)
        XCTAssertEqual(hole1.gates[0].source, "computed")
    }

    func testClubsFixtureDecodes() throws {
        let clubs = try decode([Club].self, "clubs.json")
        XCTAssertEqual(clubs.map(\.name), ["Driver", "7 iron", "PW"])
        XCTAssertEqual(clubs[0].carryM, 215, accuracy: 1e-9)
        XCTAssertNil(clubs[2].userId)
    }

    // MARK: - API → record adapters

    func testStoredPlanFlattensTheTree() throws {
        let plan = try decode(GamePlan.self, "game-plan-by-course.json")
        let stored = GamePlanSync.storedPlan(from: plan)

        XCTAssertEqual(stored.plan.id, "plan-1")
        XCTAssertEqual(stored.plan.courseId, plan.courseId)
        XCTAssertEqual(stored.plan.windSpeedMps ?? 0, 4.5, accuracy: 1e-9)

        XCTAssertEqual(stored.holes.map(\.holeNumber), [1, 2])
        XCTAssertEqual(stored.holes[0].notes, "Favor the left half off the tee.")
        XCTAssertEqual(stored.holes[1].windSpeedMps ?? 0, 6, accuracy: 1e-9)

        XCTAssertEqual(stored.shots.count, 2)
        let shot = try XCTUnwrap(stored.shots.first { $0.id == "shot-1a" })
        XCTAssertEqual(shot.gamePlanHoleId, "plan-1-h1")
        XCTAssertEqual(shot.sortOrder, 0)
        XCTAssertEqual(shot.clubId, "club-driver")
        XCTAssertEqual(shot.lat, 58.36180, accuracy: 1e-9)
        XCTAssertEqual(shot.elevation ?? 0, 77.9, accuracy: 1e-9)

        XCTAssertEqual(stored.gates.count, 1)
        let gate = stored.gates[0]
        XCTAssertEqual(gate.directionDeg, 341.5, accuracy: 1e-9)
        XCTAssertEqual(gate.halfWidthLeftM, 18, accuracy: 1e-9)
        XCTAssertEqual(gate.halfWidthRightM, 24, accuracy: 1e-9)
        XCTAssertEqual(gate.source, "computed")
    }

    func testClubRecordAdapter() throws {
        let clubs = try decode([Club].self, "clubs.json")
        let records = clubs.map(GamePlanSync.clubRecord)
        XCTAssertEqual(records.map(\.id), ["club-driver", "club-7i", "club-pw"])
        XCTAssertEqual(records.map(\.sortOrder), [0, 1, 2])
        XCTAssertEqual(records[1].name, "7 iron")
    }

    // MARK: - CoursePlan assembly

    private func makeCoursePlan() throws -> CoursePlan {
        let plan = try decode(GamePlan.self, "game-plan-by-course.json")
        let clubs = try decode([Club].self, "clubs.json")
        return CoursePlan.make(
            stored: GamePlanSync.storedPlan(from: plan),
            clubs: clubs.map(GamePlanSync.clubRecord)
        )
    }

    func testCoursePlanSortsShotsAndResolvesClubNames() throws {
        let coursePlan = try makeCoursePlan()
        XCTAssertTrue(coursePlan.hasContent)

        let hole1 = try XCTUnwrap(coursePlan.hole(number: 1))
        // The fixture lists sortOrder 1 before 0 — assembly must sort.
        XCTAssertEqual(hole1.shots.map(\.id), ["shot-1a", "shot-1b"])
        XCTAssertEqual(hole1.shots.map(\.clubName), ["Driver", "7 iron"])
        XCTAssertNil(hole1.shots[0].label, "JSON null label stays nil")
        XCTAssertEqual(hole1.shots[1].label, "Layup short of bunker")
        XCTAssertEqual(hole1.gates.count, 1)
        XCTAssertEqual(hole1.teeId, "tee-yellow-1")
    }

    func testHoleWithoutContentIsHidden() throws {
        let coursePlan = try makeCoursePlan()
        XCTAssertNil(coursePlan.hole(number: 2), "no shots + no gates → no plan UI")
        XCTAssertNil(coursePlan.hole(number: 3), "unknown hole")
    }

    func testWindFallsBackFromHoleToPlan() throws {
        let coursePlan = try makeCoursePlan()
        let plan1 = try XCTUnwrap(coursePlan.wind(holeNumber: 1))
        XCTAssertEqual(plan1.speedMps, 4.5, accuracy: 1e-9)
        XCTAssertEqual(plan1.directionDeg, 220, accuracy: 1e-9)
        let plan2 = try XCTUnwrap(coursePlan.wind(holeNumber: 2))
        XCTAssertEqual(plan2.speedMps, 6, accuracy: 1e-9)
        XCTAssertEqual(plan2.directionDeg, 180, accuracy: 1e-9)
    }

    func testUnknownClubIdDegradesToNilName() {
        let stored = StoredGamePlan(
            plan: GamePlanRecord(id: "p", courseId: "c"),
            holes: [GamePlanHoleRecord(id: "h", gamePlanId: "p", holeNumber: 1)],
            shots: [PlanShotRecord(
                id: "s", gamePlanHoleId: "h", sortOrder: 0,
                lat: 58.36, lon: 15.71, clubId: "gone-club"
            )],
            gates: []
        )
        let coursePlan = CoursePlan.make(stored: stored, clubs: [])
        XCTAssertEqual(coursePlan.hole(number: 1)?.shots.first?.clubName, nil)
        XCTAssertEqual(coursePlan.hole(number: 1)?.shots.first?.clubId, "gone-club")
    }

    // MARK: - Gate endpoint geometry

    /// Direction 0° (due north): the gate bar runs east–west — left endpoint
    /// west of center by halfWidthLeftM, right endpoint east by
    /// halfWidthRightM (planar SWEREF 99 TM meters).
    func testGateEndpointsPerpendicularToNorthPlay() {
        let center = LatLon(lat: 58.36, lon: 15.71)
        let (left, right) = CoursePlan.Gate.endpoints(
            center: center, directionDeg: 0, halfWidthLeftM: 18, halfWidthRightM: 24
        )
        XCTAssertEqual(Distance.planarMeters(center, left), 18, accuracy: 0.05)
        XCTAssertEqual(Distance.planarMeters(center, right), 24, accuracy: 0.05)
        // Grid-perpendicular: allow ~1.5° for the meridian convergence between
        // grid north and true north at lon 15.71.
        XCTAssertEqual(Distance.bearingDegrees(center, left), 270, accuracy: 1.5)
        XCTAssertEqual(Distance.bearingDegrees(center, right), 90, accuracy: 1.5)
    }

    /// Direction 90° (due east): left of the line of play is north.
    func testGateEndpointsPerpendicularToEastPlay() {
        let center = LatLon(lat: 58.36, lon: 15.71)
        let (left, right) = CoursePlan.Gate.endpoints(
            center: center, directionDeg: 90, halfWidthLeftM: 10, halfWidthRightM: 10
        )
        XCTAssertEqual(Distance.planarMeters(center, left), 10, accuracy: 0.05)
        XCTAssertEqual(Distance.bearingDegrees(center, left), 0, accuracy: 1.5)
        XCTAssertEqual(Distance.bearingDegrees(center, right), 180, accuracy: 1.5)
        // The full bar spans left + right widths.
        XCTAssertEqual(Distance.planarMeters(left, right), 20, accuracy: 0.1)
    }
}
