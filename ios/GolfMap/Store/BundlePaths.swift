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

/// On-disk layout of offline course bundles:
///
///     <root>/<courseId>/features.geojson
///     <root>/<courseId>/tiles/ortho/{z}/{x}/{y}.jpg
///     <root>/<courseId>/tiles/terrain/{z}/{x}/{y}.png
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

    /// Final directory for a course's bundle.
    public func courseDirectory(courseId: String) -> URL {
        rootDirectory.appending(path: courseId, directoryHint: .isDirectory)
    }

    /// Staging directory used while downloading; renamed to
    /// `courseDirectory` once every file has landed.
    public func temporaryCourseDirectory(courseId: String) -> URL {
        rootDirectory.appending(path: "\(courseId).tmp", directoryHint: .isDirectory)
    }

    public func featuresURL(courseId: String) -> URL {
        courseDirectory(courseId: courseId).appending(path: "features.geojson")
    }

    /// Render-only variant with the surface stack resolved server-side
    /// (overlaps clipped so translucent fills don't compound). Absent in
    /// bundles downloaded before the variant shipped — the map falls back to
    /// `featuresURL`.
    public func resolvedFeaturesURL(courseId: String) -> URL {
        courseDirectory(courseId: courseId).appending(path: "features-resolved.geojson")
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
        tileURL(in: courseDirectory(courseId: courseId), layer: layer, z: z, x: x, y: y)
    }

    /// file:// URL template for MapLibre raster/raster-dem sources, with
    /// literal {z}/{x}/{y} placeholders preserved (built by string
    /// concatenation — URL APIs would percent-encode the braces).
    public func tileURLTemplate(courseId: String, layer: TileLayer) -> String {
        var base = courseDirectory(courseId: courseId).absoluteString
        if !base.hasSuffix("/") { base += "/" }
        return base + "tiles/\(layer.rawValue)/{z}/{x}/{y}.\(layer.fileExtension)"
    }

    /// Removes the bundle files (final and any leftover staging directory).
    /// Missing directories are not an error.
    public func removeBundleFiles(courseId: String) {
        let fm = FileManager.default
        try? fm.removeItem(at: courseDirectory(courseId: courseId))
        try? fm.removeItem(at: temporaryCourseDirectory(courseId: courseId))
    }
}
