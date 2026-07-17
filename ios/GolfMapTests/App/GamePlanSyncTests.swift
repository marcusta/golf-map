import XCTest
import GRDB
@testable import GolfMap

/// `GamePlanSync.refresh()` reconciliation: the plan tree AND the club bag
/// each skip being overwritten by the server while a local edit is pending,
/// but the two guards are independent — a dirty club bag must not block a
/// clean plan refresh (and vice versa). Mirrors the request/mock-body style
/// of `PlanSyncTests`/`ClubSyncTests`, but drives `GamePlanSync.refresh`
/// directly rather than a sync-service actor.
final class GamePlanSyncTests: XCTestCase {

    private func makeClient() -> GolfAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return GolfAPIClient(baseURL: URL(string: "http://mock.local")!, session: URLSession(configuration: config))
    }

    private func makeDatabaseWithCourse() async throws -> AppDatabase {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture())
        return database
    }

    private func emptyPlanBody(id: String = "srv-p1", version: Int = 1) -> Data {
        Data("""
        {"id":"\(id)","courseId":"course-1","userId":"u1",
         "windSpeedMps":null,"windDirectionDeg":null,"holes":[],"version":\(version)}
        """.utf8)
    }

    private func clubJSON(id: String, name: String = "Driver", carryM: Double = 215, sortOrder: Int = 0, version: Int = 1) -> String {
        """
        {"id":"\(id)","userId":"u1","name":"\(name)","carryM":\(carryM),
         "dispersionM":22,"sortOrder":\(sortOrder),"version":\(version)}
        """
    }

    private func clubListBody(_ entries: [String]) -> Data {
        Data("[\(entries.joined(separator: ","))]".utf8)
    }

    private func optionPlanBody() -> Data {
        Data("""
        {"id":"server-plan","courseId":"course-1","userId":"u1",
         "windSpeedMps":null,"windDirectionDeg":null,"version":2,
         "holes":[{"id":"server-hole","gamePlanId":"server-plan","holeNumber":1,
         "teeId":null,"preferredClubId":null,"plannedDirectionDeg":null,
         "windSpeedMps":null,"windDirectionDeg":null,"notes":null,"version":1,
         "shots":[{"id":"server-root","gamePlanHoleId":"server-hole","sortOrder":0,
         "parentShotId":null,"lat":58.36,"lon":15.71,"elevation":null,
         "clubId":null,"label":"Server option","version":1}],"gates":[]}]}
        """.utf8)
    }

    // MARK: - Tests

    func testRefreshSavesCleanClubBagFromServer() async throws {
        let database = try await makeDatabaseWithCourse()
        MockURLProtocol.shared.setScript([.init(status: 200, body: emptyPlanBody())], forPathContaining: "/game-plans/by-course")
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubListBody([clubJSON(id: "srv-driver", carryM: 230)]))],
            forPathContaining: "/clubs"
        )

        try await GamePlanSync.refresh(client: makeClient(), database: database, courseId: "course-1")

        let clubs = try await database.allClubs()
        XCTAssertEqual(clubs.map(\.id), ["srv-driver"])
        XCTAssertEqual(clubs[0].carryM, 230, accuracy: 1e-9)
        XCTAssertEqual(clubs[0].syncState, .synced)
    }

    func testRefreshSkipsClubSaveWhileClubEditsArePending() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveClubs([
            ClubRecord(id: "local-1", name: "My driver", carryM: 240, dispersionM: 25, sortOrder: 0, serverId: "local-1", syncState: .synced),
        ])
        try await database.updateClub(id: "local-1") { $0.carryM = 245 } // → dirty, unsynced

        MockURLProtocol.shared.setScript([.init(status: 200, body: emptyPlanBody())], forPathContaining: "/game-plans/by-course")
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubListBody([clubJSON(id: "srv-driver-should-not-land", carryM: 999)]))],
            forPathContaining: "/clubs"
        )

        try await GamePlanSync.refresh(client: makeClient(), database: database, courseId: "course-1")

        let clubs = try await database.allClubs()
        XCTAssertEqual(clubs.map(\.id), ["local-1"], "the server bag was NOT written over the pending local edit")
        XCTAssertEqual(clubs[0].carryM, 245, accuracy: 1e-9, "local edit survives the refresh")
        XCTAssertEqual(clubs[0].syncState, .dirty)
    }

    func testRefreshSkipsClubSaveWhileOrderIsDirtyEvenWithNoDirtyRows() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
            ClubRecord(id: "c2", name: "7 iron", carryM: 145, dispersionM: 10, sortOrder: 1, serverId: "c2", syncState: .synced),
        ])
        try await database.reorderClubs(orderedIds: ["c2", "c1"]) // no dirty rows, just order-dirty

        MockURLProtocol.shared.setScript([.init(status: 200, body: emptyPlanBody())], forPathContaining: "/game-plans/by-course")
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubListBody([clubJSON(id: "c1"), clubJSON(id: "c2", name: "7 iron", sortOrder: 1)]))],
            forPathContaining: "/clubs"
        )

        try await GamePlanSync.refresh(client: makeClient(), database: database, courseId: "course-1")

        let clubs = try await database.allClubs()
        XCTAssertEqual(clubs.map(\.id), ["c2", "c1"], "local reorder survives — the guard also covers order-only dirt")
    }

    func testRefreshSavesCleanPlanEvenWhileClubBagIsDirty() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        try await database.updateClub(id: "c1") { $0.carryM = 216 } // club bag dirty

        MockURLProtocol.shared.setScript([.init(status: 200, body: emptyPlanBody(id: "srv-p1", version: 3))], forPathContaining: "/game-plans/by-course")
        MockURLProtocol.shared.setScript([.init(status: 200, body: clubListBody([clubJSON(id: "c1")]))], forPathContaining: "/clubs")

        try await GamePlanSync.refresh(client: makeClient(), database: database, courseId: "course-1")

        let plan = try await database.gamePlan(courseId: "course-1")
        XCTAssertEqual(plan?.plan.serverId, "srv-p1", "the plan guard is independent of the club-bag guard")
        XCTAssertEqual(plan?.plan.serverVersion, 3)

        // But the club bag guard still held.
        let clubs = try await database.allClubs()
        XCTAssertEqual(clubs[0].carryM, 216, accuracy: 1e-9)
        XCTAssertEqual(clubs[0].syncState, .dirty)
    }

    func testRefreshOptionTreeDoesNotClobberPendingLocalPlanEdit() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(
                id: "local-plan", courseId: "course-1",
                serverId: "local-plan", serverVersion: 1, syncState: .synced
            ),
            holes: [GamePlanHoleRecord(
                id: "local-hole", gamePlanId: "local-plan", holeNumber: 1,
                serverId: "local-hole", serverVersion: 1, syncState: .synced
            )],
            shots: [PlanShotRecord(
                id: "local-shot", gamePlanHoleId: "local-hole", sortOrder: 0,
                parentShotId: nil, lat: 58.35, lon: 15.70, label: "Local edit",
                serverId: "local-shot", serverVersion: 1, syncState: .dirty
            )],
            gates: []
        ))
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: optionPlanBody())],
            forPathContaining: "/game-plans/by-course"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubListBody([]))],
            forPathContaining: "/clubs"
        )

        try await GamePlanSync.refresh(
            client: makeClient(), database: database, courseId: "course-1"
        )

        let fetched = try await database.gamePlan(courseId: "course-1")
        let stored = try XCTUnwrap(fetched)
        XCTAssertEqual(stored.plan.id, "local-plan")
        XCTAssertEqual(stored.shots.map(\.id), ["local-shot"])
        XCTAssertEqual(stored.shots[0].label, "Local edit")
        XCTAssertEqual(stored.shots[0].syncState, .dirty)
    }
}
