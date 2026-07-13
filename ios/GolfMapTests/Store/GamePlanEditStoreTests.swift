import XCTest
import GRDB
@testable import GolfMap

/// The v5 writable plan tree: migration columns, lazy plan/hole creation, the
/// dirty-flag transitions, the delete/tombstone rule, and the sync-queue reads
/// `PlanSyncService` relies on. Mirrors `RoundStoreTests`.
final class GamePlanEditStoreTests: XCTestCase {

    /// Plans FK to `course`, so the course row must exist first.
    private func makeDatabaseWithCourse() async throws -> AppDatabase {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture())
        return database
    }

    func testMigrationV5AddsSyncColumns() async throws {
        let database = try AppDatabase.inMemory()
        let columns = try await database.dbQueue.read { db in
            try Row.fetchAll(db, sql: "PRAGMA table_info(planShot)").map { $0["name"] as String }
        }
        for expected in ["serverId", "serverVersion", "syncState"] {
            XCTAssertTrue(columns.contains(expected), "planShot missing \(expected)")
        }
    }

    func testEnsurePlanRowLazyCreatesPendingThenReturnsExisting() async throws {
        let database = try await makeDatabaseWithCourse()
        let created = try await database.ensurePlanRow(courseId: "course-1")
        XCTAssertEqual(created.syncState, .pending)
        XCTAssertNil(created.serverId)

        let again = try await database.ensurePlanRow(courseId: "course-1")
        XCTAssertEqual(again.id, created.id, "returns the existing row, no duplicate")
        let count = try await database.dbQueue.read { try GamePlanRecord.fetchCount($0) }
        XCTAssertEqual(count, 1)
    }

    func testEnsurePlanHoleRowLazyCreates() async throws {
        let database = try await makeDatabaseWithCourse()
        let plan = try await database.ensurePlanRow(courseId: "course-1")
        let hole = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        XCTAssertEqual(hole.holeNumber, 1)
        XCTAssertEqual(hole.syncState, .pending)

        let again = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        XCTAssertEqual(again.id, hole.id)
    }

    func testSavePendingShotAndQueueReads() async throws {
        let database = try await makeDatabaseWithCourse()
        let plan = try await database.ensurePlanRow(courseId: "course-1")
        let hole = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        // Out of sortOrder to exercise the ordered read.
        try await database.savePlanShot(PlanShotRecord(
            id: "s2", gamePlanHoleId: hole.id, sortOrder: 1, lat: 58.35, lon: 15.72, syncState: .pending
        ))
        try await database.savePlanShot(PlanShotRecord(
            id: "s1", gamePlanHoleId: hole.id, sortOrder: 0, lat: 58.35, lon: 15.72, syncState: .pending
        ))

        let plans = try await database.plansNeedingSync()
        XCTAssertEqual(plans.map(\.id), [plan.id])
        let holes = try await database.planHolesNeedingSync(gamePlanId: plan.id)
        XCTAssertEqual(holes.map(\.id), [hole.id])
        let shots = try await database.planShotsNeedingSync(gamePlanHoleId: hole.id)
        XCTAssertEqual(shots.map(\.id), ["s1", "s2"], "ordered by sortOrder")
    }

    func testSyncedPlanTreeIsNotQueued() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(
                id: "p1", courseId: "course-1",
                serverId: "p1", serverVersion: 1, syncState: .synced
            ),
            holes: [GamePlanHoleRecord(
                id: "h1", gamePlanId: "p1", holeNumber: 1,
                serverId: "h1", serverVersion: 1, syncState: .synced
            )],
            shots: [PlanShotRecord(
                id: "s1", gamePlanHoleId: "h1", sortOrder: 0, lat: 58.35, lon: 15.72,
                serverId: "s1", serverVersion: 1, syncState: .synced
            )],
            gates: []
        ))
        let plans = try await database.plansNeedingSync()
        XCTAssertTrue(plans.isEmpty, "a fully synced tree is never queued")
        let hasPending = try await database.hasPendingPlanEdits(courseId: "course-1")
        XCTAssertFalse(hasPending)
    }

    func testSyncedPlanWithDirtyShotIsQueued() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(id: "p1", courseId: "course-1", serverId: "p1", serverVersion: 1, syncState: .synced),
            holes: [GamePlanHoleRecord(id: "h1", gamePlanId: "p1", holeNumber: 1, serverId: "h1", serverVersion: 1, syncState: .synced)],
            shots: [PlanShotRecord(id: "s1", gamePlanHoleId: "h1", sortOrder: 0, lat: 58.35, lon: 15.72, serverId: "s1", serverVersion: 3, syncState: .dirty)],
            gates: []
        ))
        let plans = try await database.plansNeedingSync()
        XCTAssertEqual(plans.map(\.id), ["p1"], "a synced plan with a dirty shot still needs sync")
        let hasPending = try await database.hasPendingPlanEdits(courseId: "course-1")
        XCTAssertTrue(hasPending)
    }

    func testDeletePendingShotHardDeletes() async throws {
        let database = try await makeDatabaseWithCourse()
        let plan = try await database.ensurePlanRow(courseId: "course-1")
        let hole = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        try await database.savePlanShot(PlanShotRecord(
            id: "s1", gamePlanHoleId: hole.id, sortOrder: 0, lat: 58.35, lon: 15.72, syncState: .pending
        ))
        try await database.deletePlanShot(id: "s1")
        let remaining = try await database.dbQueue.read { try PlanShotRecord.fetchCount($0) }
        XCTAssertEqual(remaining, 0, "a shot the server never saw leaves no tombstone")
    }

    func testDeleteSyncedShotTombstonesThenHardDeletes() async throws {
        let database = try await makeDatabaseWithCourse()
        let plan = try await database.ensurePlanRow(courseId: "course-1")
        let hole = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        try await database.savePlanShot(PlanShotRecord(
            id: "s1", gamePlanHoleId: hole.id, sortOrder: 0, lat: 58.35, lon: 15.72,
            serverId: "srv-s1", serverVersion: 1, syncState: .synced
        ))
        try await database.deletePlanShot(id: "s1")

        let queued = try await database.planShotsNeedingSync(gamePlanHoleId: hole.id)
        XCTAssertEqual(queued.map(\.syncState), [.deleted])

        try await database.hardDeletePlanShot(id: "s1")
        let remaining = try await database.dbQueue.read { try PlanShotRecord.fetchCount($0) }
        XCTAssertEqual(remaining, 0)
    }
}
