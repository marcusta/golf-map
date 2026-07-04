import XCTest
@testable import GolfMap

/// Drives `AppEnvironment.bootstrap()` / `login` / `logout` through the auth
/// state machine. `AppEnvironment` builds its own `GolfAPIClient` on
/// `URLSession.shared`, so we intercept the network with a globally-registered
/// `URLProtocol` (registered on the shared session for the duration of a test).
final class AuthStateMachineTests: XCTestCase {
    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(AuthMockURLProtocol.self)
        AuthMockURLProtocol.reset()
    }

    override func tearDown() {
        URLProtocol.unregisterClass(AuthMockURLProtocol.self)
        AuthMockURLProtocol.reset()
        super.tearDown()
    }

    @MainActor
    private func makeEnv(keychain: Keychain) throws -> AppEnvironment {
        AppEnvironment(
            serverOrigin: URL(string: "http://auth-mock.local")!,
            database: try AppDatabase.inMemory(),
            bundlePaths: BundlePaths(rootDirectory: FileManager.default.temporaryDirectory
                .appending(path: "auth-tests-\(UUID().uuidString)")),
            keychain: keychain
        )
    }

    private func uniqueKeychain() -> Keychain {
        Keychain(service: "com.marcusandersson.golfmap.authtests.\(UUID().uuidString)")
    }

    // MARK: - Bootstrap paths

    @MainActor
    func testBootstrapWithValidSessionCookieLogsIn() async throws {
        AuthMockURLProtocol.set("/auth/me", status: 200, body: #"{"id":"u1","username":"marcus"}"#)
        let env = try makeEnv(keychain: uniqueKeychain())

        await env.bootstrap()

        XCTAssertFalse(env.isBootstrapping)
        XCTAssertEqual(env.authState, .loggedIn(AuthUser(id: "u1", username: "marcus")))
    }

    @MainActor
    func testBootstrap401WithNoStoredCredsLogsOut() async throws {
        AuthMockURLProtocol.set("/auth/me", status: 401, body: #"{"error":"Unauthorized"}"#)
        let kc = uniqueKeychain()
        kc.clear()
        let env = try makeEnv(keychain: kc)

        await env.bootstrap()

        XCTAssertEqual(env.authState, .loggedOut)
    }

    @MainActor
    func testBootstrap401WithStoredCredsAutoLogsIn() async throws {
        // /auth/me is 401; the stored creds drive a successful /auth/login.
        AuthMockURLProtocol.set("/auth/me", status: 401, body: #"{"error":"Unauthorized"}"#)
        AuthMockURLProtocol.set("/auth/login", status: 200, body: #"{"id":"u1","username":"marcus"}"#)
        let kc = uniqueKeychain()
        kc.save(.init(username: "marcus", password: "change-me"))
        defer { kc.clear() }
        let env = try makeEnv(keychain: kc)

        await env.bootstrap()

        XCTAssertEqual(env.authState, .loggedIn(AuthUser(id: "u1", username: "marcus")))
    }

    @MainActor
    func testBootstrap401WithStaleStoredCredsLogsOut() async throws {
        // Stored creds no longer valid: /auth/login also 401 → clear + loggedOut.
        AuthMockURLProtocol.set("/auth/me", status: 401, body: #"{"error":"Unauthorized"}"#)
        AuthMockURLProtocol.set("/auth/login", status: 401, body: #"{"error":"Unauthorized"}"#)
        let kc = uniqueKeychain()
        kc.save(.init(username: "marcus", password: "wrong"))
        let env = try makeEnv(keychain: kc)

        await env.bootstrap()

        XCTAssertEqual(env.authState, .loggedOut)
        XCTAssertNil(kc.load(), "stale credentials should be wiped")
    }

    @MainActor
    func testBootstrapNetworkFailureGoesOffline() async throws {
        AuthMockURLProtocol.setFailure("/auth/me")
        let env = try makeEnv(keychain: uniqueKeychain())

        await env.bootstrap()

        XCTAssertEqual(env.authState, .offline)
    }

    // MARK: - Explicit login / logout

    @MainActor
    func testLoginSuccessSavesCredentialsAndLogsIn() async throws {
        AuthMockURLProtocol.set("/auth/login", status: 200, body: #"{"id":"u1","username":"marcus"}"#)
        let kc = uniqueKeychain()
        defer { kc.clear() }
        let env = try makeEnv(keychain: kc)

        try await env.login(username: "marcus", password: "change-me")

        XCTAssertEqual(env.authState, .loggedIn(AuthUser(id: "u1", username: "marcus")))
        XCTAssertEqual(kc.load(), Keychain.Credentials(username: "marcus", password: "change-me"))
    }

    @MainActor
    func testLoginFailureThrowsAndDoesNotSave() async throws {
        AuthMockURLProtocol.set("/auth/login", status: 401, body: #"{"error":"Unauthorized"}"#)
        let kc = uniqueKeychain()
        let env = try makeEnv(keychain: kc)

        do {
            try await env.login(username: "marcus", password: "wrong")
            XCTFail("Expected login to throw")
        } catch APIError.unauthorized {
            // expected
        }
        XCTAssertNil(kc.load())
        XCTAssertEqual(env.authState, .loggedOut)
    }

    @MainActor
    func testLogoutClearsStateAndCredentials() async throws {
        AuthMockURLProtocol.set("/auth/logout", status: 200, body: #"{"ok":true}"#)
        let kc = uniqueKeychain()
        kc.save(.init(username: "marcus", password: "change-me"))
        let env = try makeEnv(keychain: kc)

        await env.logout()

        XCTAssertEqual(env.authState, .loggedOut)
        XCTAssertNil(kc.load())
    }
}

// MARK: - Mock

/// A globally-registered URLProtocol keyed by path substring. Distinct name
/// from the API/Store mocks so registration doesn't clash across suites.
final class AuthMockURLProtocol: URLProtocol {
    private struct Stub { let status: Int; let body: Data; let fail: Bool }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var stubs: [String: Stub] = [:]

    static func set(_ pathKey: String, status: Int, body: String) {
        lock.lock(); defer { lock.unlock() }
        stubs[pathKey] = Stub(status: status, body: Data(body.utf8), fail: false)
    }

    static func setFailure(_ pathKey: String) {
        lock.lock(); defer { lock.unlock() }
        stubs[pathKey] = Stub(status: 0, body: Data(), fail: true)
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        stubs = [:]
    }

    private static func stub(for url: URL) -> Stub? {
        lock.lock(); defer { lock.unlock() }
        for (key, stub) in stubs where url.path.contains(key) { return stub }
        return nil
    }

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        return url.host == "auth-mock.local"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let stub = Self.stub(for: url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        if stub.fail {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(
            url: url, statusCode: stub.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
