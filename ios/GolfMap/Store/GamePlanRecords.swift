import Foundation
import GRDB

// MARK: - Game plan store records (schema v2 + v5 write columns)
//
// GRDB Codable records for the locally cached game plan + club bag. Like the
// bundle furniture records, these double as the Store module's input DTOs:
// the wiring layer (`GamePlanSync`) adapts the API models into these types so
// the Store stays importable without the API code.
//
// v5 (task T3) makes the plan tree WRITABLE on device — the on-course planner
// tool edits shots offline. The plan/hole/shot rows therefore carry the same
// dirty-flag machinery as rounds (`RoundSyncState`): a nullable `serverId`
// (server rows use their server id as the local `id`; device-created rows mint
// a local UUID and fill `serverId` once pushed), the server optimistic-lock
// `serverVersion`, and a `syncState`. Internal FK links (`gamePlanId`,
// `gamePlanHoleId`) always use the LOCAL `id`. Gates stay view-only in T3 —
// they carry the columns for schema uniformity but are never marked dirty.

/// One club in the player's bag (user-level, not per course).
///
/// v6 (task T4) makes the bag WRITABLE on device — the club-settings screen
/// edits carry/dispersion/name/order offline. Carries the same dirty-flag
/// columns as the plan tree: server-originated rows use their server id as
/// the local `id` and stamp `serverId`/`serverVersion`/`syncState: .synced`;
/// device-created clubs mint a local UUID with `serverId == nil` until
/// pushed. The bag's *order* is tracked separately in `clubOrderState` since
/// the server only exposes a whole-list `reorder` call, not a per-row one.
public struct ClubRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "club"

    public var id: String
    public var name: String
    public var carryM: Double
    public var dispersionM: Double
    public var sortOrder: Int
    public var serverId: String?
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String,
        name: String,
        carryM: Double,
        dispersionM: Double,
        sortOrder: Int,
        serverId: String? = nil,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .synced
    ) {
        self.id = id
        self.name = name
        self.carryM = carryM
        self.dispersionM = dispersionM
        self.sortOrder = sortOrder
        self.serverId = serverId
        self.serverVersion = serverVersion
        self.syncState = syncState
    }
}

/// Singleton flag: does the local club bag's order (sortOrder columns)
/// diverge from the last order the server was told about? A separate concern
/// from any individual club row's create/update/delete state, because the
/// server's `/clubs/reorder` endpoint takes the whole ordered id list rather
/// than a per-row patch. Always row id 1.
public struct ClubOrderStateRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "clubOrderState"

    public var id: Int
    public var dirty: Bool

    public init(id: Int = 1, dirty: Bool) {
        self.id = id
        self.dirty = dirty
    }
}

/// The plan header row — one plan per course (the on-device store is
/// single-user). FK to `course`; downloaded-data removal keeps the course and
/// therefore preserves its plan.
public struct GamePlanRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "gamePlan"

    public var id: String
    public var courseId: String
    /// Plan-level default wind.
    public var windSpeedMps: Double?
    public var windDirectionDeg: Double?
    /// Server row id once the plan has been pushed; for server-originated rows
    /// it equals `id`. Nil while a locally lazy-created plan is unpushed.
    public var serverId: String?
    /// Server optimistic-lock version from the last sync response.
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String,
        courseId: String,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        serverId: String? = nil,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .synced
    ) {
        self.id = id
        self.courseId = courseId
        self.windSpeedMps = windSpeedMps
        self.windDirectionDeg = windDirectionDeg
        self.serverId = serverId
        self.serverVersion = serverVersion
        self.syncState = syncState
    }
}

/// Per-hole plan row (keyed by hole NUMBER — plans reference holes by number,
/// not by the bundle's hole ids).
public struct GamePlanHoleRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "gamePlanHole"

    public var id: String
    public var gamePlanId: String
    public var holeNumber: Int
    public var teeId: String?
    public var preferredClubId: String?
    public var plannedDirectionDeg: Double?
    public var windSpeedMps: Double?
    public var windDirectionDeg: Double?
    public var notes: String?
    public var serverId: String?
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String,
        gamePlanId: String,
        holeNumber: Int,
        teeId: String? = nil,
        preferredClubId: String? = nil,
        plannedDirectionDeg: Double? = nil,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        notes: String? = nil,
        serverId: String? = nil,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .synced
    ) {
        self.id = id
        self.gamePlanId = gamePlanId
        self.holeNumber = holeNumber
        self.teeId = teeId
        self.preferredClubId = preferredClubId
        self.plannedDirectionDeg = plannedDirectionDeg
        self.windSpeedMps = windSpeedMps
        self.windDirectionDeg = windDirectionDeg
        self.notes = notes
        self.serverId = serverId
        self.serverVersion = serverVersion
        self.syncState = syncState
    }
}

/// One planned landing point in the option tree. `sortOrder` is sibling rank;
/// `parentShotId == nil` is a tee-root option.
public struct PlanShotRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "planShot"

    public var id: String
    public var gamePlanHoleId: String
    public var sortOrder: Int
    public var parentShotId: String?
    public var lat: Double
    public var lon: Double
    public var elevation: Double?
    public var clubId: String?
    public var label: String?
    public var serverId: String?
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String,
        gamePlanHoleId: String,
        sortOrder: Int,
        parentShotId: String? = nil,
        lat: Double,
        lon: Double,
        elevation: Double? = nil,
        clubId: String? = nil,
        label: String? = nil,
        serverId: String? = nil,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .synced
    ) {
        self.id = id
        self.gamePlanHoleId = gamePlanHoleId
        self.sortOrder = sortOrder
        self.parentShotId = parentShotId
        self.lat = lat
        self.lon = lon
        self.elevation = elevation
        self.clubId = clubId
        self.label = label
        self.serverId = serverId
        self.serverVersion = serverVersion
        self.syncState = syncState
    }
}

/// One target gate: a cross-line at (lat, lon) perpendicular to
/// `directionDeg`, `halfWidthLeftM` to the left / `halfWidthRightM` to the
/// right of the line of play.
public struct PlanGateRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "planGate"

    public var id: String
    public var gamePlanHoleId: String
    public var sortOrder: Int
    public var lat: Double
    public var lon: Double
    public var directionDeg: Double
    public var halfWidthLeftM: Double
    public var halfWidthRightM: Double
    /// `manual` / `computed` (raw server string).
    public var source: String
    public var serverId: String?
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String,
        gamePlanHoleId: String,
        sortOrder: Int,
        lat: Double,
        lon: Double,
        directionDeg: Double,
        halfWidthLeftM: Double,
        halfWidthRightM: Double,
        source: String,
        serverId: String? = nil,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .synced
    ) {
        self.id = id
        self.gamePlanHoleId = gamePlanHoleId
        self.sortOrder = sortOrder
        self.lat = lat
        self.lon = lon
        self.directionDeg = directionDeg
        self.halfWidthLeftM = halfWidthLeftM
        self.halfWidthRightM = halfWidthRightM
        self.source = source
        self.serverId = serverId
        self.serverVersion = serverVersion
        self.syncState = syncState
    }
}

/// Everything that goes into GRDB for one course's game plan (the plan
/// counterpart of `CourseFurniture`).
public struct StoredGamePlan: Sendable, Equatable {
    public var plan: GamePlanRecord
    public var holes: [GamePlanHoleRecord]
    public var shots: [PlanShotRecord]
    public var gates: [PlanGateRecord]

    public init(
        plan: GamePlanRecord,
        holes: [GamePlanHoleRecord],
        shots: [PlanShotRecord],
        gates: [PlanGateRecord]
    ) {
        self.plan = plan
        self.holes = holes
        self.shots = shots
        self.gates = gates
    }
}
