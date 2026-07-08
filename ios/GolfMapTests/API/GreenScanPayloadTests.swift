import XCTest
@testable import GolfMap

/// Round-trip encode/decode tests for the green-scan payload contract,
/// pinning the wire format against hand-written contract-shaped JSON literals
/// (docs/reference/green-scan-payload.md). If a field name / nesting / unit
/// drifts, these break — which is the point (the payloads are the contract).
final class GreenScanPayloadTests: XCTestCase {

    private let decoder = JSONDecoder()
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    // MARK: - spot_level

    /// Contract-shaped `spot_level` payload literal (doc §"spot_level payload").
    private let spotLevelJSON = """
    {
        "version": 1,
        "kind": "spot_level",
        "capturedAt": "2026-07-07T14:00:00Z",
        "device": "iPhone17,2",
        "appVersion": "0.1.0",
        "location": { "lat": 58.4, "lon": 15.6, "horizontalAccuracyM": 3.2 },
        "slopePct": 2.3,
        "fallLineBearingDeg": 213.5,
        "sampleDurationS": 1.2,
        "sampleCount": 120,
        "tiltStdDeg": 0.04,
        "headingAccuracyDeg": 5.0
    }
    """

    func testSpotLevelDecodesContractLiteral() throws {
        let payload = try decoder.decode(SpotLevelPayload.self, from: Data(spotLevelJSON.utf8))
        XCTAssertEqual(payload.version, 1)
        XCTAssertEqual(payload.kind, .spotLevel)
        XCTAssertEqual(payload.capturedAt, "2026-07-07T14:00:00Z")
        XCTAssertEqual(payload.device, "iPhone17,2")
        XCTAssertEqual(payload.appVersion, "0.1.0")
        XCTAssertEqual(payload.location.lat, 58.4)
        XCTAssertEqual(payload.location.lon, 15.6)
        XCTAssertEqual(payload.location.horizontalAccuracyM, 3.2)
        XCTAssertEqual(payload.slopePct, 2.3)
        XCTAssertEqual(payload.fallLineBearingDeg, 213.5)
        XCTAssertEqual(payload.sampleDurationS, 1.2)
        XCTAssertEqual(payload.sampleCount, 120)
        XCTAssertEqual(payload.tiltStdDeg, 0.04)
        XCTAssertEqual(payload.headingAccuracyDeg, 5.0)
    }

    func testSpotLevelRoundTrips() throws {
        let payload = try decoder.decode(SpotLevelPayload.self, from: Data(spotLevelJSON.utf8))
        let reencoded = try encoder.encode(payload)
        let redecoded = try decoder.decode(SpotLevelPayload.self, from: reencoded)
        XCTAssertEqual(payload, redecoded)
    }

    func testSpotLevelKindWireValue() throws {
        // The `spot_level` kind must serialise to the snake_case string.
        let payload = try decoder.decode(SpotLevelPayload.self, from: Data(spotLevelJSON.utf8))
        let json = try encoder.encode(payload)
        let string = String(decoding: json, as: UTF8.self)
        XCTAssertTrue(string.contains("\"kind\":\"spot_level\""), "kind must be snake_case on the wire")
    }

    // MARK: - corridor (task E1 shape)

    /// Contract-shaped `corridor` payload literal (doc §"corridor payload"),
    /// including nested endpoint spot-levels, fit, passes.
    private let corridorJSON = """
    {
        "version": 1,
        "kind": "corridor",
        "capturedAt": "2026-07-07T14:05:00Z",
        "device": "iPhone17,2",
        "appVersion": "0.1.0",
        "ball": { "lat": 58.4, "lon": 15.6, "horizontalAccuracyM": 3.0 },
        "hole": { "lat": 58.4001, "lon": 15.6002, "horizontalAccuracyM": 3.0 },
        "endpointLevels": [
            {
                "version": 1, "kind": "spot_level",
                "capturedAt": "2026-07-07T14:05:01Z", "device": "iPhone17,2", "appVersion": "0.1.0",
                "location": { "lat": 58.4, "lon": 15.6, "horizontalAccuracyM": 3.0 },
                "slopePct": 2.1, "fallLineBearingDeg": 210.0,
                "sampleDurationS": 1.0, "sampleCount": 100, "tiltStdDeg": 0.03, "headingAccuracyDeg": 6.0
            },
            {
                "version": 1, "kind": "spot_level",
                "capturedAt": "2026-07-07T14:05:20Z", "device": "iPhone17,2", "appVersion": "0.1.0",
                "location": { "lat": 58.4001, "lon": 15.6002, "horizontalAccuracyM": 3.0 },
                "slopePct": 1.9, "fallLineBearingDeg": 215.0,
                "sampleDurationS": 1.0, "sampleCount": 100, "tiltStdDeg": 0.03, "headingAccuracyDeg": 6.0
            }
        ],
        "frame": { "originalLineBearingDeg": 213.5, "lineLengthM": 8.2 },
        "points": [[0.0, 0.0, 0.0], [1.0, 0.1, -0.02]],
        "fit": {
            "type": "poly2",
            "coefficients": [0.0, 0.01, -0.02, 0.001, 0.0, 0.0005],
            "rmseM": 0.004,
            "corridorWidthM": 2.1,
            "coverageFrac": 0.93
        },
        "passes": [
            { "direction": "out",  "fit": { "type": "poly2", "coefficients": [0,0,0,0,0,0], "rmseM": 0.005, "corridorWidthM": 2.0, "coverageFrac": 0.9 } },
            { "direction": "back", "fit": { "type": "poly2", "coefficients": [0,0,0,0,0,0], "rmseM": 0.006, "corridorWidthM": 2.0, "coverageFrac": 0.9 } }
        ],
        "passMismatchSlopePct": 0.12
    }
    """

    func testCorridorDecodesContractLiteral() throws {
        let payload = try decoder.decode(CorridorPayload.self, from: Data(corridorJSON.utf8))
        XCTAssertEqual(payload.kind, .corridor)
        XCTAssertEqual(payload.ball.lat, 58.4)
        XCTAssertEqual(payload.hole.horizontalAccuracyM, 3.0)
        XCTAssertEqual(payload.endpointLevels.count, 2)
        XCTAssertEqual(payload.endpointLevels[0].kind, .spotLevel)
        XCTAssertEqual(payload.endpointLevels[0].slopePct, 2.1)
        XCTAssertEqual(payload.frame.originalLineBearingDeg, 213.5)
        XCTAssertEqual(payload.frame.lineLengthM, 8.2)
        XCTAssertEqual(payload.points.count, 2)
        XCTAssertEqual(payload.points[1], [1.0, 0.1, -0.02])
        XCTAssertEqual(payload.fit.type, "poly2")
        XCTAssertEqual(payload.fit.coefficients.count, 6)
        XCTAssertEqual(payload.fit.rmseM, 0.004)
        XCTAssertEqual(payload.passes.count, 2)
        XCTAssertEqual(payload.passes[0].direction, "out")
        XCTAssertEqual(payload.passMismatchSlopePct, 0.12)
    }

    func testCorridorRoundTrips() throws {
        let payload = try decoder.decode(CorridorPayload.self, from: Data(corridorJSON.utf8))
        let reencoded = try encoder.encode(payload)
        let redecoded = try decoder.decode(CorridorPayload.self, from: reencoded)
        XCTAssertEqual(payload, redecoded)
    }

    // MARK: - quality_json

    func testSpotLevelQualityOmitsCorridorOnlyFields() throws {
        // spot_level verdict carries only `verdict`; mismatch/rmse/coverage are
        // corridor-only and must not appear.
        let quality = GreenScanQuality(verdict: .green)
        let json = String(decoding: try encoder.encode(quality), as: UTF8.self)
        XCTAssertTrue(json.contains("\"verdict\":\"green\""))
        XCTAssertFalse(json.contains("rmseM"))
        XCTAssertFalse(json.contains("passMismatchSlopePct"))
        XCTAssertFalse(json.contains("coverageFrac"))
    }

    func testCorridorQualityRoundTrips() throws {
        let quality = GreenScanQuality(
            verdict: .yellow,
            passMismatchSlopePct: 0.12,
            rmseM: 0.004,
            coverageFrac: 0.93,
            endpointLevelDeltaPct: 0.08
        )
        let data = try encoder.encode(quality)
        let decoded = try decoder.decode(GreenScanQuality.self, from: data)
        XCTAssertEqual(decoded, quality)
    }

    func testVerdictWireValues() throws {
        XCTAssertEqual(try roundTripVerdict(.green), .green)
        XCTAssertEqual(try roundTripVerdict(.yellow), .yellow)
        XCTAssertEqual(try roundTripVerdict(.red), .red)
    }

    private func roundTripVerdict(_ v: GreenScanVerdict) throws -> GreenScanVerdict {
        let q = GreenScanQuality(verdict: v)
        let data = try encoder.encode(q)
        return try decoder.decode(GreenScanQuality.self, from: data).verdict
    }
}
