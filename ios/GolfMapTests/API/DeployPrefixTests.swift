import XCTest
@testable import GolfMap

/// The app's server base URL is user-configurable, and the Sweden Indoor Golf
/// deploy puts golf-map under a PATH, not its own host:
/// `https://app.swedenindoorgolf.se/golf-map` (Caddy strips `/golf-map` before
/// proxying, so the server still answers rooted paths — the CLIENT must supply
/// the prefix).
///
/// Every URL joiner in the app therefore has to PRESERVE a path-bearing base.
/// They all use `appendingPathComponent` / `appending(path:)`, which do; the
/// trap this pins down is `URL(string:relativeTo:)`, which silently REPLACES
/// the base's path when the relative string starts with "/" — swapping one
/// joiner for the other would send every request to `/api/...` on the shared
/// host, i.e. at some other service, and only in production.
///
/// No behaviour is asserted here that a localhost base doesn't already have;
/// these are regression pins for the path-bearing case.
final class DeployPrefixTests: XCTestCase {
    private let prefixedOrigin = URL(string: "https://app.swedenindoorgolf.se/golf-map")!

    // MARK: - GolfAPIClient

    /// `GolfAPIClient.init` does `baseURL.appendingPathComponent("api")`, so a
    /// path-bearing origin must yield `/golf-map/api/...`, not `/api/...`.
    func testAPIRequestsKeepThePathPrefix() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = GolfAPIClient(
            baseURL: prefixedOrigin,
            session: URLSession(configuration: config)
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"id":"u1","username":"marcus"}"#.utf8))],
            forPathContaining: "/auth/me"
        )

        // The mock's request log is a process-wide singleton that is never
        // reset between tests, so compare against the delta, not the whole log.
        let before = MockURLProtocol.shared.log().count
        _ = try await client.me()
        let newPaths = Array(MockURLProtocol.shared.log().dropFirst(before))

        XCTAssertEqual(newPaths, ["/golf-map/api/auth/me"])
    }

    /// A bare origin (the default, and every local/dev setup) is unaffected.
    func testAPIRequestsAtOriginRootAreUnchanged() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = GolfAPIClient(
            baseURL: URL(string: "http://localhost:3000")!,
            session: URLSession(configuration: config)
        )
        MockURLProtocol.shared.setScript(
            [.init(status: 200, body: Data(#"{"id":"u1","username":"marcus"}"#.utf8))],
            forPathContaining: "/auth/me"
        )

        let before = MockURLProtocol.shared.log().count
        _ = try await client.me()
        let newPaths = Array(MockURLProtocol.shared.log().dropFirst(before))

        XCTAssertEqual(newPaths, ["/api/auth/me"])
    }

    // MARK: - Tiles

    func testTileURLsKeepThePathPrefix() {
        let builder = TileURLBuilder(baseURL: prefixedOrigin)

        XCTAssertEqual(
            builder.url(courseId: "COURSE", layer: .ortho, z: 17, x: 71260, y: 39231).absoluteString,
            "https://app.swedenindoorgolf.se/golf-map/tiles/COURSE/ortho/17/71260/39231.jpg"
        )
        XCTAssertEqual(
            builder.url(courseId: "COURSE", layer: .terrain, z: 14, x: 8907, y: 4903, version: "20260704T082859Z")
                .absoluteString,
            "https://app.swedenindoorgolf.se/golf-map/tiles/COURSE/terrain/14/8907/4903.png?v=20260704T082859Z"
        )
    }

    /// `SyncService` builds the downloader's tile base as
    /// `serverOrigin.appendingPathComponent("tiles")` and `BundleDownloader`
    /// appends the course/layer/archive onto it — this pins the composition of
    /// those two steps, which is what a real bundle download issues.
    func testBundleArchiveURLKeepsThePathPrefix() {
        let tileBaseURL = prefixedOrigin.appendingPathComponent("tiles")

        XCTAssertEqual(
            BundleDownloader.archiveRequestURL(
                baseURL: tileBaseURL,
                courseId: "COURSE",
                layer: .ortho,
                versionParam: "20260704T082859Z",
                maxzoom: 19
            ).absoluteString,
            "https://app.swedenindoorgolf.se/golf-map/tiles/COURSE/ortho/archive.tar?v=20260704T082859Z&maxzoom=19"
        )

        XCTAssertEqual(
            BundleDownloader.archiveRequestURL(
                baseURL: URL(string: "http://localhost:3000")!.appendingPathComponent("tiles"),
                courseId: "COURSE",
                layer: .terrain,
                versionParam: "20260704T082859Z",
                maxzoom: nil
            ).absoluteString,
            "http://localhost:3000/tiles/COURSE/terrain/archive.tar?v=20260704T082859Z"
        )
    }

    /// A trailing slash on the configured base must not double up or drop the
    /// prefix — users type the URL by hand, so both spellings reach these joiners.
    func testTrailingSlashOnTheBaseIsHarmless() {
        let withSlash = URL(string: "https://app.swedenindoorgolf.se/golf-map/")!
        XCTAssertEqual(
            TileURLBuilder(baseURL: withSlash)
                .url(courseId: "C", layer: .ortho, z: 1, x: 2, y: 3).absoluteString,
            "https://app.swedenindoorgolf.se/golf-map/tiles/C/ortho/1/2/3.jpg"
        )
    }
}
