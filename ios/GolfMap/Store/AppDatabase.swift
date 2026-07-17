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

        // v2: read-only game-plan viewer — locally cached game plans + club bag
        // (fetched on course open, read offline). No server `version` columns:
        // the device never edits these rows.
        migrator.registerMigration("v2") { db in
            try db.create(table: "club") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("carryM", .double).notNull()
                t.column("dispersionM", .double).notNull()
                t.column("sortOrder", .integer).notNull()
            }

            try db.create(table: "gamePlan") { t in
                t.primaryKey("id", .text)
                // One plan per course. Removing downloaded map data keeps the
                // course row (and therefore the plan) intact.
                t.column("courseId", .text).notNull().unique()
                    .references("course", onDelete: .cascade)
                t.column("windSpeedMps", .double)
                t.column("windDirectionDeg", .double)
            }

            try db.create(table: "gamePlanHole") { t in
                t.primaryKey("id", .text)
                t.column("gamePlanId", .text).notNull().indexed()
                    .references("gamePlan", onDelete: .cascade)
                t.column("holeNumber", .integer).notNull()
                t.column("teeId", .text)
                t.column("preferredClubId", .text)
                t.column("plannedDirectionDeg", .double)
                t.column("windSpeedMps", .double)
                t.column("windDirectionDeg", .double)
                t.column("notes", .text)
            }

            try db.create(table: "planShot") { t in
                t.primaryKey("id", .text)
                t.column("gamePlanHoleId", .text).notNull().indexed()
                    .references("gamePlanHole", onDelete: .cascade)
                t.column("sortOrder", .integer).notNull()
                t.column("lat", .double).notNull()
                t.column("lon", .double).notNull()
                t.column("elevation", .double)
                t.column("clubId", .text)
                t.column("label", .text)
            }

            try db.create(table: "planGate") { t in
                t.primaryKey("id", .text)
                t.column("gamePlanHoleId", .text).notNull().indexed()
                    .references("gamePlanHole", onDelete: .cascade)
                t.column("sortOrder", .integer).notNull()
                t.column("lat", .double).notNull()
                t.column("lon", .double).notNull()
                t.column("directionDeg", .double).notNull()
                t.column("halfWidthLeftM", .double).notNull()
                t.column("halfWidthRightM", .double).notNull()
                t.column("source", .text).notNull()
            }
        }

        // v3: on-course shot capture (docs/feature-shot-capture.md §2/§4) —
        // locally recorded rounds + strokes with a dirty-flag sync queue.
        // These are USER DATA (device is the writer), so unlike v1/v2 they
        // carry local UUID primary keys + nullable server ids, and rounds
        // deliberately do NOT reference `course`: deleting/refreshing a
        // bundle must never destroy recorded rounds.
        migrator.registerMigration("v3") { db in
            try db.create(table: "round") { t in
                t.primaryKey("id", .text)
                t.column("serverId", .text)
                t.column("courseId", .text).notNull().indexed()
                t.column("startedAt", .text).notNull()
                t.column("endedAt", .text)
                t.column("gamePlanId", .text)
                t.column("windSpeedMps", .double)
                t.column("windDirectionDeg", .double)
                t.column("serverVersion", .integer)
                t.column("syncState", .text).notNull()
                    .defaults(to: RoundSyncState.pending.rawValue)
            }

            try db.create(table: "shot") { t in
                t.primaryKey("id", .text)
                t.column("serverId", .text)
                t.column("roundId", .text).notNull().indexed()
                    .references("round", onDelete: .cascade)
                t.column("holeNumber", .integer).notNull()
                t.column("sortOrder", .integer).notNull()
                t.column("lat", .double).notNull()
                t.column("lon", .double).notNull()
                t.column("clubId", .text)
                t.column("shotType", .text).notNull()
                    .defaults(to: ShotType.full.rawValue)
                t.column("targetLat", .double)
                t.column("targetLon", .double)
                t.column("penaltyStrokes", .integer).notNull().defaults(to: 0)
                t.column("recordedAt", .text).notNull()
                t.column("serverVersion", .integer)
                t.column("syncState", .text).notNull()
                    .defaults(to: RoundSyncState.pending.rawValue)
            }
        }

        // v4: read-only per-green calibration cache — the read side of the
        // green-scan round-trip (docs/feature-putting-green-reading.md §4.2).
        // Fetched on course open like the game plan, consumed offline by the
        // putt read. FK to `course`; removing downloaded map data deliberately
        // retains both rows. No server
        // version column (the device never edits these rows).
        migrator.registerMigration("v4") { db in
            try db.create(table: "greenCalibration") { t in
                // Keyed by the server green ROW id (one calibration per green).
                t.primaryKey("greenId", .text)
                t.column("courseId", .text).notNull().indexed()
                    .references("course", onDelete: .cascade)
                t.column("confidence", .double).notNull()
                t.column("sampleCount", .double).notNull()
                t.column("biasTiltE", .double)
                t.column("biasTiltN", .double)
            }
        }

        // v5: make the game-plan tree WRITABLE (task T3 — the on-course planner
        // tool edits shots offline). Adds the dirty-flag sync machinery to the
        // v2 plan/hole/shot/gate tables: a nullable `serverId` (server rows keep
        // their server id as the local `id`; device-created rows mint a local
        // UUID and fill `serverId` on push), the server optimistic-lock
        // `serverVersion`, and a `syncState` driving `PlanSyncService`. Existing
        // cached rows default to `synced` with a NULL `serverId` — the next
        // online `GamePlanSync.refresh` backfills the server ids.
        migrator.registerMigration("v5") { db in
            for table in ["gamePlan", "gamePlanHole", "planShot", "planGate"] {
                try db.alter(table: table) { t in
                    t.add(column: "serverId", .text)
                    t.add(column: "serverVersion", .integer)
                    t.add(column: "syncState", .text).notNull()
                        .defaults(to: RoundSyncState.synced.rawValue)
                }
            }
        }

        // v6: make the club bag WRITABLE (task T4 — the on-device club-settings
        // screen edits the bag offline). Adds the same dirty-flag sync columns
        // v5 added to the plan tree; existing cached rows default to `synced`
        // with a NULL `serverId` (the next `GamePlanSync.refresh` backfills
        // them). The bag's *order* is a separate concern from any one row's
        // create/update/delete state — the server only accepts a full
        // `orderedIds` reorder call, so a singleton `clubOrderState` row tracks
        // whether the local order has drifted from the last pushed order.
        migrator.registerMigration("v6") { db in
            try db.alter(table: "club") { t in
                t.add(column: "serverId", .text)
                t.add(column: "serverVersion", .integer)
                t.add(column: "syncState", .text).notNull()
                    .defaults(to: RoundSyncState.synced.rawValue)
            }

            try db.create(table: "clubOrderState") { t in
                t.primaryKey("id", .integer)
                t.column("dirty", .boolean).notNull().defaults(to: false)
            }
        }

        // v7: separate per-course download state from the physical map bundle.
        // A site can contain several courses, all referencing one promoted set
        // of tiles. Course-derived raw/resolved features stay per course.
        // Existing bundles retain mapKey == id.
        migrator.registerMigration("v7") { db in
            try db.alter(table: "course") { t in
                t.add(column: "siteId", .text)
            }

            try db.create(table: "mapBundle") { t in
                t.primaryKey("mapKey", .text)
                t.column("versionParam", .text).notNull()
                t.column("generatedAt", .text).notNull()
            }

            try db.execute(sql: """
                INSERT INTO mapBundle (mapKey, versionParam, generatedAt)
                SELECT course.id, tileManifest.versionParam, tileManifest.generatedAt
                FROM course
                JOIN tileManifest ON tileManifest.courseId = course.id
                WHERE course.downloadedRevision IS NOT NULL
                """)
        }

        // v8: per-round green speed (stimp), the one round-start field of
        // round-loop R6. Defaults from the previous round at the course and
        // feeds the putt read's tour/plays-like figures, replacing the app
        // default. LOCAL-ONLY — the server rounds schema has no stimp column
        // yet, so the value never syncs (dropped from `rounds/start`); nullable
        // so pre-v8 rounds read as "no recorded stimp".
        migrator.registerMigration("v8") { db in
            try db.alter(table: "round") { t in
                t.add(column: "stimpFt", .double)
            }
        }

        // v9 (T32): cache the server's option tree. Existing device rows use
        // the old hole-global sortOrder, so backfill them into the same
        // rank-0 parent chain as server migration 009. New explicit NULL
        // parents remain tee-root sibling options.
        migrator.registerMigration("v9") { db in
            try db.alter(table: "planShot") { t in
                t.add(column: "parentShotId", .text)
            }
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT id, gamePlanHoleId
                    FROM planShot
                    ORDER BY gamePlanHoleId, sortOrder, id
                    """
            )
            var previousByHole: [String: String] = [:]
            for row in rows {
                let id: String = row["id"]
                let holeId: String = row["gamePlanHoleId"]
                try db.execute(
                    sql: "UPDATE planShot SET parentShotId = ?, sortOrder = 0 WHERE id = ?",
                    arguments: [previousByHole[holeId], id]
                )
                previousByHole[holeId] = id
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

    public func mapBundle(mapKey: String) async throws -> MapBundleRecord? {
        try await dbQueue.read { db in
            try MapBundleRecord.fetchOne(db, key: mapKey)
        }
    }

    public func hasCurrentMapBundle(mapKey: String, versionParam: String) async throws -> Bool {
        try await dbQueue.read { db in
            try MapBundleRecord
                .filter(Column("mapKey") == mapKey && Column("versionParam") == versionParam)
                .fetchCount(db) > 0
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
            // Keep pointing at the currently usable map while an update is in
            // flight. This matters for the first post-v7 update: the server
            // supplies a shared siteId, but the old tiles still live under the
            // legacy per-course map key until promotion succeeds.
            if existing?.downloadedRevision != nil {
                row.siteId = existing?.siteId
            }
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
    public func saveCompletedBundle(
        _ furniture: CourseFurniture,
        mapBundle: MapBundleRecord? = nil
    ) async throws {
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
            if let mapBundle { try mapBundle.save(db) }
        }
    }

    /// Permanently deletes the course row (cascades to all children +
    /// manifest). This is not the user-facing downloaded-data removal path;
    /// see `downloadedCourseDataRemovalPlan(courseId:)` and
    /// `commitDownloadedCourseDataRemoval(_:)` for that.
    public func deleteCourse(id: String) async throws {
        _ = try await dbQueue.write { db in
            try CourseRecord.deleteOne(db, key: id)
        }
    }

    /// Describes the filesystem work needed before committing a removal. The
    /// database is intentionally unchanged so a filesystem failure leaves the
    /// removal affordance available for retry.
    public func downloadedCourseDataRemovalPlan(
        courseId: String
    ) async throws -> DownloadedCourseDataRemovalPlan? {
        try await dbQueue.read { db in
            guard let course = try CourseRecord.fetchOne(db, key: courseId) else { return nil }
            let mapKey = course.mapKey
            let otherReferences = try CourseRecord
                .filter(Column("id") != courseId)
                .filter(Column("downloadedRevision") != nil)
                .filter(sql: "COALESCE(siteId, id) = ?", arguments: [mapKey])
                .fetchCount(db)
            return DownloadedCourseDataRemovalPlan(
                courseId: courseId,
                mapKey: mapKey,
                removesMapBundle: otherReferences == 0
            )
        }
    }

    /// Commits a removal after its required filesystem cleanup succeeds.
    public func commitDownloadedCourseDataRemoval(
        _ plan: DownloadedCourseDataRemovalPlan
    ) async throws {
        try await dbQueue.write { db in
            guard var course = try CourseRecord.fetchOne(db, key: plan.courseId) else { return }
            course.downloadedRevision = nil
            course.bundleState = .none
            try course.save(db)

            if plan.removesMapBundle {
                try MapBundleRecord.deleteOne(db, key: plan.mapKey)
            }
        }
    }

    /// Checks whether a former map key is safe to retire after a successful
    /// map-key transition.
    public func mapBundleIsUnreferenced(mapKey: String) async throws -> Bool {
        try await dbQueue.read { db in
            try CourseRecord
                .filter(Column("downloadedRevision") != nil)
                .filter(sql: "COALESCE(siteId, id) = ?", arguments: [mapKey])
                .fetchCount(db) == 0
        }
    }

    /// Removes map metadata only when no downloaded course references it.
    /// Used after successful filesystem cleanup of a former map key.
    public func removeMapBundleIfUnreferenced(mapKey: String) async throws -> Bool {
        try await dbQueue.write { db in
            let references = try CourseRecord
                .filter(Column("downloadedRevision") != nil)
                .filter(sql: "COALESCE(siteId, id) = ?", arguments: [mapKey])
                .fetchCount(db)
            guard references == 0 else { return false }
            try MapBundleRecord.deleteOne(db, key: mapKey)
            return true
        }
    }

    // MARK: - Game plan (read-only viewer cache)

    /// The stored game plan for a course, or nil when none is cached. Holes
    /// come back ordered by hole number, shots/gates by (hole, sortOrder).
    public func gamePlan(courseId: String) async throws -> StoredGamePlan? {
        try await dbQueue.read { db in
            guard let plan = try GamePlanRecord
                .filter(Column("courseId") == courseId)
                .fetchOne(db)
            else { return nil }

            let holes = try GamePlanHoleRecord
                .filter(Column("gamePlanId") == plan.id)
                .order(Column("holeNumber"))
                .fetchAll(db)
            let holeIds = holes.map(\.id)
            let shots = try PlanShotRecord
                .filter(holeIds.contains(Column("gamePlanHoleId")))
                .order(Column("gamePlanHoleId"), Column("sortOrder"), Column("id"))
                .fetchAll(db)
            let gates = try PlanGateRecord
                .filter(holeIds.contains(Column("gamePlanHoleId")))
                .order(Column("gamePlanHoleId"), Column("sortOrder"))
                .fetchAll(db)

            return StoredGamePlan(plan: plan, holes: holes, shots: shots, gates: gates)
        }
    }

    /// Atomically replaces the stored plan for the plan's course (the delete
    /// cascades wipe old holes/shots/gates). No-op merge semantics are not
    /// needed — the server response is the whole plan tree.
    public func saveGamePlan(_ stored: StoredGamePlan) async throws {
        try await dbQueue.write { db in
            try GamePlanRecord
                .filter(Column("courseId") == stored.plan.courseId)
                .deleteAll(db)
            try stored.plan.insert(db)
            for hole in stored.holes { try hole.insert(db) }
            for shot in stored.shots { try shot.insert(db) }
            for gate in stored.gates { try gate.insert(db) }
        }
    }

    /// Removes the cached plan for a course (server said the plan is gone).
    public func deleteGamePlan(courseId: String) async throws {
        _ = try await dbQueue.write { db in
            try GamePlanRecord
                .filter(Column("courseId") == courseId)
                .deleteAll(db)
        }
    }

    // MARK: - Clubs (viewer cache — see ClubEditStore.swift for the writable side)

    /// The cached club bag, ordered like the web bag (sortOrder). Tombstoned
    /// (`.deleted`) rows are hidden — they're awaiting a sync push, not part
    /// of the bag any more.
    public func allClubs() async throws -> [ClubRecord] {
        try await dbQueue.read { db in
            try ClubRecord
                .filter(Column("syncState") != RoundSyncState.deleted.rawValue)
                .order(Column("sortOrder"), Column("name"))
                .fetchAll(db)
        }
    }

    /// Atomically replaces the cached club bag with the server's list. Callers
    /// must check `hasPendingClubEdits()` first — this unconditionally
    /// clobbers local rows and is only safe when nothing is pending push.
    public func saveClubs(_ clubs: [ClubRecord]) async throws {
        try await dbQueue.write { db in
            try ClubRecord.deleteAll(db)
            for club in clubs { try club.insert(db) }
        }
    }

    // MARK: - Green calibration (read-only viewer cache)

    /// The cached per-green calibration rows for a course (the caller keys them
    /// by greenId). Only greens the server calibrated from scans are stored.
    public func greenCalibrations(courseId: String) async throws -> [GreenCalibrationCacheRecord] {
        try await dbQueue.read { db in
            try GreenCalibrationCacheRecord
                .filter(Column("courseId") == courseId)
                .fetchAll(db)
        }
    }

    /// Atomically replaces the cached calibration for a course with the
    /// server's list (delete-all-for-course, then insert). A green that lost
    /// its calibration server-side simply drops out of the cache.
    public func saveGreenCalibrations(
        courseId: String,
        _ records: [GreenCalibrationCacheRecord]
    ) async throws {
        try await dbQueue.write { db in
            try GreenCalibrationCacheRecord
                .filter(Column("courseId") == courseId)
                .deleteAll(db)
            for record in records { try record.insert(db) }
        }
    }
}
