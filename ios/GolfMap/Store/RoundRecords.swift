import Foundation
import GRDB

// MARK: - Round + shot records (schema v3)
//
// GRDB Codable records for on-course shot capture (docs/feature-shot-capture.md
// §2/§4). Unlike the bundle furniture and the game-plan cache, these rows are
// USER DATA captured on the device — the device is the writer and the server
// is the sink. They therefore:
//  - carry a LOCAL primary key (UUID minted on device) plus a nullable
//    `serverId` filled in once the row has been pushed;
//  - carry a `syncState` dirty-flag driving the offline queue (see
//    `RoundSyncService`);
//  - deliberately do NOT foreign-key to `course`: deleting/refreshing a course
//    bundle must never destroy recorded rounds.

/// The stroke classification from the shot-capture plan §3.
/// Only `full` swings enter dispersion fitting; all types are SG-relevant.
public enum ShotType: String, Codable, Sendable, CaseIterable {
    case full
    case partial
    case putt
    case recovery

    /// Display label for pickers.
    public var label: String {
        switch self {
        case .full: return "Full"
        case .partial: return "Partial"
        case .putt: return "Putt"
        case .recovery: return "Recovery"
        }
    }
}

/// Dirty-flag sync lifecycle of a locally captured row.
///
/// Chosen over an append-only ops queue: rounds/shots are simple entities with
/// per-entity server endpoints (add/update/remove), so the ROW ITSELF is the
/// single source of truth and the flag says what the server still needs. No
/// replay ordering, no op compaction (five penalty taps = one dirty row, one
/// update call). The one thing a dirty flag can't express — deletion — gets a
/// tombstone state; the row is hard-deleted only after the server confirms.
public enum RoundSyncState: String, Codable, Sendable {
    /// Created locally; the server has never seen it.
    case pending
    /// Exists on the server (`serverId` set) but has local edits to push.
    case dirty
    /// Server and device agree.
    case synced
    /// Deleted locally; awaiting server delete (tombstone). Rows with a nil
    /// `serverId` skip this state and are hard-deleted immediately.
    case deleted
}

/// One recorded round. `endedAt == nil` marks the ACTIVE round — at most one
/// per course is created by `AppDatabase.activeRound` callers, and resuming
/// after an app restart is just re-reading that row.
public struct RoundRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "round"

    /// Local UUID primary key (minted at capture time, offline).
    public var id: String
    /// Server row id once `rounds/start` succeeded; nil while offline.
    public var serverId: String?
    public var courseId: String
    /// ISO-8601 timestamps (server string convention).
    public var startedAt: String
    public var endedAt: String?
    /// Plan-vs-actual link + round-level wind snapshot, captured at start.
    public var gamePlanId: String?
    public var windSpeedMps: Double?
    public var windDirectionDeg: Double?
    /// Server optimistic-lock version from the last sync response.
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String = UUID().uuidString,
        serverId: String? = nil,
        courseId: String,
        startedAt: String,
        endedAt: String? = nil,
        gamePlanId: String? = nil,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .pending
    ) {
        self.id = id
        self.serverId = serverId
        self.courseId = courseId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.gamePlanId = gamePlanId
        self.windSpeedMps = windSpeedMps
        self.windDirectionDeg = windDirectionDeg
        self.serverVersion = serverVersion
        self.syncState = syncState
    }
}

/// One stroke, recorded AT the position it was played FROM (§2 — the landing
/// of stroke *i* is the position of stroke *i+1*; the last stroke on a hole
/// lands in the cup). Penalties are not rows: `penaltyStrokes` counts strokes
/// added as a consequence of THIS stroke (OB, water, unplayable).
public struct ShotRecord: Codable, Sendable, Equatable, Identifiable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "shot"

    /// Local UUID primary key.
    public var id: String
    /// Server row id once `rounds/shots/add` succeeded.
    public var serverId: String?
    /// FK to the LOCAL round row (cascade).
    public var roundId: String
    public var holeNumber: Int
    /// Local stroke order within (round, hole) — 0-based append order.
    public var sortOrder: Int
    public var lat: Double
    public var lon: Double
    /// SERVER club id (the cached bag mirrors server ids), nil for putts /
    /// no-club strokes.
    public var clubId: String?
    public var shotType: ShotType
    /// Intended target at address (defaulted from pin/plan/green center —
    /// the dispersion-fitting frame; see plan §3).
    public var targetLat: Double?
    public var targetLon: Double?
    public var penaltyStrokes: Int
    /// ISO-8601 capture timestamp; also the cross-hole sync order.
    public var recordedAt: String
    public var serverVersion: Int?
    public var syncState: RoundSyncState

    public init(
        id: String = UUID().uuidString,
        serverId: String? = nil,
        roundId: String,
        holeNumber: Int,
        sortOrder: Int,
        lat: Double,
        lon: Double,
        clubId: String? = nil,
        shotType: ShotType = .full,
        targetLat: Double? = nil,
        targetLon: Double? = nil,
        penaltyStrokes: Int = 0,
        recordedAt: String,
        serverVersion: Int? = nil,
        syncState: RoundSyncState = .pending
    ) {
        self.id = id
        self.serverId = serverId
        self.roundId = roundId
        self.holeNumber = holeNumber
        self.sortOrder = sortOrder
        self.lat = lat
        self.lon = lon
        self.clubId = clubId
        self.shotType = shotType
        self.targetLat = targetLat
        self.targetLon = targetLon
        self.penaltyStrokes = penaltyStrokes
        self.recordedAt = recordedAt
        self.serverVersion = serverVersion
        self.syncState = syncState
    }

    public var target: LatLon? {
        guard let targetLat, let targetLon else { return nil }
        return LatLon(lat: targetLat, lon: targetLon)
    }

    public var position: LatLon { LatLon(lat: lat, lon: lon) }
}
