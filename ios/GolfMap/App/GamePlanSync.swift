import Foundation

/// Fetch + cache wiring for the read-only game-plan viewer: pulls the
/// course's game plan and the player's club bag from the server and mirrors
/// them into GRDB, so the on-course screen can read them offline.
///
/// Same design as `SyncService`: the mapping is a set of pure static
/// functions (API models → Store records) so it's unit-testable from
/// fixtures without any I/O; `refresh` is the thin async wiring on top.
/// Fetch failures are the CALLER's to swallow — on course open a failed
/// refresh must degrade silently to whatever was cached last.
enum GamePlanSync {

    // MARK: - Fetch + store

    /// Fetches the plan + clubs and replaces the local cache. A server `null`
    /// plan DELETES the cached plan (the plan was removed on the web) so the
    /// viewer never shows a stale strategy. Throws on any network/decode/DB
    /// error — the caller logs and keeps the previous cache.
    ///
    /// RECONCILIATION (task T3, extended by T4): both the plan tree AND the
    /// club bag are now writable on device, so a refresh must never stomp
    /// local edits that haven't reached the server. If the course has any
    /// pending/dirty/deleted plan row, the server plan is left untouched (the
    /// pending edits push separately via `PlanSyncService`, and the next clean
    /// refresh picks up the merged result). Same rule for the club bag against
    /// `ClubSyncService` — see `hasPendingClubEdits`.
    static func refresh(client: GolfAPIClient, database: AppDatabase, courseId: String) async throws {
        async let planTask = client.gamePlan(courseId: courseId)
        async let clubsTask = client.clubs()

        let plan = try await planTask
        let clubs = try await clubsTask

        // Skip clobbering local club edits; they reconcile through ClubSyncService.
        if try await !database.hasPendingClubEdits() {
            try await database.saveClubs(clubs.map(clubRecord))
        }

        // Skip clobbering local plan edits; they reconcile through PlanSyncService.
        if try await database.hasPendingPlanEdits(courseId: courseId) { return }

        if let plan {
            try await database.saveGamePlan(storedPlan(from: plan))
        } else {
            try await database.deleteGamePlan(courseId: courseId)
        }
    }

    /// Reads the cached plan + clubs and assembles the display value, or nil
    /// when no plan (with any content) is cached for the course.
    static func loadCoursePlan(database: AppDatabase, courseId: String) async throws -> CoursePlan? {
        guard let stored = try await database.gamePlan(courseId: courseId) else { return nil }
        let clubs = try await database.allClubs()
        return CoursePlan.make(stored: stored, clubs: clubs)
    }

    // MARK: - Pure adapters (API models → Store records)

    /// Flattens the server's plan tree into store records. Pure — no I/O.
    static func storedPlan(from plan: GamePlan) -> StoredGamePlan {
        StoredGamePlan(
            plan: GamePlanRecord(
                id: plan.id,
                courseId: plan.courseId,
                windSpeedMps: plan.windSpeedMps,
                windDirectionDeg: plan.windDirectionDeg,
                // Server-originated rows keep the server id as the local id and
                // land `.synced` — the writable T3 tables carry these columns.
                serverId: plan.id,
                serverVersion: plan.version,
                syncState: .synced
            ),
            holes: plan.holes.map(holeRecord),
            shots: plan.holes.flatMap { $0.shots.map(shotRecord) },
            gates: plan.holes.flatMap { $0.gates.map(gateRecord) }
        )
    }

    static func holeRecord(_ h: GamePlanHole) -> GamePlanHoleRecord {
        GamePlanHoleRecord(
            id: h.id,
            gamePlanId: h.gamePlanId,
            holeNumber: h.holeNumber,
            teeId: h.teeId,
            preferredClubId: h.preferredClubId,
            plannedDirectionDeg: h.plannedDirectionDeg,
            windSpeedMps: h.windSpeedMps,
            windDirectionDeg: h.windDirectionDeg,
            notes: h.notes,
            serverId: h.id,
            serverVersion: h.version,
            syncState: .synced
        )
    }

    static func shotRecord(_ s: PlanShot) -> PlanShotRecord {
        PlanShotRecord(
            id: s.id,
            gamePlanHoleId: s.gamePlanHoleId,
            sortOrder: s.sortOrder,
            lat: s.lat,
            lon: s.lon,
            elevation: s.elevation,
            clubId: s.clubId,
            label: s.label,
            serverId: s.id,
            serverVersion: s.version,
            syncState: .synced
        )
    }

    static func gateRecord(_ g: PlanGate) -> PlanGateRecord {
        PlanGateRecord(
            id: g.id,
            gamePlanHoleId: g.gamePlanHoleId,
            sortOrder: g.sortOrder,
            lat: g.lat,
            lon: g.lon,
            directionDeg: g.directionDeg,
            halfWidthLeftM: g.halfWidthLeftM,
            halfWidthRightM: g.halfWidthRightM,
            source: g.source,
            serverId: g.id,
            serverVersion: g.version,
            syncState: .synced
        )
    }

    static func clubRecord(_ c: Club) -> ClubRecord {
        ClubRecord(
            id: c.id,
            name: c.name,
            carryM: c.carryM,
            dispersionM: c.dispersionM,
            sortOrder: c.sortOrder,
            // Server-originated rows keep the server id as the local id and
            // land `.synced` — the writable T4 club table carries these columns.
            serverId: c.id,
            serverVersion: c.version,
            syncState: .synced
        )
    }
}
