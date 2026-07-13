import Foundation

/// Everything needed to download one course bundle. The wiring layer builds
/// this from API models; Store itself has no dependency on the API client.
public struct BundleDownloadRequest: Sendable {
    /// Base URL of the tile endpoint, e.g. `http://localhost:3000/tiles`.
    /// A layer archive is fetched from
    /// `<base>/<courseId>/<layer>/archive.tar?v=<versionParam>[&maxzoom=<n>]`.
    public var tileBaseURL: URL
    /// Course row, children, and the tile manifest (bounds/zooms/version).
    public var furniture: CourseFurniture
    /// Provides the `features.geojson` payload (typically an API call).
    public var featuresGeoJSON: @Sendable () async throws -> Data
    /// Provides the render-only `features-resolved.geojson` payload (surface
    /// stack clipped server-side). nil skips the file (tests, older wiring);
    /// the map then falls back to the raw features.
    public var resolvedFeaturesGeoJSON: (@Sendable () async throws -> Data)?

    public init(
        tileBaseURL: URL,
        furniture: CourseFurniture,
        featuresGeoJSON: @escaping @Sendable () async throws -> Data,
        resolvedFeaturesGeoJSON: (@Sendable () async throws -> Data)? = nil
    ) {
        self.tileBaseURL = tileBaseURL
        self.furniture = furniture
        self.featuresGeoJSON = featuresGeoJSON
        self.resolvedFeaturesGeoJSON = resolvedFeaturesGeoJSON
    }
}

/// Cumulative download progress in bytes, summed across both layer archives.
/// `totalBytes` is the sum of each archive's `Content-Length` (0 until a
/// response's length is known); `completedBytes` is bytes streamed so far.
public struct BundleProgress: Sendable, Equatable {
    public var completedBytes: Int64
    public var totalBytes: Int64

    public init(completedBytes: Int64, totalBytes: Int64) {
        self.completedBytes = completedBytes
        self.totalBytes = totalBytes
    }
}

public struct BundleDownloadResult: Sendable, Equatable {
    /// Total tile files unpacked from both layer archives.
    public var downloadedTiles: Int
    /// Total bytes downloaded across both archives.
    public var totalBytes: Int64

    public init(downloadedTiles: Int, totalBytes: Int64) {
        self.downloadedTiles = downloadedTiles
        self.totalBytes = totalBytes
    }
}

/// Outcome of releasing a course's downloaded map data. `removedMapBundle`
/// is false when another downloaded course still uses the same site map.
public struct CourseDataRemovalResult: Sendable, Equatable {
    public var courseId: String
    public var removedMapBundle: Bool

    public init(courseId: String, removedMapBundle: Bool) {
        self.courseId = courseId
        self.removedMapBundle = removedMapBundle
    }
}

public enum BundleDownloadError: Error, Equatable {
    /// Non-404 HTTP error that persisted through the retry.
    case httpStatus(Int, URL)
    /// Response was not HTTP at all.
    case badResponse(URL)
    /// The server has no tiles for a layer (archive request 404'd, or the
    /// archive was empty). Installing it would record a `complete` bundle with
    /// no map and no way to repair from the list — refuse instead.
    case layerHasNoTiles(TileLayer)
    /// A layer archive downloaded but did not parse as a valid tar.
    case malformedArchive(TileLayer)
}

extension BundleDownloadError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .httpStatus(status, url):
            "HTTP \(status) for \(url.lastPathComponent)"
        case let .badResponse(url):
            "Unexpected response for \(url.lastPathComponent)"
        case let .layerHasNoTiles(layer):
            "The server has no \(layer.rawValue) tiles for this course."
        case let .malformedArchive(layer):
            "The \(layer.rawValue) tile archive was corrupt."
        }
    }
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

/// Downloads course bundles: one tar archive per layer (ortho capped at
/// `orthoBundleMaxZoom`, terrain uncapped), streamed to disk and unpacked into
/// a shared map staging layout. Raw and resolved features remain per course;
/// only tiles are promoted once per `course.mapKey`. GRDB rows are written
/// only after the files land, so `bundleState == .complete` implies a usable
/// bundle on disk.
public actor BundleDownloader {
    /// Offline ortho cap: the archive requests `maxzoom=19` and the map style
    /// overzooms z19 tiles past this at deeper view zooms. Deeper native ortho
    /// levels balloon the bundle for little on-course benefit.
    public static let orthoBundleMaxZoom = 19

    private static let streamBufferSize = 256 * 1024

    private let database: AppDatabase
    private let paths: BundlePaths
    private let session: URLSession

    public init(
        database: AppDatabase,
        paths: BundlePaths,
        session: URLSession = .shared,
        maxConcurrentDownloads: Int = 8
    ) {
        self.database = database
        self.paths = paths
        self.session = session
        // maxConcurrentDownloads retained for source compatibility; the archive
        // scheme fetches at most one request per layer.
        _ = maxConcurrentDownloads
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
        let mapKey = request.furniture.course.mapKey
        let manifest = request.furniture.manifest
        let previousCourse = try await database.course(id: courseId)
        let previousMapKey = previousCourse?.downloadedRevision == nil
            ? nil
            : previousCourse?.mapKey

        try await database.markDownloading(course: request.furniture.course)

        let fileManager = FileManager.default
        let courseTmpDir = paths.temporaryCourseDataDirectory(courseId: courseId)
        let mapTmpDir = paths.temporaryMapBundleDirectory(mapKey: mapKey)
        // Clear any leftovers from a previous interrupted attempt.
        try? fileManager.removeItem(at: courseTmpDir)
        try? fileManager.removeItem(at: mapTmpDir)

        let result: BundleDownloadResult
        do {
            try fileManager.createDirectory(at: courseTmpDir, withIntermediateDirectories: true)

            // Raw features describe this course rather than the whole site.
            let features = try await request.featuresGeoJSON()
            try features.write(to: courseTmpDir.appending(path: "features.geojson"))
            if let resolvedFeatures = try await request.resolvedFeaturesGeoJSON?() {
                try resolvedFeatures.write(to: courseTmpDir.appending(path: "features-resolved.geojson"))
            }

            let canReuseMap = try await database.hasCurrentMapBundle(
                mapKey: mapKey,
                versionParam: manifest.versionParam
            ) && Self.mapFilesAreUsable(paths: paths, mapKey: mapKey)
            var downloadedTiles = 0
            var totalBytes: Int64 = 0
            var completedMapBundle: MapBundleRecord?

            if !canReuseMap {
                try fileManager.createDirectory(at: mapTmpDir, withIntermediateDirectories: true)

                let aggregator = ByteProgressAggregator(onProgress: onProgress)
                let session = self.session
                let baseURL = request.tileBaseURL
                let bundlePaths = self.paths
                let layerSpecs: [(layer: TileLayer, maxzoom: Int?)] = [
                    (.ortho, Self.orthoBundleMaxZoom),
                    (.terrain, nil),
                ]
                try await withThrowingTaskGroup(of: Int.self) { group in
                    for spec in layerSpecs {
                        group.addTask {
                            try await Self.downloadLayerArchive(
                                layer: spec.layer,
                                maxzoom: spec.maxzoom,
                                courseId: courseId,
                                baseURL: baseURL,
                                versionParam: manifest.versionParam,
                                stagingDirectory: mapTmpDir,
                                paths: bundlePaths,
                                session: session,
                                aggregator: aggregator
                            )
                        }
                    }
                    for try await tilesInLayer in group {
                        downloadedTiles += tilesInLayer
                    }
                }
                totalBytes = aggregator.totalBytes
                completedMapBundle = MapBundleRecord(
                    mapKey: mapKey,
                    versionParam: manifest.versionParam,
                    generatedAt: manifest.generatedAt
                )
            }

            try Task.checkCancellation()

            if !canReuseMap {
                let finalMapDir = paths.canonicalMapBundleDirectory(mapKey: mapKey)
                try fileManager.createDirectory(
                    at: finalMapDir.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? fileManager.removeItem(at: finalMapDir)
                try fileManager.moveItem(at: mapTmpDir, to: finalMapDir)
            }

            let finalCourseDir = paths.canonicalCourseDataDirectory(courseId: courseId)
            try fileManager.createDirectory(
                at: finalCourseDir.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? fileManager.removeItem(at: finalCourseDir)
            try fileManager.moveItem(at: courseTmpDir, to: finalCourseDir)

            // Furniture + manifest + complete flag land only after the files.
            try await database.saveCompletedBundle(request.furniture, mapBundle: completedMapBundle)

            result = BundleDownloadResult(
                downloadedTiles: downloadedTiles,
                totalBytes: totalBytes
            )
        } catch {
            await cleanUpAfterFailure(
                courseId: courseId,
                temporaryDirectories: [courseTmpDir, mapTmpDir]
            )
            if error is CancellationError || Task.isCancelled {
                throw CancellationError()
            }
            throw error
        }

        // A successful first post-v7 update switches the course from its
        // legacy per-course map key to the shared site key. Retire the old
        // metadata and expensive files only after the new map + DB state are
        // complete; failed/cancelled updates continue using the old key
        // untouched. Cleanup errors must not run the download-failure rollback
        // now that the newly promoted bundle is already authoritative.
        if let previousMapKey, previousMapKey != mapKey,
           try await database.mapBundleIsUnreferenced(mapKey: previousMapKey) {
            try paths.preserveLegacyCourseData(courseId: courseId, mapKey: previousMapKey)
            try paths.removeMapBundleFiles(mapKey: previousMapKey)
            _ = try await database.removeMapBundleIfUnreferenced(mapKey: previousMapKey)
        }

        return result
    }

    /// Releases only the expensive ortho/terrain data for a course. Cheap
    /// furniture, feature payloads, plans, calibrations, rounds, and shots are
    /// retained. A shared site map is removed only after its last downloaded
    /// course is released.
    @discardableResult
    public func removeDownloadedData(courseId: String) async throws -> CourseDataRemovalResult {
        guard let plan = try await database.downloadedCourseDataRemovalPlan(courseId: courseId) else {
            return CourseDataRemovalResult(courseId: courseId, removedMapBundle: false)
        }
        if plan.removesMapBundle {
            try paths.preserveLegacyCourseData(courseId: courseId, mapKey: plan.mapKey)
            try paths.removeMapBundleFiles(mapKey: plan.mapKey)
        }
        try await database.commitDownloadedCourseDataRemoval(plan)
        return CourseDataRemovalResult(
            courseId: courseId,
            removedMapBundle: plan.removesMapBundle
        )
    }

    /// Compatibility name used by existing wiring. This removes downloaded
    /// data; it deliberately does not delete the course or its cheap data.
    public func deleteBundle(courseId: String) async throws {
        _ = try await removeDownloadedData(courseId: courseId)
    }

    // MARK: - Private

    private func cleanUpAfterFailure(courseId: String, temporaryDirectories: [URL]) async {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
        }
        // The enclosing task may already be cancelled, and GRDB async accesses
        // honor task cancellation — run the state reset in a fresh task.
        let database = self.database
        await Task.detached {
            try? await database.markDownloadFailed(courseId: courseId)
        }.value
    }

    private static func mapFilesAreUsable(paths: BundlePaths, mapKey: String) -> Bool {
        let mapDirectory = paths.mapBundleDirectory(mapKey: mapKey)
        let fm = FileManager.default
        return fm.fileExists(atPath: paths.layerTilesDirectory(in: mapDirectory, layer: .ortho).path(percentEncoded: false))
            && fm.fileExists(atPath: paths.layerTilesDirectory(in: mapDirectory, layer: .terrain).path(percentEncoded: false))
    }

    /// Downloads one layer's archive to a temp file, unpacks it into the
    /// staging tile layout, and returns the number of tiles written. A single
    /// retry covers a transport error; a 404 (or an empty archive) becomes
    /// `layerHasNoTiles`.
    private static func downloadLayerArchive(
        layer: TileLayer,
        maxzoom: Int?,
        courseId: String,
        baseURL: URL,
        versionParam: String,
        stagingDirectory: URL,
        paths: BundlePaths,
        session: URLSession,
        aggregator: ByteProgressAggregator
    ) async throws -> Int {
        let url = archiveRequestURL(
            baseURL: baseURL,
            courseId: courseId,
            layer: layer,
            versionParam: versionParam,
            maxzoom: maxzoom
        )
        let tarURL = stagingDirectory.appending(path: "\(layer.rawValue).tar")

        try await streamArchiveWithSingleRetry(
            url: url,
            destination: tarURL,
            layer: layer,
            session: session,
            aggregator: aggregator
        )

        // Unpack via a memory-mapped read so a large archive is not held in
        // RAM in full.
        let archiveData = try Data(contentsOf: tarURL, options: .mappedIfSafe)
        let layerDir = paths.layerTilesDirectory(in: stagingDirectory, layer: layer)
        let fileManager = FileManager.default

        var count = 0
        do {
            try TarArchiveReader.read(archiveData) { entry in
                let dest = layerDir.appending(path: entry.name)
                try fileManager.createDirectory(
                    at: dest.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try entry.data.write(to: dest)
                count += 1
            }
        } catch is TarArchiveError {
            throw BundleDownloadError.malformedArchive(layer)
        }

        try? fileManager.removeItem(at: tarURL)

        if count == 0 {
            // An archive with no regular-file entries is as unusable as a 404.
            throw BundleDownloadError.layerHasNoTiles(layer)
        }
        return count
    }

    /// Streams the archive to `destination`, retrying once on a transport
    /// error. HTTP status errors (including the 404 → `layerHasNoTiles` map)
    /// and cancellation are final — never retried.
    private static func streamArchiveWithSingleRetry(
        url: URL,
        destination: URL,
        layer: TileLayer,
        session: URLSession,
        aggregator: ByteProgressAggregator
    ) async throws {
        do {
            try await streamArchiveOnce(
                url: url, destination: destination, layer: layer,
                session: session, aggregator: aggregator
            )
        } catch {
            try Task.checkCancellation()
            if error is CancellationError { throw error }
            if error is BundleDownloadError { throw error } // final: no retry
            if let urlError = error as? URLError, urlError.code == .cancelled {
                throw CancellationError()
            }
            // Transport error — reset this layer's byte tally and retry once.
            aggregator.reset(layer: layer)
            try? FileManager.default.removeItem(at: destination)
            try await streamArchiveOnce(
                url: url, destination: destination, layer: layer,
                session: session, aggregator: aggregator
            )
        }
    }

    private static func streamArchiveOnce(
        url: URL,
        destination: URL,
        layer: TileLayer,
        session: URLSession,
        aggregator: ByteProgressAggregator
    ) async throws {
        let (bytes, response) = try await session.bytes(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw BundleDownloadError.badResponse(url)
        }
        if http.statusCode == 404 {
            throw BundleDownloadError.layerHasNoTiles(layer)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BundleDownloadError.httpStatus(http.statusCode, url)
        }

        aggregator.setTotal(layer: layer, total: max(response.expectedContentLength, 0))

        let fileManager = FileManager.default
        fileManager.createFile(atPath: destination.path, contents: nil)
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }

        var buffer = Data()
        buffer.reserveCapacity(streamBufferSize)
        var downloaded: Int64 = 0

        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count >= streamBufferSize {
                try handle.write(contentsOf: buffer)
                downloaded += Int64(buffer.count)
                buffer.removeAll(keepingCapacity: true)
                aggregator.update(layer: layer, downloaded: downloaded)
                try Task.checkCancellation()
            }
        }
        if !buffer.isEmpty {
            try handle.write(contentsOf: buffer)
            downloaded += Int64(buffer.count)
        }
        aggregator.update(layer: layer, downloaded: downloaded)
    }

    static func archiveRequestURL(
        baseURL: URL,
        courseId: String,
        layer: TileLayer,
        versionParam: String,
        maxzoom: Int?
    ) -> URL {
        var url = baseURL
            .appending(path: courseId)
            .appending(path: layer.rawValue)
            .appending(path: "archive.tar")
        var items = [URLQueryItem(name: "v", value: versionParam)]
        if let maxzoom {
            items.append(URLQueryItem(name: "maxzoom", value: String(maxzoom)))
        }
        url.append(queryItems: items)
        return url
    }
}

/// Aggregates per-layer byte counts into a single `BundleProgress`, emitting on
/// every update. Lock-protected because the layer download tasks run
/// concurrently.
private final class ByteProgressAggregator: @unchecked Sendable {
    private let lock = NSLock()
    private var downloadedByLayer: [TileLayer: Int64] = [:]
    private var totalByLayer: [TileLayer: Int64] = [:]
    private let onProgress: @Sendable (BundleProgress) -> Void

    init(onProgress: @escaping @Sendable (BundleProgress) -> Void) {
        self.onProgress = onProgress
    }

    func setTotal(layer: TileLayer, total: Int64) {
        lock.lock()
        defer { lock.unlock() }
        totalByLayer[layer] = total
        emit()
    }

    func update(layer: TileLayer, downloaded: Int64) {
        lock.lock()
        defer { lock.unlock() }
        downloadedByLayer[layer] = downloaded
        emit()
    }

    func reset(layer: TileLayer) {
        lock.lock()
        defer { lock.unlock() }
        downloadedByLayer[layer] = 0
        totalByLayer[layer] = 0
        emit()
    }

    var totalBytes: Int64 {
        lock.lock()
        defer { lock.unlock() }
        return totalByLayer.values.reduce(0, +)
    }

    /// Caller holds `lock`.
    private func emit() {
        let completed = downloadedByLayer.values.reduce(0, +)
        let total = totalByLayer.values.reduce(0, +)
        onProgress(BundleProgress(completedBytes: completed, totalBytes: total))
    }
}
