import Foundation

/// Bridges `OnCourseModel`'s planner-tool edits to the GRDB plan-edit store +
/// `PlanSyncService`. Local-first, mirroring `RoundModel`'s persistence shape:
/// every edit writes a dirty row and kicks the sync engine; a failed DB write
/// logs and is otherwise swallowed (the model already holds the in-memory
/// truth, so the map never waits on I/O).
///
/// Lazy creation lives in the store (`ensurePlanRow` / `ensurePlanHoleRow`): the
/// first edit on a course/hole with no server rows creates local `.pending`
/// rows that push (plan upsert → set-hole) before their shots.
struct PlanEditStore: Sendable {
    let database: AppDatabase
    let planSync: PlanSyncService
    let courseId: String

    /// The `OnCourseModel.PlanEditWriter` backed by this store.
    func writer() -> OnCourseModel.PlanEditWriter {
        OnCourseModel.PlanEditWriter(
            addShot: { holeNumber, shotId, sortOrder, parentShotId, lat, lon, elevation, clubId in
                await addShot(
                    holeNumber: holeNumber, shotId: shotId, sortOrder: sortOrder,
                    parentShotId: parentShotId,
                    lat: lat, lon: lon, elevation: elevation, clubId: clubId
                )
            },
            moveShot: { shotId, lat, lon, elevation in
                await patchShot(id: shotId) { shot in
                    shot.lat = lat
                    shot.lon = lon
                    shot.elevation = elevation
                }
            },
            setShotClub: { shotId, clubId in
                await patchShot(id: shotId) { shot in shot.clubId = clubId }
            },
            removeShot: { shotId in await removeShot(id: shotId) },
            setPlanWind: { speedMps, directionDeg in
                await setPlanWind(speedMps: speedMps, directionDeg: directionDeg)
            },
            setHoleWind: { holeNumber, speedMps, directionDeg in
                await setHoleWind(
                    holeNumber: holeNumber, speedMps: speedMps, directionDeg: directionDeg
                )
            }
        )
    }

    private func addShot(
        holeNumber: Int, shotId: String, sortOrder: Int, parentShotId: String?,
        lat: Double, lon: Double, elevation: Double?, clubId: String?
    ) async {
        do {
            let plan = try await database.ensurePlanRow(courseId: courseId)
            let hole = try await database.ensurePlanHoleRow(
                gamePlanId: plan.id, holeNumber: holeNumber
            )
            try await database.savePlanShot(PlanShotRecord(
                id: shotId,
                gamePlanHoleId: hole.id,
                sortOrder: sortOrder,
                parentShotId: parentShotId,
                lat: lat, lon: lon, elevation: elevation, clubId: clubId,
                syncState: .pending
            ))
        } catch {
            print("Plan edit add failed (kept in memory): \(error)")
        }
        await planSync.flush()
    }

    /// Applies `mutate` to the stored shot and flags it for the server. A
    /// still-`pending` (never-pushed) row keeps `pending` — its create will
    /// carry the new values; a `synced` row becomes `dirty`.
    private func patchShot(id: String, _ mutate: (inout PlanShotRecord) -> Void) async {
        do {
            guard var shot = try await database.planShot(id: id) else { return }
            mutate(&shot)
            if shot.syncState == .synced { shot.syncState = .dirty }
            try await database.savePlanShot(shot)
        } catch {
            print("Plan edit update failed (kept in memory): \(error)")
        }
        await planSync.flush()
    }

    /// The on-course wind editor's two writes. Nil speed+direction is a real
    /// edit, not "unchanged": calm on the plan, inherit-the-plan on a hole.
    private func setPlanWind(speedMps: Double?, directionDeg: Double?) async {
        do {
            try await database.setPlanWind(
                courseId: courseId, speedMps: speedMps, directionDeg: directionDeg
            )
        } catch {
            print("Plan wind edit failed (kept in memory): \(error)")
        }
        await planSync.flush()
    }

    private func setHoleWind(holeNumber: Int, speedMps: Double?, directionDeg: Double?) async {
        do {
            try await database.setPlanHoleWind(
                courseId: courseId, holeNumber: holeNumber,
                speedMps: speedMps, directionDeg: directionDeg
            )
        } catch {
            print("Hole wind edit failed (kept in memory): \(error)")
        }
        await planSync.flush()
    }

    private func removeShot(id: String) async {
        do {
            try await database.deletePlanShot(id: id)
        } catch {
            print("Plan edit remove failed (kept in memory): \(error)")
        }
        await planSync.flush()
    }
}
