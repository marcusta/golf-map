import Foundation
import GRDB

// MARK: - Club edit store (schema v6 writes)
//
// The writable-bag counterpart to `AppDatabase`'s read-only club cache
// (`allClubs`/`saveClubs`). Mirrors `GamePlanEditStore.swift` (dirty-flag
// transitions, tombstone-then-hard-delete) and `RoundStore.swift` (flat
// per-row entity, no tree). All writes are LOCAL-FIRST: the club-settings
// screen writes a row and returns; pushing to the server is
// `ClubSyncService`'s separate job, driven by the `syncState` flags these
// methods maintain plus the `clubOrderState` dirty flag for reordering.

extension AppDatabase {

    // MARK: - Reads

    /// A single club by id, or nil.
    public func club(id: String) async throws -> ClubRecord? {
        try await dbQueue.read { db in
            try ClubRecord.fetchOne(db, key: id)
        }
    }

    /// The next `sortOrder` for a newly added club (end of the bag).
    public func nextClubSortOrder() async throws -> Int {
        try await dbQueue.read { db in
            let maxOrder = try Int.fetchOne(
                db, sql: "SELECT MAX(sortOrder) FROM club"
            )
            return (maxOrder ?? -1) + 1
        }
    }

    // MARK: - Writes

    /// Inserts or updates a club row (capture-side writes + sync-side
    /// serverId/version/state updates share this).
    public func saveClub(_ club: ClubRecord) async throws {
        try await dbQueue.write { db in
            try club.save(db)
        }
    }

    /// Creates a device-originated club: local UUID id, `.pending` sync state,
    /// nil serverId, appended to the end of the bag.
    @discardableResult
    public func createClub(name: String, carryM: Double, dispersionM: Double) async throws -> ClubRecord {
        try await dbQueue.write { db in
            let maxOrder = try Int.fetchOne(db, sql: "SELECT MAX(sortOrder) FROM club")
            let club = ClubRecord(
                id: UUID().uuidString,
                name: name,
                carryM: carryM,
                dispersionM: dispersionM,
                sortOrder: (maxOrder ?? -1) + 1,
                syncState: .pending
            )
            try club.insert(db)
            return club
        }
    }

    /// Applies `mutate` to the stored club and marks it `.dirty` unless it's
    /// still `.pending` (a never-pushed row stays `.pending` — there's nothing
    /// on the server yet to diverge from) or already `.deleted`.
    @discardableResult
    public func updateClub(id: String, _ mutate: @Sendable (inout ClubRecord) -> Void) async throws -> ClubRecord? {
        try await dbQueue.write { db in
            guard var club = try ClubRecord.fetchOne(db, key: id) else { return nil }
            mutate(&club)
            if club.syncState == .synced { club.syncState = .dirty }
            try club.save(db)
            return club
        }
    }

    /// Deletes a club: rows the server never saw are hard-deleted; synced
    /// rows become tombstones (`syncState = .deleted`) until the sync engine
    /// confirms the server-side remove.
    public func deleteClub(id: String) async throws {
        try await dbQueue.write { db in
            guard var club = try ClubRecord.fetchOne(db, key: id) else { return }
            if club.serverId == nil {
                try club.delete(db)
            } else {
                club.syncState = .deleted
                try club.save(db)
            }
        }
    }

    /// Hard-deletes a tombstoned row after the server confirmed the remove.
    public func hardDeleteClub(id: String) async throws {
        _ = try await dbQueue.write { db in
            try ClubRecord.deleteOne(db, key: id)
        }
    }

    /// Reassigns `sortOrder` for every id in `orderedIds` (its index in the
    /// array), and marks the bag order dirty so `ClubSyncService` pushes a
    /// `/clubs/reorder` call. Ids not present in `orderedIds` are left as-is.
    public func reorderClubs(orderedIds: [String]) async throws {
        try await dbQueue.write { db in
            for (index, id) in orderedIds.enumerated() {
                guard var club = try ClubRecord.fetchOne(db, key: id) else { continue }
                club.sortOrder = index
                try club.save(db)
            }
            try ClubOrderStateRecord(dirty: true).save(db)
        }
    }

    /// Whether the local bag order has drifted from the last pushed order.
    public func clubOrderDirty() async throws -> Bool {
        try await dbQueue.read { db in
            try ClubOrderStateRecord.fetchOne(db, key: 1)?.dirty ?? false
        }
    }

    /// Clears the order-dirty flag once `ClubSyncService` has pushed a reorder.
    public func clearClubOrderDirty() async throws {
        try await dbQueue.write { db in
            try ClubOrderStateRecord(dirty: false).save(db)
        }
    }

    // MARK: - Sync queue reads

    /// Clubs with anything left to push (create/update/delete), ordered by
    /// `sortOrder` so server creates replay in bag order.
    public func clubsNeedingSync() async throws -> [ClubRecord] {
        try await dbQueue.read { db in
            try ClubRecord
                .filter(Column("syncState") != RoundSyncState.synced.rawValue)
                .order(Column("sortOrder"))
                .fetchAll(db)
        }
    }

    /// True if anything about the bag (a row's create/update/delete, or the
    /// order itself) is waiting to be pushed. The refresh-reconciliation guard
    /// in `GamePlanSync.refresh` uses this to avoid clobbering local edits.
    public func hasPendingClubEdits() async throws -> Bool {
        try await dbQueue.read { db in
            let dirtyRow = try Int.fetchOne(
                db,
                sql: "SELECT 1 FROM club WHERE syncState <> ? LIMIT 1",
                arguments: [RoundSyncState.synced.rawValue]
            )
            if dirtyRow != nil { return true }
            return try ClubOrderStateRecord.fetchOne(db, key: 1)?.dirty ?? false
        }
    }
}
