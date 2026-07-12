import XCTest
import GRDB
@testable import GolfMap

/// The v2 schema (game-plan + club cache): round trips, replace-on-save
/// semantics, FK cascades, and the ordered reads the viewer relies on.
final class GamePlanStoreTests: XCTestCase {

    /// A database with the fixture course bundle saved — game plans FK to
    /// `course`, so the course row must exist first (matching production:
    /// plans are only fetched when a downloaded course is opened).
    private func makeDatabaseWithCourse() async throws -> AppDatabase {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture())
        return database
    }

    private func makeStoredPlan(
        planId: String = "plan-1",
        courseId: String = "course-1"
    ) -> StoredGamePlan {
        StoredGamePlan(
            plan: GamePlanRecord(
                id: planId, courseId: courseId,
                windSpeedMps: 3, windDirectionDeg: 200
            ),
            holes: [
                // Out of hole order to exercise the ordered read.
                GamePlanHoleRecord(
                    id: "\(planId)-h2", gamePlanId: planId, holeNumber: 2,
                    windSpeedMps: 5, windDirectionDeg: 90
                ),
                GamePlanHoleRecord(
                    id: "\(planId)-h1", gamePlanId: planId, holeNumber: 1,
                    teeId: "course-1-t1", preferredClubId: "club-driver",
                    plannedDirectionDeg: 12.5, notes: "aim left"
                ),
            ],
            shots: [
                // Out of sortOrder to exercise the ordered read.
                PlanShotRecord(
                    id: "\(planId)-s2", gamePlanHoleId: "\(planId)-h1", sortOrder: 1,
                    lat: 58.3525, lon: 15.7222, elevation: 41, clubId: "club-7i", label: "layup"
                ),
                PlanShotRecord(
                    id: "\(planId)-s1", gamePlanHoleId: "\(planId)-h1", sortOrder: 0,
                    lat: 58.3515, lon: 15.7215, clubId: "club-driver"
                ),
            ],
            gates: [
                PlanGateRecord(
                    id: "\(planId)-g1", gamePlanHoleId: "\(planId)-h1", sortOrder: 0,
                    lat: 58.352, lon: 15.7218, directionDeg: 30,
                    halfWidthLeftM: 15, halfWidthRightM: 20, source: "manual"
                ),
            ]
        )
    }

    func testMigrationCreatesPlanAndClubTables() throws {
        let database = try AppDatabase.inMemory()
        let tables = try database.dbQueue.read { db in
            try String.fetchAll(
                db,
                sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        }
        for expected in ["club", "gamePlan", "gamePlanHole", "planShot", "planGate"] {
            XCTAssertTrue(tables.contains(expected), "missing table \(expected)")
        }
    }

    func testGamePlanRoundTripWithOrderedReads() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(makeStoredPlan())

        let loaded = try await database.gamePlan(courseId: "course-1")
        let plan = try XCTUnwrap(loaded)
        XCTAssertEqual(plan.plan.id, "plan-1")
        XCTAssertEqual(plan.plan.windSpeedMps ?? 0, 3, accuracy: 1e-9)
        XCTAssertEqual(plan.holes.map(\.holeNumber), [1, 2], "holes ordered by number")
        XCTAssertEqual(plan.shots.map(\.id), ["plan-1-s1", "plan-1-s2"], "shots ordered by sortOrder")
        XCTAssertEqual(plan.shots[0].clubId, "club-driver")
        XCTAssertEqual(plan.gates.count, 1)
        XCTAssertEqual(plan.gates[0].halfWidthRightM, 20, accuracy: 1e-9)

        let missing = try await database.gamePlan(courseId: "other-course")
        XCTAssertNil(missing)
    }

    func testSaveGamePlanReplacesThePreviousPlan() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(makeStoredPlan(planId: "plan-old"))

        try await database.saveGamePlan(makeStoredPlan(planId: "plan-new"))

        let loaded = try await database.gamePlan(courseId: "course-1")
        let plan = try XCTUnwrap(loaded)
        XCTAssertEqual(plan.plan.id, "plan-new")

        // No orphans from the old plan tree.
        let counts = try await database.dbQueue.read { db in
            [
                try GamePlanRecord.fetchCount(db),
                try GamePlanHoleRecord.filter(Column("gamePlanId") == "plan-old").fetchCount(db),
                try PlanShotRecord.filter(Column("id") == "plan-old-s1").fetchCount(db),
                try PlanGateRecord.filter(Column("id") == "plan-old-g1").fetchCount(db),
            ]
        }
        XCTAssertEqual(counts, [1, 0, 0, 0])
    }

    func testDeleteGamePlanRemovesTheTree() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(makeStoredPlan())

        try await database.deleteGamePlan(courseId: "course-1")

        let remaining = try await database.gamePlan(courseId: "course-1")
        XCTAssertNil(remaining)
        let counts = try await database.dbQueue.read { db in
            [
                try GamePlanHoleRecord.fetchCount(db),
                try PlanShotRecord.fetchCount(db),
                try PlanGateRecord.fetchCount(db),
            ]
        }
        XCTAssertEqual(counts, [0, 0, 0])
    }

    func testDeletingTheCourseCascadesToThePlan() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(makeStoredPlan())

        try await database.deleteCourse(id: "course-1")

        let counts = try await database.dbQueue.read { db in
            [
                try GamePlanRecord.fetchCount(db),
                try GamePlanHoleRecord.fetchCount(db),
                try PlanShotRecord.fetchCount(db),
                try PlanGateRecord.fetchCount(db),
            ]
        }
        XCTAssertEqual(counts, [0, 0, 0, 0])
    }

    func testGamePlanRequiresItsCourseRow() async throws {
        let database = try AppDatabase.inMemory()
        await XCTAssertThrowsErrorAsync(
            try await database.saveGamePlan(makeStoredPlan(courseId: "missing-course"))
        )
    }

    func testClubsSaveIsReplaceAll() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0),
            ClubRecord(id: "c2", name: "7 iron", carryM: 145, dispersionM: 10, sortOrder: 1),
        ])
        try await database.saveClubs([
            // c2 renamed, c1 gone, c3 new — the cache mirrors the server list.
            ClubRecord(id: "c3", name: "3 wood", carryM: 195, dispersionM: 18, sortOrder: 0),
            ClubRecord(id: "c2", name: "7i", carryM: 146, dispersionM: 10, sortOrder: 1),
        ])

        let clubs = try await database.allClubs()
        XCTAssertEqual(clubs.map(\.id), ["c3", "c2"], "ordered by sortOrder")
        XCTAssertEqual(clubs.map(\.name), ["3 wood", "7i"])
    }
}
