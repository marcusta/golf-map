import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// On-disk files of reference photos (docs/feature-reference-photos.md §4.3):
/// `<root>/<id>.heic` (original), `<id>.jpg` (2048 px preview, quality 0.85)
/// and `<id>-thumb.jpg` (512 px). All three are written at capture time, so
/// the upload never decodes HEIC and the list never waits for the network.
///
/// Rows store file names relative to `rootDirectory`: the app container path
/// changes across installs and restores, a relative name does not. Every
/// FileManager call uses `path(percentEncoded: false)`.
struct PhotoFiles: Sendable {
    let rootDirectory: URL

    static let previewLongEdge = 2048
    static let previewQuality = 0.85
    static let thumbnailLongEdge = 512
    static let thumbnailQuality = 0.8

    /// Production layout, Application Support/photos.
    static func `default`() throws -> PhotoFiles {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return PhotoFiles(rootDirectory: support.appending(path: "photos", directoryHint: .isDirectory))
    }

    func url(_ file: String) -> URL {
        rootDirectory.appending(path: file, directoryHint: .notDirectory)
    }

    func exists(_ file: String) -> Bool {
        FileManager.default.fileExists(atPath: url(file).path(percentEncoded: false))
    }

    func read(_ file: String) throws -> Data {
        try Data(contentsOf: url(file))
    }

    func remove(_ file: String) {
        try? FileManager.default.removeItem(atPath: url(file).path(percentEncoded: false))
    }

    // MARK: - Capture

    struct Written: Sendable, Equatable {
        var originalFile: String
        var previewFile: String
        var thumbnailFile: String
        var originalSha256: String
        var originalBytes: Int
        var previewSha256: String
        var previewBytes: Int
        /// Size after EXIF orientation.
        var width: Int
        var height: Int
        /// EXIF orientation of the original (1 when absent).
        var exifOrientation: UInt32
    }

    enum WriteError: Error, Equatable {
        case unreadableImage
        case encodeFailed
    }

    /// Writes the original bytes as captured, then encodes the preview and
    /// thumbnail from them with EXIF orientation applied to the pixels.
    func write(id: String, original: Data) throws -> Written {
        try FileManager.default.createDirectory(
            atPath: rootDirectory.path(percentEncoded: false),
            withIntermediateDirectories: true
        )
        guard let source = CGImageSourceCreateWithData(original as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = props[kCGImagePropertyPixelWidth] as? Int,
              let pixelHeight = props[kCGImagePropertyPixelHeight] as? Int
        else { throw WriteError.unreadableImage }
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
        let oriented = CameraPoseMath.orientedSize(
            pixelWidth: pixelWidth, pixelHeight: pixelHeight, exifOrientation: orientation
        )

        let originalFile = "\(id).heic"
        let previewFile = "\(id).jpg"
        let thumbnailFile = "\(id)-thumb.jpg"

        try original.write(to: url(originalFile), options: .atomic)
        let preview = try Self.jpeg(from: source, longEdge: Self.previewLongEdge, quality: Self.previewQuality)
        try preview.write(to: url(previewFile), options: .atomic)
        let thumb = try Self.jpeg(from: source, longEdge: Self.thumbnailLongEdge, quality: Self.thumbnailQuality)
        try thumb.write(to: url(thumbnailFile), options: .atomic)

        return Written(
            originalFile: originalFile,
            previewFile: previewFile,
            thumbnailFile: thumbnailFile,
            originalSha256: Self.sha256Hex(original),
            originalBytes: original.count,
            previewSha256: Self.sha256Hex(preview),
            previewBytes: preview.count,
            width: oriented.width,
            height: oriented.height,
            exifOrientation: orientation
        )
    }

    /// Lowercase hex SHA-256, the `X-Content-SHA256` header format.
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// JPEG with the long edge at most `longEdge`, EXIF orientation baked
    /// into the pixels (no orientation tag), sRGB.
    static func jpeg(from source: CGImageSource, longEdge: Int, quality: Double) throws -> Data {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw WriteError.encodeFailed
        }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw WriteError.encodeFailed
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw WriteError.encodeFailed }
        return out as Data
    }
}
