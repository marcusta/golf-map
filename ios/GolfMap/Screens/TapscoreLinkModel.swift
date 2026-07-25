import Foundation
import Observation

/// The subset of `GolfAPIClient` the Tapscore link UI needs, so the model can
/// be exercised without a URL session.
public protocol TapscoreLinkAPI: Sendable {
    func tapscoreLink(roundId: String) async throws -> TapscoreLink
    func linkTapscore(roundId: String, token: String, ballId: String?) async throws -> TapscoreLink
    func unlinkTapscore(roundId: String) async throws -> TapscoreLink
    func tapscoreBalls(token: String) async throws -> [TapscoreBall]
}

extension GolfAPIClient: TapscoreLinkAPI {}

/// Why a link attempt could not be completed, in the user's terms.
///
/// The server states the *rule* (docs/feature-tapscore-bridge.md §3.1); this
/// translates it into what the player can actually do about it. Classification
/// is by HTTP status FIRST (404/409 are the contract) and refined by the
/// message only to pick the right remedy — so an unrecognized wording still
/// surfaces the server's own text rather than a shrug.
public enum TapscoreLinkFailure: Equatable, Sendable {
    /// The request never reached the server. Linking is the one bridge action
    /// that needs connectivity — scores themselves publish server-side.
    case offline
    /// 404: the share code matches no Tapscore round.
    case unknownCode
    /// 404: this round has not been created on the golf-map server yet.
    case roundNotOnServer
    /// 409: several claimed balls — the player must say which one.
    case ambiguousBall(serverMessage: String)
    /// 409: the chosen ball is an unclaimed seat; Tapscore refuses to score it.
    case unclaimedSeat(serverMessage: String)
    /// 409: any other ball-resolution refusal (e.g. unknown ball id).
    case conflict(serverMessage: String)
    /// The session expired.
    case notSignedIn
    /// Anything else (5xx, Tapscore unreachable from the server, decode error).
    /// The payload is DIAGNOSTIC — it is logged, never shown: raw server text
    /// or a Swift error dump is noise to a player standing on a tee.
    case other(String)

    public var message: String {
        switch self {
        case .offline:
            return "No connection. Linking needs the server — scores keep recording offline and you can link later."
        case .unknownCode:
            return "No Tapscore round matches that code. Check the share link and try again."
        case .roundNotOnServer:
            return "This round hasn't reached the server yet. Reconnect so it syncs, then link."
        case let .ambiguousBall(serverMessage):
            return "That Tapscore round has more than one player. Enter the ball ID to score into. (\(serverMessage))"
        case let .unclaimedSeat(serverMessage):
            return "That player slot isn't claimed in Tapscore yet — claim it there first, otherwise scores would never arrive. (\(serverMessage))"
        case let .conflict(serverMessage):
            return serverMessage
        case .notSignedIn:
            return "Signed out. Sign in again to link this round."
        case .other:
            return "Tapscore didn't answer. Try again in a moment — scores keep recording either way."
        }
    }

    /// Diagnostic text for the log, when there is any.
    public var diagnostic: String? {
        if case let .other(detail) = self { return detail }
        return nil
    }

    /// Whether the UI should ask which ball to score into (the roster picker,
    /// or the free-text ID field when the roster couldn't be fetched).
    public var needsBallChoice: Bool {
        if case .ambiguousBall = self { return true }
        return false
    }
}

/// Backs the "Link to Tapscore round" UI on a round.
///
/// Division of labour (docs/feature-tapscore-bridge.md): this model manages the
/// **link only**. Once a round carries a token the server's shot-write hook
/// publishes per-hole gross strokes by itself, off the write path — there is no
/// score push to trigger and nothing to retry from the device.
///
/// Offline behaviour: link/unlink/status all need the network, so the local
/// round row mirrors the last known link (`RoundRecord.tapscoreToken`). That
/// mirror is what the scorecard renders when a refresh can't reach the server,
/// so a linked round still reads "linked" in the middle of a course with no
/// signal; a refresh failure is silently tolerated rather than shown as an
/// error, while a deliberate link/unlink tap reports it.
@MainActor
@Observable
final class TapscoreLinkModel {

    /// What the UI should render.
    enum State: Equatable, Sendable {
        /// No round is running — nothing to link.
        case noActiveRound
        /// The round exists only on this device; the server must see it first.
        case roundNotSynced
        /// Known (or last known) to be unlinked.
        case unlinked
        /// Linked; scores publish automatically.
        case linked(ballId: String?)
    }

    private let roundModel: RoundModel
    @ObservationIgnored private let api: any TapscoreLinkAPI

    /// Last known link state, seeded from the local mirror so it is correct
    /// offline and refined by `refresh()` when the server answers.
    private(set) var state: State = .noActiveRound
    /// True while a link/unlink/refresh call is in flight.
    private(set) var isBusy = false
    /// Set by the last deliberate action; cleared on the next attempt.
    private(set) var failure: TapscoreLinkFailure?
    /// True when the server asked which ball to score into — the UI reveals the
    /// ball picker (or the ball-ID field when the roster couldn't be fetched).
    /// Sticky until a successful link or an explicit reset.
    private(set) var needsBallChoice = false
    /// The claimed balls of the token's round, fetched after an ambiguous-ball
    /// 409 so the player picks a name instead of transcribing an id. Empty when
    /// the roster fetch failed — the UI then falls back to the free-text field.
    private(set) var ballChoices: [TapscoreBall] = []

    init(roundModel: RoundModel, api: any TapscoreLinkAPI) {
        self.roundModel = roundModel
        self.api = api
        self.state = Self.localState(of: roundModel.round)
    }

    /// The active round's SERVER id, or nil while the round is device-only.
    private var serverRoundId: String? { roundModel.round?.serverId }

    /// Recomputes `state` from the local round, first adopting a `serverId` the
    /// sync engine may have assigned since the round was started — that write
    /// lands on the DB row, not on the screen's in-memory snapshot, so without
    /// this a round started in the current session would read as "not on the
    /// server" for as long as the screen stays open. No network.
    func syncFromLocalRound() async {
        await roundModel.adoptSyncedIdentity()
        state = Self.localState(of: roundModel.round)
    }

    private static func localState(of round: RoundRecord?) -> State {
        guard let round else { return .noActiveRound }
        if let token = round.tapscoreToken, !token.isEmpty {
            return .linked(ballId: round.tapscoreBallId)
        }
        return round.serverId == nil ? .roundNotSynced : .unlinked
    }

    // MARK: - Actions

    /// Refreshes the link from the server. Best effort: a failure leaves the
    /// locally mirrored state alone and reports nothing — the player did not
    /// ask for this, and a mid-course signal drop is not an error worth a
    /// banner. Only the server's *authoritative* answer overwrites the mirror.
    func refresh() async {
        await syncFromLocalRound()
        guard let roundId = serverRoundId, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        guard let link = try? await api.tapscoreLink(roundId: roundId) else { return }
        await apply(link)
    }

    /// Links the active round. `rawToken` may be a bare share code or a pasted
    /// Tapscore share URL. `ballId` is only needed after an ambiguous-ball 409.
    func link(rawToken: String, ballId: String? = nil) async {
        failure = nil
        // The round may have been pushed since the sheet opened; the serverId
        // that push assigned lives on the DB row (see `adoptSyncedIdentity`).
        await roundModel.adoptSyncedIdentity()
        guard let round = roundModel.round else {
            state = .noActiveRound
            return
        }
        guard let roundId = round.serverId else {
            state = .roundNotSynced
            failure = .roundNotOnServer
            return
        }
        let token = Self.extractToken(from: rawToken)
        guard !token.isEmpty else {
            failure = .unknownCode
            return
        }
        let ball = ballId?.trimmingCharacters(in: .whitespacesAndNewlines)

        isBusy = true
        defer { isBusy = false }
        do {
            let link = try await api.linkTapscore(
                roundId: roundId,
                token: token,
                ballId: (ball?.isEmpty == false) ? ball : nil
            )
            await apply(link)
            needsBallChoice = false
            ballChoices = []
        } catch {
            let classified = Self.report(error)
            failure = classified
            if classified.needsBallChoice {
                needsBallChoice = true
                await loadBallChoices(token: token)
            }
        }
    }

    /// Fetches the token round's roster so the ambiguous-ball retry is a pick,
    /// not a transcription. Pending (unclaimed) seats are dropped — the server
    /// refuses to link them, so offering one would only manufacture the next
    /// 409. Best effort: a fetch failure leaves `ballChoices` empty and the UI
    /// falls back to the free-text field; the ambiguous-ball failure already
    /// on screen stays the message.
    private func loadBallChoices(token: String) async {
        let roster = (try? await api.tapscoreBalls(token: token)) ?? []
        ballChoices = roster.filter { !$0.pending }
    }

    /// Unlinks the active round. Scores already published stay in Tapscore —
    /// golf-map simply stops writing (§6, "deletion is one-way").
    func unlink() async {
        failure = nil
        guard let roundId = serverRoundId else {
            state = Self.localState(of: roundModel.round)
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let link = try await api.unlinkTapscore(roundId: roundId)
            await apply(link)
            needsBallChoice = false
            ballChoices = []
        } catch {
            failure = Self.report(error)
        }
    }

    /// `classify` plus the log line for the diagnostics it deliberately hides.
    private static func report(_ error: any Error) -> TapscoreLinkFailure {
        let classified = classify(error)
        if let diagnostic = classified.diagnostic {
            print("Tapscore link failed: \(diagnostic)")
        }
        return classified
    }

    /// Drops a stale ball-choice prompt (e.g. the player typed a new code —
    /// the fetched roster belongs to the old token).
    func clearBallChoice() {
        needsBallChoice = false
        ballChoices = []
        failure = nil
    }

    /// Writes the server's answer into the local mirror and the rendered state.
    private func apply(_ link: TapscoreLink) async {
        let token = link.linked ? link.token : nil
        let ballId = link.linked ? link.ballId : nil
        await roundModel.setTapscoreLink(token: token, ballId: ballId)
        state = link.linked ? .linked(ballId: ballId) : .unlinked
    }

    // MARK: - Pure helpers (unit-tested)

    /// A pasted Tapscore share link reduces to its token; anything else is
    /// trimmed and used as-is. Players share the URL far more often than the
    /// bare code, and typing the code out of a URL by hand is exactly the kind
    /// of transcription this should absorb.
    static func extractToken(from raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("/") || trimmed.contains("?") else { return trimmed }
        if let components = URLComponents(string: trimmed) {
            if let queryToken = components.queryItems?.first(where: { $0.name == "token" })?.value,
               !queryToken.isEmpty {
                return queryToken
            }
            let lastPathSegment = components.path
                .split(separator: "/")
                .last
                .map(String.init) ?? ""
            if !lastPathSegment.isEmpty { return lastPathSegment }
        }
        return trimmed
            .split(separator: "/")
            .last
            .map { String($0.split(separator: "?").first ?? $0) } ?? trimmed
    }

    /// Maps an API error to the failure the player sees. Status first (the
    /// contract), message only to choose between the two 404s / three 409s.
    static func classify(_ error: any Error) -> TapscoreLinkFailure {
        guard let apiError = error as? APIError else {
            return .other(String(describing: error))
        }
        switch apiError {
        case .transport:
            return .offline
        case .unauthorized:
            return .notSignedIn
        case let .decoding(detail):
            return .other(detail)
        case let .http(status, message):
            let text = message ?? ""
            let lowered = text.lowercased()
            switch status {
            case 404:
                // "Tapscore round not found for token" vs "Round <id> not found".
                return lowered.contains("token") ? .unknownCode : .roundNotOnServer
            case 409:
                // Verbatim wordings live in
                // server/services/tapscore-bridge.service.ts (resolveBallId);
                // the unclaimed-seat check runs FIRST so a ball id that happens
                // to contain "ballid" can't steal the ambiguous branch.
                if lowered.contains("unclaimed seat") {
                    return .unclaimedSeat(serverMessage: text)
                }
                if lowered.contains("ballid") || lowered.contains("claimed balls") {
                    return .ambiguousBall(serverMessage: text)
                }
                return .conflict(serverMessage: text.isEmpty ? "Tapscore refused the link." : text)
            default:
                return .other(text.isEmpty ? "HTTP \(status)" : text)
            }
        }
    }
}
