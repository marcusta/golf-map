import Foundation

// MARK: - Game plan API models
//
// Transcribed from `shared/api/game-plans.gen.ts` and `shared/api/clubs.gen.ts`
// response shapes (camelCase JSON, no CodingKeys needed). These are the RESPONSE
// shapes; the write requests live in `GolfAPIClient` (the device edits shots and
// wind on course — plan structure beyond that is still built on the web).

/// A wind PATCH for the plan / plan-hole write endpoints.
///
/// The server patches only the wind keys present in the request body, so the
/// three states are distinct and all reachable:
///  - no patch at all (nil `PlanWindPatch`) — leave the server's wind alone;
///  - a patch with values — set that wind;
///  - a patch of nils (`.calm`) — write JSON null, i.e. clear the wind (calm
///    on a plan, "inherit the plan wind" on a hole).
public struct PlanWindPatch: Sendable, Equatable {
    public let speedMps: Double?
    public let directionDeg: Double?

    public init(speedMps: Double?, directionDeg: Double?) {
        self.speedMps = speedMps
        self.directionDeg = directionDeg
    }

    /// Clear the wind (plan → calm, hole → inherit the plan's wind).
    public static let calm = PlanWindPatch(speedMps: nil, directionDeg: nil)

    /// Writes both wind keys into `container` — as numbers, or as explicit
    /// JSON nulls when the patch clears the wind.
    func encode<Key: CodingKey>(
        into container: inout KeyedEncodingContainer<Key>,
        speed speedKey: Key,
        direction directionKey: Key
    ) throws {
        if let speedMps {
            try container.encode(speedMps, forKey: speedKey)
        } else {
            try container.encodeNil(forKey: speedKey)
        }
        if let directionDeg {
            try container.encode(directionDeg, forKey: directionKey)
        } else {
            try container.encodeNil(forKey: directionKey)
        }
    }
}

/// Where a newly added shot attaches in the hole's shot TREE.
///
/// The add endpoint distinguishes an absent `parentShotId` from an explicit
/// null, so the three cases are separate values rather than one `String?`:
///  - `.shot(id)` — a continuation of that shot;
///  - `.root` — a new root option (explicit JSON null);
///  - `.primaryLineTail` — let the SERVER pick (key omitted); only for callers
///    that genuinely don't know the tree, which the sync engine never is.
public enum PlanShotParent: Sendable, Equatable {
    case shot(String)
    case root
    case primaryLineTail
}

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

/// One planned landing point in the option tree. `sortOrder` is the rank
/// within one sibling group; rank 0 is the primary choice.
public struct PlanShot: Codable, Sendable, Equatable {
    public let id: String
    public let gamePlanHoleId: String
    public let sortOrder: Int
    /// Parent in the plan tree; nil is a tee-root option. Older servers omit
    /// the field entirely, which `GamePlanSync` recognises via
    /// `parentShotIdWasPresent` and upgrades as a legacy linear chain.
    public let parentShotId: String?
    public let lat: Double
    public let lon: Double
    public let elevation: Double?
    /// Club planned to REACH this landing point (id into the clubs list).
    public let clubId: String?
    public let label: String?
    public let version: Int

    /// Decoding compatibility bit. An explicit JSON null is a real root;
    /// absence means the whole old response used linear `sortOrder` semantics.
    let parentShotIdWasPresent: Bool

    private enum CodingKeys: String, CodingKey {
        case id, gamePlanHoleId, sortOrder, parentShotId, lat, lon
        case elevation, clubId, label, version
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        gamePlanHoleId = try values.decode(String.self, forKey: .gamePlanHoleId)
        sortOrder = try values.decode(Int.self, forKey: .sortOrder)
        parentShotIdWasPresent = values.contains(.parentShotId)
        parentShotId = try values.decodeIfPresent(String.self, forKey: .parentShotId)
        lat = try values.decode(Double.self, forKey: .lat)
        lon = try values.decode(Double.self, forKey: .lon)
        elevation = try values.decodeIfPresent(Double.self, forKey: .elevation)
        clubId = try values.decodeIfPresent(String.self, forKey: .clubId)
        label = try values.decodeIfPresent(String.self, forKey: .label)
        version = try values.decode(Int.self, forKey: .version)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(gamePlanHoleId, forKey: .gamePlanHoleId)
        try values.encode(sortOrder, forKey: .sortOrder)
        if parentShotIdWasPresent {
            try values.encode(parentShotId, forKey: .parentShotId)
        }
        try values.encode(lat, forKey: .lat)
        try values.encode(lon, forKey: .lon)
        try values.encodeIfPresent(elevation, forKey: .elevation)
        try values.encodeIfPresent(clubId, forKey: .clubId)
        try values.encodeIfPresent(label, forKey: .label)
        try values.encode(version, forKey: .version)
    }
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
