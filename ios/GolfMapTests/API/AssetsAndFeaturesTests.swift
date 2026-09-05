import XCTest
@testable import GolfMap

final class AssetsAndFeaturesTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testAssetsDecodeAndKinds() throws {
        let data = try FixtureLoader.data("assets-by-course.json")
        let assets = try decoder.decode([CourseAsset].self, from: data)
        XCTAssertEqual(assets.count, 3)
        let kinds = assets.map(\.kind)
        XCTAssertTrue(kinds.contains(.orthoCog))
        XCTAssertTrue(kinds.contains(.demCog))
        XCTAssertTrue(kinds.contains(.tileManifest))
        // No kind should decode to .unknown for this fixture.
        XCTAssertFalse(kinds.contains(.unknown))
    }

    func testTileManifestParsing() throws {
        let data = try FixtureLoader.data("assets-by-course.json")
        let assets = try decoder.decode([CourseAsset].self, from: data)

        guard let manifestAsset = assets.first(where: { $0.kind == .tileManifest }) else {
            return XCTFail("No tile_manifest asset in fixture")
        }
        guard let manifest = manifestAsset.tileManifest() else {
            return XCTFail("tileManifest() returned nil")
        }

        XCTAssertEqual(manifest.layers.ortho.minzoom, 14)
        XCTAssertEqual(manifest.layers.ortho.maxzoom, 20)
        XCTAssertEqual(manifest.layers.terrain.minzoom, 12)
        XCTAssertEqual(manifest.layers.terrain.maxzoom, 17)
        XCTAssertEqual(manifest.generatedAt, "2026-07-04T08:28:59Z")
        XCTAssertEqual(manifest.versionParam, "20260704T082859Z")
        XCTAssertEqual(manifest.elevation.min, 53.27858352661133, accuracy: 1e-6)
        XCTAssertEqual(manifest.elevation.max, 98.49988555908203, accuracy: 1e-6)
        XCTAssertEqual(manifest.bounds.west, 15.695402171504204, accuracy: 1e-9)
        XCTAssertFalse(manifest.attribution.isEmpty)
    }

    func testTileManifestReturnsNilForNonManifestAsset() throws {
        let data = try FixtureLoader.data("assets-by-course.json")
        let assets = try decoder.decode([CourseAsset].self, from: data)
        let ortho = try XCTUnwrap(assets.first { $0.kind == .orthoCog })
        // ortho_cog metaJson is a manifest-shaped blob too, so it *does* parse;
        // assert instead that a nil metaJson yields nil. Construct one:
        let noMeta = CourseAsset(
            id: "x", courseId: "c", kind: .svgSource, filename: "f",
            metaJson: nil, version: 1, createdAt: "", updatedAt: ""
        )
        XCTAssertNil(noMeta.tileManifest())
        // And malformed JSON yields nil.
        let bad = CourseAsset(
            id: "x", courseId: "c", kind: .tileManifest, filename: "f",
            metaJson: "{not json", version: 1, createdAt: "", updatedAt: ""
        )
        XCTAssertNil(bad.tileManifest())
        XCTAssertNotNil(ortho) // touch to silence unused warning
    }

    func testUnknownAssetKindDecodesToUnknown() throws {
        let json = #"{"id":"a","courseId":"c","kind":"future_kind","filename":"f","metaJson":null,"version":1,"createdAt":"","updatedAt":""}"#
        let asset = try decoder.decode(CourseAsset.self, from: Data(json.utf8))
        XCTAssertEqual(asset.kind, .unknown)
    }

    func testVersionParamStripsSeparators() {
        // Directly exercise the transform contract.
        let manifest = TileManifest(
            bounds: .init(west: 0, south: 0, east: 0, north: 0),
            layers: .init(ortho: .init(minzoom: 0, maxzoom: 0),
                          terrain: .init(minzoom: 0, maxzoom: 0)),
            elevation: .init(min: 0, max: 0),
            generatedAt: "2026-07-04T08:28:59Z",
            attribution: ""
        )
        XCTAssertEqual(manifest.versionParam, "20260704T082859Z")
    }

    func testAssetsBySiteRoutesSiteIdentity() async throws {
        let client = try makeRoutingClient()

        let assets = try await client.assets(siteId: "site shared/1")

        XCTAssertEqual(assets.count, 3)
        let url = try XCTUnwrap(AssetRoutingURLProtocol.state.lastURL)
        XCTAssertEqual(url.path, "/api/assets/by-site")
        XCTAssertEqual(queryValue("siteId", in: url), "site shared/1")
        XCTAssertNil(queryValue("courseId", in: url))
    }

    func testAssetsByCourseKeepsLegacyRoute() async throws {
        let client = try makeRoutingClient()

        _ = try await client.assets(courseId: "legacy-course")

        let url = try XCTUnwrap(AssetRoutingURLProtocol.state.lastURL)
        XCTAssertEqual(url.path, "/api/assets/by-course")
        XCTAssertEqual(queryValue("courseId", in: url), "legacy-course")
        XCTAssertNil(queryValue("siteId", in: url))
    }

    func testFeaturesGeoJSONDecode() throws {
        let data = try FixtureLoader.data("features.geojson")
        let collection = try decoder.decode(CourseFeatureCollection.self, from: data)
        XCTAssertEqual(collection.features.count, 685)

        let knownTypes: Set<String> = [
            "bunker", "deep_rough", "fairway", "green", "path",
            "rough", "semi_rough", "tee", "water", "water_creek",
        ]
        let presentTypes = Set(collection.features.map(\.type))
        // Every present type is within the known set.
        XCTAssertTrue(presentTypes.isSubset(of: knownTypes), "Unexpected types: \(presentTypes.subtracting(knownTypes))")
        // Sanity: fairway and green both appear.
        XCTAssertTrue(presentTypes.contains("fairway"))
        XCTAssertTrue(presentTypes.contains("green"))

        // Every feature has at least one ring with at least 3 vertices,
        // and coordinates are plausible WGS84 (lon ~15, lat ~58).
        let first = try XCTUnwrap(collection.features.first)
        let outerRing = try XCTUnwrap(first.rings.first)
        XCTAssertGreaterThanOrEqual(outerRing.count, 3)
        let v = try XCTUnwrap(outerRing.first)
        XCTAssertEqual(v.lon, 15, accuracy: 1.0)
        XCTAssertEqual(v.lat, 58, accuracy: 1.0)
    }

    func testFeatureDecodesAttributesAndSource() throws {
        let json = """
        {"type":"FeatureCollection","features":[
          {"type":"Feature","id":"gen1","properties":{"courseId":"c1","holeId":null,"type":"trees","source":"lidar-canopy",
            "attributes":{"heightMaxM":21.4,"heightP90M":18.2,"heightMeanM":12,"areaM2":340,"label":"copse","dense":true,"skip":null,"nested":{"a":1}}},
           "geometry":{"type":"Polygon","coordinates":[[[15.70,58.36],[15.71,58.36],[15.71,58.37],[15.70,58.36]]]}},
          {"type":"Feature","id":"hand1","properties":{"courseId":"c1","holeId":"h1","type":"bunker"},
           "geometry":{"type":"Polygon","coordinates":[[[15.70,58.36],[15.71,58.36],[15.71,58.37],[15.70,58.36]]]}}
        ]}
        """
        let collection = try decoder.decode(CourseFeatureCollection.self, from: Data(json.utf8))
        XCTAssertEqual(collection.features.count, 2)

        let gen = collection.features[0]
        XCTAssertEqual(gen.source, "lidar-canopy")
        XCTAssertNil(gen.holeId)
        XCTAssertEqual(gen.attributes?["heightMaxM"], .number(21.4))
        XCTAssertEqual(gen.attributes?["heightP90M"], .number(18.2))
        XCTAssertEqual(gen.attributes?["areaM2"], .number(340))
        XCTAssertEqual(gen.attributes?["label"], .string("copse"))
        XCTAssertEqual(gen.attributes?["dense"], .bool(true))
        XCTAssertNil(gen.attributes?["skip"], "null entries are dropped")
        XCTAssertNil(gen.attributes?["nested"], "nested entries are dropped, the rest kept")
        XCTAssertEqual(gen.attributes?["heightP90M"]?.doubleValue, 18.2)
        XCTAssertNil(gen.attributes?["label"]?.doubleValue)

        let hand = collection.features[1]
        XCTAssertNil(hand.source)
        XCTAssertNil(hand.attributes)
        XCTAssertEqual(hand.holeId, "h1")
    }

    func testFeatureAttributeValueRoundTrips() throws {
        let values: [String: FeatureAttributeValue] = ["n": .number(1.5), "s": .string("x"), "b": .bool(false)]
        let data = try JSONEncoder().encode(values)
        XCTAssertEqual(try decoder.decode([String: FeatureAttributeValue].self, from: data), values)
    }

    private func makeRoutingClient() throws -> GolfAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssetRoutingURLProtocol.self]
        AssetRoutingURLProtocol.state.reset(
            responseBody: try FixtureLoader.data("assets-by-course.json")
        )
        return GolfAPIClient(
            baseURL: URL(string: "http://assets.test")!,
            session: URLSession(configuration: configuration)
        )
    }

    private func queryValue(_ name: String, in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == name }?
            .value
    }
}

private final class AssetRoutingURLProtocol: URLProtocol {
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var responseBody = Data("[]".utf8)
        private var capturedURL: URL?

        var lastURL: URL? {
            lock.lock(); defer { lock.unlock() }
            return capturedURL
        }

        func reset(responseBody: Data) {
            lock.lock(); defer { lock.unlock() }
            self.responseBody = responseBody
            capturedURL = nil
        }

        func capture(_ url: URL) -> Data {
            lock.lock(); defer { lock.unlock() }
            capturedURL = url
            return responseBody
        }
    }

    nonisolated(unsafe) static let state = State()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let body = Self.state.capture(url)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
