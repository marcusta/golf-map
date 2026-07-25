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

    /// Inserts a round row (round start). Existing rows are mutated through
    /// the column-level helpers below, NOT by re-saving a caller's snapshot:
    /// the sync engine assigns serverId/syncState to the row concurrently, and
    /// a full-row upsert of a stale snapshot would revert them — the next
    /// flush would POST a duplicate `rounds/start` and the real server round
    /// would never get its `rounds/end`.
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

    /// Marks a round finished against the FRESH row (read-modify-write in one
    /// transaction — see `saveRound` for why not a caller snapshot). Returns
    /// the updated row, or nil when no such row exists.
    public func finishRound(id: String, endedAt: String) async throws -> RoundRecord? {
        try await dbQueue.write { db in
            guard var round = try RoundRecord.fetchOne(db, key: id) else { return nil }
            round.endedAt = endedAt
            if round.syncState == .synced { round.syncState = .dirty }
            try round.save(db)
            return round
        }
    }

    /// Sets a round's green speed against the FRESH row. `syncState` is
    /// deliberately untouched — see `RoundModel.setStimp`. Returns the updated
    /// row, or nil when no such row exists.
    public func updateRoundStimp(id: String, stimpFt: Double?) async throws -> RoundRecord? {
        try await dbQueue.write { db in
            guard var round = try RoundRecord.fetchOne(db, key: id) else { return nil }
            round.stimpFt = stimpFt
            try round.save(db)
            return round
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

    /// Inserts or updates a stroke row (stroke capture — a freshly minted row
    /// the sync engine hasn't seen yet). Edits to existing rows go through
    /// `updateShot` for the same stale-snapshot reason as `saveRound`.
    public func saveShot(_ shot: ShotRecord) async throws {
        try await dbQueue.write { db in
            try shot.save(db)
        }
    }

    /// After-the-fact stroke edit applied to the FRESH row (the caller's
    /// snapshot may predate sync's serverId assignment — see `saveRound`).
    /// Unspecified fields keep their stored value; a `.synced` row goes
    /// `.dirty`. Returns the updated row, or nil when no such row exists.
    public func updateShot(
        id: String,
        clubId: String?? = nil,
        shotType: ShotType? = nil,
        penaltyStrokes: Int? = nil
    ) async throws -> ShotRecord? {
        try await dbQueue.write { db in
            guard var shot = try ShotRecord.fetchOne(db, key: id) else { return nil }
            if let clubId { shot.clubId = clubId }
            if let shotType { shot.shotType = shotType }
            if let penaltyStrokes { shot.penaltyStrokes = max(0, penaltyStrokes) }
            if shot.syncState == .synced { shot.syncState = .dirty }
            try shot.save(db)
            return shot
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

    // MARK: - Sync-result adoption
    //
    // The sync engine's writes are column-level against the FRESH row for the
    // mirror-image of the `saveRound` hazard: a capture write can land while a
    // push is in flight, and a full-row save of the pre-push snapshot would
    // silently revert it (e.g. un-end a round finished during its
    // `rounds/start` call).

    /// Records a successful `rounds/start`: server identity plus a syncState
    /// derived from the FRESH row — ended while the call was in flight →
    /// `.dirty`, so the end push follows in the same flush. Returns the
    /// updated row, or nil when no such row exists.
    public func adoptRoundStart(
        id: String, serverId: String, serverVersion: Int
    ) async throws -> RoundRecord? {
        try await dbQueue.write { db in
            guard var round = try RoundRecord.fetchOne(db, key: id) else { return nil }
            round.serverId = serverId
            round.serverVersion = serverVersion
            round.syncState = round.endedAt == nil ? .synced : .dirty
            try round.save(db)
            return round
        }
    }

    /// Records a successful `rounds/end`. Nothing capture-side can re-dirty a
    /// finished round (stimp is only editable while active), so the row goes
    /// straight to `.synced`.
    public func adoptRoundEnd(id: String, serverVersion: Int) async throws -> RoundRecord? {
        try await dbQueue.write { db in
            guard var round = try RoundRecord.fetchOne(db, key: id) else { return nil }
            round.serverVersion = serverVersion
            round.syncState = .synced
            try round.save(db)
            return round
        }
    }

    /// Records a successful shot add. The FRESH row keeps any edits made
    /// while the add was in flight: content unchanged → `.synced`; edited →
    /// `.dirty` (the follow-up update push carries the edit). A row
    /// hard-deleted during the flight (nil-serverId deletes skip the
    /// tombstone) is resurrected AS a tombstone so the next flush removes the
    /// copy the server just created.
    public func adoptShotAdd(
        id: String, serverId: String, serverVersion: Int, pushed: ShotRecord
    ) async throws -> ShotRecord {
        try await dbQueue.write { db in
            guard var shot = try ShotRecord.fetchOne(db, key: id) else {
                var tombstone = pushed
                tombstone.serverId = serverId
                tombstone.serverVersion = serverVersion
                tombstone.syncState = .deleted
                try tombstone.save(db)
                return tombstone
            }
            shot.serverId = serverId
            shot.serverVersion = serverVersion
            shot.syncState = shotContentEquals(shot, pushed) ? .synced : .dirty
            try shot.save(db)
            return shot
        }
    }

    /// Records a successful shot update: the version is always adopted;
    /// `.synced` only when the row still matches what was pushed and wasn't
    /// tombstoned meanwhile.
    public func adoptShotUpdate(
        id: String, serverVersion: Int, pushed: ShotRecord
    ) async throws -> ShotRecord? {
        try await dbQueue.write { db in
            guard var shot = try ShotRecord.fetchOne(db, key: id) else { return nil }
            shot.serverVersion = serverVersion
            if shot.syncState == .dirty, shotContentEquals(shot, pushed) {
                shot.syncState = .synced
            }
            try shot.save(db)
            return shot
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

/// Row equality ignoring sync bookkeeping — "did capture change this shot
/// while its push was in flight?".
private func shotContentEquals(_ a: ShotRecord, _ b: ShotRecord) -> Bool {
    var a = a, b = b
    a.serverId = nil; b.serverId = nil
    a.serverVersion = nil; b.serverVersion = nil
    a.syncState = .pending; b.syncState = .pending
    return a == b
}
