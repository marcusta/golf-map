import Foundation
import Observation

/// Backs the round lifecycle + stroke capture for one open course: the active
/// round (resumed across app restarts from GRDB — `endedAt == nil` IS the
/// persistence of "active"), the in-memory stroke list the UI reads, and the
/// local-first writes.
///
/// Every mutation follows the same shape: update the in-memory state
/// synchronously (the UI must never wait on I/O), persist to GRDB, then kick
/// the sync engine. A failed DB write logs and keeps the in-memory value —
/// capture is never blocked (docs/feature-shot-capture.md §4, offline-first).
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
    /// The `syncState` is deliberately NOT flipped: stimp is device-local (no
    /// server column yet), so a synced round stays synced and a stimp tweak
    /// never queues a spurious push — the value degrades gracefully out of sync.
    @discardableResult
    func setStimp(_ value: Double) async -> RoundRecord? {
        guard var record = round, record.stimpFt != value else { return round }
        record.stimpFt = value
        round = record
        do {
            try await database.saveRound(record)
        } catch {
            print("Round store stimp write failed (kept in memory): \(error)")
        }
        return record
    }

    /// Finishes the active round (sets `endedAt`, flags it for the server's
    /// `rounds/end`). The scorecard keeps showing it until the screen closes.
    func finishRound() async {
        guard var record = round else { return }
        record.endedAt = Self.timestamp()
        if record.syncState == .synced { record.syncState = .dirty }
        round = nil
        await persistRound(record)
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
        guard let index = shots.firstIndex(where: { $0.id == id }) else { return nil }
        var shot = shots[index]
        if let clubId { shot.clubId = clubId }
        if let shotType { shot.shotType = shotType }
        if let penaltyStrokes { shot.penaltyStrokes = max(0, penaltyStrokes) }
        if shot.syncState == .synced { shot.syncState = .dirty }
        shots[index] = shot
        await persistShot(shot)
        return shot
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
