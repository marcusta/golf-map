import Foundation
import Observation

/// Backs the round lifecycle + stroke capture for one open course: the active
/// round (resumed across app restarts from GRDB — `endedAt == nil` IS the
/// persistence of "active"), the in-memory stroke list the UI reads, and the
/// local-first writes.
///
/// Inserts (start round, record stroke) write the in-memory record and save
/// it. Mutations of EXISTING rows instead go through the store's column-level
/// read-modify-write helpers and re-adopt the returned row — never a full-row
/// save of the in-memory snapshot, which may predate the sync engine's
/// serverId/syncState assignment (writing it back would reset the row to
/// `.pending` and re-push a duplicate `rounds/start`). A failed DB write logs
/// and keeps the in-memory value — capture is never blocked
/// (docs/feature-shot-capture.md §4, offline-first).
@MainActor
@Observable
final class RoundModel {

    let courseId: String
    /// Course holes (par lookup for the scorecard), sorted by number.
    private let holes: [HoleRecord]
    @ObservationIgnored private let database: AppDatabase
    /// Sync engine to kick after each write; nil in tests that only exercise
    /// the local path.
    @ObservationIgnored private let sync: RoundSyncService?

    /// The active round, nil when none is running on this course.
    private(set) var round: RoundRecord?
    /// The active round's strokes, ordered (holeNumber, sortOrder).
    private(set) var shots: [ShotRecord] = []

    init(
        courseId: String,
        holes: [HoleRecord],
        database: AppDatabase,
        sync: RoundSyncService? = nil
    ) {
        self.courseId = courseId
        self.holes = holes.sorted { $0.number < $1.number }
        self.database = database
        self.sync = sync
    }

    var hasActiveRound: Bool { round != nil }

    // MARK: - Lifecycle

    /// Resumes the course's active round (if any) after screen open / app
    /// restart. No-op when none exists.
    func loadActiveRound() async {
        guard round == nil else { return }
        guard let active = try? await database.activeRound(courseId: courseId) else { return }
        round = active
        shots = (try? await database.shots(roundId: active.id)) ?? []
    }

    /// Starts a round, snapshotting the plan link + plan-level wind
    /// (docs/feature-shot-capture.md §3: round-level conditions snapshot).
    /// One active round max per course: an existing active round is resumed,
    /// not duplicated.
    @discardableResult
    func startRound(
        gamePlanId: String? = nil,
        wind: (speedMps: Double, directionDeg: Double)? = nil,
        stimpFt: Double? = nil
    ) async -> RoundRecord? {
        if round == nil {
            // A round might exist from a previous session even if the screen
            // never called loadActiveRound.
            await loadActiveRound()
        }
        if let round { return round }

        // R6: default the round's green speed from the most recent round at
        // this course that recorded one, else the caller's app-default seed
        // (`AppSettings.defaultStimpFt`). One field on round start.
        let previousStimp = (try? await database.rounds(courseId: courseId))?
            .first { $0.stimpFt != nil }?.stimpFt

        let record = RoundRecord(
            courseId: courseId,
            startedAt: Self.timestamp(),
            gamePlanId: gamePlanId,
            windSpeedMps: wind?.speedMps,
            windDirectionDeg: wind?.directionDeg,
            stimpFt: previousStimp ?? stimpFt
        )
        round = record
        shots = []
        await persistRound(record)
        return record
    }

    /// Set the active round's green speed (round-loop R6 — the one per-round
    /// stimp field, adjusted from the green view's stimp control). Persisted
    /// with the local round record; no-op when unchanged or no round is active.
    ///
    /// The `syncState` is deliberately NOT flipped: the seed value rides the
    /// `rounds/start` push, and every finished round gets a `rounds/end` push
    /// (`finishRound` flips synced→dirty) that carries the final stimp — so a
    /// mid-round tweak never queues a spurious push and still reaches the
    /// server. Stimp is only editable while the round is active, so there is
    /// no post-end edit to lose.
    @discardableResult
    func setStimp(_ value: Double) async -> RoundRecord? {
        guard var record = round, record.stimpFt != value else { return round }
        record.stimpFt = value
        round = record
        do {
            if let updated = try await database.updateRoundStimp(id: record.id, stimpFt: value) {
                // Adopt the fresh row — it carries any serverId/syncState the
                // sync engine assigned since our snapshot.
                if round?.id == updated.id { round = updated }
            } else {
                // Row missing (the start-time insert failed) — recreate it.
                try await database.saveRound(record)
            }
        } catch {
            print("Round store stimp write failed (kept in memory): \(error)")
        }
        return round
    }

    /// Finishes the active round (sets `endedAt`, flags it for the server's
    /// `rounds/end`). The scorecard keeps showing it until the screen closes.
    func finishRound() async {
        guard let record = round else { return }
        let endedAt = Self.timestamp()
        round = nil
        do {
            // Column-level against the fresh row — our snapshot may predate
            // sync's serverId assignment, and a full-row save would revert it
            // (duplicating the round server-side, never ending the real one).
            if try await database.finishRound(id: record.id, endedAt: endedAt) == nil {
                // Row missing (the start-time insert failed) — recreate it.
                var fallback = record
                fallback.endedAt = endedAt
                if fallback.syncState == .synced { fallback.syncState = .dirty }
                try await database.saveRound(fallback)
            }
        } catch {
            print("Round store write failed (kept in memory): \(error)")
        }
        kickSync()
    }

    // MARK: - Strokes

    /// Appends a stroke recorded AT `position` (played FROM — §2). Returns
    /// the written record for the capture panel's confirmed state.
    @discardableResult
    func recordStroke(
        holeNumber: Int,
        position: LatLon,
        clubId: String?,
        shotType: ShotType,
        target: LatLon?
    ) async -> ShotRecord? {
        guard let round else { return nil }
        let record = ShotRecord(
            roundId: round.id,
            holeNumber: holeNumber,
            sortOrder: strokeCount(holeNumber: holeNumber),
            lat: position.lat,
            lon: position.lon,
            clubId: clubId,
            shotType: shotType,
            targetLat: target?.lat,
            targetLon: target?.lon,
            recordedAt: Self.timestamp()
        )
        shots.append(record)
        shots.sort { ($0.holeNumber, $0.sortOrder) < ($1.holeNumber, $1.sortOrder) }
        await persistShot(record)
        return record
    }

    /// +1 penalty on a stroke (the capture panel's stepper on the
    /// just-confirmed stroke; also the scorecard editor's path).
    @discardableResult
    func addPenalty(shotId: String) async -> ShotRecord? {
        guard let current = shots.first(where: { $0.id == shotId }) else { return nil }
        return await updateStroke(id: shotId, penaltyStrokes: current.penaltyStrokes + 1)
    }

    /// After-the-fact edit (scorecard): club, type and/or penalty count.
    /// Unspecified fields keep their value.
    @discardableResult
    func updateStroke(
        id: String,
        clubId: String?? = nil,
        shotType: ShotType? = nil,
        penaltyStrokes: Int? = nil
    ) async -> ShotRecord? {
        guard shots.contains(where: { $0.id == id }) else { return nil }
        var result: ShotRecord?
        do {
            // Column-level against the fresh row — our snapshot may predate
            // sync's serverId assignment, and a full-row save would revert it
            // (re-adding the stroke server-side on the next flush).
            result = try await database.updateShot(
                id: id, clubId: clubId, shotType: shotType, penaltyStrokes: penaltyStrokes
            )
        } catch {
            print("Shot store write failed (kept in memory): \(error)")
        }
        if result == nil {
            // Degraded path (write threw, or the row is missing after a failed
            // capture-time insert): apply to the snapshot and upsert so the
            // edit still reaches disk when possible.
            guard var shot = shots.first(where: { $0.id == id }) else { return nil }
            if let clubId { shot.clubId = clubId }
            if let shotType { shot.shotType = shotType }
            if let penaltyStrokes { shot.penaltyStrokes = max(0, penaltyStrokes) }
            if shot.syncState == .synced { shot.syncState = .dirty }
            try? await database.saveShot(shot)
            result = shot
        }
        guard let updated = result else { return nil }
        // Re-find the index: the list can shift across the await.
        if let index = shots.firstIndex(where: { $0.id == id }) { shots[index] = updated }
        kickSync()
        return updated
    }

    /// Deletes a stroke (scorecard editor). Later strokes on the hole keep
    /// their sortOrder — order stays monotonic, which is all §2 needs.
    func deleteStroke(id: String) async {
        guard let index = shots.firstIndex(where: { $0.id == id }) else { return }
        shots.remove(at: index)
        do {
            try await database.deleteShot(id: id)
        } catch {
            print("Round store delete failed (kept in memory): \(error)")
        }
        kickSync()
    }

    // MARK: - Reads

    /// Recorded strokes on a hole so far (hole-nav badge + capture ordinal).
    func strokeCount(holeNumber: Int) -> Int {
        shots.count { $0.holeNumber == holeNumber }
    }

    /// Strokes of one hole in order (scorecard editor).
    func strokes(holeNumber: Int) -> [ShotRecord] {
        shots.filter { $0.holeNumber == holeNumber }
    }

    /// The current scorecard over the active round.
    var scorecard: Scorecard {
        Scorecard.build(holes: holes, shots: shots)
    }

    // MARK: - Persistence plumbing

    private func persistRound(_ record: RoundRecord) async {
        do {
            try await database.saveRound(record)
        } catch {
            print("Round store write failed (kept in memory): \(error)")
        }
        kickSync()
    }

    private func persistShot(_ record: ShotRecord) async {
        do {
            try await database.saveShot(record)
        } catch {
            print("Shot store write failed (kept in memory): \(error)")
        }
        kickSync()
    }

    private func kickSync() {
        guard let sync else { return }
        Task { await sync.flush() }
    }

    private static func timestamp(_ date: Date = Date()) -> String {
        date.ISO8601Format()
    }
}
