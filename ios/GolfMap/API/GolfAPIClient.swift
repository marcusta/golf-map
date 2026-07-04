import Foundation

/// Async client for the golf-map server API.
///
/// Design:
/// - **`actor`** (not `@MainActor final class`): the client owns mutable state
///   — the credentials-provider hook and the in-flight re-login guard — and does
///   only async network I/O, never touches UIKit. An actor gives us safe
///   serialized access to that state off the main thread under Swift 6 strict
///   concurrency, without forcing callers onto the main actor.
/// - **Cookie session**: uses `URLSession`'s default `HTTPCookieStorage`, which
///   carries the `session` cookie set by `/api/auth/login` automatically. No
///   manual header handling.
/// - **Auto re-login on 401**: if a `credentialsProvider` is set, a 401 triggers
///   one silent re-login and one retry of the original request. A per-request
///   flag prevents infinite loops.
public actor GolfAPIClient {
    /// Supplies `(username, password)` for silent re-login, or nil to abort.
    /// Keychain storage is out of scope for this client — this is just the hook.
    public typealias CredentialsProvider = @Sendable () async -> (username: String, password: String)?

    /// API base, e.g. `http://localhost:3000/api`.
    private let apiBaseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private var credentialsProvider: CredentialsProvider?

    /// - Parameters:
    ///   - baseURL: server origin, e.g. `http://localhost:3000`. The `/api`
    ///     prefix is appended internally.
    ///   - session: defaults to `.shared` so the process-wide cookie storage is
    ///     used. Tests inject a `URLSession` with a mock `URLProtocol`.
    ///   - credentialsProvider: optional hook for silent re-login on 401.
    public init(
        baseURL: URL,
        session: URLSession = .shared,
        credentialsProvider: CredentialsProvider? = nil
    ) {
        self.apiBaseURL = baseURL.appendingPathComponent("api")
        self.session = session
        self.decoder = JSONDecoder()
        self.credentialsProvider = credentialsProvider
    }

    /// Sets (or clears) the re-login hook after construction.
    public func setCredentialsProvider(_ provider: CredentialsProvider?) {
        self.credentialsProvider = provider
    }

    // MARK: - Auth

    @discardableResult
    public func login(username: String, password: String) async throws -> AuthUser {
        let body = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
        return try await request(
            path: "auth/login",
            method: "POST",
            body: body,
            allowRelogin: false
        )
    }

    @discardableResult
    public func logout() async throws -> OKResponse {
        try await request(path: "auth/logout", method: "POST", allowRelogin: false)
    }

    public func me() async throws -> AuthUser {
        try await request(path: "auth/me")
    }

    // MARK: - Meta (unauthenticated)

    public func meta() async throws -> Meta {
        try await request(path: "meta", allowRelogin: false)
    }

    // MARK: - Courses

    public func courses(offset: Int = 0, limit: Int = 100) async throws -> CoursePage {
        try await request(path: "courses", query: ["offset": String(offset), "limit": String(limit)])
    }

    /// Course list filtered to published courses only (the iOS app never shows drafts).
    public func publishedCourses(offset: Int = 0, limit: Int = 100) async throws -> [CourseSummary] {
        let page = try await courses(offset: offset, limit: limit)
        return page.items.filter { $0.status == "published" }
    }

    public func course(id: String) async throws -> Course {
        try await request(path: "courses/get", query: ["id": id])
    }

    // MARK: - Holes

    public func holes(courseId: String) async throws -> [Hole] {
        try await request(path: "holes", query: ["courseId": courseId])
    }

    // MARK: - Tees

    public func tees(courseId: String) async throws -> [Tee] {
        try await request(path: "tees/by-course", query: ["courseId": courseId])
    }

    // MARK: - Greens

    /// Green for a hole, or nil when the hole has none (server returns JSON `null`).
    public func green(holeId: String) async throws -> Green? {
        try await requestOptional(path: "greens", query: ["holeId": holeId])
    }

    // MARK: - Pins

    public func pins(greenId: String) async throws -> [Pin] {
        try await request(path: "pins", query: ["greenId": greenId])
    }

    public func pins(courseId: String) async throws -> [Pin] {
        try await request(path: "pins/by-course", query: ["courseId": courseId])
    }

    // MARK: - Aim points

    public func aimPoints(holeId: String) async throws -> [AimPoint] {
        try await request(path: "aim-points", query: ["holeId": holeId])
    }

    // MARK: - Assets

    public func assets(courseId: String) async throws -> [CourseAsset] {
        try await request(path: "assets/by-course", query: ["courseId": courseId])
    }

    // MARK: - Course features

    /// Raw GeoJSON FeatureCollection bytes — hand straight to MapLibre.
    public func featuresGeoJSONData(courseId: String) async throws -> Data {
        try await requestData(path: "features.geojson", query: ["courseId": courseId]).0
    }

    /// Decoded course features (type + polygon rings) for distance math.
    public func features(courseId: String) async throws -> [CourseFeature] {
        let data = try await featuresGeoJSONData(courseId: courseId)
        do {
            return try decoder.decode(CourseFeatureCollection.self, from: data).features
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    // MARK: - Request core

    private func makeURL(path: String, query: [String: String]) -> URL {
        let base = apiBaseURL.appendingPathComponent(path)
        guard !query.isEmpty,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return base }
        components.queryItems = query
            .sorted { $0.key < $1.key }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.url ?? base
    }

    /// Performs the HTTP call, applies the 401 → re-login → retry policy, and
    /// returns `(data, status)` for any 2xx response. Throws `APIError` otherwise.
    private func requestData(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        allowRelogin: Bool = true
    ) async throws -> (Data, Int) {
        var attemptedRelogin = false

        while true {
            var req = URLRequest(url: makeURL(path: path, query: query))
            req.httpMethod = method
            if let body {
                req.httpBody = body
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            req.setValue("application/json", forHTTPHeaderField: "Accept")

            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: req)
            } catch {
                throw APIError.transport(String(describing: error))
            }

            guard let http = response as? HTTPURLResponse else {
                throw APIError.transport("Non-HTTP response.")
            }

            if (200..<300).contains(http.statusCode) {
                return (data, http.statusCode)
            }

            if http.statusCode == 401 {
                if allowRelogin, !attemptedRelogin, let provider = credentialsProvider,
                   let creds = await provider() {
                    attemptedRelogin = true
                    // Re-login itself must not recurse into the retry loop.
                    _ = try? await login(username: creds.username, password: creds.password)
                    continue
                }
                throw APIError.unauthorized
            }

            throw APIError.http(status: http.statusCode, message: decodeErrorMessage(data))
        }
    }

    /// Decodes a 2xx body into `T`.
    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        allowRelogin: Bool = true
    ) async throws -> T {
        let (data, _) = try await requestData(
            path: path, method: method, query: query, body: body, allowRelogin: allowRelogin
        )
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// Like `request`, but tolerates a JSON `null` body → nil.
    private func requestOptional<T: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        allowRelogin: Bool = true
    ) async throws -> T? {
        let (data, _) = try await requestData(
            path: path, method: method, query: query, body: body, allowRelogin: allowRelogin
        )
        let trimmed = data.trimmingLeadingWhitespace()
        if trimmed.isEmpty || trimmed == Data("null".utf8) {
            return nil
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func decodeErrorMessage(_ data: Data) -> String? {
        if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
            return envelope.error
        }
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (text?.isEmpty == false) ? text : nil
    }
}

private extension Data {
    /// Returns the data with leading ASCII whitespace bytes removed.
    func trimmingLeadingWhitespace() -> Data {
        let whitespace: Set<UInt8> = [0x20, 0x09, 0x0A, 0x0D]
        guard let firstNonWS = firstIndex(where: { !whitespace.contains($0) }) else {
            return Data()
        }
        return subdata(in: firstNonWS..<endIndex)
    }
}
