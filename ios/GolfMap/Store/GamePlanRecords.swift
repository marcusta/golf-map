import Foundation
import GRDB

// MARK: - Game plan store records (schema v2)
//
// GRDB Codable records for the locally cached game plan + club bag. Like the
// bundle furniture records, these double as the Store module's input DTOs:
// the wiring layer (`GamePlanSync`) adapts the API models into these types so
// the Store stays importable without the API code. Read-only viewer — no
// server `version` columns are persisted (no optimistic-locking on device).

/// One club in the player's bag (user-level, not per course).
public struct ClubRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "club"

    public var id: String
    public var name: String
    public var carryM: Double
    public var dispersionM: Double
    public var sortOrder: Int

    public init(id: String, name: String, carryM: Double, dispersionM: Double, sortOrder: Int) {
        self.id = id
        self.name = name
        self.carryM = carryM
        self.dispersionM = dispersionM
        self.sortOrder = sortOrder
    }
}

/// The plan header row — one plan per course (the on-device store is
/// single-user). FK to `course` so deleting a bundle wipes its plan.
public struct GamePlanRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "gamePlan"

    public var id: String
    public var courseId: String
    /// Plan-level default wind.
    public var windSpeedMps: Double?
    public var windDirectionDeg: Double?

    public init(id: String, courseId: String, windSpeedMps: Double? = nil, windDirectionDeg: Double? = nil) {
        self.id = id
        self.courseId = courseId
        self.windSpeedMps = windSpeedMps
        self.windDirectionDeg = windDirectionDeg
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

    public init(
        id: String,
        gamePlanId: String,
        holeNumber: Int,
        teeId: String? = nil,
        preferredClubId: String? = nil,
        plannedDirectionDeg: Double? = nil,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        notes: String? = nil
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
    }
}

/// One planned landing point (tee→green order via `sortOrder`).
public struct PlanShotRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "planShot"

    public var id: String
    public var gamePlanHoleId: String
    public var sortOrder: Int
    public var lat: Double
    public var lon: Double
    public var elevation: Double?
    public var clubId: String?
    public var label: String?

    public init(
        id: String,
        gamePlanHoleId: String,
        sortOrder: Int,
        lat: Double,
        lon: Double,
        elevation: Double? = nil,
        clubId: String? = nil,
        label: String? = nil
    ) {
        self.id = id
        self.gamePlanHoleId = gamePlanHoleId
        self.sortOrder = sortOrder
        self.lat = lat
        self.lon = lon
        self.elevation = elevation
        self.clubId = clubId
        self.label = label
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

    public init(
        id: String,
        gamePlanHoleId: String,
        sortOrder: Int,
        lat: Double,
        lon: Double,
        directionDeg: Double,
        halfWidthLeftM: Double,
        halfWidthRightM: Double,
        source: String
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
