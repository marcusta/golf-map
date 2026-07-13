import Foundation

/// Tile layer within a course bundle. File extensions match what the server
/// pipeline produces: JPEG orthophoto, PNG terrain-RGB.
public enum TileLayer: String, Sendable, CaseIterable {
    case ortho
    case terrain

    public var fileExtension: String {
        switch self {
        case .ortho: "jpg"
        case .terrain: "png"
        }
    }
}

/// On-disk layout of offline data:
///
///     <root>/courses/<courseId>/features.geojson
///     <root>/courses/<courseId>/features-resolved.geojson
///     <root>/maps/<mapKey>/tiles/ortho/{z}/{x}/{y}.jpg
///     <root>/maps/<mapKey>/tiles/terrain/{z}/{x}/{y}.png
///
/// where `<root>` defaults to Application Support/bundles. Downloads land in
/// `<root>/<courseId>.tmp/` first and are renamed into place on success.
public struct BundlePaths: Sendable, Equatable {
    /// Directory containing one subdirectory per course.
    public let rootDirectory: URL

    public init(rootDirectory: URL) {
        self.rootDirectory = rootDirectory
    }

    /// Production layout under Application Support/bundles.
    public static func `default`() throws -> BundlePaths {
        let supportDir = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return BundlePaths(rootDirectory: supportDir.appending(path: "bundles", directoryHint: .isDirectory))
    }

    public func courseDataDirectory(courseId: String) -> URL {
        let canonical = rootDirectory.appending(path: "courses/\(courseId)", directoryHint: .isDirectory)
        let legacy = rootDirectory.appending(path: courseId, directoryHint: .isDirectory)
        return FileManager.default.fileExists(atPath: canonical.path(percentEncoded: false)) ? canonical : legacy
    }

    public func canonicalCourseDataDirectory(courseId: String) -> URL {
        rootDirectory.appending(path: "courses/\(courseId)", directoryHint: .isDirectory)
    }

    public func temporaryCourseDataDirectory(courseId: String) -> URL {
        rootDirectory.appending(path: "courses/\(courseId).tmp", directoryHint: .isDirectory)
    }

    public func mapBundleDirectory(mapKey: String) -> URL {
        let canonical = rootDirectory.appending(path: "maps/\(mapKey)", directoryHint: .isDirectory)
        let legacy = rootDirectory.appending(path: mapKey, directoryHint: .isDirectory)
        return FileManager.default.fileExists(atPath: canonical.path(percentEncoded: false)) ? canonical : legacy
    }

    public func canonicalMapBundleDirectory(mapKey: String) -> URL {
        rootDirectory.appending(path: "maps/\(mapKey)", directoryHint: .isDirectory)
    }

    public func temporaryMapBundleDirectory(mapKey: String) -> URL {
        rootDirectory.appending(path: "maps/\(mapKey).tmp", directoryHint: .isDirectory)
    }

    public func courseFeaturesURL(courseId: String) -> URL {
        courseDataDirectory(courseId: courseId).appending(path: "features.geojson")
    }

    public func courseResolvedFeaturesURL(courseId: String) -> URL {
        courseDataDirectory(courseId: courseId).appending(path: "features-resolved.geojson")
    }

    /// Compatibility alias for the legacy per-course map directory.
    public func courseDirectory(courseId: String) -> URL {
        mapBundleDirectory(mapKey: courseId)
    }

    /// Staging directory used while downloading; renamed to
    /// `courseDirectory` once every file has landed.
    public func temporaryCourseDirectory(courseId: String) -> URL {
        rootDirectory.appending(path: "\(courseId).tmp", directoryHint: .isDirectory)
    }

    public func featuresURL(courseId: String) -> URL {
        courseFeaturesURL(courseId: courseId)
    }

    /// Render-only variant with the surface stack resolved server-side
    /// (overlaps clipped so translucent fills don't compound). Absent in
    /// bundles downloaded before the variant shipped — the map falls back to
    /// `featuresURL`.
    public func resolvedFeaturesURL(courseId: String) -> URL {
        courseResolvedFeaturesURL(courseId: courseId)
    }

    /// Directory holding one layer's tile pyramid inside the given bundle
    /// directory (`<bundle>/tiles/<layer>`). The archive unpacker writes each
    /// tar entry (`<z>/<x>/<y>.<ext>`) relative to this, preserving the
    /// entry's own extension.
    public func layerTilesDirectory(in bundleDirectory: URL, layer: TileLayer) -> URL {
        bundleDirectory
            .appending(path: "tiles", directoryHint: .isDirectory)
            .appending(path: layer.rawValue, directoryHint: .isDirectory)
    }

    /// Path of a single tile inside the given bundle directory. Exposed with
    /// an explicit base so the downloader can target the .tmp directory.
    public func tileURL(in bundleDirectory: URL, layer: TileLayer, z: Int, x: Int, y: Int) -> URL {
        bundleDirectory
            .appending(path: "tiles", directoryHint: .isDirectory)
            .appending(path: layer.rawValue, directoryHint: .isDirectory)
            .appending(path: String(z), directoryHint: .isDirectory)
            .appending(path: String(x), directoryHint: .isDirectory)
            .appending(path: "\(y).\(layer.fileExtension)")
    }

    /// Tile path inside the final bundle for a course.
    public func tileURL(courseId: String, layer: TileLayer, z: Int, x: Int, y: Int) -> URL {
        tileURL(mapKey: courseId, layer: layer, z: z, x: x, y: y)
    }

    public func tileURL(mapKey: String, layer: TileLayer, z: Int, x: Int, y: Int) -> URL {
        tileURL(in: mapBundleDirectory(mapKey: mapKey), layer: layer, z: z, x: x, y: y)
    }

    /// file:// URL template for MapLibre raster/raster-dem sources, with
    /// literal {z}/{x}/{y} placeholders preserved (built by string
    /// concatenation — URL APIs would percent-encode the braces).
    public func tileURLTemplate(courseId: String, layer: TileLayer) -> String {
        tileURLTemplate(mapKey: courseId, layer: layer)
    }

    public func tileURLTemplate(mapKey: String, layer: TileLayer) -> String {
        var base = mapBundleDirectory(mapKey: mapKey).absoluteString
        if !base.hasSuffix("/") { base += "/" }
        return base + "tiles/\(layer.rawValue)/{z}/{x}/{y}.\(layer.fileExtension)"
    }

    /// Removes the bundle files (final and any leftover staging directory).
    /// Missing directories are not an error.
    public func removeBundleFiles(courseId: String) {
        removeCourseDataFiles(courseId: courseId)
        try? removeMapBundleFiles(mapKey: courseId)
    }

    public func removeCourseDataFiles(courseId: String) {
        let fm = FileManager.default
        try? fm.removeItem(at: canonicalCourseDataDirectory(courseId: courseId))
        try? fm.removeItem(at: temporaryCourseDataDirectory(courseId: courseId))
    }

    /// Copies cheap feature payloads out of the pre-v7 combined course/map
    /// directory before that directory is removed as an orphaned map bundle.
    public func preserveLegacyCourseData(courseId: String, mapKey: String) throws {
        guard courseId == mapKey else { return }
        let legacyDirectory = rootDirectory.appending(path: mapKey, directoryHint: .isDirectory)
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: legacyDirectory.path(percentEncoded: false)) else { return }

        let names = ["features.geojson", "features-resolved.geojson"]
        let existingNames = names.filter {
            fileManager.fileExists(atPath: legacyDirectory.appending(path: $0).path(percentEncoded: false))
        }
        guard !existingNames.isEmpty else { return }

        let destinationDirectory = canonicalCourseDataDirectory(courseId: courseId)
        try fileManager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)
        for name in existingNames {
            let destination = destinationDirectory.appending(path: name)
            guard !fileManager.fileExists(atPath: destination.path(percentEncoded: false)) else { continue }
            try fileManager.copyItem(
                at: legacyDirectory.appending(path: name),
                to: destination
            )
        }
    }

    /// Removes only expensive ortho/terrain storage. Missing directories are
    /// harmless, but actual filesystem failures are surfaced to the caller.
    public func removeMapBundleFiles(mapKey: String) throws {
        let fm = FileManager.default
        for directory in [
            canonicalMapBundleDirectory(mapKey: mapKey),
            temporaryMapBundleDirectory(mapKey: mapKey),
            rootDirectory.appending(path: mapKey, directoryHint: .isDirectory),
        ] where fm.fileExists(atPath: directory.path(percentEncoded: false)) {
            try fm.removeItem(at: directory)
        }
        // This is called only after GRDB proves the map has no references, so
        // it is also safe to clean up a pre-v7 bundle left at <root>/<mapKey>.
    }
}
