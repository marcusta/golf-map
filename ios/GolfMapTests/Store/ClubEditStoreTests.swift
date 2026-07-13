import XCTest
import GRDB
@testable import GolfMap

/// The v6 writable club bag: migration columns, dirty-flag transitions, the
/// delete/tombstone rule, order-dirty tracking, and the sync-queue reads
/// `ClubSyncService` relies on. Mirrors `GamePlanEditStoreTests`.
final class ClubEditStoreTests: XCTestCase {

    func testMigrationV6AddsSyncColumnsAndOrderTable() async throws {
        let database = try AppDatabase.inMemory()
        let columns = try await database.dbQueue.read { db in
            try Row.fetchAll(db, sql: "PRAGMA table_info(club)").map { $0["name"] as String }
        }
        for expected in ["serverId", "serverVersion", "syncState"] {
            XCTAssertTrue(columns.contains(expected), "club missing \(expected)")
        }
        let tables = try await database.dbQueue.read { db in
            try String.fetchAll(db, sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        }
        XCTAssertTrue(tables.contains("clubOrderState"))
    }

    func testCreateClubIsPendingAtEndOfBag() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])

        let created = try await database.createClub(name: "3 wood", carryM: 195, dispersionM: 18)
        XCTAssertEqual(created.sortOrder, 1)
        XCTAssertEqual(created.syncState, .pending)
        XCTAssertNil(created.serverId)

        let all = try await database.allClubs()
        XCTAssertEqual(all.map(\.id), ["c1", created.id])
    }

    func testUpdateSyncedClubBecomesDirtyPendingStaysPending() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        let pending = try await database.createClub(name: "3 wood", carryM: 195, dispersionM: 18)

        let updated = try await database.updateClub(id: "c1") { $0.carryM = 220 }
        XCTAssertEqual(updated?.syncState, .dirty)
        XCTAssertEqual(updated?.carryM ?? 0, 220, accuracy: 1e-9)

        let stillPending = try await database.updateClub(id: pending.id) { $0.carryM = 200 }
        XCTAssertEqual(stillPending?.syncState, .pending, "never-pushed row stays pending")
    }

    func testDeletePendingClubHardDeletes() async throws {
        let database = try AppDatabase.inMemory()
        let created = try await database.createClub(name: "3 wood", carryM: 195, dispersionM: 18)
        try await database.deleteClub(id: created.id)

        let remaining = try await database.dbQueue.read { try ClubRecord.fetchCount($0) }
        XCTAssertEqual(remaining, 0, "a club the server never saw leaves no tombstone")
    }

    func testDeleteSyncedClubTombstonesThenHardDeletes() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        try await database.deleteClub(id: "c1")

        let queued = try await database.clubsNeedingSync()
        XCTAssertEqual(queued.map(\.syncState), [.deleted])
        // Tombstoned rows are hidden from the viewer.
        let visible = try await database.allClubs()
        XCTAssertTrue(visible.isEmpty)

        try await database.hardDeleteClub(id: "c1")
        let remaining = try await database.dbQueue.read { try ClubRecord.fetchCount($0) }
        XCTAssertEqual(remaining, 0)
    }

    func testClubsNeedingSyncOrderedBySortOrder() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        _ = try await database.createClub(name: "Second", carryM: 150, dispersionM: 12)
        _ = try await database.createClub(name: "Third", carryM: 100, dispersionM: 8)
        try await database.updateClub(id: "c1") { $0.carryM = 218 }

        let queued = try await database.clubsNeedingSync()
        XCTAssertEqual(queued.map(\.name), ["Driver", "Second", "Third"])
    }

    func testSyncedBagHasNoPendingEdits() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        let hasPending = try await database.hasPendingClubEdits()
        XCTAssertFalse(hasPending)
    }

    func testDirtyRowMeansPendingEdits() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
        ])
        try await database.updateClub(id: "c1") { $0.carryM = 218 }
        let hasPending = try await database.hasPendingClubEdits()
        XCTAssertTrue(hasPending)
    }

    func testReorderMarksOrderDirtyAndReassignsSortOrder() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveClubs([
            ClubRecord(id: "c1", name: "Driver", carryM: 215, dispersionM: 22, sortOrder: 0, serverId: "c1", syncState: .synced),
            ClubRecord(id: "c2", name: "7 iron", carryM: 145, dispersionM: 10, sortOrder: 1, serverId: "c2", syncState: .synced),
        ])
        var dirty = try await database.clubOrderDirty()
        XCTAssertFalse(dirty)

        try await database.reorderClubs(orderedIds: ["c2", "c1"])

        dirty = try await database.clubOrderDirty()
        XCTAssertTrue(dirty)
        let hasPending = try await database.hasPendingClubEdits()
        XCTAssertTrue(hasPending, "order-dirty counts as a pending edit even with no dirty rows")

        let ordered = try await database.allClubs()
        XCTAssertEqual(ordered.map(\.id), ["c2", "c1"])

        try await database.clearClubOrderDirty()
        dirty = try await database.clubOrderDirty()
        XCTAssertFalse(dirty)
    }
}
