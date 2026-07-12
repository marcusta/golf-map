import XCTest
import GRDB
@testable import GolfMap

/// The v3 schema (rounds + shots): migration, active-round resume, ordered
/// reads, the delete/tombstone rule, and the sync-queue queries.
final class RoundStoreTests: XCTestCase {

    private func makeRound(
        id: String = "r1",
        courseId: String = "course-1",
        startedAt: String = "2026-07-12T09:00:00Z",
        endedAt: String? = nil,
        syncState: RoundSyncState = .pending
    ) -> RoundRecord {
        RoundRecord(
            id: id,
            courseId: courseId,
            startedAt: startedAt,
            endedAt: endedAt,
            gamePlanId: "plan-1",
            windSpeedMps: 4,
            windDirectionDeg: 210,
            syncState: syncState
        )
    }

    private func makeShot(
        id: String,
        roundId: String = "r1",
        hole: Int = 1,
        order: Int = 0,
        recordedAt: String = "2026-07-12T09:05:00Z",
        serverId: String? = nil,
        syncState: RoundSyncState = .pending
    ) -> ShotRecord {
        ShotRecord(
            id: id,
            serverId: serverId,
            roundId: roundId,
            holeNumber: hole,
            sortOrder: order,
            lat: 58.351,
            lon: 15.721,
            clubId: "club-7i",
            shotType: .full,
            targetLat: 58.353,
            targetLon: 15.723,
            recordedAt: recordedAt,
            syncState: syncState
        )
    }

    func testMigrationCreatesRoundAndShotTables() throws {
        let database = try AppDatabase.inMemory()
        let tables = try database.dbQueue.read { db in
            try String.fetchAll(
                db,
                sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        }
        for expected in ["round", "shot"] {
            XCTAssertTrue(tables.contains(expected), "missing table \(expected)")
        }
    }

    func testRoundsDoNotRequireACourseRow() async throws {
        // Rounds are user data — they must survive without (and outlive) the
        // course bundle cache, so no FK to `course`.
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound())
        let active = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(active?.id, "r1")
    }

    func testActiveRoundIsTheUnendedOnePerCourse() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound(
            id: "r-done", startedAt: "2026-07-10T09:00:00Z",
            endedAt: "2026-07-10T13:00:00Z", syncState: .synced
        ))
        let noneActive = try await database.activeRound(courseId: "course-1")
        XCTAssertNil(noneActive)

        try await database.saveRound(makeRound(id: "r-live"))
        let active = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(active?.id, "r-live", "resume finds the unended round")
        let otherCourse = try await database.activeRound(courseId: "other-course")
        XCTAssertNil(otherCourse, "active rounds are per course")
    }

    func testShotsReadOrderedByHoleThenSortOrder() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound())
        // Inserted out of order on purpose.
        try await database.saveShot(makeShot(id: "s3", hole: 2, order: 0))
        try await database.saveShot(makeShot(id: "s2", hole: 1, order: 1))
        try await database.saveShot(makeShot(id: "s1", hole: 1, order: 0))

        let shots = try await database.shots(roundId: "r1")
        XCTAssertEqual(shots.map(\.id), ["s1", "s2", "s3"])
        XCTAssertEqual(shots[0].shotType, .full)
        XCTAssertEqual(shots[0].target, LatLon(lat: 58.353, lon: 15.723))
    }

    func testDeleteBeforeSyncHardDeletes() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound())
        try await database.saveShot(makeShot(id: "s1"))

        try await database.deleteShot(id: "s1")

        let remaining = try await database.dbQueue.read { db in
            try ShotRecord.fetchCount(db)
        }
        XCTAssertEqual(remaining, 0, "a shot the server never saw leaves no tombstone")
    }

    func testDeleteAfterSyncLeavesATombstone() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound(syncState: .synced))
        try await database.saveShot(makeShot(id: "s1", serverId: "srv-1", syncState: .synced))

        try await database.deleteShot(id: "s1")

        // Hidden from the live read, but still queued for the server delete.
        let visible = try await database.shots(roundId: "r1")
        XCTAssertTrue(visible.isEmpty)
        let queued = try await database.shotsNeedingSync(roundId: "r1")
        XCTAssertEqual(queued.map(\.id), ["s1"])
        XCTAssertEqual(queued[0].syncState, .deleted)

        try await database.hardDeleteShot(id: "s1")
        let remaining = try await database.dbQueue.read { db in
            try ShotRecord.fetchCount(db)
        }
        XCTAssertEqual(remaining, 0)
    }

    func testDeletingARoundCascadesToItsShots() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound())
        try await database.saveShot(makeShot(id: "s1"))
        _ = try await database.dbQueue.write { db in
            try RoundRecord.deleteOne(db, key: "r1")
        }
        let remaining = try await database.dbQueue.read { db in
            try ShotRecord.fetchCount(db)
        }
        XCTAssertEqual(remaining, 0)
    }

    func testRoundsNeedingSyncIncludesSyncedRoundsWithUnsyncedShots() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound(id: "r-clean", syncState: .synced))
        try await database.saveRound(makeRound(
            id: "r-dirty-shots", startedAt: "2026-07-12T10:00:00Z", syncState: .synced
        ))
        try await database.saveRound(makeRound(
            id: "r-pending", startedAt: "2026-07-12T11:00:00Z"
        ))
        try await database.saveShot(makeShot(id: "s1", roundId: "r-dirty-shots"))

        let queue = try await database.roundsNeedingSync()
        XCTAssertEqual(
            queue.map(\.id), ["r-dirty-shots", "r-pending"],
            "startedAt order; fully synced rounds are skipped"
        )
    }

    func testShotsNeedingSyncOrderedByCaptureTime() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveRound(makeRound())
        try await database.saveShot(makeShot(
            id: "s-late", hole: 2, order: 0, recordedAt: "2026-07-12T10:00:00Z"
        ))
        try await database.saveShot(makeShot(
            id: "s-early", hole: 1, order: 0, recordedAt: "2026-07-12T09:10:00Z"
        ))
        try await database.saveShot(makeShot(
            id: "s-synced", hole: 1, order: 1,
            recordedAt: "2026-07-12T09:20:00Z", serverId: "srv", syncState: .synced
        ))

        let queue = try await database.shotsNeedingSync(roundId: "r1")
        XCTAssertEqual(queue.map(\.id), ["s-early", "s-late"])
    }
}
