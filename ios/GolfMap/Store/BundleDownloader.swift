import Foundation

/// Everything needed to download one course bundle. The wiring layer builds
/// this from API models; Store itself has no dependency on the API client.
public struct BundleDownloadRequest: Sendable {
    /// Base URL of the tile endpoint, e.g. `http://localhost:3000/tiles`.
    /// Tiles are fetched from `<base>/<courseId>/<layer>/<z>/<x>/<y>.<ext>?v=<versionParam>`.
    public var tileBaseURL: URL
    /// Course row, children, and the tile manifest (bounds/zooms/version).
    public var furniture: CourseFurniture
    /// Provides the `features.geojson` payload (typically an API call).
    public var featuresGeoJSON: @Sendable () async throws -> Data

    public init(
        tileBaseURL: URL,
        furniture: CourseFurniture,
        featuresGeoJSON: @escaping @Sendable () async throws -> Data
    ) {
        self.tileBaseURL = tileBaseURL
        self.furniture = furniture
        self.featuresGeoJSON = featuresGeoJSON
    }
}

/// Cumulative progress. `completedTiles` counts every settled tile, including
/// 404s (tiles outside actual coverage); it always reaches `totalTiles` on
/// success.
public struct BundleProgress: Sendable, Equatable {
    public var completedTiles: Int
    public var totalTiles: Int
    public var missingTiles: Int

    public init(completedTiles: Int, totalTiles: Int, missingTiles: Int) {
        self.completedTiles = completedTiles
        self.totalTiles = totalTiles
        self.missingTiles = missingTiles
    }
}

public struct BundleDownloadResult: Sendable, Equatable {
    public var totalTiles: Int
    public var downloadedTiles: Int
    public var missingTiles: Int

    public init(totalTiles: Int, downloadedTiles: Int, missingTiles: Int) {
        self.totalTiles = totalTiles
        self.downloadedTiles = downloadedTiles
        self.missingTiles = missingTiles
    }
}

public enum BundleDownloadError: Error, Equatable {
    /// Non-404 HTTP error that persisted through the retry.
    case httpStatus(Int, URL)
    /// Response was not HTTP at all.
    case badResponse(URL)
}

/// A started download: consume `progress` for UI, await `result` (or
/// `cancel()`); the progress stream finishes when the download settles.
public struct BundleDownloadHandle: Sendable {
    public let progress: AsyncStream<BundleProgress>
    private let task: Task<BundleDownloadResult, any Error>

    init(progress: AsyncStream<BundleProgress>, task: Task<BundleDownloadResult, any Error>) {
        self.progress = progress
        self.task = task
    }

    public var result: BundleDownloadResult {
        get async throws { try await task.value }
    }

    public func cancel() {
        task.cancel()
    }
}

/// Downloads course bundles: all tiles for both layers (concurrency-limited),
/// plus `features.geojson`, staged in `<courseId>.tmp/` and renamed into
/// place; GRDB furniture rows are written only after the files land, so
/// `bundleState == .complete` implies a usable bundle on disk.
public actor BundleDownloader {
    private let database: AppDatabase
    private let paths: BundlePaths
    private let session: URLSession
    private let maxConcurrentDownloads: Int

    public init(
        database: AppDatabase,
        paths: BundlePaths,
        session: URLSession = .shared,
        maxConcurrentDownloads: Int = 8
    ) {
        self.database = database
        self.paths = paths
        self.session = session
        self.maxConcurrentDownloads = max(1, maxConcurrentDownloads)
    }

    /// Starts a download and returns immediately with a handle.
    public func startDownload(_ request: BundleDownloadRequest) -> BundleDownloadHandle {
        let (stream, continuation) = AsyncStream.makeStream(of: BundleProgress.self)
        let task = Task {
            defer { continuation.finish() }
            return try await self.download(request) { progress in
                continuation.yield(progress)
            }
        }
        return BundleDownloadHandle(progress: stream, task: task)
    }

    /// Runs a download to completion, reporting progress via callback.
    /// Throws `CancellationError` if the surrounding task is cancelled; the
    /// staging directory is removed and the course row reset either way.
    public func download(
        _ request: BundleDownloadRequest,
        onProgress: @escaping @Sendable (BundleProgress) -> Void = { _ in }
    ) async throws -> BundleDownloadResult {
        let courseId = request.furniture.course.id
        let manifest = request.furniture.manifest
        let bounds = TileBounds(
            west: manifest.west,
            south: manifest.south,
            east: manifest.east,
            north: manifest.north
        )

        var jobs: [TileJob] = []
        jobs += TileEnumerator
            .tiles(in: bounds, zoomLevels: manifest.orthoMinZoom...manifest.orthoMaxZoom)
            .map { TileJob(layer: .ortho, coordinate: $0) }
        jobs += TileEnumerator
            .tiles(in: bounds, zoomLevels: manifest.terrainMinZoom...manifest.terrainMaxZoom)
            .map { TileJob(layer: .terrain, coordinate: $0) }
        let totalTiles = jobs.count

        try await database.markDownloading(course: request.furniture.course)

        let fileManager = FileManager.default
        let tmpDir = paths.temporaryCourseDirectory(courseId: courseId)
        // Clear any leftovers from a previous interrupted attempt.
        try? fileManager.removeItem(at: tmpDir)

        do {
            try fileManager.createDirectory(at: tmpDir, withIntermediateDirectories: true)

            // Features first: cheap, and fails fast before the tile storm.
            let features = try await request.featuresGeoJSON()
            try features.write(to: tmpDir.appending(path: "features.geojson"))

            var completed = 0
            var missing = 0
            let session = self.session
            let baseURL = request.tileBaseURL
            let versionParam = manifest.versionParam
            let bundlePaths = self.paths

            try await withThrowingTaskGroup(of: TileOutcome.self) { group in
                var nextIndex = 0

                func startNextJob(_ group: inout ThrowingTaskGroup<TileOutcome, any Error>) {
                    guard nextIndex < jobs.count else { return }
                    let job = jobs[nextIndex]
                    nextIndex += 1
                    group.addTask {
                        try await Self.downloadTile(
                            job,
                            courseId: courseId,
                            baseURL: baseURL,
                            versionParam: versionParam,
                            destinationDirectory: tmpDir,
                            paths: bundlePaths,
                            session: session
                        )
                    }
                }

                for _ in 0..<min(maxConcurrentDownloads, jobs.count) {
                    startNextJob(&group)
                }
                while let outcome = try await group.next() {
                    completed += 1
                    if outcome == .missing { missing += 1 }
                    onProgress(BundleProgress(
                        completedTiles: completed,
                        totalTiles: totalTiles,
                        missingTiles: missing
                    ))
                    startNextJob(&group)
                }
            }

            try Task.checkCancellation()

            // Promote staging directory to its final location, replacing any
            // previous bundle for this course.
            let finalDir = paths.courseDirectory(courseId: courseId)
            try? fileManager.removeItem(at: finalDir)
            try fileManager.moveItem(at: tmpDir, to: finalDir)

            // Furniture + manifest + complete flag land only after the files.
            try await database.saveCompletedBundle(request.furniture)

            return BundleDownloadResult(
                totalTiles: totalTiles,
                downloadedTiles: completed - missing,
                missingTiles: missing
            )
        } catch {
            await cleanUpAfterFailure(courseId: courseId, tmpDir: tmpDir)
            if error is CancellationError || Task.isCancelled {
                throw CancellationError()
            }
            throw error
        }
    }

    /// Removes a course's bundle files and its database rows.
    public func deleteBundle(courseId: String) async throws {
        paths.removeBundleFiles(courseId: courseId)
        try await database.deleteCourse(id: courseId)
    }

    // MARK: - Private

    private struct TileJob: Sendable {
        let layer: TileLayer
        let coordinate: TileCoordinate
    }

    private enum TileOutcome: Sendable, Equatable {
        case downloaded
        case missing
    }

    private func cleanUpAfterFailure(courseId: String, tmpDir: URL) async {
        try? FileManager.default.removeItem(at: tmpDir)
        // The enclosing task may already be cancelled, and GRDB async accesses
        // honor task cancellation — run the state reset in a fresh task.
        let database = self.database
        await Task.detached {
            try? await database.markDownloadFailed(courseId: courseId)
        }.value
    }

    private static func downloadTile(
        _ job: TileJob,
        courseId: String,
        baseURL: URL,
        versionParam: String,
        destinationDirectory: URL,
        paths: BundlePaths,
        session: URLSession
    ) async throws -> TileOutcome {
        let coordinate = job.coordinate
        let url = tileRequestURL(
            baseURL: baseURL,
            courseId: courseId,
            layer: job.layer,
            coordinate: coordinate,
            versionParam: versionParam
        )

        guard let data = try await fetchWithSingleRetry(url: url, session: session) else {
            // 404: tile outside actual coverage — expected, not an error.
            return .missing
        }

        let fileURL = paths.tileURL(
            in: destinationDirectory,
            layer: job.layer,
            z: coordinate.z,
            x: coordinate.x,
            y: coordinate.y
        )
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL)
        return .downloaded
    }

    static func tileRequestURL(
        baseURL: URL,
        courseId: String,
        layer: TileLayer,
        coordinate: TileCoordinate,
        versionParam: String
    ) -> URL {
        var url = baseURL
            .appending(path: courseId)
            .appending(path: layer.rawValue)
            .appending(path: String(coordinate.z))
            .appending(path: String(coordinate.x))
            .appending(path: "\(coordinate.y).\(layer.fileExtension)")
        url.append(queryItems: [URLQueryItem(name: "v", value: versionParam)])
        return url
    }

    /// Returns tile data, nil for 404, throws after one retry for transport
    /// errors or other HTTP statuses. Never retries a cancellation.
    private static func fetchWithSingleRetry(url: URL, session: URLSession) async throws -> Data? {
        do {
            return try await fetchOnce(url: url, session: session)
        } catch {
            try Task.checkCancellation()
            if let urlError = error as? URLError, urlError.code == .cancelled {
                throw CancellationError()
            }
            return try await fetchOnce(url: url, session: session)
        }
    }

    private static func fetchOnce(url: URL, session: URLSession) async throws -> Data? {
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw BundleDownloadError.badResponse(url)
        }
        if http.statusCode == 404 {
            return nil
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BundleDownloadError.httpStatus(http.statusCode, url)
        }
        return data
    }
}
