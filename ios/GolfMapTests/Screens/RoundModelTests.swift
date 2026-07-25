import XCTest
@testable import GolfMap

/// The round lifecycle + local-first stroke writes: start snapshots the plan
/// link/wind, one active round per course, resume across "restarts" (a fresh
/// model over the same database), the §2 recording convention fields, and
/// after-the-fact edits flagging rows for sync.
@MainActor
final class RoundModelTests: XCTestCase {

    private let holes = [
        HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4),
        HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3),
    ]

    private func makeModel(database: AppDatabase) -> RoundModel {
        RoundModel(courseId: "course-1", holes: holes, database: database)
    }

    func testStartRoundSnapshotsPlanLinkAndWind() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)

        let round = await model.startRound(gamePlanId: "plan-1", wind: (5.5, 220))
        XCTAssertEqual(round?.gamePlanId, "plan-1")
        XCTAssertEqual(round?.windSpeedMps, 5.5)
        XCTAssertEqual(round?.windDirectionDeg, 220)
        XCTAssertEqual(round?.syncState, .pending)

        // Persisted immediately (offline-first).
        let stored = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(stored?.id, round?.id)
    }

    func testStartIsIdempotentWhileARoundIsActive() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)

        let first = await model.startRound()
        let second = await model.startRound(gamePlanId: "plan-2")
        XCTAssertEqual(first?.id, second?.id, "one active round max per course")
        XCTAssertNil(second?.gamePlanId, "the existing round is resumed unchanged")
    }

    func testResumeAfterRestartFindsTheActiveRoundAndItsStrokes() async throws {
        let database = try AppDatabase.inMemory()
        let before = makeModel(database: database)
        await before.startRound()
        await before.recordStroke(
            holeNumber: 1,
            position: LatLon(lat: 58.351, lon: 15.721),
            clubId: "club-dr",
            shotType: .full,
            target: LatLon(lat: 58.353, lon: 15.723)
        )

        // "App restart": a fresh model over the same database.
        let after = makeModel(database: database)
        await after.loadActiveRound()
        XCTAssertTrue(after.hasActiveRound)
        XCTAssertEqual(after.round?.id, before.round?.id)
        XCTAssertEqual(after.strokeCount(holeNumber: 1), 1)
        XCTAssertEqual(after.shots[0].clubId, "club-dr")
    }

    func testFinishedRoundDoesNotResume() async throws {
        let database = try AppDatabase.inMemory()
        let before = makeModel(database: database)
        await before.startRound()
        await before.finishRound()
        XCTAssertFalse(before.hasActiveRound)

        let after = makeModel(database: database)
        await after.loadActiveRound()
        XCTAssertFalse(after.hasActiveRound)
    }

    func testRecordStrokeWritesTheSection2Convention() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound()

        let position = LatLon(lat: 58.3515, lon: 15.7215)
        let target = LatLon(lat: 58.353, lon: 15.723)
        let shot = await model.recordStroke(
            holeNumber: 1, position: position, clubId: "club-7i",
            shotType: .full, target: target
        )
        XCTAssertEqual(shot?.lat, position.lat, "recorded AT the position played FROM")
        XCTAssertEqual(shot?.target, target)
        XCTAssertEqual(shot?.sortOrder, 0)
        XCTAssertEqual(shot?.penaltyStrokes, 0)

        // Ordinals are per hole.
        let second = await model.recordStroke(
            holeNumber: 1, position: target, clubId: nil, shotType: .putt, target: target
        )
        XCTAssertEqual(second?.sortOrder, 1)
        let otherHole = await model.recordStroke(
            holeNumber: 2, position: position, clubId: nil, shotType: .full, target: nil
        )
        XCTAssertEqual(otherHole?.sortOrder, 0)
        XCTAssertEqual(model.strokeCount(holeNumber: 1), 2)
        XCTAssertEqual(model.strokeCount(holeNumber: 2), 1)
    }

    func testPenaltyAndEditsFlagSyncedRowsDirty() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound()
        let shot = await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.351, lon: 15.721),
            clubId: "club-dr", shotType: .full, target: nil
        )
        let shotId = try XCTUnwrap(shot?.id)

        // Pending rows stay pending through edits (one add carries it all).
        let withPenalty = await model.addPenalty(shotId: shotId)
        XCTAssertEqual(withPenalty?.penaltyStrokes, 1)
        XCTAssertEqual(withPenalty?.syncState, .pending)

        // A synced row goes dirty on edit.
        var synced = try XCTUnwrap(withPenalty)
        synced.serverId = "srv-1"
        synced.serverVersion = 1
        synced.syncState = .synced
        try await database.saveShot(synced)
        let reloaded = makeModel(database: database)
        await reloaded.loadActiveRound()
        let edited = await reloaded.updateStroke(id: shotId, shotType: .recovery)
        XCTAssertEqual(edited?.shotType, .recovery)
        XCTAssertEqual(edited?.syncState, .dirty)
    }

    // MARK: - Sync interplay
    //
    // Regression: the model's in-memory snapshot predates the sync engine's
    // serverId/syncState assignment (sync writes the DB row only). Mutators
    // used to save the stale snapshot back full-row, resetting the row to
    // `.pending`/nil serverId — the next flush POSTed a duplicate
    // `rounds/start` and the real server round never got its `rounds/end`.

    private func makeSyncService(database: AppDatabase) -> RoundSyncService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = GolfAPIClient(
            baseURL: URL(string: "http://mock.local")!,
            session: URLSession(configuration: config)
        )
        return RoundSyncService(client: client, database: database)
    }

    private func roundBody(id: String, endedAt: String? = nil, version: Int = 1) -> Data {
        let ended = endedAt.map { "\"\($0)\"" } ?? "null"
        return Data("""
        {"id":"\(id)","courseId":"course-1","userId":"u1",
         "startedAt":"2026-07-25T09:00:00Z","endedAt":\(ended),"notes":null,
         "gamePlanId":null,"windSpeedMps":null,"windDirectionDeg":null,
         "version":\(version),"createdAt":"2026-07-25T09:00:01Z",
         "updatedAt":"2026-07-25T09:00:01Z"}
        """.utf8)
    }

    private func shotBody(id: String, version: Int = 1) -> Data {
        Data("""
        {"id":"\(id)","roundId":"srv-r1","holeNumber":1,"sortOrder":0,
         "lat":58.351,"lon":15.721,"clubId":"club-7i","lie":null,
         "shotType":"full","targetLat":null,"targetLon":null,
         "penaltyStrokes":0,"recordedAt":"2026-07-25T09:10:00Z",
         "version":\(version),"createdAt":"2026-07-25T09:10:01Z",
         "updatedAt":"2026-07-25T09:10:01Z"}
        """.utf8)
    }

    /// The request log is a process-wide singleton — assert on deltas.
    private func requestCount(_ pathPart: String) -> Int {
        MockURLProtocol.shared.log().filter { $0.contains(pathPart) }.count
    }

    func testFinishAfterSyncKeepsServerIdentityAndEndsTheSameServerRound() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database) // no sync wired — flushes are driven manually
        let service = makeSyncService(database: database)
        await model.startRound()

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1"))],
            forPathContaining: "/rounds/start"
        )
        let startsBefore = requestCount("/rounds/start")
        // Sync assigns the server identity to the DB row behind the model's back.
        await service.flush()

        // Mid-round edit + finish, both through the model's stale snapshot.
        await model.setStimp(10.5)
        await model.finishRound()

        let storedRounds = try await database.rounds(courseId: "course-1")
        let stored = try XCTUnwrap(storedRounds.first)
        XCTAssertEqual(stored.serverId, "srv-r1", "sync identity survives capture-side mutators")
        XCTAssertEqual(stored.syncState, .dirty, "queued for rounds/end — not a fresh rounds/start")
        XCTAssertEqual(stored.stimpFt, 10.5)
        XCTAssertNotNil(stored.endedAt)

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1", endedAt: stored.endedAt, version: 2))],
            forPathContaining: "/rounds/end"
        )
        let endsBefore = requestCount("/rounds/end")
        await service.flush()

        XCTAssertEqual(
            requestCount("/rounds/start") - startsBefore, 1,
            "exactly one server round across both flushes — no duplicate start"
        )
        XCTAssertEqual(requestCount("/rounds/end") - endsBefore, 1, "the original round was ended")
        let finalRounds = try await database.rounds(courseId: "course-1")
        let final = try XCTUnwrap(finalRounds.first)
        XCTAssertEqual(final.syncState, .synced)
        XCTAssertEqual(final.serverVersion, 2)
    }

    func testShotEditAfterSyncKeepsServerIdentityAndPushesAnUpdate() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        let service = makeSyncService(database: database)
        await model.startRound()
        let recorded = await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.351, lon: 15.721),
            clubId: "club-7i", shotType: .full, target: nil
        )
        let shot = try XCTUnwrap(recorded)

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: roundBody(id: "srv-r1"))],
            forPathContaining: "/rounds/start"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: shotBody(id: "srv-s1"))],
            forPathContaining: "/rounds/shots/add"
        )
        let addsBefore = requestCount("/rounds/shots/add")
        await service.flush()

        // Edit through the model's stale snapshot (in-memory serverId is nil).
        let penalized = await model.addPenalty(shotId: shot.id)
        let edited = try XCTUnwrap(penalized)
        XCTAssertEqual(edited.serverId, "srv-s1", "model adopted the fresh row")
        XCTAssertEqual(edited.syncState, .dirty, "queued as an update — not a re-add")

        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: shotBody(id: "srv-s1", version: 2))],
            forPathContaining: "/rounds/shots/update"
        )
        await service.flush()

        XCTAssertEqual(
            requestCount("/rounds/shots/add") - addsBefore, 1,
            "the stroke reached the server exactly once"
        )
        let stored = try await database.shots(roundId: shot.roundId)
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0].serverVersion, 2)
        XCTAssertEqual(stored[0].syncState, .synced)
        XCTAssertEqual(stored[0].penaltyStrokes, 1)
    }

    func testDeleteStrokeUpdatesScorecard() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound()
        let first = await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.351, lon: 15.721),
            clubId: nil, shotType: .full, target: nil
        )
        await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.352, lon: 15.722),
            clubId: nil, shotType: .putt, target: nil
        )
        XCTAssertEqual(model.scorecard.line(holeNumber: 1)?.strokes, 2)

        await model.deleteStroke(id: try XCTUnwrap(first?.id))
        XCTAssertEqual(model.scorecard.line(holeNumber: 1)?.strokes, 1)
        XCTAssertEqual(model.scorecard.line(holeNumber: 1)?.putts, 1)
    }
}
