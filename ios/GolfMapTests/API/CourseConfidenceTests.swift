import XCTest
@testable import GolfMap

/// `GolfAPIClient.courseConfidence` hits GET /green-calibration/confidence and
/// decodes the `{ greens: [...] }` envelope (the read side of the scan
/// round-trip). Uses the shared `CapturingURLProtocol` (PostGreenScanTests).
final class CourseConfidenceTests: XCTestCase {

    private func makeClient() -> GolfAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CapturingURLProtocol.self]
        let session = URLSession(configuration: config)
        return GolfAPIClient(baseURL: URL(string: "http://mock.local")!, session: session)
    }

    override func setUp() {
        super.setUp()
        CapturingURLProtocol.reset()
    }

    func testCourseConfidenceDecodesGreensEnvelope() async throws {
        CapturingURLProtocol.responseBody = Data("""
        { "greens": [
            { "greenId": "g1", "confidence": 0.667, "sampleCount": 2, "source": "scans",
              "bias": { "tiltE": 0.004, "tiltN": -0.002 } },
            { "greenId": "g2", "confidence": 0.6, "sampleCount": 0, "source": "prior" }
        ] }
        """.utf8)

        let client = makeClient()
        let greens = try await client.courseConfidence(courseId: "course-1")

        XCTAssertEqual(greens.count, 2)
        XCTAssertEqual(greens[0].greenId, "g1")
        XCTAssertEqual(greens[0].source, "scans")
        XCTAssertEqual(greens[0].bias?.tiltN ?? 0, -0.002, accuracy: 1e-12)
        XCTAssertEqual(greens[1].source, "prior")
        XCTAssertNil(greens[1].bias)

        XCTAssertEqual(CapturingURLProtocol.lastMethod, "GET")
        XCTAssertTrue(
            CapturingURLProtocol.lastPath?.contains("/green-calibration/confidence") == true,
            "hit the confidence endpoint"
        )
    }
}
