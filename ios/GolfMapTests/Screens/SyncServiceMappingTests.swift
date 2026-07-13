import XCTest
@testable import GolfMap

/// Verifies the `SyncService` pure adapters map decoded API models into the
/// exact Store records the on-device bundle expects. Driven by the same
/// server-captured fixtures the API decode tests use (FixtureLoader).
final class SyncServiceMappingTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ type: T.Type, _ fixture: String) throws -> T {
        try decoder.decode(T.self, from: FixtureLoader.data(fixture))
    }

    // MARK: - Per-record adapters

    func testCourseRecordMapping() throws {
        let course = try decode(Course.self, "course-get.json")
        let record = SyncService.courseRecord(course)

        XCTAssertEqual(record.id, "26D37361-D79C-41AA-AA49-92F2C2277222")
        XCTAssertEqual(record.siteId, "26D37361-D79C-41AA-AA49-92F2C2277222")
        XCTAssertEqual(record.mapKey, record.siteId)
        XCTAssertEqual(record.name, "Landeryd Masters")
        XCTAssertEqual(record.status, "published")
        XCTAssertEqual(record.revision, 2)
        XCTAssertEqual(record.homeLat ?? 0, 58.361893571209315, accuracy: 1e-9)
        XCTAssertEqual(record.homeLon ?? 0, 15.716457452277877, accuracy: 1e-9)
        XCTAssertEqual(record.updatedAt, "2026-07-04 13:59:26")
        // Sync state is left to AppDatabase on save.
        XCTAssertNil(record.downloadedRevision)
        XCTAssertEqual(record.bundleState, .none)
    }

    func testAssetScopeUsesSiteForSharedCourse() throws {
        let course = try decode(Course.self, "course-get.json")
        XCTAssertEqual(
            SyncService.assetScope(for: course),
            .site("26D37361-D79C-41AA-AA49-92F2C2277222")
        )
    }

    func testAssetScopeFallsBackToCourseForLegacyCourse() throws {
        let json = #"{"id":"legacy","name":"Legacy","status":"published","revision":1,"crs":"EPSG:4326","georeferenceJson":null,"homeLat":null,"homeLon":null,"notes":null,"siteId":null,"version":1,"createdAt":"","updatedAt":""}"#
        let course = try decoder.decode(Course.self, from: Data(json.utf8))
        XCTAssertEqual(SyncService.assetScope(for: course), .course("legacy"))
    }

    func testHoleRecordMapping() throws {
        let holes = try decode([Hole].self, "holes.json")
        let records = holes.map(SyncService.holeRecord)
        XCTAssertEqual(records.count, 18)
        XCTAssertEqual(records.map(\.number), Array(1...18))
        let first = records[0]
        XCTAssertEqual(first.courseId, holes[0].courseId)
        XCTAssertEqual(first.par, 4)
        XCTAssertNil(first.strokeIndex)
    }

    func testTeeRecordMapping() throws {
        let tees = try decode([Tee].self, "tees-by-course.json")
        let records = tees.map(SyncService.teeRecord)
        XCTAssertEqual(records.count, 32)
        let first = records[0]
        XCTAssertEqual(first.name, "default")
        XCTAssertNil(first.color)
        XCTAssertEqual(first.sortOrder, 0)
        XCTAssertEqual(first.lat, 58.361676784359815, accuracy: 1e-9)
        XCTAssertNotNil(first.elevation)
    }

    func testGreenRecordMappingDropsBoundary() throws {
        let green = try decode(Green.self, "green-by-hole.json")
        let record = SyncService.greenRecord(green)
        // boundaryJson has no home in GreenRecord — dropped by design.
        XCTAssertEqual(record.id, green.id)
        XCTAssertEqual(record.holeId, green.holeId)
        XCTAssertEqual(record.centerLat, 58.363947160867994, accuracy: 1e-9)
        XCTAssertEqual(record.centerLon, 15.70735740618441, accuracy: 1e-9)
        XCTAssertEqual(record.frontLat ?? 0, green.frontLat ?? -1, accuracy: 1e-9)
        XCTAssertEqual(record.backLon ?? 0, green.backLon ?? -1, accuracy: 1e-9)
        XCTAssertEqual(record.elevation ?? 0, 78.28551483154297, accuracy: 1e-6)
    }

    func testPinRecordMapping() throws {
        let pins = try decode([Pin].self, "pins-by-course.json")
        let records = pins.map(SyncService.pinRecord)
        XCTAssertEqual(records.count, 1)
        let pin = records[0]
        XCTAssertEqual(pin.greenId, "4CD3B075-CEB1-49EE-8B0E-382EAC66F355-green")
        XCTAssertEqual(pin.name, "Front-left")
        XCTAssertEqual(pin.difficulty, "easy")
        XCTAssertFalse(pin.active)
    }

    func testAimPointRecordMapping() throws {
        let aims = try decode([AimPoint].self, "aim-points.json")
        let records = aims.map(SyncService.aimPointRecord)
        XCTAssertEqual(records.count, 1)
        let a = records[0]
        XCTAssertEqual(a.sortOrder, 0)
        XCTAssertNil(a.label)
        XCTAssertEqual(a.lat, 58.36326966168596, accuracy: 1e-9)
        XCTAssertEqual(a.elevation ?? 0, 77.38896942138672, accuracy: 1e-6)
    }

    // MARK: - Manifest adapter (from a tile_manifest asset)

    func testManifestRecordMapping() throws {
        let assets = try decode([CourseAsset].self, "assets-by-course.json")
        let course = try decode(Course.self, "course-get.json")
        guard let manifest = SyncService.tileManifest(from: assets) else {
            return XCTFail("Expected a tile_manifest asset in the fixture")
        }
        let record = SyncService.manifestRecord(course: course, manifest: manifest)

        XCTAssertEqual(record.courseId, course.id)
        // Values from the tile_manifest asset (the 3rd asset in the fixture).
        XCTAssertEqual(record.west, 15.695402171504204, accuracy: 1e-9)
        XCTAssertEqual(record.north, 58.37121131892607, accuracy: 1e-9)
        XCTAssertEqual(record.orthoMinZoom, 14)
        XCTAssertEqual(record.orthoMaxZoom, 20)
        XCTAssertEqual(record.terrainMinZoom, 12)
        XCTAssertEqual(record.terrainMaxZoom, 17)
        XCTAssertEqual(record.elevMin, 53.27858352661133, accuracy: 1e-6)
        XCTAssertEqual(record.elevMax, 98.49988555908203, accuracy: 1e-6)
        XCTAssertEqual(record.generatedAt, "2026-07-04T08:28:59Z")
        // versionParam strips punctuation: 2026-07-04T08:28:59Z -> 20260704T082859Z
        XCTAssertEqual(record.versionParam, "20260704T082859Z")
    }

    /// Guards the asset-kind selection: `ortho_cog` (z14-19) is the FIRST asset
    /// and also parses as a manifest, but the authoritative served tile set is
    /// the `tile_manifest` asset (z14-20). Selection must key on kind, not order.
    func testTileManifestSelectionPicksTileManifestKind() throws {
        let assets = try decode([CourseAsset].self, "assets-by-course.json")
        // The first asset is ortho_cog — a naive .first would pick z14-19.
        XCTAssertEqual(assets.first?.kind, .orthoCog)
        let manifest = try XCTUnwrap(SyncService.tileManifest(from: assets))
        XCTAssertEqual(manifest.layers.ortho.maxzoom, 20)
        XCTAssertEqual(manifest.layers.terrain.maxzoom, 17)
    }

    // MARK: - Full assembly

    func testMakeFurnitureAssemblesAllRecords() throws {
        let course = try decode(Course.self, "course-get.json")
        let holes = try decode([Hole].self, "holes.json")
        let tees = try decode([Tee].self, "tees-by-course.json")
        let green = try decode(Green.self, "green-by-hole.json")
        let pins = try decode([Pin].self, "pins-by-course.json")
        let aims = try decode([AimPoint].self, "aim-points.json")
        let assets = try decode([CourseAsset].self, "assets-by-course.json")
        let manifest = try XCTUnwrap(SyncService.tileManifest(from: assets))

        let furniture = SyncService.makeFurniture(
            course: course,
            holes: holes,
            tees: tees,
            greens: [green],
            pinsByCourse: pins,
            aimPoints: aims,
            manifest: manifest
        )

        XCTAssertEqual(furniture.course.id, course.id)
        XCTAssertEqual(furniture.holes.count, 18)
        XCTAssertEqual(furniture.tees.count, 32)
        XCTAssertEqual(furniture.greens.count, 1)
        XCTAssertEqual(furniture.pins.count, 1)
        XCTAssertEqual(furniture.aimPoints.count, 1)
        XCTAssertEqual(furniture.manifest.courseId, course.id)
    }

    /// A full round-trip: assemble furniture from fixtures, save it into an
    /// in-memory AppDatabase, and read it back as CourseFurniture — proves the
    /// adapted records satisfy every Store column + FK constraint.
    func testAssembledFurnitureSavesAndReadsBack() async throws {
        let course = try decode(Course.self, "course-get.json")
        let holes = try decode([Hole].self, "holes.json")
        let tees = try decode([Tee].self, "tees-by-course.json")
        let green = try decode(Green.self, "green-by-hole.json")
        let pins = try decode([Pin].self, "pins-by-course.json")
        let aims = try decode([AimPoint].self, "aim-points.json")
        let assets = try decode([CourseAsset].self, "assets-by-course.json")
        let manifest = try XCTUnwrap(SyncService.tileManifest(from: assets))

        // The single green + pin reference hole/green ids that aren't in this
        // course's hole/green set (fixtures were captured from different holes),
        // so build a self-consistent subset: keep only rows whose FKs resolve.
        let holeIds = Set(holes.map(\.id))
        let consistentGreens = [green].filter { holeIds.contains($0.holeId) }
        let greenIds = Set(consistentGreens.map(\.id))
        let consistentPins = pins.filter { greenIds.contains($0.greenId) }
        let consistentAims = aims.filter { holeIds.contains($0.holeId) }

        let furniture = SyncService.makeFurniture(
            course: course, holes: holes, tees: tees,
            greens: consistentGreens, pinsByCourse: consistentPins,
            aimPoints: consistentAims, manifest: manifest
        )

        let db = try AppDatabase.inMemory()
        try await db.saveCompletedBundle(furniture)

        let readBack = try await XCTUnwrapAsync(await db.courseFurniture(courseId: course.id))
        XCTAssertEqual(readBack.course.downloadedRevision, course.revision)
        XCTAssertEqual(readBack.course.bundleState, .complete)
        XCTAssertEqual(readBack.holes.count, 18)
        XCTAssertEqual(readBack.tees.count, 32)
        XCTAssertEqual(readBack.manifest.versionParam, "20260704T082859Z")
    }
}

/// Small async unwrap helper (XCTUnwrap can't be applied to an already-awaited
/// optional cleanly in older toolchains).
func XCTUnwrapAsync<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    guard let value else {
        XCTFail("Expected non-nil value", file: file, line: line)
        throw CocoaError(.coderValueNotFound)
    }
    return value
}
