import Foundation

// MARK: - Game plan API models
//
// Transcribed from `shared/api/game-plans.gen.ts` and `shared/api/clubs.gen.ts`
// response shapes (camelCase JSON, no CodingKeys needed). The iOS app is a
// READ-ONLY viewer of plans built on the web — only the GET shapes exist here.

/// A player's full game plan for one course:
/// `GET /api/game-plans/by-course` (returns the object or JSON `null`).
public struct GamePlan: Codable, Sendable, Equatable {
    public let id: String
    public let courseId: String
    public let userId: String?
    /// Plan-level default wind (m/s + direction the wind blows FROM, degrees).
    public let windSpeedMps: Double?
    public let windDirectionDeg: Double?
    public let holes: [GamePlanHole]
    public let version: Int
}

/// Per-hole plan data nested inside `GamePlan`.
public struct GamePlanHole: Codable, Sendable, Equatable {
    public let id: String
    public let gamePlanId: String
    public let holeNumber: Int
    public let teeId: String?
    public let preferredClubId: String?
    public let plannedDirectionDeg: Double?
    /// Per-hole wind override (falls back to the plan-level wind when nil).
    public let windSpeedMps: Double?
    public let windDirectionDeg: Double?
    public let notes: String?
    public let shots: [PlanShot]
    public let gates: [PlanGate]
    public let version: Int
}

/// One planned landing point (in tee→green order via `sortOrder`).
public struct PlanShot: Codable, Sendable, Equatable {
    public let id: String
    public let gamePlanHoleId: String
    public let sortOrder: Int
    public let lat: Double
    public let lon: Double
    public let elevation: Double?
    /// Club planned to REACH this landing point (id into the clubs list).
    public let clubId: String?
    public let label: String?
    public let version: Int
}

/// One target gate: a corridor cross-line at (lat, lon), perpendicular to
/// `directionDeg` (the direction of play), extending `halfWidthLeftM` to the
/// left and `halfWidthRightM` to the right of the line of play.
public struct PlanGate: Codable, Sendable, Equatable {
    public let id: String
    public let gamePlanHoleId: String
    public let lat: Double
    public let lon: Double
    public let directionDeg: Double
    public let halfWidthLeftM: Double
    public let halfWidthRightM: Double
    /// `manual` or `computed` — kept as a raw string; the viewer renders both
    /// the same and must not break on new sources.
    public let source: String
    public let sortOrder: Int
    public let version: Int
}

// MARK: - Clubs

/// One club in the player's bag: `GET /api/clubs`. The viewer only needs the
/// id → name mapping (plan shots reference clubs by id), but the carry /
/// dispersion figures ride along for future use.
public struct Club: Codable, Sendable, Equatable {
    public let id: String
    public let userId: String?
    public let name: String
    public let carryM: Double
    public let dispersionM: Double
    public let sortOrder: Int
    public let version: Int
}
