import XCTest
@testable import GolfMap

/// `GolfAPIClient.postGreenScan` hits POST /green-calibration/scans with the
/// `ingestScan` envelope shape and decodes the response.
final class PostGreenScanTests: XCTestCase {

    private func makeClient() -> GolfAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CapturingURLProtocol.self]
        let session = URLSession(configuration: config)
        return GolfAPIClient(baseURL: URL(string: "http://mock.local")!, session: session)
    }

    private func makePayload() -> SpotLevelPayload {
        SpotLevelPayload(
            capturedAt: "2026-07-07T14:00:00Z",
            device: "iPhone17,2",
            appVersion: "0.1.0",
            location: GreenScanLocation(lat: 58.4, lon: 15.6, horizontalAccuracyM: 3.2),
            slopePct: 2.3,
            fallLineBearingDeg: 213.5,
            sampleDurationS: 1.2,
            sampleCount: 120,
            tiltStdDeg: 0.04,
            headingAccuracyDeg: 5.0
        )
    }

    override func setUp() {
        super.setUp()
        CapturingURLProtocol.reset()
    }

    func testPostGreenScanSendsEnvelopeAndDecodesResponse() async throws {
        CapturingURLProtocol.responseBody = Data("""
        {
            "scan": {
                "id": "scan-1", "greenId": "g1", "kind": "spot_level",
                "capturedAt": "2026-07-07T14:00:00Z",
                "payloadJson": "{}", "qualityJson": "{}",
                "createdAt": "2026-07-07T14:00:01Z"
            },
            "calibration": null
        }
        """.utf8)

        let client = makeClient()
        let response = try await client.postGreenScan(
            greenId: "g1",
            kind: .spotLevel,
            capturedAt: "2026-07-07T14:00:00Z",
            payload: makePayload(),
            quality: GreenScanQuality(verdict: .green)
        )

        XCTAssertEqual(response.scan.id, "scan-1")
        XCTAssertEqual(response.scan.greenId, "g1")
        XCTAssertNil(response.calibration)

        // Assert the request hit the right endpoint with a well-formed body.
        XCTAssertEqual(CapturingURLProtocol.lastMethod, "POST")
        XCTAssertTrue(CapturingURLProtocol.lastPath?.contains("/green-calibration/scans") == true)

        let body = try XCTUnwrap(CapturingURLProtocol.lastBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(json?["greenId"] as? String, "g1")
        XCTAssertEqual(json?["kind"] as? String, "spot_level")
        XCTAssertEqual(json?["capturedAt"] as? String, "2026-07-07T14:00:00Z")
        // payload is nested JSON (not a string) and self-describes its kind.
        let payload = json?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["kind"] as? String, "spot_level")
        XCTAssertEqual(payload?["slopePct"] as? Double, 2.3)
        let quality = json?["quality"] as? [String: Any]
        XCTAssertEqual(quality?["verdict"] as? String, "green")
    }
}

/// Minimal URLProtocol that captures the request body/method/path and returns a
/// canned 200 body. Separate from `MockURLProtocol` so its captured-request
/// state doesn't collide with the re-login script.
final class CapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responseBody = Data("{}".utf8)
    nonisolated(unsafe) static var lastBody: Data?
    nonisolated(unsafe) static var lastMethod: String?
    nonisolated(unsafe) static var lastPath: String?

    static func reset() {
        responseBody = Data("{}".utf8)
        lastBody = nil
        lastMethod = nil
        lastPath = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastMethod = request.httpMethod
        Self.lastPath = request.url?.path
        // URLSession moves an httpBody into a stream; capture whichever is set.
        if let body = request.httpBody {
            Self.lastBody = body
        } else if let stream = request.httpBodyStream {
            Self.lastBody = Self.drain(stream)
        }
        let http = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 4096
        var buffer = [UInt8](repeating: 0, count: size)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: size)
            if read > 0 { data.append(buffer, count: read) } else { break }
        }
        return data
    }
}
