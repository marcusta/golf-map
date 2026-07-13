import Foundation

/// Bridges `ClubsModel`'s edits to the GRDB club-edit store + `ClubSyncService`.
/// Local-first, mirroring `PlanEditStore`'s shape: every edit writes a dirty
/// row and kicks the sync engine; a failed DB write logs and is otherwise
/// swallowed (the model already holds the in-memory truth, so the screen
/// never waits on I/O).
struct ClubEditStore: Sendable {
    let database: AppDatabase
    let clubSync: ClubSyncService

    /// The `ClubsModel.ClubEditWriter` backed by this store.
    func writer() -> ClubsModel.ClubEditWriter {
        ClubsModel.ClubEditWriter(
            create: { id, name, carryM, dispersionM in
                await create(id: id, name: name, carryM: carryM, dispersionM: dispersionM)
            },
            update: { id, name, carryM, dispersionM in
                await update(id: id, name: name, carryM: carryM, dispersionM: dispersionM)
            },
            remove: { id in await remove(id: id) },
            reorder: { orderedIds in await reorder(orderedIds: orderedIds) }
        )
    }

    /// The model already minted the id/sortOrder — this just persists a
    /// `.pending` row with those exact values so the sync push matches what's
    /// on screen.
    private func create(id: String, name: String, carryM: Double, dispersionM: Double) async {
        do {
            let sortOrder = try await database.nextClubSortOrder()
            try await database.saveClub(ClubRecord(
                id: id, name: name, carryM: carryM, dispersionM: dispersionM,
                sortOrder: sortOrder, syncState: .pending
            ))
        } catch {
            print("Club edit create failed (kept in memory): \(error)")
        }
        await clubSync.flush()
    }

    /// Applies whichever fields are non-nil and flags the row for the server.
    /// A still-`pending` (never-pushed) row keeps `pending` — its create will
    /// carry the new values; a `synced` row becomes `dirty`.
    private func update(id: String, name: String?, carryM: Double?, dispersionM: Double?) async {
        do {
            try await database.updateClub(id: id) { club in
                if let name { club.name = name }
                if let carryM { club.carryM = carryM }
                if let dispersionM { club.dispersionM = dispersionM }
            }
        } catch {
            print("Club edit update failed (kept in memory): \(error)")
        }
        await clubSync.flush()
    }

    private func remove(id: String) async {
        do {
            try await database.deleteClub(id: id)
        } catch {
            print("Club edit remove failed (kept in memory): \(error)")
        }
        await clubSync.flush()
    }

    private func reorder(orderedIds: [String]) async {
        do {
            try await database.reorderClubs(orderedIds: orderedIds)
        } catch {
            print("Club edit reorder failed (kept in memory): \(error)")
        }
        await clubSync.flush()
    }
}
