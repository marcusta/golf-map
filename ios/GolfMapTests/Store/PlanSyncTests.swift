import XCTest
import GRDB
@testable import GolfMap

/// The offline planner-edit queue end to end: dirty-flag plan rows in an
/// in-memory GRDB database pushed through a REAL `GolfAPIClient` whose HTTP
/// layer is mocked with `MockURLProtocol`. Mirrors `RoundSyncTests`.
final class PlanSyncTests: XCTestCase {

    private func makeService(database: AppDatabase) -> PlanSyncService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = GolfAPIClient(
            baseURL: URL(string: "http://mock.local")!,
            session: URLSession(configuration: config)
        )
        return PlanSyncService(client: client, database: database)
    }

    private func makeDatabaseWithCourse() async throws -> AppDatabase {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture())
        return database
    }

    // MARK: - Response bodies

    private func planBody(id: String, version: Int = 1) -> Data {
        Data("""
        {"id":"\(id)","courseId":"course-1","userId":"u1",
         "windSpeedMps":null,"windDirectionDeg":null,"holes":[],"version":\(version)}
        """.utf8)
    }

    private func holeBody(id: String, version: Int = 1) -> Data {
        Data("""
        {"id":"\(id)","gamePlanId":"srv-p1","holeNumber":1,"teeId":null,
         "preferredClubId":null,"plannedDirectionDeg":null,"windSpeedMps":null,
         "windDirectionDeg":null,"notes":null,"shots":[],"gates":[],"version":\(version)}
        """.utf8)
    }

    private func shotBody(id: String, sortOrder: Int, version: Int = 1) -> Data {
        Data("""
        {"id":"\(id)","gamePlanHoleId":"srv-h1","sortOrder":\(sortOrder),
         "lat":58.35,"lon":15.72,"elevation":null,"clubId":null,"label":null,"version":\(version)}
        """.utf8)
    }

    /// A full server tree for a re-pull (by-course).
    private func treeBody() -> Data {
        Data("""
        {"id":"srv-p1","courseId":"course-1","userId":"u1",
         "windSpeedMps":null,"windDirectionDeg":null,"version":9,
         "holes":[{"id":"srv-h1","gamePlanId":"srv-p1","holeNumber":1,"teeId":null,
           "preferredClubId":null,"plannedDirectionDeg":null,"windSpeedMps":null,
           "windDirectionDeg":null,"notes":null,"version":4,
           "shots":[{"id":"srv-authoritative","gamePlanHoleId":"srv-h1","sortOrder":0,
             "lat":58.36,"lon":15.73,"elevation":null,"clubId":null,"label":null,"version":7}],
           "gates":[]}]}
        """.utf8)
    }

    // MARK: - Tests

    func testFlushCreatesPlanThenHoleThenShotsInSortOrder() async throws {
        let database = try await makeDatabaseWithCourse()
        let plan = try await database.ensurePlanRow(courseId: "course-1")
        let hole = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        try await database.savePlanShot(PlanShotRecord(
            id: "s2", gamePlanHoleId: hole.id, sortOrder: 1, lat: 58.35, lon: 15.72, syncState: .pending
        ))
        try await database.savePlanShot(PlanShotRecord(
            id: "s1", gamePlanHoleId: hole.id, sortOrder: 0, lat: 58.35, lon: 15.72, syncState: .pending
        ))

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: planBody(id: "srv-p1"))],
            forPathContaining: "/game-plans/upsert"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: holeBody(id: "srv-h1"))],
            forPathContaining: "/game-plans/set-hole"
        )
        MockURLProtocol.shared.setScript(
            [
                .init(status: 200, body: shotBody(id: "srv-s1", sortOrder: 0)),
                .init(status: 200, body: shotBody(id: "srv-s2", sortOrder: 1)),
            ],
            forPathContaining: "/game-plans/shots/add"
        )

        await makeService(database: database).flush()

        let savedPlan = try await database.dbQueue.read { try GamePlanRecord.fetchOne($0, key: plan.id) }
        XCTAssertEqual(savedPlan?.serverId, "srv-p1")
        XCTAssertEqual(savedPlan?.syncState, .synced)
        let savedHole = try await database.dbQueue.read { try GamePlanHoleRecord.fetchOne($0, key: hole.id) }
        XCTAssertEqual(savedHole?.serverId, "srv-h1")
        XCTAssertEqual(savedHole?.syncState, .synced)
        let shots = try await database.planShotsNeedingSync(gamePlanHoleId: hole.id)
        XCTAssertTrue(shots.isEmpty, "all shots synced — queue empty")
        // Capture order: s1 (sortOrder 0) got the first server id.
        let s1 = try await database.planShot(id: "s1")
        XCTAssertEqual(s1?.serverId, "srv-s1")
        XCTAssertEqual(s1?.syncState, .synced)

        let leftover = try await database.plansNeedingSync()
        XCTAssertTrue(leftover.isEmpty, "everything pushed")
    }

    func testFailedPlanCreateLeavesQueueUntouched() async throws {
        let database = try await makeDatabaseWithCourse()
        let plan = try await database.ensurePlanRow(courseId: "course-1")
        let hole = try await database.ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: 1)
        try await database.savePlanShot(PlanShotRecord(
            id: "s1", gamePlanHoleId: hole.id, sortOrder: 0, lat: 58.35, lon: 15.72, syncState: .pending
        ))

        MockURLProtocol.shared.setScript(
            [.init(status: 500, body: Data(#"{"error":"boom"}"#.utf8))],
            forPathContaining: "/game-plans/upsert"
        )
        await makeService(database: database).flush()

        let savedPlan = try await database.dbQueue.read { try GamePlanRecord.fetchOne($0, key: plan.id) }
        XCTAssertEqual(savedPlan?.syncState, .pending, "offline → nothing changes, nothing lost")
        XCTAssertNil(savedPlan?.serverId)
        let s1 = try await database.planShot(id: "s1")
        XCTAssertEqual(s1?.syncState, .pending, "shots never push for a plan the server doesn't have")
    }

    func testDirtyShotPushesAnUpdate() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(id: "p1", courseId: "course-1", serverId: "srv-p1", serverVersion: 1, syncState: .synced),
            holes: [GamePlanHoleRecord(id: "h1", gamePlanId: "p1", holeNumber: 1, serverId: "srv-h1", serverVersion: 1, syncState: .synced)],
            shots: [PlanShotRecord(id: "s1", gamePlanHoleId: "h1", sortOrder: 0, lat: 58.99, lon: 15.99, serverId: "srv-s1", serverVersion: 1, syncState: .dirty)],
            gates: []
        ))
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: shotBody(id: "srv-s1", sortOrder: 0, version: 2))],
            forPathContaining: "/game-plans/shots/update"
        )

        await makeService(database: database).flush()

        let s1 = try await database.planShot(id: "s1")
        XCTAssertEqual(s1?.syncState, .synced)
        XCTAssertEqual(s1?.serverVersion, 2)
        XCTAssertEqual(s1?.lat ?? 0, 58.99, accuracy: 1e-9, "local edit preserved")
    }

    func testVersionConflictOnUpdateRePullsTree() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(id: "p1", courseId: "course-1", serverId: "srv-p1", serverVersion: 1, syncState: .synced),
            holes: [GamePlanHoleRecord(id: "h1", gamePlanId: "p1", holeNumber: 1, serverId: "srv-h1", serverVersion: 1, syncState: .synced)],
            shots: [PlanShotRecord(id: "s-local", gamePlanHoleId: "h1", sortOrder: 0, lat: 58.99, lon: 15.99, serverId: "srv-s1", serverVersion: 1, syncState: .dirty)],
            gates: []
        ))
        MockURLProtocol.shared.setScript(
            [.init(status: 409, body: Data(#"{"error":"Version conflict"}"#.utf8))],
            forPathContaining: "/game-plans/shots/update"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: treeBody())],
            forPathContaining: "/game-plans/by-course"
        )

        await makeService(database: database).flush()

        // Local dirty shot is clobbered by the authoritative server tree.
        let clobbered = try await database.planShot(id: "s-local")
        XCTAssertNil(clobbered, "the divergent local row was replaced by the re-pull")
        let authoritative = try await database.planShot(id: "srv-authoritative")
        XCTAssertEqual(authoritative?.syncState, .synced)
        let hasPending = try await database.hasPendingPlanEdits(courseId: "course-1")
        XCTAssertFalse(hasPending)
    }

    func testTombstonedShotRemovedThenHardDeleted() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(id: "p1", courseId: "course-1", serverId: "srv-p1", serverVersion: 1, syncState: .synced),
            holes: [GamePlanHoleRecord(id: "h1", gamePlanId: "p1", holeNumber: 1, serverId: "srv-h1", serverVersion: 1, syncState: .synced)],
            shots: [PlanShotRecord(id: "s1", gamePlanHoleId: "h1", sortOrder: 0, lat: 58.35, lon: 15.72, serverId: "srv-s1", serverVersion: 1, syncState: .synced)],
            gates: []
        ))
        try await database.deletePlanShot(id: "s1") // → tombstone

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            forPathContaining: "/game-plans/shots/remove"
        )

        await makeService(database: database).flush()

        let remaining = try await database.dbQueue.read { try PlanShotRecord.fetchCount($0) }
        XCTAssertEqual(remaining, 0, "tombstone hard-deleted after the server confirmed")
        let leftover = try await database.plansNeedingSync()
        XCTAssertTrue(leftover.isEmpty)
    }
}
