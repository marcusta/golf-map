import Foundation

/// Errors surfaced by `GolfAPIClient`.
public enum APIError: Error, Equatable, Sendable {
    /// The server returned 401. After the client's one automatic re-login retry
    /// (when a credentials provider is configured) still failed, or no provider
    /// is set.
    case unauthorized
    /// A non-2xx, non-401 HTTP status. `message` is the decoded `{error}` body
    /// when present, else the raw body prefix (may be empty).
    case http(status: Int, message: String?)
    /// The response body could not be decoded into the expected model.
    case decoding(String)
    /// The request never produced an HTTP response (URLSession error, no
    /// `HTTPURLResponse`, etc.).
    case transport(String)
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Unauthorized."
        case let .http(status, message):
            return "HTTP \(status)\(message.map { ": \($0)" } ?? "")."
        case let .decoding(detail):
            return "Failed to decode response: \(detail)"
        case let .transport(detail):
            return "Network error: \(detail)"
        }
    }
}
