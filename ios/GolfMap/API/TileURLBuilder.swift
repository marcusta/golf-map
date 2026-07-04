import Foundation

/// Builds tile URLs for the unauthenticated tile endpoint:
///   `GET /tiles/{courseId}/{layer}/{z}/{x}/{y}.{jpg|png}`
///
/// Layer → extension is fixed by the server: `ortho` serves JPEG, `terrain`
/// serves PNG. This is a pure URL builder — actually downloading tiles is the
/// download manager's job (owned by another module).
public struct TileURLBuilder: Sendable {
    /// A tile layer and its wire image format.
    public enum Layer: String, Sendable, CaseIterable {
        case ortho
        case terrain

        /// File extension the server serves this layer as.
        public var fileExtension: String {
            switch self {
            case .ortho: return "jpg"
            case .terrain: return "png"
            }
        }
    }

    /// Base URL of the server, e.g. `http://localhost:3000`.
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// URL for a single tile.
    /// - Parameter version: optional cache-buster appended as `?v=<version>`
    ///   (pass `TileManifest.versionParam`). When nil, no query is added.
    public func url(
        courseId: String,
        layer: Layer,
        z: Int,
        x: Int,
        y: Int,
        version: String? = nil
    ) -> URL {
        var url = baseURL
            .appendingPathComponent("tiles")
            .appendingPathComponent(courseId)
            .appendingPathComponent(layer.rawValue)
            .appendingPathComponent(String(z))
            .appendingPathComponent(String(x))
            .appendingPathComponent("\(y).\(layer.fileExtension)")

        if let version, !version.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.queryItems = [URLQueryItem(name: "v", value: version)]
            if let withQuery = components?.url {
                url = withQuery
            }
        }
        return url
    }
}
