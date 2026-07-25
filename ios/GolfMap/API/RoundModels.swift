import Foundation

// MARK: - Rounds API models
//
// Transcribed from `shared/api/rounds.gen.ts` response shapes (camelCase
// JSON, no CodingKeys). The iOS app captures rounds/shots offline and pushes
// them through `rounds/start`, `rounds/end`, `rounds/shots/add|update|remove`
// — only the shapes those endpoints return live here.

/// A round row: `POST /api/rounds/start` and `POST /api/rounds/end` response.
public struct Round: Codable, Sendable, Equatable {
    public let id: String
    public let courseId: String
    public let userId: String?
    public let startedAt: String
    public let endedAt: String?
    public let notes: String?
    public let gamePlanId: String?
    public let windSpeedMps: Double?
    public let windDirectionDeg: Double?
    public let stimpFt: Double?
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}

/// The Tapscore scoring-bridge link of one round — the response of
/// `GET/POST /api/rounds/tapscore-link` and `POST /api/rounds/tapscore-unlink`
/// (`shared/api/tapscore-bridge.gen.ts`, `TapscoreLinkStatus`).
///
/// Linking is the ONLY thing a client does: once a round carries a token, the
/// server's shot-write hook publishes per-hole gross strokes automatically
/// (docs/feature-tapscore-bridge.md §3.2). There is no sync endpoint to call.
public struct TapscoreLink: Codable, Sendable, Equatable {
    public let roundId: String
    public let linked: Bool
    /// The Tapscore friendly-round share token; nil when unlinked.
    public let token: String?
    /// Which Tapscore ball (scorecard column) the scores land on; nil when unlinked.
    public let ballId: String?

    public init(roundId: String, linked: Bool, token: String?, ballId: String?) {
        self.roundId = roundId
        self.linked = linked
        self.token = token
        self.ballId = ballId
    }
}

/// One ball (scorecard column) of a Tapscore round — an element of the
/// `GET /api/rounds/tapscore-balls` response (`shared/api/tapscore-bridge.gen.ts`,
/// `TapscoreBall`). Fetched by share token at link time so an ambiguous-ball
/// 409 can offer a picker instead of asking the player to transcribe an id.
public struct TapscoreBall: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// Player name as Tapscore shows it; nil for an unnamed seat.
    public let label: String?
    /// True iff the ball is an unclaimed placeholder seat (not linkable).
    public let pending: Bool

    public init(id: String, label: String?, pending: Bool) {
        self.id = id
        self.label = label
        self.pending = pending
    }
}

/// A shot row: `POST /api/rounds/shots/add` and `/update` response.
public struct Shot: Codable, Sendable, Equatable {
    public let id: String
    public let roundId: String
    public let holeNumber: Int
    public let sortOrder: Int
    public let lat: Double
    public let lon: Double
    public let clubId: String?
    public let lie: String?
    /// Raw server string ('full' | 'partial' | 'putt' | 'recovery').
    public let shotType: String
    public let targetLat: Double?
    public let targetLon: Double?
    public let penaltyStrokes: Int
    public let recordedAt: String
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}
