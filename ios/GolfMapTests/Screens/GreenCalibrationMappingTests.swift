import XCTest
@testable import GolfMap

/// The calibration read-side pipeline: API JSON → `GreenCalibrationSync`
/// adapters (DTO → store record → domain calibration). The key rule is that
/// only `"scans"` greens are cached; `"prior"` greens are dropped so the iOS
/// read keeps its conservative terrain-tile default (doc §4.2).
final class GreenCalibrationMappingTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decodeResponse(_ json: String) throws -> CourseConfidenceResponse {
        try decoder.decode(CourseConfidenceResponse.self, from: Data(json.utf8))
    }

    // MARK: - Decoding

    func testConfidenceResponseDecodes() throws {
        let res = try decodeResponse("""
        { "greens": [
            { "greenId": "g1", "confidence": 0.667, "sampleCount": 2, "source": "scans",
              "bias": { "tiltE": 0.004, "tiltN": -0.002 } },
            { "greenId": "g2", "confidence": 0.5, "sampleCount": 1.5, "source": "scans" },
            { "greenId": "g3", "confidence": 0.6, "sampleCount": 0, "source": "prior" }
        ] }
        """)
        XCTAssertEqual(res.greens.count, 3)
        XCTAssertEqual(res.greens[0].source, "scans")
        XCTAssertEqual(res.greens[0].bias?.tiltE ?? 0, 0.004, accuracy: 1e-12)
        XCTAssertEqual(res.greens[0].bias?.tiltN ?? 0, -0.002, accuracy: 1e-12)
        XCTAssertNil(res.greens[1].bias, "a scans green may carry no fitted bias")
        XCTAssertEqual(res.greens[1].sampleCount, 1.5, accuracy: 1e-12, "weighted count is fractional")
        XCTAssertEqual(res.greens[2].source, "prior")
        XCTAssertNil(res.greens[2].bias)
    }

    // MARK: - DTO → store record (only scans are cached)

    func testRecordAdapterKeepsScansAndDropsPrior() throws {
        let scansWithBias = GreenConfidenceDTO(
            greenId: "g1", confidence: 0.667, sampleCount: 2, source: "scans",
            bias: GreenBiasDTO(tiltE: 0.004, tiltN: -0.002)
        )
        let scansNoBias = GreenConfidenceDTO(
            greenId: "g2", confidence: 0.5, sampleCount: 1.5, source: "scans", bias: nil
        )
        let prior = GreenConfidenceDTO(
            greenId: "g3", confidence: 0.6, sampleCount: 0, source: "prior", bias: nil
        )

        XCTAssertNil(
            GreenCalibrationSync.record(courseId: "c1", prior),
            "prior greens are not cached — iOS keeps its terrain-tile default"
        )

        let r1 = try XCTUnwrap(GreenCalibrationSync.record(courseId: "c1", scansWithBias))
        XCTAssertEqual(r1.greenId, "g1")
        XCTAssertEqual(r1.courseId, "c1")
        XCTAssertEqual(r1.confidence, 0.667, accuracy: 1e-12)
        XCTAssertEqual(r1.sampleCount, 2, accuracy: 1e-12)
        XCTAssertEqual(r1.biasTiltE ?? 0, 0.004, accuracy: 1e-12)
        XCTAssertEqual(r1.biasTiltN ?? 0, -0.002, accuracy: 1e-12)

        let r2 = try XCTUnwrap(GreenCalibrationSync.record(courseId: "c1", scansNoBias))
        XCTAssertNil(r2.biasTiltE, "no bias fitted → nil tilt columns")
        XCTAssertNil(r2.biasTiltN)
    }

    // MARK: - Store record → domain calibration

    func testRecordToCalibrationMapsBias() {
        let withBias = GreenCalibrationCacheRecord(
            greenId: "g1", courseId: "c1", confidence: 0.667, sampleCount: 2,
            biasTiltE: 0.004, biasTiltN: -0.002
        )
        let cal = GreenCalibrationSync.calibration(from: withBias)
        XCTAssertEqual(cal.greenId, "g1")
        XCTAssertEqual(cal.confidence, 0.667, accuracy: 1e-12)
        XCTAssertEqual(cal.sampleCount, 2, accuracy: 1e-12)
        XCTAssertEqual(cal.bias?.tiltE ?? 0, 0.004, accuracy: 1e-12)
        XCTAssertEqual(cal.bias?.tiltN ?? 0, -0.002, accuracy: 1e-12)

        let noBias = GreenCalibrationCacheRecord(
            greenId: "g2", courseId: "c1", confidence: 0.5, sampleCount: 1,
            biasTiltE: nil, biasTiltN: nil
        )
        XCTAssertNil(GreenCalibrationSync.calibration(from: noBias).bias)
    }
}
