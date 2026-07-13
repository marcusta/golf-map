import Foundation

/// Pushes locally edited club-bag rows to the server — the consumer of the
/// `syncState`/`clubOrderState` dirty flags maintained by `ClubEditStore`.
///
/// Design mirrors `RoundSyncService`/`PlanSyncService`, but the bag is FLAT
/// (no tree) and has one extra wrinkle: the server's `/clubs/reorder` takes
/// the WHOLE ordered id list rather than a per-row patch, so:
///  - **Dirty-flag rows, not an ops queue.** `pending` → create, `dirty` →
///    update, `deleted` → remove-then-hard-delete.
///  - **Best-effort, never throws.** A network/server failure leaves the row
///    untouched and retries on the next trigger.
///  - **Push order: creates (sortOrder) → updates → removes → reorder.**
///    Creates push in local `sortOrder` so the server assigns ids that at
///    least start in the right order; a failed create stops the remaining
///    creates this pass (their sortOrder would land wrong), but updates and
///    removes for already-synced clubs are independent and still proceed.
///    The reorder call only fires once every live club has a `serverId` —
///    otherwise the server would be told to reorder ids it's never heard of.
///  - **Conflict → re-pull.** An optimistic-lock conflict (HTTP 409) means the
///    server bag diverged; the whole bag is re-fetched and overwrites local
///    state (the clobber is logged — no merge UI, matching plan sync).
///
/// An `actor` so concurrent triggers can't interleave two flushes.
actor ClubSyncService {
    private let client: GolfAPIClient
    private let database: AppDatabase
    private var isFlushing = false

    init(client: GolfAPIClient, database: AppDatabase) {
        self.client = client
        self.database = database
    }

    /// Pushes every unsynced club row, then a reorder if the bag order
    /// drifted. Safe to call from anywhere, any time.
    func flush() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        if let clubs = try? await database.clubsNeedingSync() {
            for club in clubs where club.syncState == .pending {
                guard await push(create: club) else { break }
            }
            for club in clubs where club.syncState == .dirty {
                await push(update: club)
            }
            for club in clubs where club.syncState == .deleted {
                await push(delete: club)
            }
        }

        await pushReorderIfNeeded()
    }

    // MARK: - Per-row pushes

    /// Creates a pending club; returns false on failure (stops the remaining
    /// creates this pass — matches the plan/round sync "adds in order" rule).
    private func push(create club: ClubRecord) async -> Bool {
        do {
            let created = try await client.createClub(
                name: club.name, carryM: club.carryM, dispersionM: club.dispersionM
            )
            var club = club
            club.serverId = created.id
            club.serverVersion = created.version
            club.syncState = .synced
            return (try? await database.saveClub(club)) != nil
        } catch {
            await handle(error)
            return false
        }
    }

    private func push(update club: ClubRecord) async {
        guard let serverId = club.serverId ?? synthesizedServerId(club) else { return }
        do {
            let updated = try await client.updateClub(
                id: serverId, version: club.serverVersion ?? 1,
                name: club.name, carryM: club.carryM, dispersionM: club.dispersionM
            )
            var club = club
            club.serverVersion = updated.version
            club.syncState = .synced
            try? await database.saveClub(club)
        } catch {
            await handle(error)
        }
    }

    private func push(delete club: ClubRecord) async {
        guard let serverId = club.serverId ?? synthesizedServerId(club) else {
            try? await database.hardDeleteClub(id: club.id)
            return
        }
        do {
            _ = try await client.removeClub(id: serverId, version: club.serverVersion ?? 1)
            try? await database.hardDeleteClub(id: club.id)
        } catch {
            await handle(error)
        }
    }

    /// A server-originated row (from an older cache, or the v2 read-only era)
    /// keeps the server id as its local `id` but may have a NULL `serverId`
    /// until the next refresh — treat a non-pending row's `id` as the server
    /// id, same idiom as `PlanSyncService.synthesizedServerId`.
    private func synthesizedServerId(_ club: ClubRecord) -> String? {
        club.syncState == .pending ? nil : club.id
    }

    // MARK: - Reorder

    /// Pushes the bag's order once every live club has a server id — a
    /// still-pending club means the server doesn't know that id yet, so the
    /// reorder call would be rejected/meaningless; it retries next flush.
    private func pushReorderIfNeeded() async {
        guard let dirty = try? await database.clubOrderDirty(), dirty else { return }
        guard let clubs = try? await database.allClubs(), !clubs.isEmpty else { return }

        let serverIds = clubs.compactMap { $0.serverId ?? synthesizedServerId($0) }
        guard serverIds.count == clubs.count else { return } // still waiting on a create

        do {
            _ = try await client.reorderClubs(orderedIds: serverIds)
            try? await database.clearClubOrderDirty()
        } catch {
            await handle(error)
        }
    }

    // MARK: - Conflict handling

    /// On an optimistic-lock conflict (HTTP 409) re-pull the whole bag and
    /// overwrite local state (logged clobber; no merge UI). Any other error
    /// is transient — left for the next flush.
    private func handle(_ error: Error) async {
        guard case APIError.http(let status, _) = error, status == 409 else { return }
        await repull()
    }

    private func repull() async {
        do {
            let clubs = try await client.clubs()
            try await database.saveClubs(clubs.map(GamePlanSync.clubRecord))
            try? await database.clearClubOrderDirty()
            print("ClubSync: version conflict — re-pulled server bag, local edits clobbered.")
        } catch {
            print("ClubSync: conflict re-pull failed: \(error)")
        }
    }
}
