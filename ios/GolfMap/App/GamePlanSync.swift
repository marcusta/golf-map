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
    static func refresh(client: GolfAPIClient, database: AppDatabase, courseId: String) async throws {
        async let planTask = client.gamePlan(courseId: courseId)
        async let clubsTask = client.clubs()

        let plan = try await planTask
        let clubs = try await clubsTask

        try await database.saveClubs(clubs.map(clubRecord))
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
                windDirectionDeg: plan.windDirectionDeg
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
            notes: h.notes
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
            label: s.label
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
            source: g.source
        )
    }

    static func clubRecord(_ c: Club) -> ClubRecord {
        ClubRecord(
            id: c.id,
            name: c.name,
            carryM: c.carryM,
            dispersionM: c.dispersionM,
            sortOrder: c.sortOrder
        )
    }
}
