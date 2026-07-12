import XCTest
@testable import GolfMap

/// `CalibratedSurface` applies a green's low-frequency bias as a rigid plane
/// tilt: corrected ∇h = base ∇h + (tiltE, tiltN), with the matching height
/// ramp about a fixed origin (doc §4.2, contract green-scan-payload.md
/// `bias_json`). Confidence passes through the base untouched; coverage nils
/// pass through.
final class CalibratedSurfaceTests: XCTestCase {

    func testBiasAddsTiltToGradientWithConsistentHeightRamp() throws {
        // Base plane: 2% down toward EAST → gradX = −0.02, gradY = 0.
        let base = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90, confidence: 0.45)
        let origin = Vec2(x: 100, y: 200)
        let bias = GreenBias(tiltE: 0.005, tiltN: -0.003)
        let calibrated = CalibratedSurface(base: base, bias: bias, origin: origin)

        let p = Vec2(x: 110, y: 190)
        let b = try XCTUnwrap(base.sampleAt(p))
        let c = try XCTUnwrap(calibrated.sampleAt(p))

        XCTAssertEqual(c.gradX, b.gradX + 0.005, accuracy: 1e-12)
        XCTAssertEqual(c.gradY, b.gradY - 0.003, accuracy: 1e-12)
        // Height ramp about the origin: h + tiltE·Δe + tiltN·Δn.
        let expectedHeight = b.height + 0.005 * (110 - 100) + (-0.003) * (190 - 200)
        XCTAssertEqual(c.height, expectedHeight, accuracy: 1e-12)
        // Confidence is emitted by the base, not the decorator.
        XCTAssertEqual(c.confidence, b.confidence, accuracy: 1e-12)
    }

    /// The height ramp is origin-independent in the ONLY way the read uses
    /// height: the ball→hole difference. Two calibrated surfaces with different
    /// origins must agree on Δh.
    func testHeightDifferenceIsOriginIndependent() throws {
        let base = PlaneSurface(slopePct: 1.5, fallLineBearingDeg: 210)
        let bias = GreenBias(tiltE: 0.01, tiltN: 0.004)
        let a = CalibratedSurface(base: base, bias: bias, origin: Vec2(x: 0, y: 0))
        let d = CalibratedSurface(base: base, bias: bias, origin: Vec2(x: 500_000, y: 6_400_000))

        let ball = Vec2(x: 123, y: 456)
        let hole = Vec2(x: 130, y: 449)
        let deltaA = try XCTUnwrap(a.sampleAt(hole)).height - (try XCTUnwrap(a.sampleAt(ball)).height)
        let deltaD = try XCTUnwrap(d.sampleAt(hole)).height - (try XCTUnwrap(d.sampleAt(ball)).height)
        XCTAssertEqual(deltaA, deltaD, accuracy: 1e-9)
    }

    func testCoverageNilPassesThrough() {
        let calibrated = CalibratedSurface(
            base: NilSurface(), bias: GreenBias(tiltE: 0.01, tiltN: 0), origin: Vec2(x: 0, y: 0)
        )
        XCTAssertNil(calibrated.sampleAt(Vec2(x: 1, y: 1)))
    }

    /// A base surface with no coverage anywhere — exercises the nil path.
    private struct NilSurface: GreenSurface {
        func sampleAt(_ p: Vec2) -> SurfaceSample? { nil }
    }
}
