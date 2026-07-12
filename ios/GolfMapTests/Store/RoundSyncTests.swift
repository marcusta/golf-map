import XCTest
import GRDB
@testable import GolfMap

/// The offline capture queue end to end: dirty-flag rows in an in-memory
/// GRDB database pushed through a REAL `GolfAPIClient` whose HTTP layer is
/// mocked with `MockURLProtocol` (the API-test convention — the client and
/// the store are never faked).
final class RoundSyncTests: XCTestCase {

    // MARK: - Fixtures

    private func makeService(database: AppDatabase) -> RoundSyncService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = GolfAPIClient(
            baseURL: URL(string: "http://mock.local")!,
            session: URLSession(configuration: config)
        )
        return RoundSyncService(client: client, database: database)
    }

    private func pendingRound(
        id: String = "r1",
        endedAt: String? = nil
    ) -> RoundRecord {
        RoundRecord(
            id: id,
            courseId: "course-1",
            startedAt: "2026-07-12T09:00:00Z",
            endedAt: endedAt,
            gamePlanId: "plan-1",
            windSpeedMps: 4,
            windDirectionDeg: 210
        )
    }

    private func pendingShot(
        id: String,
        roundId: String = "r1",
        hole: Int = 1,
        order: Int = 0,
        recordedAt: String
    ) -> ShotRecord {
        ShotRecord(
            id: id,
            roundId: roundId,
            holeNumber: hole,
            sortOrder: order,
            lat: 58.351,
            lon: 15.721,
            clubId: "club-7i",
            shotType: .full,
            targetLat: 58.353,
            targetLon: 15.723,
            recordedAt: recordedAt
        )
    }

    private func roundBody(id: String, endedAt: String? = nil, version: Int = 1) -> Data {
        let ended = endedAt.map { "\"\($0)\"" } ?? "null"
        return Data("""
        {"id":"\(id)","courseId":"course-1","userId":"u1",
         "startedAt":"2026-07-12T09:00:00Z","endedAt":\(ended),"notes":null,
         "gamePlanId":"plan-1","windSpeedMps":4,"windDirectionDeg":210,
         "version":\(version),"createdAt":"2026-07-12T09:00:01Z",
         "updatedAt":"2026-07-12T09:00:01Z"}
        """.utf8)
    }

    private func shotBody(id: String, sortOrder: Int, version: Int = 1) -> Data {
        Data("""
        {"id":"\(id)","roundId":"srv-r1","holeNumber":1,"sortOrder":\(sortOrder),
         "lat":58.351,"lon":15.721,"clubId":"club-7i","lie":null,
         "shotType":"full","targetLat":58.353,"targetLon":15.723,
         "penaltyStrokes":0,"recordedAt":"2026-07-12T09:10:00Z",
         "version":\(version),"createdAt":"2026-07-12T09:10:01Z",
         "updatedAt":"2026-07-12T09:10:01Z"}
        """.utf8)
    }

    private func addPathCount() -> Int {
        MockURLProtocol.shared.log().filter { $0.contains("/rounds/shots/add") }.count
    }

    // MARK: - Tests

    func testFlushPushesPendingRoundThenShotsInCaptureOrder() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(pendingRound())
        try await database.saveShot(pendingShot(id: "s2", order: 1, recordedAt: "2026-07-12T09:20:00Z"))
        try await database.saveShot(pendingShot(id: "s1", order: 0, recordedAt: "2026-07-12T09:10:00Z"))

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1"))],
            forPathContaining: "/rounds/start"
        )
        MockURLProtocol.shared.setScript(
            [
                .init(status: 200, body: shotBody(id: "srv-s1", sortOrder: 0)),
                .init(status: 200, body: shotBody(id: "srv-s2", sortOrder: 1)),
            ],
            forPathContaining: "/rounds/shots/add"
        )

        await makeService(database: database).flush()

        let activeRound = try await database.activeRound(courseId: "course-1")
        let round = try XCTUnwrap(activeRound)
        XCTAssertEqual(round.serverId, "srv-r1")
        XCTAssertEqual(round.serverVersion, 1)
        XCTAssertEqual(round.syncState, .synced)

        let shots = try await database.shots(roundId: "r1")
        XCTAssertEqual(shots.map(\.syncState), [.synced, .synced])
        // Capture order (recordedAt): s1 pushed first → got the first server id.
        XCTAssertEqual(shots.first(where: { $0.id == "s1" })?.serverId, "srv-s1")
        XCTAssertEqual(shots.first(where: { $0.id == "s2" })?.serverId, "srv-s2")
        let leftover = try await database.roundsNeedingSync()
        XCTAssertTrue(leftover.isEmpty, "everything pushed — the queue is empty")
    }

    func testFailedStartLeavesQueueUntouchedAndRetrySucceeds() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(pendingRound())
        try await database.saveShot(pendingShot(id: "s1", recordedAt: "2026-07-12T09:10:00Z"))
        let service = makeService(database: database)

        // Server down: nothing changes, nothing is lost.
        MockURLProtocol.shared.setScript(
            [.init(status: 500, body: Data(#"{"error":"boom"}"#.utf8))],
            forPathContaining: "/rounds/start"
        )
        let addsBefore = addPathCount()
        await service.flush()

        let afterFailure = try await database.activeRound(courseId: "course-1")
        var round = try XCTUnwrap(afterFailure)
        XCTAssertNil(round.serverId)
        XCTAssertEqual(round.syncState, .pending)
        XCTAssertEqual(
            addPathCount(), addsBefore,
            "shots are never pushed for a round the server doesn't have"
        )

        // Connectivity back: the SAME rows flush clean.
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1"))],
            forPathContaining: "/rounds/start"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: shotBody(id: "srv-s1", sortOrder: 0))],
            forPathContaining: "/rounds/shots/add"
        )
        await service.flush()

        let afterRetry = try await database.activeRound(courseId: "course-1")
        round = try XCTUnwrap(afterRetry)
        XCTAssertEqual(round.syncState, .synced)
        let shots = try await database.shots(roundId: "r1")
        XCTAssertEqual(shots.map(\.syncState), [.synced])
    }

    func testRoundEndedOfflineIsStartedThenEnded() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(pendingRound(endedAt: "2026-07-12T13:00:00Z"))

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1", version: 1))],
            forPathContaining: "/rounds/start"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1", endedAt: "2026-07-12T13:00:00Z", version: 2))],
            forPathContaining: "/rounds/end"
        )

        await makeService(database: database).flush()

        let rounds = try await database.rounds(courseId: "course-1")
        XCTAssertEqual(rounds.count, 1)
        XCTAssertEqual(rounds[0].serverId, "srv-r1")
        XCTAssertEqual(rounds[0].syncState, .synced)
        XCTAssertEqual(rounds[0].serverVersion, 2, "end bumped the optimistic-lock version")
    }

    func testDirtyShotPushesAnUpdate() async throws {
        let database = try AppDatabase.inMemory()
        var round = pendingRound()
        round.serverId = "srv-r1"
        round.serverVersion = 1
        round.syncState = .synced
        try await database.saveRound(round)
        var shot = pendingShot(id: "s1", recordedAt: "2026-07-12T09:10:00Z")
        shot.serverId = "srv-s1"
        shot.serverVersion = 1
        shot.penaltyStrokes = 1 // the local edit
        shot.syncState = .dirty
        try await database.saveShot(shot)

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: shotBody(id: "srv-s1", sortOrder: 0, version: 2))],
            forPathContaining: "/rounds/shots/update"
        )

        await makeService(database: database).flush()

        let shots = try await database.shots(roundId: "r1")
        XCTAssertEqual(shots[0].syncState, .synced)
        XCTAssertEqual(shots[0].serverVersion, 2)
        XCTAssertEqual(shots[0].penaltyStrokes, 1, "local edit preserved")
    }

    func testTombstonedShotIsRemovedOnServerThenHardDeleted() async throws {
        let database = try AppDatabase.inMemory()
        var round = pendingRound()
        round.serverId = "srv-r1"
        round.syncState = .synced
        try await database.saveRound(round)
        var shot = pendingShot(id: "s1", recordedAt: "2026-07-12T09:10:00Z")
        shot.serverId = "srv-s1"
        shot.serverVersion = 1
        shot.syncState = .synced
        try await database.saveShot(shot)
        try await database.deleteShot(id: "s1") // → tombstone

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            forPathContaining: "/rounds/shots/remove"
        )

        await makeService(database: database).flush()

        let remaining = try await database.dbQueue.read { db in
            try ShotRecord.fetchCount(db)
        }
        XCTAssertEqual(remaining, 0, "tombstone hard-deleted after the server confirmed")
        let queue = try await database.roundsNeedingSync()
        XCTAssertTrue(queue.isEmpty)
    }

    func testFirstAddFailureStopsLaterAddsToKeepServerOrder() async throws {
        let database = try AppDatabase.inMemory()
        var round = pendingRound()
        round.serverId = "srv-r1"
        round.serverVersion = 1
        round.syncState = .synced
        try await database.saveRound(round)
        try await database.saveShot(pendingShot(id: "s1", order: 0, recordedAt: "2026-07-12T09:10:00Z"))
        try await database.saveShot(pendingShot(id: "s2", order: 1, recordedAt: "2026-07-12T09:20:00Z"))

        MockURLProtocol.shared.setScript(
            [.init(status: 500, body: Data(#"{"error":"boom"}"#.utf8))],
            forPathContaining: "/rounds/shots/add"
        )
        let addsBefore = addPathCount()
        await makeService(database: database).flush()

        XCTAssertEqual(
            addPathCount() - addsBefore, 1,
            "the second add must not jump the queue — server sortOrder is insert order"
        )
        let shots = try await database.shots(roundId: "r1")
        XCTAssertEqual(shots.map(\.syncState), [.pending, .pending])
    }
}
