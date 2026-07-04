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

    // The fixture manifest (bounds 0..10, ortho z1-2, terrain z1) covers
    // exactly these 6 tiles — see StoreFixtures and TileEnumeratorTests.
    private let expectedTilePaths = [
        "tiles/ortho/1/1/0.jpg",
        "tiles/ortho/1/1/1.jpg",
        "tiles/ortho/2/2/1.jpg",
        "tiles/ortho/2/2/2.jpg",
        "tiles/terrain/1/1/0.png",
        "tiles/terrain/1/1/1.png",
    ]

    // MARK: - Happy path

    func testSuccessfulDownloadWithOne404() async throws {
        let tileBytes = Data("tile-bytes".utf8)
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("terrain/1/1/0") {
                return MockTileResponse(statusCode: 404, data: Data())
            }
            return MockTileResponse(statusCode: 200, data: tileBytes)
        }

        let collector = ProgressCollector()
        let result = try await downloader.download(makeRequest()) { collector.append($0) }

        XCTAssertEqual(result, BundleDownloadResult(totalTiles: 6, downloadedTiles: 5, missingTiles: 1))

        // Files landed in the final directory; the 404 tile has no file.
        let courseDir = paths.courseDirectory(courseId: "course-1")
        let fm = FileManager.default
        for tilePath in expectedTilePaths where tilePath != "tiles/terrain/1/1/0.png" {
            XCTAssertTrue(
                fm.fileExists(atPath: courseDir.appending(path: tilePath).path()),
                "missing \(tilePath)"
            )
        }
        XCTAssertFalse(fm.fileExists(atPath: courseDir.appending(path: "tiles/terrain/1/1/0.png").path()))
        XCTAssertEqual(
            try Data(contentsOf: courseDir.appending(path: "tiles/ortho/1/1/0.jpg")),
            tileBytes
        )
        XCTAssertEqual(
            try Data(contentsOf: paths.featuresURL(courseId: "course-1")),
            Data(#"{"type":"FeatureCollection","features":[]}"#.utf8)
        )

        // Staging directory is gone.
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))

        // Every tile request carried ?v=<versionParam>.
        let tileURLs = StoreMockURLProtocol.requestedURLs
        XCTAssertEqual(tileURLs.count, 6)
        for url in tileURLs {
            XCTAssertEqual(url.query(), "v=ver1", "missing version param on \(url)")
        }

        // Progress: one event per tile, ending at done == total.
        let events = collector.events
        XCTAssertEqual(events.count, 6)
        XCTAssertEqual(events.last, BundleProgress(completedTiles: 6, totalTiles: 6, missingTiles: 1))

        // Furniture landed with the complete flag.
        let fetchedCourse = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetchedCourse)
        XCTAssertEqual(course.bundleState, .complete)
        XCTAssertEqual(course.downloadedRevision, 3)
        let furniture = try await database.courseFurniture(courseId: "course-1")
        XCTAssertNotNil(furniture)
    }

    func testStartDownloadStreamsProgressAndFinishes() async throws {
        StoreMockURLProtocol.setHandler { _ in
            MockTileResponse(statusCode: 200, data: Data("t".utf8))
        }

        let handle = await downloader.startDownload(makeRequest())
        var events: [BundleProgress] = []
        for await progress in handle.progress {
            events.append(progress)
        }
        // The stream finished, so the download settled.
        let result = try await handle.result
        XCTAssertEqual(result.totalTiles, 6)
        XCTAssertEqual(events.count, 6)
        XCTAssertEqual(events.last, BundleProgress(completedTiles: 6, totalTiles: 6, missingTiles: 0))
    }

    // MARK: - Retry

    func testTransient500IsRetriedOncePerTile() async throws {
        let attempts = AttemptCounter()
        StoreMockURLProtocol.setHandler { request in
            let key = request.url!.path()
            if attempts.record(key) == 1, key.contains("ortho/2/2/1") {
                return MockTileResponse(statusCode: 500, data: Data())
            }
            return MockTileResponse(statusCode: 200, data: Data("t".utf8))
        }

        let result = try await downloader.download(makeRequest())
        XCTAssertEqual(result, BundleDownloadResult(totalTiles: 6, downloadedTiles: 6, missingTiles: 0))

        // The failing tile was requested exactly twice.
        let retriedRequests = StoreMockURLProtocol.requestedURLs.filter { $0.path().contains("ortho/2/2/1") }
        XCTAssertEqual(retriedRequests.count, 2)
    }

    // MARK: - Failure

    func testPersistent500FailsCleanly() async throws {
        StoreMockURLProtocol.setHandler { request in
            if request.url!.path().contains("ortho/1/1/1") {
                return MockTileResponse(statusCode: 500, data: Data())
            }
            return MockTileResponse(statusCode: 200, data: Data("t".utf8))
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

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()))
        XCTAssertFalse(fm.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path()))

        let fetchedCourse = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetchedCourse)
        XCTAssertEqual(course.bundleState, BundleState.none)
        XCTAssertNil(course.downloadedRevision)
    }

    func testFeaturesProviderFailureAborts() async throws {
        StoreMockURLProtocol.setHandler { _ in
            MockTileResponse(statusCode: 200, data: Data("t".utf8))
        }
        struct FeaturesUnavailable: Error {}
        let request = BundleDownloadRequest(
            tileBaseURL: URL(string: "http://localhost:3000/tiles")!,
            furniture: StoreFixtures.furniture(),
            featuresGeoJSON: { throw FeaturesUnavailable() }
        )

        await XCTAssertThrowsErrorAsync(try await downloader.download(request))
        XCTAssertTrue(StoreMockURLProtocol.requestedURLs.isEmpty, "no tiles should be fetched")
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: paths.temporaryCourseDirectory(courseId: "course-1").path()
            )
        )
    }

    // MARK: - Cancellation

    func testCancellationCleansUpStagingDirectory() async throws {
        // Slow responses so cancellation lands mid-flight.
        StoreMockURLProtocol.setHandler { _ in
            MockTileResponse(statusCode: 200, data: Data("t".utf8), delay: 0.5)
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

        let fetchedCourse = try await database.course(id: "course-1")
        let course = try XCTUnwrap(fetchedCourse)
        XCTAssertEqual(course.bundleState, BundleState.none)
    }

    // MARK: - Delete

    func testDeleteBundleRemovesFilesAndRows() async throws {
        StoreMockURLProtocol.setHandler { _ in
            MockTileResponse(statusCode: 200, data: Data("t".utf8))
        }
        _ = try await downloader.download(makeRequest())

        try await downloader.deleteBundle(courseId: "course-1")

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: paths.courseDirectory(courseId: "course-1").path())
        )
        let course = try await database.course(id: "course-1")
        XCTAssertNil(course)
    }

    // MARK: - Path helpers

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
