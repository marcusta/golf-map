import XCTest
@testable import GolfMap

/// Port of `shared/strategy/wind.test.ts` — the Ballnamic plays-as wind
/// calibration grid (2026-07) that supersedes the v1 linear-per-mph curve.
/// Bit-level TS parity is covered separately by StrategyGoldenParityTests;
/// this suite pins the model's behaviour (table reproduction, sign
/// convention, clamp/extrapolation policy) independently.
final class WindTests: XCTestCase {

    private func mps(_ mph: Double) -> Double { mphToMps(mph) }

    // Independent oracle: the raw table verbatim from the spec (yards of
    // plays-as adjustment; hurting = added / helping = subtracted).
    private let distNodes = [115.0, 140.0, 162.5, 187.5, 225.0, 285.0]
    private let speedNodes = [5.0, 10.0, 15.0, 20.0, 25.0]
    private let hurtYd: [[Double]] = [
        [5, 11, 18, 26, 35], // 115
        [6, 12, 20, 28, 38], // 140
        [6, 14, 23, 32, 43], // 162.5
        [7, 15, 24, 35, 47], // 187.5
        [5, 11, 19, 28, 38], // 225
        [4, 9, 15, 21, 28], // 285
    ]
    private let helpYd: [[Double]] = [
        [4, 8, 11, 14, 16], // 115
        [5, 9, 12, 15, 17], // 140
        [5, 10, 13, 16, 18], // 162.5
        [6, 10, 14, 17, 18], // 187.5
        [4, 6, 8, 8, 7], // 225
        [4, 7, 9, 11, 12], // 285
    ]
    private func yd(_ y: Double) -> Double { y * 0.9144 }
    private func toYd(_ m: Double) -> Double { m / 0.9144 }

    // MARK: - windComponents (unchanged decomposition)

    func testWindComponentsDecomposition() {
        let head = windComponents(mps(10), 0, 0)
        XCTAssertEqual(head.headTailMph, -10, accuracy: 1e-9)
        XCTAssertEqual(head.crosswindMph, 0, accuracy: 1e-9)

        let tail = windComponents(mps(20), 180, 0)
        XCTAssertEqual(tail.headTailMph, 20, accuracy: 1e-9)

        let fromLeft = windComponents(mps(10), 270, 0)
        XCTAssertEqual(fromLeft.crosswindMph, 10, accuracy: 1e-9) // drifts right
        let fromRight = windComponents(mps(10), 90, 0)
        XCTAssertEqual(fromRight.crosswindMph, -10, accuracy: 1e-9)
    }

    // MARK: - windEffect calibration grid

    func testReproducesAll60TableCells() {
        for i in 0..<distNodes.count {
            let D = yd(distNodes[i])
            for j in 0..<speedNodes.count {
                let speed = mphToMps(speedNodes[j])
                // Hurting: dead headwind (windDir == bearing).
                let eHurt = windEffect(speed, 0, 0, D)
                XCTAssertEqual(toYd(playsAsM(D, eHurt)), distNodes[i] + hurtYd[i][j], accuracy: 0.01,
                               "hurt cell d=\(distNodes[i]) s=\(speedNodes[j])")
                // Helping: dead tailwind (windDir == bearing + 180).
                let eHelp = windEffect(speed, 180, 0, D)
                XCTAssertEqual(toYd(playsAsM(D, eHelp)), distNodes[i] - helpYd[i][j], accuracy: 0.01,
                               "help cell d=\(distNodes[i]) s=\(speedNodes[j])")
            }
        }
    }

    func testSignConvention() {
        let D = yd(160)
        let head = windEffect(mps(15), 0, 0, D)
        let tail = windEffect(mps(15), 180, 0, D)
        XCTAssertLessThan(head, 0)
        XCTAssertGreaterThan(tail, 0)
        XCTAssertGreaterThan(playsAsM(D, head), D) // plays longer
        XCTAssertLessThan(playsAsM(D, tail), D) // plays shorter
    }

    func testDeadCrosswindIsZero() {
        // cos(90°) is ~6e-17 in FP → negligible head component, negligible effect.
        XCTAssertEqual(windEffect(mps(15), 270, 0, yd(160)), 0, accuracy: 1e-12)
        XCTAssertEqual(windEffect(mps(15), 90, 0, yd(160)), 0, accuracy: 1e-12)
    }

    func testZeroWindAndNonPositiveDistance() {
        XCTAssertEqual(windEffect(0, 123, 45, yd(160)), 0)
        XCTAssertEqual(windEffect(mps(15), 0, 0, 0), 0)
        XCTAssertEqual(windEffect(mps(15), 0, 0, -50), 0)
    }

    func testDistanceBelow115ClampsToFirstRow() {
        let e = windEffect(mps(10), 0, 0, yd(100))
        let a = hurtYd[0][1] / distNodes[0] // 115 row @ 10 mph = 11/115
        XCTAssertEqual(e, -a / (1 + a), accuracy: 1e-9)
    }

    func testDistanceAbove285ClampsToLastRow() {
        let e = windEffect(mps(10), 0, 0, yd(320))
        let a = hurtYd[5][1] / distNodes[5] // 285 row @ 10 mph = 9/285
        XCTAssertEqual(e, -a / (1 + a), accuracy: 1e-9)
    }

    func testComponentBelow5MphLinearFromZero() {
        let e = windEffect(mphToMps(2.5), 0, 0, yd(140)) // half of the 5-mph column
        let a = 0.5 * (hurtYd[1][0] / distNodes[1]) // ½ · 6/140
        XCTAssertEqual(e, -a / (1 + a), accuracy: 1e-9)
    }

    func testComponentAbove25HurtingCapsAt35() {
        let e = windEffect(mphToMps(40), 0, 0, yd(140)) // 40 mph head → capped at 35
        let v3 = hurtYd[1][3] // 28
        let v4 = hurtYd[1][4] // 38
        let cappedYd = v4 + ((35 - 25) / 5) * (v4 - v3) // 38 + 2·10 = 58
        let a = cappedYd / distNodes[1]
        XCTAssertEqual(e, -a / (1 + a), accuracy: 1e-9)
    }

    func testComponentAbove25HelpingClampsTo25Column() {
        let e = windEffect(mphToMps(40), 180, 0, yd(140)) // 40 mph tail → clamp to 25
        let a = helpYd[1][4] / distNodes[1] // 17/140
        XCTAssertEqual(e, a / (1 - a), accuracy: 1e-9)
    }

    func testInterpolationSmokeBetweenNodes() {
        let mid = windEffect(mphToMps(12.5), 0, 0, yd(150)) // hurting, negative
        XCTAssertLessThan(mid, windEffect(mphToMps(10), 0, 0, yd(150)))
        XCTAssertGreaterThan(mid, windEffect(mphToMps(15), 0, 0, yd(150)))
        let loD = windEffect(mphToMps(12.5), 0, 0, yd(140))
        let hiD = windEffect(mphToMps(12.5), 0, 0, yd(162.5))
        XCTAssertLessThanOrEqual(mid, max(loD, hiD) + 1e-12)
        XCTAssertGreaterThanOrEqual(mid, min(loD, hiD) - 1e-12)
    }

    // MARK: - application forms

    func testPlaysAsIsDivisionNotMultiply() {
        XCTAssertEqual(playsAsM(150, -0.08), 150 / 0.92, accuracy: 1e-12)
    }

    func testForwardAndPlaysAsShareEffectSign() {
        let e = windEffect(mps(12), 0, 0, yd(200))
        XCTAssertLessThan(e, 0)
        XCTAssertLessThan(adjustedCarryM(200, e), 200)
        XCTAssertGreaterThan(playsAsM(yd(200), e), yd(200))
    }

    func testCrosswindDriftUnchanged() {
        XCTAssertEqual(crosswindDriftM(243, 10), 12.15, accuracy: 1e-12)
        XCTAssertEqual(crosswindDriftM(243, -10), -12.15, accuracy: 1e-12)
        XCTAssertEqual(crosswindDriftM(243, 0), 0)
    }
}
