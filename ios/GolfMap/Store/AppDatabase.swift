import Foundation
import GRDB

/// The on-device SQLite database for offline course bundles.
///
/// Wraps a GRDB `DatabaseQueue` and owns the schema (migrations) plus the
/// handful of writes/reads the Store layer needs. Higher layers (wiring, UI)
/// talk to this type and `BundleDownloader`; they never touch SQL directly.
public struct AppDatabase: Sendable {
    public let dbQueue: DatabaseQueue

    /// Wraps an existing queue and brings it up to the current schema.
    public init(_ dbQueue: DatabaseQueue) throws {
        self.dbQueue = dbQueue
        try Self.migrator.migrate(dbQueue)
    }

    /// The production database at Application Support/golfmap.sqlite.
    public static func onDisk() throws -> AppDatabase {
        let supportDir = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dbURL = supportDir.appending(path: "golfmap.sqlite")
        return try AppDatabase(DatabaseQueue(path: dbURL.path))
    }

    /// An in-memory database for tests.
    public static func inMemory() throws -> AppDatabase {
        try AppDatabase(DatabaseQueue())
    }

    // MARK: - Schema

    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        migrator.registerMigration("v1") { db in
            try db.create(table: "course") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("status", .text).notNull()
                t.column("revision", .integer).notNull()
                t.column("downloadedRevision", .integer)
                t.column("homeLat", .double)
                t.column("homeLon", .double)
                t.column("updatedAt", .text).notNull()
                t.column("bundleState", .text).notNull().defaults(to: BundleState.none.rawValue)
            }

            try db.create(table: "hole") { t in
                t.primaryKey("id", .text)
                t.column("courseId", .text).notNull().indexed()
                    .references("course", onDelete: .cascade)
                t.column("number", .integer).notNull()
                t.column("par", .integer).notNull()
                t.column("strokeIndex", .integer)
            }

            try db.create(table: "tee") { t in
                t.primaryKey("id", .text)
                t.column("holeId", .text).notNull().indexed()
                    .references("hole", onDelete: .cascade)
                t.column("name", .text).notNull()
                t.column("color", .text)
                t.column("lat", .double).notNull()
                t.column("lon", .double).notNull()
                t.column("elevation", .double)
                t.column("sortOrder", .integer).notNull()
            }

            try db.create(table: "green") { t in
                t.primaryKey("id", .text)
                // UNIQUE also gives us the lookup index for the FK.
                t.column("holeId", .text).notNull().unique()
                    .references("hole", onDelete: .cascade)
                t.column("centerLat", .double).notNull()
                t.column("centerLon", .double).notNull()
                t.column("frontLat", .double)
                t.column("frontLon", .double)
                t.column("backLat", .double)
                t.column("backLon", .double)
                t.column("elevation", .double)
            }

            try db.create(table: "pin") { t in
                t.primaryKey("id", .text)
                t.column("greenId", .text).notNull().indexed()
                    .references("green", onDelete: .cascade)
                t.column("name", .text).notNull()
                t.column("lat", .double).notNull()
                t.column("lon", .double).notNull()
                t.column("difficulty", .text)
                t.column("active", .integer).notNull()
            }

            try db.create(table: "aimPoint") { t in
                t.primaryKey("id", .text)
                t.column("holeId", .text).notNull().indexed()
                    .references("hole", onDelete: .cascade)
                t.column("sortOrder", .integer).notNull()
                t.column("lat", .double).notNull()
                t.column("lon", .double).notNull()
                t.column("elevation", .double)
                t.column("label", .text)
            }

            try db.create(table: "tileManifest") { t in
                t.primaryKey("courseId", .text)
                    .references("course", onDelete: .cascade)
                t.column("west", .double).notNull()
                t.column("south", .double).notNull()
                t.column("east", .double).notNull()
                t.column("north", .double).notNull()
                t.column("orthoMinZoom", .integer).notNull()
                t.column("orthoMaxZoom", .integer).notNull()
                t.column("terrainMinZoom", .integer).notNull()
                t.column("terrainMaxZoom", .integer).notNull()
                t.column("elevMin", .double).notNull()
                t.column("elevMax", .double).notNull()
                t.column("generatedAt", .text).notNull()
                t.column("versionParam", .text).notNull()
            }
        }

        return migrator
    }

    // MARK: - Reads

    public func allCourses() async throws -> [CourseRecord] {
        try await dbQueue.read { db in
            try CourseRecord.order(Column("name")).fetchAll(db)
        }
    }

    public func course(id: String) async throws -> CourseRecord? {
        try await dbQueue.read { db in
            try CourseRecord.fetchOne(db, key: id)
        }
    }

    /// Local per-course sync state, as input to `SyncPlanner.plan`.
    public func localCourseSummaries() async throws -> [LocalCourseSummary] {
        try await dbQueue.read { db in
            try CourseRecord.fetchAll(db).map {
                LocalCourseSummary(
                    id: $0.id,
                    downloadedRevision: $0.downloadedRevision,
                    bundleState: $0.bundleState
                )
            }
        }
    }

    /// The full furniture set for a downloaded course, or nil if the course
    /// (or its manifest) isn't stored.
    public func courseFurniture(courseId: String) async throws -> CourseFurniture? {
        try await dbQueue.read { db in
            guard
                let course = try CourseRecord.fetchOne(db, key: courseId),
                let manifest = try TileManifestRecord.fetchOne(db, key: courseId)
            else { return nil }

            let holes = try HoleRecord
                .filter(Column("courseId") == courseId)
                .order(Column("number"))
                .fetchAll(db)
            let holeIds = holes.map(\.id)
            let tees = try TeeRecord
                .filter(holeIds.contains(Column("holeId")))
                .order(Column("holeId"), Column("sortOrder"))
                .fetchAll(db)
            let greens = try GreenRecord
                .filter(holeIds.contains(Column("holeId")))
                .fetchAll(db)
            let greenIds = greens.map(\.id)
            let pins = try PinRecord
                .filter(greenIds.contains(Column("greenId")))
                .fetchAll(db)
            let aimPoints = try AimPointRecord
                .filter(holeIds.contains(Column("holeId")))
                .order(Column("holeId"), Column("sortOrder"))
                .fetchAll(db)

            return CourseFurniture(
                course: course,
                holes: holes,
                tees: tees,
                greens: greens,
                pins: pins,
                aimPoints: aimPoints,
                manifest: manifest
            )
        }
    }

    // MARK: - Writes

    /// Upserts the course row with `bundleState = .downloading`, preserving
    /// any previously downloaded revision (the old bundle stays usable on
    /// disk until the new one is promoted).
    public func markDownloading(course: CourseRecord) async throws {
        try await dbQueue.write { db in
            var row = course
            let existing = try CourseRecord.fetchOne(db, key: course.id)
            row.downloadedRevision = existing?.downloadedRevision
            row.bundleState = .downloading
            try row.save(db)
        }
    }

    /// Resets bundle state after a failed/cancelled download: back to `.stale`
    /// if an older complete bundle exists, `.none` otherwise.
    public func markDownloadFailed(courseId: String) async throws {
        try await dbQueue.write { db in
            guard var row = try CourseRecord.fetchOne(db, key: courseId) else { return }
            row.bundleState = row.downloadedRevision == nil ? BundleState.none : .stale
            try row.save(db)
        }
    }

    /// Atomically replaces all furniture for the course and marks the bundle
    /// complete (`downloadedRevision = course.revision`). Called by the
    /// downloader only after all files are in their final location.
    public func saveCompletedBundle(_ furniture: CourseFurniture) async throws {
        try await dbQueue.write { db in
            var course = furniture.course
            course.downloadedRevision = course.revision
            course.bundleState = .complete
            try course.save(db)

            // Cascades wipe tees/greens/pins/aimPoints.
            try HoleRecord.filter(Column("courseId") == course.id).deleteAll(db)
            try TileManifestRecord.deleteOne(db, key: course.id)

            for hole in furniture.holes { try hole.insert(db) }
            for tee in furniture.tees { try tee.insert(db) }
            for green in furniture.greens { try green.insert(db) }
            for pin in furniture.pins { try pin.insert(db) }
            for aimPoint in furniture.aimPoints { try aimPoint.insert(db) }
            try furniture.manifest.insert(db)
        }
    }

    /// Deletes the course row (cascades to all children + manifest).
    /// File cleanup is separate — see `BundleDownloader.deleteBundle`.
    public func deleteCourse(id: String) async throws {
        _ = try await dbQueue.write { db in
            try CourseRecord.deleteOne(db, key: id)
        }
    }
}
