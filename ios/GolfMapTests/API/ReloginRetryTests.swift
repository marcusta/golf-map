import XCTest
@testable import GolfMap

/// A programmable URLProtocol mock. Each registered handler matches on a path
/// substring; a handler can return different responses across successive calls
/// (used to serve 401-then-200 for the re-login retry).
final class MockURLProtocol: URLProtocol {
    struct Response {
        let status: Int
        let body: Data
    }

    /// Thread-safe request log + response script, keyed by URL path substring.
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var scripts: [String: [Response]] = [:]
        private(set) var requestedPaths: [String] = []

        func setScript(_ responses: [Response], forPathContaining key: String) {
            lock.lock(); defer { lock.unlock() }
            scripts[key] = responses
        }

        func next(for url: URL) -> Response? {
            lock.lock(); defer { lock.unlock() }
            requestedPaths.append(url.path)
            // Prefer the MOST SPECIFIC (longest) matching key — e.g. a bare
            // "/clubs" GET script must not accidentally answer a
            // "/clubs/update" POST just because "contains" also matches the
            // shorter key. Dictionary iteration order is otherwise
            // unspecified, so without this a test registering both a general
            // and a more specific key for overlapping paths would be flaky.
            guard let key = scripts.keys.filter({ url.path.contains($0) }).max(by: { $0.count < $1.count })
            else { return nil }
            guard !scripts[key]!.isEmpty else { return nil }
            var remaining = scripts[key]!
            let head = remaining.removeFirst()
            // Keep the last response sticky once the script is drained.
            scripts[key] = remaining.isEmpty ? [head] : remaining
            return head
        }

        func log() -> [String] {
            lock.lock(); defer { lock.unlock() }
            return requestedPaths
        }
    }

    nonisolated(unsafe) static let shared = State()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let response = Self.shared.next(for: url)
            ?? Response(status: 500, body: Data(#"{"error":"no mock"}"#.utf8))

        let httpResponse = HTTPURLResponse(
            url: url,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Thread-safe call counter usable from a `@Sendable` closure.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}

final class ReloginRetryTests: XCTestCase {
    private func makeClient(
        credentialsProvider: GolfAPIClient.CredentialsProvider? = nil
    ) -> GolfAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        return GolfAPIClient(
            baseURL: URL(string: "http://mock.local")!,
            session: session,
            credentialsProvider: credentialsProvider
        )
    }

    func testAutoReloginOnceThenRetrySucceeds() async throws {
        // /api/auth/me returns 401 first, then 200 after re-login.
        MockURLProtocol.shared.setScript(
            [
                .init(status: 401, body: Data(#"{"error":"Unauthorized"}"#.utf8)),
                .init(status: 200, body: Data(#"{"id":"u1","username":"marcus"}"#.utf8)),
            ],
            forPathContaining: "/auth/me"
        )
        // Login always succeeds.
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"id":"u1","username":"marcus"}"#.utf8))],
            forPathContaining: "/auth/login"
        )

        let providerCalls = Counter()
        let client = makeClient(credentialsProvider: {
            providerCalls.increment()
            return (username: "marcus", password: "change-me")
        })

        let user = try await client.me()
        XCTAssertEqual(user.username, "marcus")
        XCTAssertEqual(providerCalls.count, 1, "credentials provider should be consulted exactly once")
    }

    func testUnauthorizedWithoutProviderThrows() async {
        MockURLProtocol.shared.setScript(
            [.init(status: 401, body: Data(#"{"error":"Unauthorized"}"#.utf8))],
            forPathContaining: "/auth/me"
        )
        let client = makeClient(credentialsProvider: nil)
        do {
            _ = try await client.me()
            XCTFail("Expected APIError.unauthorized")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
        } catch {
            XCTFail("Expected APIError.unauthorized, got \(error)")
        }
    }

    func testReloginRetriedOnlyOnce() async {
        // /auth/me stays 401 forever; provider works. Client must give up after
        // one retry and surface .unauthorized (not loop).
        MockURLProtocol.shared.setScript(
            [.init(status: 401, body: Data(#"{"error":"Unauthorized"}"#.utf8))],
            forPathContaining: "/auth/me"
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"id":"u1","username":"marcus"}"#.utf8))],
            forPathContaining: "/auth/login"
        )

        let providerCalls = Counter()
        let client = makeClient(credentialsProvider: {
            providerCalls.increment()
            return (username: "marcus", password: "change-me")
        })

        do {
            _ = try await client.me()
            XCTFail("Expected APIError.unauthorized")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
            XCTAssertEqual(providerCalls.count, 1, "should re-login at most once")
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    func testHTTPErrorEnvelopeSurfacesMessage() async {
        MockURLProtocol.shared.setScript(
            [.init(status: 422, body: Data(#"{"error":"Validation failed"}"#.utf8))],
            forPathContaining: "/courses/get"
        )
        let client = makeClient()
        do {
            _ = try await client.course(id: "x")
            XCTFail("Expected APIError.http")
        } catch let APIError.http(status, message) {
            XCTAssertEqual(status, 422)
            XCTAssertEqual(message, "Validation failed")
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    func testGreenNullDecodesToNil() async throws {
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data("null".utf8))],
            forPathContaining: "/greens"
        )
        let client = makeClient()
        let green = try await client.green(holeId: "h1")
        XCTAssertNil(green)
    }
}
