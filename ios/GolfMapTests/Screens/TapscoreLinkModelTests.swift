import XCTest
@testable import GolfMap

/// The Tapscore link UI's logic (T65, docs/feature-tapscore-bridge.md): what the
/// player is told on each of the contract's refusals (404 unknown token, 409
/// ball ambiguity, 409 unclaimed seat, offline), how a pasted share link reduces
/// to its token, and the local mirror that keeps a linked round reading "linked"
/// with no signal.
@MainActor
final class TapscoreLinkModelTests: XCTestCase {

    // MARK: - Fake bridge

    /// Records calls and replays a scripted answer. `@unchecked Sendable` per
    /// the suite convention — the model awaits each call in order.
    private final class FakeBridge: TapscoreLinkAPI, @unchecked Sendable {
        var statusResult: Result<TapscoreLink, any Error> = .success(.unlinkedStub)
        var linkResult: Result<TapscoreLink, any Error> = .success(.linkedStub)
        var unlinkResult: Result<TapscoreLink, any Error> = .success(.unlinkedStub)

        private(set) var linkCalls: [(roundId: String, token: String, ballId: String?)] = []
        private(set) var unlinkCalls: [String] = []
        private(set) var statusCalls: [String] = []

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
            status: 404, message: "No Tapscore round found for that token"
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
            status: 409, message: "Round has 3 claimed balls; specify ballId"
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

    func testUnclaimedSeatIsItsOwnMessage() async throws {
        let database = try AppDatabase.inMemory()
        let roundModel = try await makeRoundModel(database: database)
        let bridge = FakeBridge()
        bridge.linkResult = .failure(APIError.http(
            status: 409, message: "Ball ball-2 is an unclaimed seat"
        ))
        let model = TapscoreLinkModel(roundModel: roundModel, api: bridge)

        await model.link(rawToken: "abc123", ballId: "ball-2")

        XCTAssertEqual(model.failure, .unclaimedSeat(serverMessage: "Ball ball-2 is an unclaimed seat"))
        XCTAssertFalse(model.needsBallChoice, "naming a ball is not the fix here")
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
            TapscoreLinkModel.classify(APIError.http(status: 404, message: "Round r1 not found")),
            .roundNotOnServer
        )
        XCTAssertEqual(
            TapscoreLinkModel.classify(APIError.http(status: 500, message: "boom")),
            .other("boom")
        )
        // An unrecognized 409 wording still surfaces the server's own text.
        XCTAssertEqual(
            TapscoreLinkModel.classify(APIError.http(status: 409, message: "Ball nope is not in this round")),
            .conflict(serverMessage: "Ball nope is not in this round")
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
