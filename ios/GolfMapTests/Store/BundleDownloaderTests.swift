import XCTest
@testable import GolfMap

final class BundleDownloaderTests: XCTestCase {
    private var database: AppDatabase!
    private var paths: BundlePaths!
    private var downloader: BundleDownloader!

    override func setUpWithError() throws {
        database = try AppDatabase.inMemory()
        paths = BundlePaths(rootDirectory: try makeTemporaryDirectory())
        downloader = BundleDownloader(
            database: database,
            paths: paths,
            session: StoreMockURLProtocol.makeSession()
        )
    }

    override func tearDown() {
        StoreMockURLProtocol.setHandler(nil)
        if let paths {
            try? FileManager.default.removeItem(at: paths.rootDirectory)
        }
    }

    private func makeRequest(
        furniture: CourseFurniture = StoreFixtures.furniture(),
        features: Data = Data(#"{"type":"FeatureCollection","features":[]}"#.utf8)
    ) -> BundleDownloadRequest {
        BundleDownloadRequest(
            tileBaseURL: URL(string: "http://localhost:3000/tiles")!,
            furniture: furniture,
            featuresGeoJSON: { features }
        )
    }

    // Fixture archives: ortho tiles are WebP, terrain tiles are PNG. The
    // downloader preserves each entry's own extension on disk.
    private let orthoEntries: [(name: String, data: Data)] = [
        ("14/1/1.webp", Data("ortho-a".utf8)),
        ("14/1/2.webp", Data("ortho-b".utf8)),
        ("15/2/2.webp", Data("ortho-c".utf8)),
    ]
    private let terrainEntries: [(name: String, data: Data)] = [
        ("12/1/1.png", Data("terrain-a".utf8)),
    ]

    private func serveArchives() {
        let ortho = makeTarArchive(orthoEntries)
        let terrain = makeTarArchive(terrainEntries)
        StoreMockURLProtocol.setHandler { request in
            let path = request.url!.path()
            if path.contains("/ortho/") {
                return MockTileResponse(statusCode: 200, data: ortho)
            }
            return MockTileResponse(statusCode: 200, data: terrain)
        }
    }

    private func installLegacyBundle(courseId: String = "legacy") async throws -> URL {
        let furniture = StoreFixtures.furniture(courseId: courseId)
        try await database.saveCompletedBundle(
            furniture,
            mapBundle: MapBundleRecord(
                mapKey: courseId,
                versionParam: furniture.manifest.versionParam,
                generatedAt: furniture.manifest.generatedAt
            )
        )
        let directory = paths.rootDirectory.appending(path: courseId, directoryHint: .isDirectory)
        for layer in TileLayer.allCases {
            let layerDirectory = paths.layerTilesDirectory(in: directory, layer: layer)
            try FileManager.default.createDirectory(at: layerDirectory, withIntermediateDirectories: true)
            try Data("legacy-\(layer.rawValue)".utf8)
                .write(to: layerDirectory.appending(path: "sentinel"))
        }
        try Data("legacy-features".utf8)
            .write(to: directory.appending(path: "features.geojson"))
        return directory
    }

    // MARK: - Happy path

    func testSuccessfulArchiveDownloadUnpacksBothLayers() async throws {
        serveArchives()

        let collector = ProgressCollector()
        let result = try await downloader.download(makeRequest()) { collector.append($0) }

        XCTAssertEqual(result.downloadedTiles, orthoEntries.count + terrainEntries.count)
        XCTAssertGreaterThan(result.totalBytes, 0)

        // Every entry landed in the final directory with its own extension.
        let courseDir = paths.courseDirectory(courseId: "course-1")
        let fm = FileManager.default
        for (name, data) in orthoEntries {
            let url = courseDir.appending(path: "tiles/ortho/\(name)")
            XCTAssertTrue(fm.fileExists(atPath: url.path()), "missing ortho \(name)")
            XCTAssertEqual(try Data(contentsOf: url), data)
        }
        for (name, data) in terrainEntries {
            let url = courseDir.appending(path: "tiles/terrain/\(name)")
            XCTAssertTrue(fm.fileExists(atPath: url.path()), "missing terrain \(name)")
            XCTAssertEqual(try Data(contentsOf: url), data)
        }

        XCTAssertEqual(
            try Data(contentsOf: paths.featuresURL(courseId: "course-1")),
            Data(#"{"type":"FeatureCollection","features":[]}"#.utf8)
        )

        // Staging directory (including the temp .tar files) is gone.
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))

        // Exactly one request per layer; ortho carries maxzoom=19, terrain none.
        let urls = StoreMockURLProtocol.requestedURLs
        XCTAssertEqual(urls.count, 2)
        let ortho = try XCTUnwrap(urls.first { $0.path().contains("/ortho/") })
        let terrain = try XCTUnwrap(urls.first { $0.path().contains("/terrain/") })
        XCTAssertTrue(ortho.path().hasSuffix("/ortho/archive.tar"))
        XCTAssertEqual(ortho.query(), "v=ver1&maxzoom=19")
        XCTAssertTrue(terrain.path().hasSuffix("/terrain/archive.tar"))
        XCTAssertEqual(terrain.query(), "v=ver1")

        // Progress ends fully downloaded.
        let last = try XCTUnwrap(collector.events.last)
        XCTAssertGreaterThan(last.totalBytes, 0)
        XCTAssertEqual(last.completedBytes, last.totalBytes)

        // Furniture landed with the complete flag.
        let fetched = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetched)
        XCTAssertEqual(course.bundleState, .complete)
        XCTAssertEqual(course.downloadedRevision, 3)
        let furniture = try await database.courseFurniture(courseId: "course-1")
        XCTAssertNotNil(furniture)
    }

    // MARK: - Optional lidar layers

    func testManifestWithLidarLayersDownloadsAllFiveLayers() async throws {
        let lidar = makeTarArchive([("13/3/3.png", Data("lidar".utf8))])
        let ortho = makeTarArchive(orthoEntries)
        let terrain = makeTarArchive(terrainEntries)
        StoreMockURLProtocol.setHandler { request in
            let path = request.url!.path()
            if path.contains("/ortho/") { return MockTileResponse(statusCode: 200, data: ortho) }
            if path.contains("/terrain/") { return MockTileResponse(statusCode: 200, data: terrain) }
            return MockTileResponse(statusCode: 200, data: lidar)
        }

        let furniture = StoreFixtures.furniture(lidarLayers: 12...17)
        let result = try await downloader.download(makeRequest(furniture: furniture)) { _ in }

        XCTAssertEqual(result.downloadedTiles, orthoEntries.count + terrainEntries.count + 3)
        let requested = Set(StoreMockURLProtocol.requestedURLs.map { $0.path() })
        XCTAssertEqual(requested.count, 5)
        for layer in TileLayer.allCases {
            XCTAssertTrue(
                requested.contains { $0.hasSuffix("/\(layer.rawValue)/archive.tar") },
                "no archive request for \(layer.rawValue)"
            )
        }
        // Optional layers never carry the ortho maxzoom cap.
        for url in StoreMockURLProtocol.requestedURLs where !url.path().contains("/ortho/") {
            XCTAssertEqual(url.query(), "v=ver1")
        }

        let courseDir = paths.courseDirectory(courseId: "course-1")
        for layer in TileLayer.optional {
            let tile = courseDir.appending(path: "tiles/\(layer.rawValue)/13/3/3.png")
            XCTAssertEqual(try Data(contentsOf: tile), Data("lidar".utf8), "missing \(layer.rawValue)")
        }

        // The manifest's optional zoom ranges survive the round trip.
        let stored = try await database.courseFurniture(courseId: "course-1")
        XCTAssertEqual(stored?.manifest.zoomRange(for: .canopyColor), 12...17)
        XCTAssertTrue(stored?.manifest.hasLayer(.surface) ?? false)
    }

    func testManifestWithoutLidarLayersRequestsOnlyOrthoAndTerrain() async throws {
        serveArchives()
        let furniture = StoreFixtures.furniture()
        XCTAssertFalse(furniture.manifest.hasLayer(.canopy))

        _ = try await downloader.download(makeRequest(furniture: furniture)) { _ in }

        let requested = StoreMockURLProtocol.requestedURLs.map { $0.path() }
        XCTAssertEqual(requested.count, 2)
        XCTAssertFalse(requested.contains { $0.contains("/canopy") || $0.contains("/surface/") })
        let courseDir = paths.courseDirectory(courseId: "course-1")
        for layer in TileLayer.optional {
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: courseDir.appending(path: "tiles/\(layer.rawValue)").path()),
                "\(layer.rawValue) directory should not exist"
            )
        }
    }

    func testListedLidarLayerThatTheServerLacksIsSkippedNotFatal() async throws {
        // The manifest advertises the layers but the server has no archive
        // for them (404): the bundle still installs with ortho + terrain.
        let ortho = makeTarArchive(orthoEntries)
        let terrain = makeTarArchive(terrainEntries)
        StoreMockURLProtocol.setHandler { request in
            let path = request.url!.path()
            if path.contains("/ortho/") { return MockTileResponse(statusCode: 200, data: ortho) }
            if path.contains("/terrain/") { return MockTileResponse(statusCode: 200, data: terrain) }
            return MockTileResponse(statusCode: 404, data: Data())
        }

        let furniture = StoreFixtures.furniture(lidarLayers: 12...17)
        let result = try await downloader.download(makeRequest(furniture: furniture)) { _ in }

        XCTAssertEqual(result.downloadedTiles, orthoEntries.count + terrainEntries.count)
        XCTAssertEqual(StoreMockURLProtocol.requestedURLs.count, 5)
        let courseDir = paths.courseDirectory(courseId: "course-1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: courseDir.appending(path: "tiles/terrain").path()))
        for layer in TileLayer.optional {
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: courseDir.appending(path: "tiles/\(layer.rawValue)").path())
            )
        }
        let course = try await database.course(id: "course-1")
        XCTAssertEqual(course?.bundleState, .complete)
    }

    func testInstalledMapWithoutListedLidarLayersIsRefetched() async throws {
        // First install: manifest without lidar layers.
        serveArchives()
        _ = try await downloader.download(makeRequest(furniture: StoreFixtures.furniture())) { _ in }
        XCTAssertEqual(StoreMockURLProtocol.requestedURLs.count, 2)

        // Same versionParam, but the manifest now lists the lidar layers: the
        // map is not reused, every layer is fetched and the new ones land.
        let lidar = makeTarArchive([("13/3/3.png", Data("lidar".utf8))])
        let ortho = makeTarArchive(orthoEntries)
        let terrain = makeTarArchive(terrainEntries)
        StoreMockURLProtocol.setHandler { request in
            let path = request.url!.path()
            if path.contains("/ortho/") { return MockTileResponse(statusCode: 200, data: ortho) }
            if path.contains("/terrain/") { return MockTileResponse(statusCode: 200, data: terrain) }
            return MockTileResponse(statusCode: 200, data: lidar)
        }
        _ = try await downloader.download(makeRequest(furniture: StoreFixtures.furniture(lidarLayers: 12...17))) { _ in }
        XCTAssertEqual(StoreMockURLProtocol.requestedURLs.count, 5)
        let courseDir = paths.courseDirectory(courseId: "course-1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: courseDir.appending(path: "tiles/canopy-color/13/3/3.png").path()))

        // A third download with the same manifest reuses the map: no requests.
        _ = try await downloader.download(makeRequest(furniture: StoreFixtures.furniture(lidarLayers: 12...17))) { _ in }
        XCTAssertEqual(StoreMockURLProtocol.requestedURLs.count, 5)
    }

    func testRequiredLayer404StillFailsWhenLidarLayersAreListed() async throws {
        let lidar = makeTarArchive([("13/3/3.png", Data("lidar".utf8))])
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("/terrain/") {
                return MockTileResponse(statusCode: 404, data: Data())
            }
            return MockTileResponse(statusCode: 200, data: lidar)
        }
        do {
            _ = try await downloader.download(makeRequest(furniture: StoreFixtures.furniture(lidarLayers: 12...17)))
            XCTFail("expected layerHasNoTiles(.terrain)")
        } catch let error as BundleDownloadError {
            guard case .layerHasNoTiles(.terrain) = error else { return XCTFail("got \(error)") }
        }
    }

    func testLayerSpecsFollowTheManifest() {
        let plain = BundleDownloader.layerSpecs(manifest: StoreFixtures.furniture().manifest)
        XCTAssertEqual(plain.map(\.layer), [.ortho, .terrain])
        XCTAssertEqual(plain[0].maxzoom, 19)
        XCTAssertNil(plain[1].maxzoom)

        let lidar = BundleDownloader.layerSpecs(manifest: StoreFixtures.furniture(lidarLayers: 12...17).manifest)
        XCTAssertEqual(lidar.map(\.layer), [.ortho, .terrain, .canopy, .canopyColor, .surface])
        XCTAssertEqual(lidar.dropFirst().compactMap(\.maxzoom), [])
    }

    func testStartDownloadStreamsProgressAndFinishes() async throws {
        serveArchives()

        let handle = await downloader.startDownload(makeRequest())
        var events: [BundleProgress] = []
        for await progress in handle.progress {
            events.append(progress)
        }
        // The stream finished, so the download settled.
        let result = try await handle.result
        XCTAssertEqual(result.downloadedTiles, orthoEntries.count + terrainEntries.count)
        XCTAssertFalse(events.isEmpty)
        let last = try XCTUnwrap(events.last)
        XCTAssertEqual(last.completedBytes, last.totalBytes)
    }

    // MARK: - Retry

    func testTransportErrorIsRetriedOncePerLayer() async throws {
        let ortho = makeTarArchive(orthoEntries)
        let terrain = makeTarArchive(terrainEntries)
        let attempts = AttemptCounter()
        StoreMockURLProtocol.setHandler { request in
            let path = request.url!.path()
            if path.contains("/ortho/") {
                if attempts.record("ortho") == 1 {
                    return MockTileResponse(statusCode: 0, data: Data(), networkError: URLError(.networkConnectionLost))
                }
                return MockTileResponse(statusCode: 200, data: ortho)
            }
            return MockTileResponse(statusCode: 200, data: terrain)
        }

        let result = try await downloader.download(makeRequest())
        XCTAssertEqual(result.downloadedTiles, orthoEntries.count + terrainEntries.count)

        let orthoRequests = StoreMockURLProtocol.requestedURLs.filter { $0.path().contains("/ortho/") }
        XCTAssertEqual(orthoRequests.count, 2, "ortho archive fetched twice (one retry)")
    }

    // MARK: - Failure

    func testPersistentHTTPErrorFailsCleanly() async throws {
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("/ortho/") {
                return MockTileResponse(statusCode: 500, data: Data())
            }
            return MockTileResponse(statusCode: 200, data: makeTarArchive([("12/1/1.png", Data("t".utf8))]))
        }

        do {
            _ = try await downloader.download(makeRequest())
            XCTFail("expected failure")
        } catch let error as BundleDownloadError {
            guard case .httpStatus(let status, _) = error else {
                return XCTFail("unexpected error \(error)")
            }
            XCTAssertEqual(status, 500)
        }

        // An HTTP status error is final — the ortho archive is fetched once.
        let orthoRequests = StoreMockURLProtocol.requestedURLs.filter { $0.path().contains("/ortho/") }
        XCTAssertEqual(orthoRequests.count, 1)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))
        XCTAssertFalse(fm.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path()))

        let fetched = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetched)
        XCTAssertEqual(course.bundleState, BundleState.none)
        XCTAssertNil(course.downloadedRevision)
    }

    func testMalformedArchiveFails() async throws {
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("/ortho/") {
                return MockTileResponse(statusCode: 200, data: Data("this is not a tar".utf8))
            }
            return MockTileResponse(statusCode: 200, data: makeTarArchive([("12/1/1.png", Data("t".utf8))]))
        }

        do {
            _ = try await downloader.download(makeRequest())
            XCTFail("expected malformedArchive")
        } catch let error as BundleDownloadError {
            guard case .malformedArchive(.ortho) = error else {
                return XCTFail("unexpected error \(error)")
            }
        }

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path()))
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))
    }

    func testFeaturesProviderFailureAborts() async throws {
        serveArchives()
        struct FeaturesUnavailable: Error {}
        let request = BundleDownloadRequest(
            tileBaseURL: URL(string: "http://localhost:3000/tiles")!,
            furniture: StoreFixtures.furniture(),
            featuresGeoJSON: { throw FeaturesUnavailable() }
        )

        await XCTAssertThrowsErrorAsync(try await downloader.download(request))
        XCTAssertTrue(StoreMockURLProtocol.requestedURLs.isEmpty, "no archives should be fetched")
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()
            )
        )
    }

    // MARK: - Layer has no tiles

    func testLayer404FailsInsteadOfInstallingAnEmptyBundle() async throws {
        // The server has no tiles for a layer at all (archive 404) — the
        // download must fail, not record a complete bundle.
        StoreMockURLProtocol.setHandler { _ in
            MockTileResponse(statusCode: 404, data: Data())
        }

        do {
            _ = try await downloader.download(makeRequest())
            XCTFail("expected layerHasNoTiles")
        } catch let error as BundleDownloadError {
            guard case .layerHasNoTiles = error else {
                return XCTFail("got \(error)")
            }
        }

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path()))
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))
        let fetched = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetched)
        XCTAssertEqual(course.bundleState, BundleState.none)
    }

    func testEmptyArchiveIsTreatedAsNoTiles() async throws {
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("/ortho/") {
                return MockTileResponse(statusCode: 200, data: makeTarArchive([]))
            }
            return MockTileResponse(statusCode: 200, data: makeTarArchive([("12/1/1.png", Data("t".utf8))]))
        }

        do {
            _ = try await downloader.download(makeRequest())
            XCTFail("expected layerHasNoTiles")
        } catch let error as BundleDownloadError {
            guard case .layerHasNoTiles(.ortho) = error else {
                return XCTFail("got \(error)")
            }
        }
    }

    func testResolvedFeaturesAreWrittenWhenProvided() async throws {
        serveArchives()
        let resolved = Data(#"{"type":"FeatureCollection","features":[],"resolved":true}"#.utf8)
        var request = makeRequest()
        request.resolvedFeaturesGeoJSON = { resolved }

        _ = try await downloader.download(request)

        XCTAssertEqual(
            try Data(contentsOf: paths.resolvedFeaturesURL(courseId: "course-1")),
            resolved
        )
    }

    // MARK: - Cancellation

    func testCancellationCleansUpStagingDirectory() async throws {
        // Slow responses so cancellation lands mid-flight.
        let ortho = makeTarArchive(orthoEntries)
        let terrain = makeTarArchive(terrainEntries)
        StoreMockURLProtocol.setHandler { request in
            let data = request.url!.path().contains("/ortho/") ? ortho : terrain
            return MockTileResponse(statusCode: 200, data: data, delay: 0.5)
        }

        let handle = await downloader.startDownload(makeRequest())
        try await Task.sleep(for: .milliseconds(100))
        handle.cancel()

        do {
            _ = try await handle.result
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "got \(error)")
        }

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))
        XCTAssertFalse(fm.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path()))

        let fetched = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetched)
        XCTAssertEqual(course.bundleState, BundleState.none)
    }

    // MARK: - Delete

    func testFailedFirstPostV7UpdateKeepsLegacyMapKeyAndFilesUsable() async throws {
        let legacyDirectory = try await installLegacyBundle()
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("/ortho/") {
                return MockTileResponse(statusCode: 500, data: Data())
            }
            return MockTileResponse(
                statusCode: 200,
                data: makeTarArchive([("12/1/1.png", Data("terrain".utf8))])
            )
        }
        let update = StoreFixtures.furniture(
            courseId: "legacy",
            siteId: "shared-site",
            revision: 4,
            versionParam: "ver2"
        )

        await XCTAssertThrowsErrorAsync(try await downloader.download(makeRequest(furniture: update)))

        let fetched = try await database.course(id: "legacy")
        let course = try XCTUnwrap(fetched)
        XCTAssertNil(course.siteId)
        XCTAssertEqual(course.mapKey, "legacy")
        XCTAssertEqual(course.downloadedRevision, 3)
        XCTAssertEqual(course.bundleState, .stale)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyDirectory.path()))
        let legacyMap = try await database.mapBundle(mapKey: "legacy")
        XCTAssertNotNil(legacyMap)
    }

    func testCancelledFirstPostV7UpdateKeepsLegacyMapKeyAndFilesUsable() async throws {
        let legacyDirectory = try await installLegacyBundle()
        let archive = makeTarArchive([("12/1/1.png", Data("tile".utf8))])
        StoreMockURLProtocol.setHandler { _ in
            MockTileResponse(statusCode: 200, data: archive, delay: 0.5)
        }
        let update = StoreFixtures.furniture(
            courseId: "legacy",
            siteId: "shared-site",
            revision: 4,
            versionParam: "ver2"
        )

        let handle = await downloader.startDownload(makeRequest(furniture: update))
        try await Task.sleep(for: .milliseconds(100))
        handle.cancel()
        await XCTAssertThrowsErrorAsync(try await handle.result)

        let fetched = try await database.course(id: "legacy")
        let course = try XCTUnwrap(fetched)
        XCTAssertNil(course.siteId)
        XCTAssertEqual(course.mapKey, "legacy")
        XCTAssertEqual(course.downloadedRevision, 3)
        XCTAssertEqual(course.bundleState, .stale)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyDirectory.path()))
    }

    func testSuccessfulFirstPostV7UpdatePromotesSharedMapAndCleansLegacyTiles() async throws {
        let legacyDirectory = try await installLegacyBundle()
        serveArchives()
        let update = StoreFixtures.furniture(
            courseId: "legacy",
            siteId: "shared-site",
            revision: 4,
            versionParam: "ver2"
        )
        let newFeatures = Data("new-features".utf8)

        _ = try await downloader.download(makeRequest(furniture: update, features: newFeatures))

        let fetched = try await database.course(id: "legacy")
        let course = try XCTUnwrap(fetched)
        XCTAssertEqual(course.siteId, "shared-site")
        XCTAssertEqual(course.bundleState, .complete)
        XCTAssertEqual(course.downloadedRevision, 4)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyDirectory.path()))
        let legacyMap = try await database.mapBundle(mapKey: "legacy")
        XCTAssertNil(legacyMap)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: paths.canonicalMapBundleDirectory(mapKey: "shared-site").path()
            )
        )
        XCTAssertEqual(
            try Data(contentsOf: paths.courseFeaturesURL(courseId: "legacy")),
            newFeatures
        )

        _ = try await downloader.removeDownloadedData(courseId: "legacy")

        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: paths.canonicalMapBundleDirectory(mapKey: "shared-site").path()
            )
        )
        XCTAssertEqual(
            try Data(contentsOf: paths.courseFeaturesURL(courseId: "legacy")),
            newFeatures
        )
    }

    func testFilesystemFailureDoesNotCommitDownloadedDataRemoval() async throws {
        serveArchives()
        _ = try await downloader.download(makeRequest())
        let mapsDirectory = paths.canonicalMapBundleDirectory(mapKey: "course-1")
            .deletingLastPathComponent()
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500],
            ofItemAtPath: mapsDirectory.path()
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: mapsDirectory.path()
            )
        }

        await XCTAssertThrowsErrorAsync(
            try await downloader.removeDownloadedData(courseId: "course-1")
        )

        let fetched = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetched)
        XCTAssertEqual(course.bundleState, .complete)
        XCTAssertEqual(course.downloadedRevision, 3)
        let mapBundle = try await database.mapBundle(mapKey: "course-1")
        XCTAssertNotNil(mapBundle)
    }

    func testRemoveDownloadedDataDeletesOnlyMapAndPreservesCheapAndUserData() async throws {
        serveArchives()
        _ = try await downloader.download(makeRequest())
        try await database.saveGamePlan(StoredGamePlan(
            plan: GamePlanRecord(
                id: "plan-1",
                courseId: "course-1",
                syncState: .dirty
            ),
            holes: [],
            shots: [],
            gates: []
        ))
        let round = RoundRecord(
            id: "round-1",
            courseId: "course-1",
            startedAt: "2026-07-13T08:00:00Z"
        )
        try await database.saveRound(round)
        try await database.saveShot(ShotRecord(
            id: "shot-1",
            roundId: round.id,
            holeNumber: 1,
            sortOrder: 0,
            lat: 58.0,
            lon: 15.0,
            recordedAt: "2026-07-13T08:05:00Z"
        ))
        let featuresBeforeRemoval = try Data(contentsOf: paths.courseFeaturesURL(courseId: "course-1"))

        let result = try await downloader.removeDownloadedData(courseId: "course-1")

        XCTAssertTrue(result.removedMapBundle)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path())
        )
        let fetchedCourse = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetchedCourse)
        let retainedFurniture = try await database.courseFurniture(courseId: "course-1")
        let retainedPlan = try await database.gamePlan(courseId: "course-1")
        let retainedRounds = try await database.rounds(courseId: "course-1")
        let retainedShotIds = try await database.shots(roundId: round.id).map(\.id)
        XCTAssertEqual(course.bundleState, .none)
        XCTAssertNil(course.downloadedRevision)
        XCTAssertNotNil(retainedFurniture)
        XCTAssertNotNil(retainedPlan)
        XCTAssertEqual(retainedRounds, [round])
        XCTAssertEqual(retainedShotIds, ["shot-1"])
        XCTAssertEqual(
            try Data(contentsOf: paths.courseFeaturesURL(courseId: "course-1")),
            featuresBeforeRemoval
        )
    }

    func testSecondCourseAtSameSiteReusesSharedMapButStoresOwnFeatures() async throws {
        serveArchives()
        let first = StoreFixtures.furniture(courseId: "masters", siteId: "landeryd")
        let second = StoreFixtures.furniture(courseId: "classic", siteId: "landeryd")
        let mastersFeatures = Data("masters".utf8)
        let classicFeatures = Data("classic".utf8)
        let mastersResolved = Data("masters-resolved".utf8)
        let classicResolved = Data("classic-resolved".utf8)

        var mastersRequest = makeRequest(furniture: first, features: mastersFeatures)
        mastersRequest.resolvedFeaturesGeoJSON = { mastersResolved }
        _ = try await downloader.download(mastersRequest)
        let requestCountAfterFirst = StoreMockURLProtocol.requestedURLs.count
        var classicRequest = makeRequest(furniture: second, features: classicFeatures)
        classicRequest.resolvedFeaturesGeoJSON = { classicResolved }
        let reused = try await downloader.download(classicRequest)

        XCTAssertEqual(reused.downloadedTiles, 0)
        XCTAssertEqual(reused.totalBytes, 0)
        XCTAssertEqual(StoreMockURLProtocol.requestedURLs.count, requestCountAfterFirst)
        XCTAssertEqual(try Data(contentsOf: paths.courseFeaturesURL(courseId: "masters")), mastersFeatures)
        XCTAssertEqual(try Data(contentsOf: paths.courseFeaturesURL(courseId: "classic")), classicFeatures)
        XCTAssertEqual(
            try Data(contentsOf: paths.courseResolvedFeaturesURL(courseId: "masters")),
            mastersResolved
        )
        XCTAssertEqual(
            try Data(contentsOf: paths.courseResolvedFeaturesURL(courseId: "classic")),
            classicResolved
        )
        let mapDirectory = paths.mapBundleDirectory(mapKey: "landeryd")
        XCTAssertTrue(FileManager.default.fileExists(atPath: mapDirectory.path()))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: mapDirectory.appending(path: "features-resolved.geojson").path()
            )
        )
        let classic = try await database.course(id: "classic")
        XCTAssertEqual(classic?.bundleState, .complete)
    }

    func testDeletingOneSharedCourseKeepsMapUntilLastReferenceIsDeleted() async throws {
        serveArchives()
        let first = StoreFixtures.furniture(courseId: "masters", siteId: "landeryd")
        let second = StoreFixtures.furniture(courseId: "classic", siteId: "landeryd")
        _ = try await downloader.download(makeRequest(furniture: first))
        _ = try await downloader.download(makeRequest(furniture: second))
        let sharedDirectory = paths.mapBundleDirectory(mapKey: "landeryd")

        let firstRemoval = try await downloader.removeDownloadedData(courseId: "classic")

        XCTAssertFalse(firstRemoval.removedMapBundle)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sharedDirectory.path()))
        let retainedMap = try await database.mapBundle(mapKey: "landeryd")
        let retainedCourse = try await database.course(id: "masters")
        let fetchedRemovedCourse = try await database.course(id: "classic")
        let removedCourse = try XCTUnwrap(fetchedRemovedCourse)
        XCTAssertNotNil(retainedMap)
        XCTAssertNotNil(retainedCourse)
        XCTAssertEqual(removedCourse.bundleState, .none)
        XCTAssertNil(removedCourse.downloadedRevision)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: paths.courseFeaturesURL(courseId: "classic").path())
        )

        let lastRemoval = try await downloader.removeDownloadedData(courseId: "masters")

        XCTAssertTrue(lastRemoval.removedMapBundle)
        XCTAssertFalse(FileManager.default.fileExists(atPath: sharedDirectory.path()))
        let deletedMap = try await database.mapBundle(mapKey: "landeryd")
        XCTAssertNil(deletedMap)
    }

    func testDeletingLastReferenceCleansUpLegacyPreV7MapDirectory() async throws {
        let furniture = StoreFixtures.furniture(courseId: "legacy")
        let legacyDirectory = paths.rootDirectory.appending(path: "legacy", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: legacyDirectory, withIntermediateDirectories: true)
        try Data("legacy-map".utf8).write(to: legacyDirectory.appending(path: "sentinel"))
        let legacyFeatures = Data("legacy-features".utf8)
        try legacyFeatures.write(to: legacyDirectory.appending(path: "features.geojson"))
        try await database.saveCompletedBundle(
            furniture,
            mapBundle: MapBundleRecord(
                mapKey: "legacy",
                versionParam: furniture.manifest.versionParam,
                generatedAt: furniture.manifest.generatedAt
            )
        )

        try await downloader.deleteBundle(courseId: "legacy")

        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyDirectory.path()))
        XCTAssertEqual(
            try Data(contentsOf: paths.canonicalCourseDataDirectory(courseId: "legacy")
                .appending(path: "features.geojson")),
            legacyFeatures
        )
        let retainedFurniture = try await database.courseFurniture(courseId: "legacy")
        XCTAssertNotNil(retainedFurniture)
    }

    // MARK: - Published ortho cap (deploy split §9)

    /// A VPS that publishes ortho capped below the device ceiling rewrites its
    /// `manifest.json`; the archive request must follow it down rather than
    /// asking for levels the server does not have.
    func testCappedManifestLowersTheOrthoArchiveRequest() async throws {
        serveArchives()

        _ = try await downloader.download(
            makeRequest(furniture: StoreFixtures.furniture(orthoMaxZoom: 18))
        )

        let urls = StoreMockURLProtocol.requestedURLs
        let ortho = try XCTUnwrap(urls.first { $0.path().contains("/ortho/") })
        XCTAssertEqual(ortho.query(), "v=ver1&maxzoom=18")
    }

    /// A manifest that declares no usable ortho maxzoom (pre-cap bundles) keeps
    /// the device ceiling — the behavior before the cap existed.
    func testUndeclaredManifestMaxzoomFallsBackToTheDeviceCeiling() async throws {
        serveArchives()

        _ = try await downloader.download(
            makeRequest(furniture: StoreFixtures.furniture(orthoMaxZoom: 0))
        )

        let urls = StoreMockURLProtocol.requestedURLs
        let ortho = try XCTUnwrap(urls.first { $0.path().contains("/ortho/") })
        XCTAssertEqual(ortho.query(), "v=ver1&maxzoom=19")
    }

    // MARK: - Archive request URL

    func testArchiveRequestURLCarriesVersionAndOptionalMaxzoom() {
        let base = URL(string: "http://localhost:3000/tiles")!
        let orthoURL = BundleDownloader.archiveRequestURL(
            baseURL: base, courseId: "c1", layer: .ortho, versionParam: "v9", maxzoom: 19
        )
        XCTAssertTrue(orthoURL.path().hasSuffix("/c1/ortho/archive.tar"))
        XCTAssertEqual(orthoURL.query(), "v=v9&maxzoom=19")

        let terrainURL = BundleDownloader.archiveRequestURL(
            baseURL: base, courseId: "c1", layer: .terrain, versionParam: "v9", maxzoom: nil
        )
        XCTAssertTrue(terrainURL.path().hasSuffix("/c1/terrain/archive.tar"))
        XCTAssertEqual(terrainURL.query(), "v=v9")
    }

    func testTileURLTemplateKeepsPlaceholders() {
        let template = paths.tileURLTemplate(courseId: "course-1", layer: .ortho)
        XCTAssertTrue(template.hasPrefix("file://"), "got \(template)")
        XCTAssertTrue(template.hasSuffix("course-1/tiles/ortho/{z}/{x}/{y}.jpg"), "got \(template)")

        let terrain = paths.tileURLTemplate(courseId: "course-1", layer: .terrain)
        XCTAssertTrue(terrain.hasSuffix("course-1/tiles/terrain/{z}/{x}/{y}.png"), "got \(terrain)")
    }

    // Regression: the production bundle root lives under "Application Support",
    // whose space percent-encodes to %20 in `URL.path()`. Feeding that encoded
    // string to `FileManager.fileExists(atPath:)` always failed, so the
    // canonical `maps/<mapKey>` directory was never detected and resolution
    // silently fell back to the legacy `<root>/<mapKey>` path. Every course
    // with `mapKey == courseId` masked it (its legacy dir exists); the first
    // course whose site id differs from its course id rendered no ortho tiles.
    func testDirectoryResolutionHandlesSpaceInRootPath() throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "Bundle Tests \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let spacedPaths = BundlePaths(rootDirectory: root)

        let mapKey = "site-id"
        let canonicalMap = spacedPaths.canonicalMapBundleDirectory(mapKey: mapKey)
        try FileManager.default.createDirectory(at: canonicalMap, withIntermediateDirectories: true)
        XCTAssertEqual(
            spacedPaths.mapBundleDirectory(mapKey: mapKey).path(percentEncoded: false),
            canonicalMap.path(percentEncoded: false),
            "canonical maps/<mapKey> must win over the legacy fallback even when the root path contains a space"
        )

        let courseId = "course-id"
        let canonicalCourse = spacedPaths.canonicalCourseDataDirectory(courseId: courseId)
        try FileManager.default.createDirectory(at: canonicalCourse, withIntermediateDirectories: true)
        XCTAssertEqual(
            spacedPaths.courseDataDirectory(courseId: courseId).path(percentEncoded: false),
            canonicalCourse.path(percentEncoded: false),
            "canonical courses/<courseId> must win over the legacy fallback even when the root path contains a space"
        )
    }
}

/// Lock-protected progress recorder usable from @Sendable callbacks.
private final class ProgressCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [BundleProgress] = []

    func append(_ progress: BundleProgress) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(progress)
    }

    var events: [BundleProgress] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
