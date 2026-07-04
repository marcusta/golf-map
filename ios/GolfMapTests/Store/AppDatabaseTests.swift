import XCTest
import GRDB
@testable import GolfMap

final class AppDatabaseTests: XCTestCase {
    func testMigrationCreatesAllTables() throws {
        let database = try AppDatabase.inMemory()
        let tables = try database.dbQueue.read { db in
            try String.fetchAll(
                db,
                sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        }
        for expected in ["course", "hole", "tee", "green", "pin", "aimPoint", "tileManifest"] {
            XCTAssertTrue(tables.contains(expected), "missing table \(expected)")
        }
    }

    func testMigrationIsIdempotentOnExistingDatabase() throws {
        let queue = try DatabaseQueue()
        _ = try AppDatabase(queue)
        // Re-running the migrator against the same queue must be a no-op.
        XCTAssertNoThrow(try AppDatabase(queue))
    }

    func testFurnitureRoundTrip() async throws {
        let database = try AppDatabase.inMemory()
        let furniture = StoreFixtures.furniture()

        try await database.saveCompletedBundle(furniture)

        let loaded = try await database.courseFurniture(courseId: furniture.course.id)
        let unwrapped = try XCTUnwrap(loaded)

        // saveCompletedBundle stamps state/revision; compare against that.
        var expectedCourse = furniture.course
        expectedCourse.bundleState = .complete
        expectedCourse.downloadedRevision = expectedCourse.revision

        XCTAssertEqual(unwrapped.course, expectedCourse)
        XCTAssertEqual(unwrapped.holes, furniture.holes)
        XCTAssertEqual(unwrapped.tees, furniture.tees)
        XCTAssertEqual(unwrapped.greens, furniture.greens)
        XCTAssertEqual(unwrapped.pins, furniture.pins)
        XCTAssertEqual(unwrapped.aimPoints, furniture.aimPoints)
        XCTAssertEqual(unwrapped.manifest, furniture.manifest)
    }

    func testSaveCompletedBundleReplacesPreviousFurniture() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture(revision: 3))

        // New revision with a different hole set.
        var updated = StoreFixtures.furniture(revision: 4, versionParam: "ver2")
        updated.holes = [
            HoleRecord(id: "course-1-h9", courseId: "course-1", number: 9, par: 5)
        ]
        updated.tees = []
        updated.greens = []
        updated.pins = []
        updated.aimPoints = []
        try await database.saveCompletedBundle(updated)

        let fetched = try await database.courseFurniture(courseId: "course-1")
        let loaded = try XCTUnwrap(fetched)
        XCTAssertEqual(loaded.course.downloadedRevision, 4)
        XCTAssertEqual(loaded.holes.map(\.id), ["course-1-h9"])
        XCTAssertTrue(loaded.tees.isEmpty)
        XCTAssertTrue(loaded.pins.isEmpty)
        XCTAssertEqual(loaded.manifest.versionParam, "ver2")
    }

    func testCascadeDeleteWipesAllChildren() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture())

        try await database.deleteCourse(id: "course-1")

        let counts = try await database.dbQueue.read { db in
            [
                try HoleRecord.fetchCount(db),
                try TeeRecord.fetchCount(db),
                try GreenRecord.fetchCount(db),
                try PinRecord.fetchCount(db),
                try AimPointRecord.fetchCount(db),
                try TileManifestRecord.fetchCount(db),
                try CourseRecord.fetchCount(db),
            ]
        }
        XCTAssertEqual(counts, [0, 0, 0, 0, 0, 0, 0])
    }

    func testMarkDownloadingPreservesDownloadedRevision() async throws {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture(revision: 3))

        // Server now has revision 5; a re-download begins.
        var newer = StoreFixtures.furniture(revision: 5).course
        newer.downloadedRevision = nil // wiring layer doesn't know local state
        try await database.markDownloading(course: newer)

        let fetched = try await database.course(id: "course-1")
        let row = try XCTUnwrap(fetched)
        XCTAssertEqual(row.bundleState, .downloading)
        XCTAssertEqual(row.downloadedRevision, 3, "old bundle revision must survive until promotion")
        XCTAssertEqual(row.revision, 5)
    }

    func testMarkDownloadFailedRestoresStaleOrNone() async throws {
        let database = try AppDatabase.inMemory()

        // Never-downloaded course: -> .none
        let fresh = StoreFixtures.furniture(courseId: "fresh").course
        try await database.markDownloading(course: fresh)
        try await database.markDownloadFailed(courseId: "fresh")
        let freshFetched = try await database.course(id: "fresh")
        let freshRow = try XCTUnwrap(freshFetched)
        XCTAssertEqual(freshRow.bundleState, BundleState.none)

        // Previously complete course: -> .stale
        try await database.saveCompletedBundle(StoreFixtures.furniture(courseId: "old"))
        try await database.markDownloading(course: StoreFixtures.furniture(courseId: "old", revision: 9).course)
        try await database.markDownloadFailed(courseId: "old")
        let oldFetched = try await database.course(id: "old")
        let oldRow = try XCTUnwrap(oldFetched)
        XCTAssertEqual(oldRow.bundleState, .stale)
        XCTAssertEqual(oldRow.downloadedRevision, 3)
    }

    func testForeignKeyRejectsOrphanRows() async throws {
        let database = try AppDatabase.inMemory()
        await XCTAssertThrowsErrorAsync(
            try await database.dbQueue.write { db in
                try HoleRecord(id: "orphan", courseId: "nope", number: 1, par: 4).insert(db)
            }
        )
    }
}

/// XCTAssertThrowsError for async expressions.
func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("expected error", file: file, line: line)
    } catch {
        // expected
    }
}
