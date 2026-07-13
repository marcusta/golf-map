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

    func testDeleteBundleRemovesFilesAndRows() async throws {
        serveArchives()
        _ = try await downloader.download(makeRequest())

        try await downloader.deleteBundle(courseId: "course-1")

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path())
        )
        let course = try await database.course(id: "course-1")
        XCTAssertNil(course)
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
