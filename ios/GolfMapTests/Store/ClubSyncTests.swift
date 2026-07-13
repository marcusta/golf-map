import XCTest
import GRDB
@testable import GolfMap

/// The offline club-bag edit queue end to end: dirty-flag club rows in an
/// in-memory GRDB database pushed through a REAL `GolfAPIClient` whose HTTP
/// layer is mocked with `MockURLProtocol`. Mirrors `PlanSyncTests`.
final class ClubSyncTests: XCTestCase {

    private func makeService(database: AppDatabase) -> ClubSyncService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = GolfAPIClient(
            baseURL: URL(string: "http://mock.local")!,
            session: URLSession(configuration: config)
        )
        return ClubSyncService(client: client, database: database)
    }

    private func clubJSON(
        id: String, name: String = "Driver", carryM: Double = 215,
        dispersionM: Double = 22, sortOrder: Int = 0, version: Int = 1
    ) -> String {
        """
        {"id":"\(id)","userId":"u1","name":"\(name)","carryM":\(carryM),
         "dispersionM":\(dispersionM),"sortOrder":\(sortOrder),"version":\(version)}
        """
    }

    private func clubBody(
        id: String, name: String = "Driver", carryM: Double = 215,
        dispersionM: Double = 22, sortOrder: Int = 0, version: Int = 1
    ) -> Data {
        Data(clubJSON(
            id: id, name: name, carryM: carryM, dispersionM: dispersionM,
            sortOrder: sortOrder, version: version
        ).utf8)
    }

    /// The re-pull hits `GET /api/clubs`, which decodes an array.
    private func clubListBody(_ entries: [String]) -> Data {
        Data("[\(entries.joined(separator: ","))]".utf8)
    }

    // MARK: - Tests

    func testFlushCreatesClubsInSortOrderThenUpdatesThenRemoves() async throws {
        let database2 = try AppDatabase.inMemory()
        try await database2.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        let second = try await database2.createClub(name: "Second", carryM: 150, dispersionM: 12)
        let third = try await database2.createClub(name: "Third", carryM: 100, dispersionM: 8)
        try await database2.updateClub(id: "c1") { $0.carryM = 218 }

        MockURLProtocol.shared.setScript(
            [
                .init(status: 200, body: clubBody(id: "srv-second", name: "Second", sortOrder: 1)),
                .init(status: 200, body: clubBody(id: "srv-third", name: "Third", sortOrder: 2)),
            ],
            forPathContaining: "/clubs/create"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubBody(id: "c1", name: "Driver", carryM: 218, version: 2))],
            forPathContaining: "/clubs/update"
        )

        await makeService(database: database2).flush()

        let savedSecond = try await database2.club(id: second.id)
        XCTAssertEqual(savedSecond?.serverId, "srv-second")
        XCTAssertEqual(savedSecond?.syncState, .synced)
        let savedThird = try await database2.club(id: third.id)
        XCTAssertEqual(savedThird?.serverId, "srv-third")

        let savedC1 = try await database2.club(id: "c1")
        XCTAssertEqual(savedC1?.syncState, .synced)
        XCTAssertEqual(savedC1?.serverVersion, 2)
        XCTAssertEqual(savedC1?.carryM ?? 0, 218, accuracy: 1e-9)

        let leftover = try await database2.clubsNeedingSync()
        XCTAssertTrue(leftover.isEmpty, "everything pushed")
    }

    func testFailedCreateStopsRemainingCreatesButUpdatesStillProceed() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        let first = try await database.createClub(name: "First new", carryM: 150, dispersionM: 12)
        let second = try await database.createClub(name: "Second new", carryM: 100, dispersionM: 8)
        try await database.updateClub(id: "c1") { $0.carryM = 220 }

        MockURLProtocol.shared.setScript(
            [.init(status: 500, body: Data(#"{"error":"boom"}"#.utf8))],
            forPathContaining: "/clubs/create"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubBody(id: "c1", carryM: 220, version: 2))],
            forPathContaining: "/clubs/update"
        )

        await makeService(database: database).flush()

        let savedFirst = try await database.club(id: first.id)
        XCTAssertEqual(savedFirst?.syncState, .pending, "failed create leaves the row untouched")
        let savedSecond = try await database.club(id: second.id)
        XCTAssertEqual(savedSecond?.syncState, .pending, "the create loop stops after the first failure")

        let savedC1 = try await database.club(id: "c1")
        XCTAssertEqual(savedC1?.syncState, .synced, "updates are independent of the failed creates")
        XCTAssertEqual(savedC1?.serverVersion, 2)
    }

    func testVersionConflictOnUpdateRePullsAndClobbersLocalBag() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", serverVersion: 1, syncState: .synced),
        ])
        try await database.updateClub(id: "c1") { $0.carryM = 999 }

        MockURLProtocol.shared.setScript(
            [.init(status: 409, body: Data(#"{"error":"Version conflict"}"#.utf8))],
            forPathContaining: "/clubs/update"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: clubListBody([clubJSON(id: "c1", name: "Driver", carryM: 215, version: 5)]))],
            forPathContaining: "/clubs"
        )

        await makeService(database: database).flush()

        let clobbered = try await database.club(id: "c1")
        XCTAssertEqual(clobbered?.syncState, .synced)
        XCTAssertEqual(clobbered?.carryM ?? 0, 215, accuracy: 1e-9, "local edit was clobbered by the re-pull")
        XCTAssertEqual(clobbered?.serverVersion, 5)
        let hasPending = try await database.hasPendingClubEdits()
        XCTAssertFalse(hasPending)
    }

    func testTombstonedClubRemovedThenHardDeleted() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        try await database.deleteClub(id: "c1") // → tombstone

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            forPathContaining: "/clubs/remove"
        )

        await makeService(database: database).flush()

        let remaining = try await database.dbQueue.read { try ClubRecord.fetchCount($0) }
        XCTAssertEqual(remaining, 0, "tombstone hard-deleted after the server confirmed")
        let leftover = try await database.clubsNeedingSync()
        XCTAssertTrue(leftover.isEmpty)
    }

    func testReorderPushesOnceAllClubsAreSynced() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
            ClubRecord(id: "c2", name: "7 iron", carryM: 145, dispersionM: 10, sortOrder: 1, serverId: "c2", syncState: .synced),
        ])
        try await database.reorderClubs(orderedIds: ["c2", "c1"])

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            forPathContaining: "/clubs/reorder"
        )

        // `MockURLProtocol.shared` is a process-wide singleton whose request
        // log is never reset between tests, so assert on the DELTA this test
        // caused rather than an absolute count (another test elsewhere in the
        // run may also have hit "/clubs/reorder").
        let before = MockURLProtocol.shared.log().filter { $0.contains("/clubs/reorder") }.count

        await makeService(database: database).flush()

        let dirty = try await database.clubOrderDirty()
        XCTAssertFalse(dirty, "reorder pushed and the flag cleared")
        let after = MockURLProtocol.shared.log().filter { $0.contains("/clubs/reorder") }.count
        XCTAssertEqual(after - before, 1)
    }

    func testReorderSkippedWhilePendingCreateStillNeedsAServerId() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        _ = try await database.createClub(name: "New wedge", carryM: 90, dispersionM: 9)
        try await database.reorderClubs(orderedIds: ["c1"])

        MockURLProtocol.shared.setScript(
            [.init(status: 500, body: Data(#"{"error":"should not be called"}"#.utf8))],
            forPathContaining: "/clubs/create"
        )

        // See the sibling test above re: the shared singleton's cumulative log.
        let before = MockURLProtocol.shared.log().filter { $0.contains("/clubs/reorder") }.count

        await makeService(database: database).flush()

        // The create failed (we forced a 500) so the new club still has no
        // serverId — the reorder must not have fired.
        let dirty = try await database.clubOrderDirty()
        XCTAssertTrue(dirty, "reorder deferred until every club has a serverId")
        let after = MockURLProtocol.shared.log().filter { $0.contains("/clubs/reorder") }.count
        XCTAssertEqual(after, before, "no new reorder call was made")
    }
}
