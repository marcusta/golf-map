import Foundation

/// Pushes locally edited game-plan rows to the server — the consumer of the
/// `syncState` dirty flags maintained by the plan-edit store (task T3).
///
/// Design mirrors `RoundSyncService`:
///  - **Dirty-flag rows, not an ops queue.** The row is the source of truth;
///    the flag says what the server still needs (`pending` → create,
///    `dirty` → update, `deleted` → remove-then-hard-delete). Repeated local
///    edits coalesce into one push.
///  - **Best-effort, never throws.** A network/server failure leaves the row
///    untouched and retries on the next trigger.
///  - **Lazy creation, in dependency order.** A shot can only push once its
///    hole has a `serverId`, and a hole once its plan has one — so the push
///    order is: plan upsert → set-hole → shot adds (sortOrder) → updates →
///    removes. A failed create skips everything downstream of it this pass.
///  - **Conflict → re-pull.** An optimistic-lock conflict (HTTP 409) means the
///    server tree diverged; the whole course tree is re-pulled and overwrites
///    local state (the clobber is logged — no merge UI, per the T3 brief).
///
/// An `actor` so concurrent triggers can't interleave two flushes.
actor PlanSyncService {
    private let client: GolfAPIClient
    private let database: AppDatabase
    private var isFlushing = false

    init(client: GolfAPIClient, database: AppDatabase) {
        self.client = client
        self.database = database
    }

    /// Pushes every unsynced plan row. Safe to call from anywhere, any time.
    func flush() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        guard let plans = try? await database.plansNeedingSync() else { return }
        for plan in plans {
            await sync(plan: plan)
        }
    }

    // MARK: - Per-plan pipeline

    private func sync(plan: GamePlanRecord) async {
        var plan = plan

        // 1. The plan row: lazy-create (pending) or update wind (dirty). Both
        // carry the local wind — a plan first created BY a wind edit (no
        // server row yet) must push that wind with its create, not lose it.
        let planWind = PlanWindPatch(
            speedMps: plan.windSpeedMps, directionDeg: plan.windDirectionDeg
        )
        if plan.syncState == .pending {
            do {
                let created = try await client.upsertGamePlan(
                    courseId: plan.courseId, wind: planWind
                )
                plan.serverId = created.id
                plan.serverVersion = created.version
                plan.syncState = .synced
                guard (try? await database.savePlanRecord(plan)) != nil else { return }
            } catch {
                await handle(error, courseId: plan.courseId)
                return // offline → retry; conflict → already re-pulled
            }
        } else if plan.syncState == .dirty {
            do {
                let updated = try await client.upsertGamePlan(
                    courseId: plan.courseId,
                    version: plan.serverVersion ?? 1,
                    wind: planWind
                )
                plan.serverVersion = updated.version
                plan.syncState = .synced
                try? await database.savePlanRecord(plan)
            } catch {
                await handle(error, courseId: plan.courseId)
                return
            }
        }

        // Need a server plan id before holes/shots can push.
        guard let planServerId = plan.serverId ?? (plan.syncState == .synced ? plan.id : nil),
              let holes = try? await database.planHolesNeedingSync(gamePlanId: plan.id)
        else { return }

        for hole in holes {
            await sync(hole: hole, planServerId: planServerId, courseId: plan.courseId)
        }
    }

    private func sync(hole: GamePlanHoleRecord, planServerId: String, courseId: String) async {
        var hole = hole

        // The hole's own wind override — pushed on create AND on update. A nil
        // pair is an explicit "clear the override" (the hole inherits the
        // plan wind again), which is why it goes through `PlanWindPatch`
        // rather than plain optional arguments.
        let holeWind = PlanWindPatch(
            speedMps: hole.windSpeedMps, directionDeg: hole.windDirectionDeg
        )
        if hole.syncState == .pending {
            do {
                let created = try await client.setPlanHole(
                    planId: planServerId, holeNumber: hole.holeNumber, wind: holeWind
                )
                hole.serverId = created.id
                hole.serverVersion = created.version
                hole.syncState = .synced
                guard (try? await database.savePlanHole(hole)) != nil else { return }
            } catch {
                await handle(error, courseId: courseId)
                return
            }
        } else if hole.syncState == .dirty {
            do {
                let updated = try await client.setPlanHole(
                    planId: planServerId,
                    holeNumber: hole.holeNumber,
                    version: hole.serverVersion ?? 1,
                    wind: holeWind
                )
                hole.serverVersion = updated.version
                hole.syncState = .synced
                guard (try? await database.savePlanHole(hole)) != nil else { return }
            } catch {
                await handle(error, courseId: courseId)
                return
            }
        }

        guard let holeServerId = hole.serverId ?? (hole.syncState == .synced ? hole.id : nil),
              let shots = try? await database.planShotsNeedingSync(gamePlanHoleId: hole.id)
        else { return }

        // Adds first in parent-before-child order, then updates, then removes.
        // Tree sortOrder is sibling rank now, so a flat sort can no longer
        // guarantee that an offline-created continuation follows its parent.
        for shot in parentBeforeChild(shots.filter { $0.syncState == .pending }) {
            guard await push(add: shot, holeServerId: holeServerId, courseId: courseId) else { return }
        }
        for shot in shots where shot.syncState == .dirty {
            await push(update: shot, courseId: courseId)
        }
        for shot in shots where shot.syncState == .deleted {
            await push(delete: shot, courseId: courseId)
        }
    }

    private func parentBeforeChild(_ shots: [PlanShotRecord]) -> [PlanShotRecord] {
        var remaining = shots.sorted {
            $0.sortOrder != $1.sortOrder ? $0.sortOrder < $1.sortOrder : $0.id < $1.id
        }
        let pendingIds = Set(remaining.map(\.id))
        var emitted = Set<String>()
        var result: [PlanShotRecord] = []
        while !remaining.isEmpty {
            guard let index = remaining.firstIndex(where: { shot in
                guard let parent = shot.parentShotId else { return true }
                return !pendingIds.contains(parent) || emitted.contains(parent)
            }) else {
                // Malformed local cycle: preserve deterministic retry order;
                // the server will reject rather than the sync loop hanging.
                result.append(contentsOf: remaining)
                break
            }
            let shot = remaining.remove(at: index)
            result.append(shot)
            emitted.insert(shot.id)
        }
        return result
    }

    /// Adds a pending shot; returns false on failure (stop this hole's adds so
    /// the server's insert-order sortOrder matches the local tee→green order).
    private func push(add shot: PlanShotRecord, holeServerId: String, courseId: String) async -> Bool {
        do {
            let added = try await client.addPlanShot(
                gamePlanHoleId: holeServerId,
                lat: shot.lat, lon: shot.lon,
                elevation: shot.elevation, clubId: shot.clubId, label: shot.label
            )
            var shot = shot
            shot.serverId = added.id
            shot.serverVersion = added.version
            shot.syncState = .synced
            return (try? await database.savePlanShot(shot)) != nil
        } catch {
            await handle(error, courseId: courseId)
            return false
        }
    }

    private func push(update shot: PlanShotRecord, courseId: String) async {
        guard let serverId = shot.serverId ?? synthesizedServerId(shot) else { return }
        do {
            let updated = try await client.updatePlanShot(
                id: serverId, version: shot.serverVersion ?? 1,
                lat: shot.lat, lon: shot.lon,
                elevation: shot.elevation, clubId: shot.clubId, label: shot.label
            )
            var shot = shot
            shot.serverVersion = updated.version
            shot.syncState = .synced
            try? await database.savePlanShot(shot)
        } catch {
            await handle(error, courseId: courseId)
        }
    }

    private func push(delete shot: PlanShotRecord, courseId: String) async {
        guard let serverId = shot.serverId ?? synthesizedServerId(shot) else {
            try? await database.hardDeletePlanShot(id: shot.id)
            return
        }
        do {
            _ = try await client.removePlanShot(id: serverId, version: shot.serverVersion ?? 1)
            try? await database.hardDeletePlanShot(id: shot.id)
        } catch {
            await handle(error, courseId: courseId)
        }
    }

    /// A server-originated row (from an older cache) keeps the server id as its
    /// local `id` but may have a NULL `serverId` until the next refresh — treat
    /// a non-pending row's `id` as the server id.
    private func synthesizedServerId(_ shot: PlanShotRecord) -> String? {
        shot.syncState == .pending ? nil : shot.id
    }

    // MARK: - Conflict handling

    /// On an optimistic-lock conflict (HTTP 409) re-pull the course's server
    /// tree and overwrite local state (logged clobber; no merge UI). Any other
    /// error is transient — left for the next flush.
    private func handle(_ error: Error, courseId: String) async {
        guard case APIError.http(let status, _) = error, status == 409 else { return }
        await repull(courseId: courseId)
    }

    private func repull(courseId: String) async {
        do {
            let plan = try await client.gamePlan(courseId: courseId)
            if let plan {
                try await database.saveGamePlan(GamePlanSync.storedPlan(from: plan))
            } else {
                try await database.deleteGamePlan(courseId: courseId)
            }
            print("PlanSync: version conflict on \(courseId) — re-pulled server tree, local edits clobbered.")
        } catch {
            print("PlanSync: conflict re-pull failed for \(courseId): \(error)")
        }
    }
}
