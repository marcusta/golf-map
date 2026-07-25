import Foundation
import GRDB

// MARK: - Round store (schema v3 reads/writes)
//
// The round/shot persistence surface, on the same AppDatabase the rest of the
// Store layer uses. All writes are LOCAL-FIRST: capture writes a row and
// returns; pushing to the server is `RoundSyncService`'s separate job, driven
// by the `syncState` flags these methods maintain. A failed network never
// touches this layer — capture cannot be blocked by connectivity.

extension AppDatabase {

    // MARK: - Rounds

    /// The active (not-ended) round for a course, or nil. Callers enforce
    /// "one active round per course" by resuming this instead of inserting.
    /// Latest `startedAt` wins should legacy data ever hold two.
    public func activeRound(courseId: String) async throws -> RoundRecord? {
        try await dbQueue.read { db in
            try RoundRecord
                .filter(Column("courseId") == courseId && Column("endedAt") == nil)
                .order(Column("startedAt").desc)
                .fetchOne(db)
        }
    }

    /// Inserts or updates a round row (capture-side writes + sync-side
    /// serverId/version/state updates share this).
    public func saveRound(_ round: RoundRecord) async throws {
        try await dbQueue.write { db in
            try round.save(db)
        }
    }

    /// One round row by local id. The sync engine writes `serverId` straight to
    /// the row, behind any in-memory copy a screen is holding — anything that
    /// needs the server identity of a round started in this session re-reads it
    /// with this (see `RoundModel.adoptSyncedIdentity`).
    public func round(id: String) async throws -> RoundRecord? {
        try await dbQueue.read { db in
            try RoundRecord.filter(Column("id") == id).fetchOne(db)
        }
    }

    /// Writes ONLY the Tapscore mirror columns (T65). Deliberately NOT a
    /// `saveRound`: that upserts the whole row, so a caller holding a snapshot
    /// taken before the sync engine's `serverId` write would silently roll it
    /// back. The mirror is also not sync state — this never touches
    /// `syncState`, so it cannot enqueue a push.
    public func updateRoundTapscoreLink(
        roundId: String,
        token: String?,
        ballId: String?
    ) async throws {
        try await dbQueue.write { db in
            try db.execute(
                sql: "UPDATE round SET tapscoreToken = ?, tapscoreBallId = ? WHERE id = ?",
                arguments: [token, ballId, roundId]
            )
        }
    }

    /// All finished + active rounds for a course, newest first (scorecard
    /// history — not used by capture itself).
    public func rounds(courseId: String) async throws -> [RoundRecord] {
        try await dbQueue.read { db in
            try RoundRecord
                .filter(Column("courseId") == courseId)
                .order(Column("startedAt").desc)
                .fetchAll(db)
        }
    }

    // MARK: - Shots

    /// A round's live strokes (tombstoned rows excluded), ordered by
    /// (holeNumber, sortOrder) — the scorecard/edit order.
    public func shots(roundId: String) async throws -> [ShotRecord] {
        try await dbQueue.read { db in
            try ShotRecord
                .filter(Column("roundId") == roundId
                    && Column("syncState") != RoundSyncState.deleted.rawValue)
                .order(Column("holeNumber"), Column("sortOrder"))
                .fetchAll(db)
        }
    }

    /// Inserts or updates a stroke row.
    public func saveShot(_ shot: ShotRecord) async throws {
        try await dbQueue.write { db in
            try shot.save(db)
        }
    }

    /// Deletes a stroke: rows the server never saw are hard-deleted; synced
    /// rows become tombstones (`syncState = .deleted`) until the sync engine
    /// confirms the server-side remove.
    public func deleteShot(id: String) async throws {
        try await dbQueue.write { db in
            guard var shot = try ShotRecord.fetchOne(db, key: id) else { return }
            if shot.serverId == nil {
                try shot.delete(db)
            } else {
                shot.syncState = .deleted
                try shot.save(db)
            }
        }
    }

    /// Hard-deletes a tombstoned row after the server confirmed the remove.
    public func hardDeleteShot(id: String) async throws {
        _ = try await dbQueue.write { db in
            try ShotRecord.deleteOne(db, key: id)
        }
    }

    // MARK: - Sync queue reads

    /// Rounds with anything left to push: the round row itself is not synced,
    /// or any of its shots isn't. Ordered by `startedAt` so server inserts
    /// replay in capture order.
    public func roundsNeedingSync() async throws -> [RoundRecord] {
        try await dbQueue.read { db in
            try RoundRecord.fetchAll(
                db,
                sql: """
                SELECT * FROM round
                WHERE syncState <> ?
                   OR id IN (SELECT roundId FROM shot WHERE syncState <> ?)
                ORDER BY startedAt
                """,
                arguments: [RoundSyncState.synced.rawValue, RoundSyncState.synced.rawValue]
            )
        }
    }

    /// A round's unsynced shots (pending/dirty/deleted), in capture order
    /// (`recordedAt`, then sortOrder for identical timestamps) so the server's
    /// insert-order `sortOrder` matches the local stroke order.
    public func shotsNeedingSync(roundId: String) async throws -> [ShotRecord] {
        try await dbQueue.read { db in
            try ShotRecord
                .filter(Column("roundId") == roundId
                    && Column("syncState") != RoundSyncState.synced.rawValue)
                .order(Column("recordedAt"), Column("holeNumber"), Column("sortOrder"))
                .fetchAll(db)
        }
    }
}
