import Foundation
import GRDB

// MARK: - Game-plan edit store (schema v5 writes)
//
// The writable side of the game-plan tree (task T3). Like `RoundStore`, every
// write here is LOCAL-FIRST: the planner tool mutates a row and returns; pushing
// to the server is `PlanSyncService`'s separate job, driven by the `syncState`
// flags these methods maintain. A failed network never touches this layer.
//
// LAZY CREATION mirrors the web planner: the first edit on a course with no
// server plan lazily creates a local `gamePlan` row (`.pending`), and the first
// edit on a hole lazily creates its `gamePlanHole` row (`.pending`). Both fill
// their `serverId` once `PlanSyncService` pushes them (plan upsert → set-hole).
extension AppDatabase {

    // MARK: - Lazy row creation

    /// The course's plan row, creating a `.pending` local one if none exists.
    /// The lazily-created plan has a local UUID id and no server id yet.
    public func ensurePlanRow(courseId: String) async throws -> GamePlanRecord {
        try await dbQueue.write { db in
            if let existing = try GamePlanRecord
                .filter(Column("courseId") == courseId)
                .fetchOne(db) {
                return existing
            }
            let record = GamePlanRecord(
                id: UUID().uuidString,
                courseId: courseId,
                syncState: .pending
            )
            try record.insert(db)
            return record
        }
    }

    /// The plan's hole row for `holeNumber`, creating a `.pending` local one if
    /// none exists.
    public func ensurePlanHoleRow(gamePlanId: String, holeNumber: Int) async throws -> GamePlanHoleRecord {
        try await dbQueue.write { db in
            if let existing = try GamePlanHoleRecord
                .filter(Column("gamePlanId") == gamePlanId && Column("holeNumber") == holeNumber)
                .fetchOne(db) {
                return existing
            }
            let record = GamePlanHoleRecord(
                id: UUID().uuidString,
                gamePlanId: gamePlanId,
                holeNumber: holeNumber,
                syncState: .pending
            )
            try record.insert(db)
            return record
        }
    }

    // MARK: - Writes

    public func savePlanRecord(_ record: GamePlanRecord) async throws {
        try await dbQueue.write { db in try record.save(db) }
    }

    public func savePlanHole(_ record: GamePlanHoleRecord) async throws {
        try await dbQueue.write { db in try record.save(db) }
    }

    public func savePlanShot(_ record: PlanShotRecord) async throws {
        try await dbQueue.write { db in try record.save(db) }
    }

    // MARK: - Wind edits (on-course wind editor)
    //
    // Same dirty-flag rule as `patchShot`: a still-`pending` row keeps
    // `pending` (its create carries the new wind), a `synced` row becomes
    // `dirty`. Clearing is a first-class edit — a nil speed+direction pair
    // means calm on a plan, and "inherit the plan wind" on a hole — so these
    // take optionals rather than treating nil as "unchanged".

    /// Sets the course's plan-level wind (lazily creating the plan row) and
    /// flags it for the server.
    public func setPlanWind(
        courseId: String, speedMps: Double?, directionDeg: Double?
    ) async throws {
        var plan = try await ensurePlanRow(courseId: courseId)
        plan.windSpeedMps = speedMps
        plan.windDirectionDeg = directionDeg
        if plan.syncState == .synced { plan.syncState = .dirty }
        try await savePlanRecord(plan)
    }

    /// Sets one hole's wind override (lazily creating the plan + hole rows) and
    /// flags it for the server. A nil pair clears the override.
    public func setPlanHoleWind(
        courseId: String, holeNumber: Int, speedMps: Double?, directionDeg: Double?
    ) async throws {
        let plan = try await ensurePlanRow(courseId: courseId)
        var hole = try await ensurePlanHoleRow(gamePlanId: plan.id, holeNumber: holeNumber)
        hole.windSpeedMps = speedMps
        hole.windDirectionDeg = directionDeg
        if hole.syncState == .synced { hole.syncState = .dirty }
        try await savePlanHole(hole)
    }

    /// The next append sortOrder for a hole (max existing + 1, else 0).
    public func nextPlanShotSortOrder(gamePlanHoleId: String) async throws -> Int {
        try await dbQueue.read { db in
            let max = try Int.fetchOne(
                db,
                sql: "SELECT MAX(sortOrder) FROM planShot WHERE gamePlanHoleId = ?",
                arguments: [gamePlanHoleId]
            )
            return (max ?? -1) + 1
        }
    }

    /// Deletes a plan shot: rows the server never saw are hard-deleted; synced
    /// rows become tombstones (`syncState = .deleted`) until `PlanSyncService`
    /// confirms the server-side remove. Same rule as `deleteShot`.
    public func deletePlanShot(id: String) async throws {
        try await dbQueue.write { db in
            guard var shot = try PlanShotRecord.fetchOne(db, key: id) else { return }
            if shot.serverId == nil {
                try shot.delete(db)
            } else {
                shot.syncState = .deleted
                try shot.save(db)
            }
        }
    }

    /// Hard-deletes a tombstoned plan shot after the server confirmed the remove.
    public func hardDeletePlanShot(id: String) async throws {
        _ = try await dbQueue.write { db in
            try PlanShotRecord.deleteOne(db, key: id)
        }
    }

    // MARK: - Fetches (sync engine)

    public func planShot(id: String) async throws -> PlanShotRecord? {
        try await dbQueue.read { db in try PlanShotRecord.fetchOne(db, key: id) }
    }

    // MARK: - Sync queue reads

    /// Plans with anything left to push: the plan row itself, any of its holes,
    /// or any shot under those holes is not `synced`.
    public func plansNeedingSync() async throws -> [GamePlanRecord] {
        try await dbQueue.read { db in
            try GamePlanRecord.fetchAll(
                db,
                sql: """
                SELECT * FROM gamePlan
                WHERE syncState <> ?
                   OR id IN (SELECT gamePlanId FROM gamePlanHole WHERE syncState <> ?)
                   OR id IN (
                        SELECT gamePlanId FROM gamePlanHole
                        WHERE id IN (SELECT gamePlanHoleId FROM planShot WHERE syncState <> ?)
                   )
                """,
                arguments: [
                    RoundSyncState.synced.rawValue,
                    RoundSyncState.synced.rawValue,
                    RoundSyncState.synced.rawValue,
                ]
            )
        }
    }

    /// A plan's holes that themselves need a push, or that own an unsynced shot
    /// (their hole row must exist server-side before their shots can push).
    public func planHolesNeedingSync(gamePlanId: String) async throws -> [GamePlanHoleRecord] {
        try await dbQueue.read { db in
            try GamePlanHoleRecord.fetchAll(
                db,
                sql: """
                SELECT * FROM gamePlanHole
                WHERE gamePlanId = ?
                  AND (syncState <> ?
                       OR id IN (SELECT gamePlanHoleId FROM planShot WHERE syncState <> ?))
                ORDER BY holeNumber
                """,
                arguments: [
                    gamePlanId,
                    RoundSyncState.synced.rawValue,
                    RoundSyncState.synced.rawValue,
                ]
            )
        }
    }

    /// A hole's unsynced shots (pending/dirty/deleted), in sortOrder so the
    /// server's insert-order sortOrder matches the local tee→green order.
    public func planShotsNeedingSync(gamePlanHoleId: String) async throws -> [PlanShotRecord] {
        try await dbQueue.read { db in
            try PlanShotRecord
                .filter(Column("gamePlanHoleId") == gamePlanHoleId
                    && Column("syncState") != RoundSyncState.synced.rawValue)
                .order(Column("sortOrder"))
                .fetchAll(db)
        }
    }

    /// True when the course's plan has any unsynced (pending/dirty/deleted) row
    /// — the reconciliation guard so a background `GamePlanSync.refresh` never
    /// stomps local edits that haven't reached the server yet.
    public func hasPendingPlanEdits(courseId: String) async throws -> Bool {
        try await dbQueue.read { db in
            guard let plan = try GamePlanRecord
                .filter(Column("courseId") == courseId)
                .fetchOne(db)
            else { return false }
            if plan.syncState != .synced { return true }
            let dirtyHoles = try GamePlanHoleRecord
                .filter(Column("gamePlanId") == plan.id
                    && Column("syncState") != RoundSyncState.synced.rawValue)
                .fetchCount(db)
            if dirtyHoles > 0 { return true }
            let holeIds = try GamePlanHoleRecord
                .filter(Column("gamePlanId") == plan.id)
                .fetchAll(db)
                .map(\.id)
            guard !holeIds.isEmpty else { return false }
            let dirtyShots = try PlanShotRecord
                .filter(holeIds.contains(Column("gamePlanHoleId"))
                    && Column("syncState") != RoundSyncState.synced.rawValue)
                .fetchCount(db)
            return dirtyShots > 0
        }
    }
}
