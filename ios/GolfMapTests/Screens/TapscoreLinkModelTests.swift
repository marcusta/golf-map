import XCTest
@testable import GolfMap

/// The Tapscore link UI's logic (T65, docs/feature-tapscore-bridge.md): what the
/// player is told on each of the contract's refusals (404 unknown token, 409
/// ball ambiguity, 409 unclaimed seat, offline), how a pasted share link reduces
/// to its token, and the local mirror that keeps a linked round reading "linked"
/// with no signal.
///
/// The 404/409 message strings below are VERBATIM from
/// `server/services/tapscore-bridge.service.ts` (`status`, `resolveBallId`) —
/// classification refines on their wording, so that file is the source of truth
/// and a reword there must break these tests rather than silently degrade the
/// remedy the player is offered.
@MainActor
final class TapscoreLinkModelTests: XCTestCase {

    // MARK: - Fake bridge

    /// Records calls and replays a scripted answer. `@unchecked Sendable` per
    /// the suite convention — the model awaits each call in order.
    private final class FakeBridge: TapscoreLinkAPI, @unchecked Sendable {
        var statusResult: Result<TapscoreLink, any Error> = .success(.unlinkedStub)
        var linkResult: Result<TapscoreLink, any Error> = .success(.linkedStub)
        var unlinkResult: Result<TapscoreLink, any Error> = .success(.unlinkedStub)
        var ballsResult: Result<[TapscoreBall], any Error> = .success([])

        private(set) var linkCalls: [(roundId: String, token: String, ballId: String?)] = []
        private(set) var unlinkCalls: [String] = []
        private(set) var statusCalls: [String] = []
        private(set) var ballsCalls: [String] = []

        func tapscoreLink(roundId: String) async throws -> TapscoreLink {
            statusCalls.append(roundId)
            return try statusResult.get()
        }

        func linkTapscore(roundId: String, token: String, ballId: String?) async throws -> TapscoreLink {
            linkCalls.append((roundId, token, ballId))
            return try linkResult.get()
        }

        func unlinkTapscore(roundId: String) async throws -> TapscoreLink {
            unlinkCalls.append(roundId)
            return try unlinkResult.get()
        }

        func tapscoreBalls(token: String) async throws -> [TapscoreBall] {
            ballsCalls.append(token)
            return try ballsResult.get()
        }
    }

    private let holes = [HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4)]

    /// A round model over an in-memory DB whose active round is already on the
    /// server (`serverId` set) unless `serverId: nil` is asked for.
    private func makeRoundModel(
        database: AppDatabase,
        serverId: String? = "srv-1",
        token: String? = nil,
        ballId: String? = nil
    ) async throws -> RoundModel {
        let record = RoundRecord(
            serverId: serverId,
            courseId: "course-1",
            startedAt: "2026-07-25T08:00:00Z",
            syncState: serverId == nil ? .pending : .synced,
            tapscoreToken: token,
            tapscoreBallId: ballId
        )
        try await database.saveRound(record)
        let model = RoundModel(courseId: "course-1", holes: holes, database: database)
        await model.loadActiveRound()
        return model
    }

    // MARK: - State from the local mirror

    func testNoRoundMeansNothingToLink() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = RoundModel(courseId: "course-1", holes: holes, database: database)
        let model = TapscoreLinkModel(roundModel: roundModel, api: FakeBridge())
        XCTAssertEqual(model.state, .noActiveRound)
    }

    func testDeviceOnlyRoundReportsItIsNotOnTheServerYet() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, serverId: nil)
        let model = TapscoreLinkModel(roundModel: roundModel, api: FakeBridge())
        XCTAssertEqual(model.state, .roundNotSynced)
    }

    func testLocalMirrorReportsLinkedWithoutTouchingTheServer() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, token: "tok-1", ballId: "ball-9")
        let bridge = FakeBridge()
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        XCTAssertEqual(model.state, .linked(ballId: "ball-9"))
        XCTAssertTrue(bridge.statusCalls.isEmpty, "the mirror is read offline, with no call")
    }

    func testRefreshFailureKeepsTheMirroredStateAndStaysSilent() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, token: "tok-1")
        let bridge = FakeBridge()
        bridge.statusResult = .failure(APIError.transport("The Internet connection appears to be offline."))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.refresh()
        XCTAssertEqual(model.state, .linked(ballId: nil), "a signal drop must not un-link the card")
        XCTAssertNil(model.failure, "an unasked-for refresh never shows a banner")
    }

    func testRefreshAdoptsTheServersAnswer() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, token: "stale")
        let bridge = FakeBridge()
        bridge.statusResult = .success(TapscoreLink(
            roundId: "srv-1", linked: false, token: nil, ballId: nil
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.refresh()
        XCTAssertEqual(model.state, .unlinked)
        XCTAssertNil(roundModel.round?.tapscoreToken, "the mirror follows the server")
    }

    // MARK: - Linking

    func testLinkSendsTheTokenAndMirrorsTheResult() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .success(TapscoreLink(
            roundId: "srv-1", linked: true, token: "abc123", ballId: "ball-7"
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: " abc123 ")

        XCTAssertEqual(bridge.linkCalls.count, 1)
        XCTAssertEqual(bridge.linkCalls.first?.roundId, "srv-1", "the SERVER round id is linked")
        XCTAssertEqual(bridge.linkCalls.first?.token, "abc123")
        XCTAssertNil(bridge.linkCalls.first?.ballId)
        XCTAssertEqual(model.state, .linked(ballId: "ball-7"))
        XCTAssertNil(model.failure)

        // Persisted, so a restart mid-round still reads "linked" offline.
        let stored = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(stored?.tapscoreToken, "abc123")
        XCTAssertEqual(stored?.tapscoreBallId, "ball-7")
        XCTAssertTrue(stored?.isTapscoreLinked == true)
        XCTAssertEqual(stored?.syncState, .synced, "the mirror never dirties the round for sync")
    }

    func testLinkingADeviceOnlyRoundExplainsItselfWithoutCallingTheServer() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, serverId: nil)
        let bridge = FakeBridge()
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123")

        XCTAssertTrue(bridge.linkCalls.isEmpty)
        XCTAssertEqual(model.state, .roundNotSynced)
        XCTAssertEqual(model.failure, .roundNotOnServer)
    }

    func testUnknownTokenIsReportedAsABadCode() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 404, message: "Tapscore round not found for token"
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "nope")

        XCTAssertEqual(model.failure, .unknownCode)
        XCTAssertFalse(model.needsBallChoice)
        XCTAssertEqual(model.state, .unlinked, "a refused link leaves the round unlinked")
    }

    func testAmbiguousBallRevealsTheBallField() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 409, message: "Tapscore round has 3 claimed balls; specify which ballId to link"
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123")

        XCTAssertEqual(model.failure?.needsBallChoice, true)
        XCTAssertTrue(model.needsBallChoice)

        // Retry with the ball the player read off Tapscore.
        bridge.linkResult = .success(TapscoreLink(
            roundId: "srv-1", linked: true, token: "abc123", ballId: "ball-2"
        ))
        await model.link(rawToken: "abc123", ballId: " ball-2 ")

        XCTAssertEqual(bridge.linkCalls.last?.ballId, "ball-2")
        XCTAssertEqual(model.state, .linked(ballId: "ball-2"))
        XCTAssertFalse(model.needsBallChoice)
        XCTAssertNil(model.failure)
    }

    // MARK: - Ball roster (picker instead of transcription)

    func testAmbiguousBallFetchesTheRosterAndOffersOnlyClaimedBalls() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 409, message: "Tapscore round has 2 claimed balls; specify which ballId to link"
        ))
        bridge.ballsResult = .success([
            TapscoreBall(id: "ball-1", label: "Marcus", pending: false),
            TapscoreBall(id: "ball-2", label: "Alex", pending: false),
            TapscoreBall(id: "ball-3", label: nil, pending: true), // unclaimed seat
        ])
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        // The player pasted the share URL — the roster must be fetched with the
        // EXTRACTED token, not the raw paste.
        await model.link(rawToken: "https://tapscore.app/r/abc123")

        XCTAssertTrue(model.needsBallChoice)
        XCTAssertEqual(bridge.ballsCalls, ["abc123"])
        XCTAssertEqual(
            model.ballChoices.map(\.id), ["ball-1", "ball-2"],
            "a pending seat is not linkable, so it is not offered"
        )

        // Picking a ball retries the link with its id.
        bridge.linkResult = .success(TapscoreLink(
            roundId: "srv-1", linked: true, token: "abc123", ballId: "ball-2"
        ))
        await model.link(rawToken: "abc123", ballId: "ball-2")

        XCTAssertEqual(bridge.linkCalls.last?.ballId, "ball-2")
        XCTAssertEqual(model.state, .linked(ballId: "ball-2"))
        XCTAssertFalse(model.needsBallChoice)
        XCTAssertTrue(model.ballChoices.isEmpty, "a successful link drops the roster")
    }

    func testRosterFetchFailureFallsBackToTheFreeTextField() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        let message = "Tapscore round has 2 claimed balls; specify which ballId to link"
        bridge.linkResult = .failure(APIError.http(status: 409, message: message))
        bridge.ballsResult = .failure(APIError.transport("The request timed out."))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123")

        XCTAssertTrue(model.needsBallChoice, "the question still stands")
        XCTAssertTrue(model.ballChoices.isEmpty, "no roster → the UI shows the ID field")
        XCTAssertEqual(
            model.failure, .ambiguousBall(serverMessage: message),
            "the roster fetch failing must not replace the ambiguous-ball message"
        )
    }

    func testOnlyTheAmbiguousBallConflictFetchesTheRoster() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 409, message: "Ball ball-2 is an unclaimed seat in Tapscore; claim it there before linking"
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123", ballId: "ball-2")

        XCTAssertTrue(bridge.ballsCalls.isEmpty, "naming a ball is not the fix here — no roster needed")
    }

    func testClearingTheBallChoiceDropsTheStaleRoster() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 409, message: "Tapscore round has 2 claimed balls; specify which ballId to link"
        ))
        bridge.ballsResult = .success([
            TapscoreBall(id: "ball-1", label: "Marcus", pending: false),
            TapscoreBall(id: "ball-2", label: "Alex", pending: false),
        ])
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123")
        XCTAssertFalse(model.ballChoices.isEmpty)

        // The player edits the code — the roster belongs to the old token.
        model.clearBallChoice()
        XCTAssertFalse(model.needsBallChoice)
        XCTAssertTrue(model.ballChoices.isEmpty)
        XCTAssertNil(model.failure)
    }

    func testFailureBannerPointsAtThePickerWhenTheRosterIsUp() {
        let ambiguous = TapscoreLinkFailure.ambiguousBall(
            serverMessage: "Tapscore round has 2 claimed balls; specify which ballId to link"
        )
        let withPicker = TapscoreLinkView.failureText(ambiguous, hasBallPicker: true)
        XCTAssertFalse(withPicker.lowercased().contains("ball id"), "the remedy is the picker, not an id")
        XCTAssertEqual(
            TapscoreLinkView.failureText(ambiguous, hasBallPicker: false),
            ambiguous.message,
            "the free-text fallback keeps the enter-the-id wording"
        )
        let offline = TapscoreLinkFailure.offline
        XCTAssertEqual(TapscoreLinkView.failureText(offline, hasBallPicker: true), offline.message)
    }

    func testUnclaimedSeatIsItsOwnMessage() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 409, message: "Ball ball-2 is an unclaimed seat in Tapscore; claim it there before linking"
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123", ballId: "ball-2")

        XCTAssertEqual(model.failure, .unclaimedSeat(serverMessage: "Ball ball-2 is an unclaimed seat in Tapscore; claim it there before linking"))
        XCTAssertFalse(model.needsBallChoice, "naming a ball is not the fix here")
    }

    func testEveryBallUnclaimedIsAlsoTheSeatMessage() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        let message = "Every ball in the Tapscore round is an unclaimed seat; claim one before linking"
        bridge.linkResult = .failure(APIError.http(status: 409, message: message))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123")

        XCTAssertEqual(model.failure, .unclaimedSeat(serverMessage: message))
    }

    /// F1 regression: a round STARTED in this screen session gets its `serverId`
    /// from the sync engine, which writes the DB row — not the model's in-memory
    /// snapshot. Before the fix the sheet stayed "not synced" forever and Link
    /// short-circuited without ever calling the server.
    func testRoundSyncedAfterTheSheetOpenedBecomesLinkable() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = RoundModel(courseId: "course-1", holes: holes, database: database)
        let started = await roundModel.startRound()
        let bridge = FakeBridge()
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)
        XCTAssertEqual(model.state, .roundNotSynced)

        // The sync engine pushes the round and stamps the ROW (RoundSync.swift).
        var pushed = try XCTUnwrap(started)
        pushed.serverId = "srv-9"
        pushed.serverVersion = 1
        pushed.syncState = .synced
        try await database.saveRound(pushed)

        await model.refresh()
        XCTAssertEqual(model.state, .unlinked, "the model adopts the row's serverId")
        XCTAssertEqual(bridge.statusCalls, ["srv-9"])

        bridge.linkResult = .success(TapscoreLink(
            roundId: "srv-9", linked: true, token: "abc123", ballId: nil
        ))
        await model.link(rawToken: "abc123")
        XCTAssertEqual(bridge.linkCalls.first?.roundId, "srv-9")
        XCTAssertEqual(model.state, .linked(ballId: nil))
    }

    /// The mirror write must not roll back a `serverId` the sync engine stamped
    /// on the row after the in-memory snapshot was taken (targeted UPDATE, not
    /// a full-row upsert).
    func testMirrorWriteDoesNotClobberTheRowsSyncFields() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = RoundModel(courseId: "course-1", holes: holes, database: database)
        let startedRound = await roundModel.startRound()
        let started = try XCTUnwrap(startedRound)

        var pushed = started
        pushed.serverId = "srv-9"
        pushed.serverVersion = 3
        pushed.syncState = .synced
        try await database.saveRound(pushed)

        // The model still holds the pre-push snapshot here.
        await roundModel.setTapscoreLink(token: "abc123", ballId: nil)

        let fetched = try await database.activeRound(courseId: "course-1")
        let stored = try XCTUnwrap(fetched)
        XCTAssertEqual(stored.serverId, "srv-9")
        XCTAssertEqual(stored.serverVersion, 3)
        XCTAssertEqual(stored.syncState, .synced)
        XCTAssertEqual(stored.tapscoreToken, "abc123")
    }

    func testOfflineLinkAttemptSaysSoAndKeepsTheRoundUnlinked() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.transport("The Internet connection appears to be offline."))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123")

        XCTAssertEqual(model.failure, .offline)
        XCTAssertEqual(model.state, .unlinked)
        XCTAssertFalse(model.isBusy)
    }

    func testEmptyCodeNeverReachesTheServer() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "   ")

        XCTAssertTrue(bridge.linkCalls.isEmpty)
        XCTAssertEqual(model.failure, .unknownCode)
    }

    // MARK: - Unlinking

    func testUnlinkClearsTheMirror() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, token: "tok-1", ballId: "ball-9")
        let bridge = FakeBridge()
        bridge.unlinkResult = .success(TapscoreLink(
            roundId: "srv-1", linked: false, token: nil, ballId: nil
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.unlink()

        XCTAssertEqual(bridge.unlinkCalls, ["srv-1"])
        XCTAssertEqual(model.state, .unlinked)
        let stored = try await database.activeRound(courseId: "course-1")
        XCTAssertNil(stored?.tapscoreToken)
        XCTAssertNil(stored?.tapscoreBallId)
    }

    func testFailedUnlinkKeepsTheLinkedMirror() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database, token: "tok-1")
        let bridge = FakeBridge()
        bridge.unlinkResult = .failure(APIError.transport("The request timed out."))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.unlink()

        XCTAssertEqual(model.failure, .offline)
        XCTAssertEqual(model.state, .linked(ballId: nil))
        XCTAssertEqual(roundModel.round?.tapscoreToken, "tok-1")
    }

    // MARK: - Token extraction

    func testExtractTokenAcceptsBareCodesAndPastedLinks() {
        XCTAssertEqual(TapscoreLinkModel.extractToken(from: "abc123"), "abc123")
        XCTAssertEqual(TapscoreLinkModel.extractToken(from: "  abc123\n"), "abc123")
        XCTAssertEqual(
            TapscoreLinkModel.extractToken(from: "https://tapscore.app/r/abc123"),
            "abc123"
        )
        XCTAssertEqual(
            TapscoreLinkModel.extractToken(from: "https://tapscore.app/join?token=abc123"),
            "abc123"
        )
        XCTAssertEqual(
            TapscoreLinkModel.extractToken(from: "https://tapscore.app/r/abc123/"),
            "abc123",
            "a trailing slash is not a token"
        )
    }

    // MARK: - Classification

    func testClassificationFollowsTheStatusContract() {
        XCTAssertEqual(
            TapscoreLinkModel.classify(APIError.unauthorized),
            .notSignedIn
        )
        XCTAssertEqual(
            TapscoreLinkModel.classify(APIError.http(status: 404, message: "Round srv-1 not found")),
            .roundNotOnServer
        )
        XCTAssertEqual(
            TapscoreLinkModel.classify(APIError.http(status: 500, message: "boom")),
            .other("boom")
        )
        // An unrecognized 409 wording still surfaces the server's own text.
        XCTAssertEqual(
            TapscoreLinkModel.classify(APIError.http(status: 409, message: "Ball nope is not part of the Tapscore round")),
            .conflict(serverMessage: "Ball nope is not part of the Tapscore round")
        )
    }

    // MARK: - Copy

    func testStatusCopyMatchesTheState() {
        XCTAssertEqual(TapscoreLinkView.summary(for: .linked(ballId: nil)), "Linked · scores syncing")
        XCTAssertEqual(TapscoreLinkView.summary(for: .unlinked), "Not linked")
        XCTAssertEqual(TapscoreLinkView.summary(for: .noActiveRound), "No active round")
        XCTAssertFalse(TapscoreLinkView.footer(for: .roundNotSynced).isEmpty)
    }
}

private extension TapscoreLink {
    static let unlinkedStub = TapscoreLink(roundId: "srv-1", linked: false, token: nil, ballId: nil)
    static let linkedStub = TapscoreLink(roundId: "srv-1", linked: true, token: "abc123", ballId: nil)
}
