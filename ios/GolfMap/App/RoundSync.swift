import Foundation

/// Pushes locally captured rounds/shots to the server — the consumer of the
/// `syncState` dirty flags maintained by `AppDatabase`'s round store.
///
/// Design (docs/feature-shot-capture.md §4, "offline-first"):
///  - **Dirty-flag rows, not an ops queue.** The row is the single source of
///    truth; the flag says what the server still needs (`pending` → start/add,
///    `dirty` → end/update, `deleted` → remove-then-hard-delete). No replay
///    ordering to maintain, and repeated local edits coalesce into one push.
///  - **Best-effort, never throws.** Any network/server failure leaves the
///    row's state untouched and is retried on the next trigger (app start,
///    foreground, every capture write). Capture itself only writes GRDB and
///    is never blocked by this engine.
///  - **Capture-order pushes.** Rounds sync oldest-first; a round's pending
///    shots push in `recordedAt` order, and the FIRST add failure stops that
///    round's remaining adds — the server assigns `sortOrder` by insert
///    order, so out-of-order inserts would scramble the stroke sequence.
///  - **Ordering within an entity**: shots can only push once their round has
///    a `serverId`; a failed round start skips that round's shots entirely.
///
/// An `actor` so concurrent triggers can't interleave two flushes (a second
/// call during a flush is dropped — the caller's NEXT trigger picks up
/// whatever it would have pushed).
actor RoundSyncService {
    private let client: GolfAPIClient
    private let database: AppDatabase
    private var isFlushing = false

    init(client: GolfAPIClient, database: AppDatabase) {
        self.client = client
        self.database = database
    }

    /// Pushes everything unsynced. Safe to call from anywhere, any time.
    func flush() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        guard let rounds = try? await database.roundsNeedingSync() else { return }
        for round in rounds {
            await sync(round: round)
        }
    }

    // MARK: - Per-round pipeline

    private func sync(round: RoundRecord) async {
        var round = round

        // 1. The round row itself: start (first push), then end (if ended).
        if round.syncState == .pending {
            guard let started = try? await client.startRound(
                courseId: round.courseId,
                startedAt: round.startedAt,
                gamePlanId: round.gamePlanId,
                windSpeedMps: round.windSpeedMps,
                windDirectionDeg: round.windDirectionDeg,
                stimpFt: round.stimpFt
            ) else { return } // offline/server error → whole round retries later
            round.serverId = started.id
            round.serverVersion = started.version
            round.syncState = round.endedAt == nil ? .synced : .dirty
            guard (try? await database.saveRound(round)) != nil else { return }
        }

        if round.syncState == .dirty, let serverId = round.serverId,
           let endedAt = round.endedAt {
            // stimpFt rides every end push: mid-round stimp edits don't dirty
            // the round (see RoundModel.setStimp) — the end push, which every
            // finished round gets, carries the final value.
            if let ended = try? await client.endRound(
                id: serverId,
                version: round.serverVersion ?? 1,
                endedAt: endedAt,
                stimpFt: round.stimpFt
            ) {
                round.serverVersion = ended.version
                round.syncState = .synced
                try? await database.saveRound(round)
            }
            // End failure is non-fatal for the shots below — they push
            // against the started round; the end retries next flush.
        }

        // 2. The round's shots.
        guard
            let roundServerId = round.serverId,
            let shots = try? await database.shotsNeedingSync(roundId: round.id)
        else { return }

        for shot in shots {
            switch shot.syncState {
            case .pending:
                // Server sortOrder = insert order; a failed add must not let
                // a later stroke jump the queue.
                guard await push(new: shot, roundServerId: roundServerId) else { return }
            case .dirty:
                await push(update: shot)
            case .deleted:
                await push(delete: shot)
            case .synced:
                break
            }
        }
    }

    /// Adds a pending shot; returns false on failure (stop this round's adds).
    private func push(new shot: ShotRecord, roundServerId: String) async -> Bool {
        guard let added = try? await client.addShot(
            roundId: roundServerId,
            holeNumber: shot.holeNumber,
            lat: shot.lat,
            lon: shot.lon,
            clubId: shot.clubId,
            shotType: shot.shotType.rawValue,
            targetLat: shot.targetLat,
            targetLon: shot.targetLon,
            penaltyStrokes: shot.penaltyStrokes,
            recordedAt: shot.recordedAt
        ) else { return false }
        var shot = shot
        shot.serverId = added.id
        shot.serverVersion = added.version
        shot.syncState = .synced
        return (try? await database.saveShot(shot)) != nil
    }

    private func push(update shot: ShotRecord) async {
        guard let serverId = shot.serverId else { return }
        guard let updated = try? await client.updateShot(
            id: serverId,
            version: shot.serverVersion ?? 1,
            lat: shot.lat,
            lon: shot.lon,
            holeNumber: shot.holeNumber,
            clubId: shot.clubId,
            shotType: shot.shotType.rawValue,
            targetLat: shot.targetLat,
            targetLon: shot.targetLon,
            penaltyStrokes: shot.penaltyStrokes
        ) else { return }
        var shot = shot
        shot.serverVersion = updated.version
        shot.syncState = .synced
        try? await database.saveShot(shot)
    }

    private func push(delete shot: ShotRecord) async {
        guard let serverId = shot.serverId else {
            // Never reached the server — the store hard-deletes these
            // directly, but guard anyway.
            try? await database.hardDeleteShot(id: shot.id)
            return
        }
        guard (try? await client.removeShot(id: serverId, version: shot.serverVersion ?? 1)) != nil
        else { return }
        try? await database.hardDeleteShot(id: shot.id)
    }
}
