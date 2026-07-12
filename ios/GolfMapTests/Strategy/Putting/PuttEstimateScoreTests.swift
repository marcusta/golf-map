import XCTest
@testable import GolfMap

/// Parity tests for `scoreEstimate` against `web/src/planner/putt-estimate-score.ts`.
/// Two families:
///  - hand-verifiable cases lifted directly from
///    `web/tests/putt-estimate-score.test.ts` (taper edges, weighting,
///    floor-at-zero, straight-vs-break mismatch);
///  - TS-computed golden cases run through the real `scoreEstimate()` via
///    `bun run` and hard-coded here (six mixed-error scenarios spanning
///    near-perfect to worst-case), per the task's golden-fixture allowance.
final class PuttEstimateScoreTests: XCTestCase {

    // MARK: - Hand-verifiable cases (ported from the web test file)

    func testPerfectEstimateScores100() {
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let estimate = PuttEstimate(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let result = scoreEstimate(estimate, truth: truth)
        XCTAssertEqual(result.score, 100)
        XCTAssertEqual(result.slopeErrorPct, 0)
        XCTAssertTrue(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 0)
        XCTAssertEqual(result.paceErrorM, 0)
    }

    func testSlopeCreditTaper_exactlyAtZeroThreshold_scores60() {
        // Weighted-40% component fully zeroed out, others perfect:
        // blend = 0.4*0 + 0.2*1 + 0.2*1 + 0.2*1 = 0.6 → 60.
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .straight, aimOffsetM: 0, playsLikeM: 5)
        let estimate = PuttEstimate(slopePct: 2 + SLOPE_ERROR_ZERO_PCT, breakSide: .straight, aimOffsetM: 0, playsLikeM: 5)
        XCTAssertEqual(scoreEstimate(estimate, truth: truth).score, 60)
    }

    func testSlopeCreditTaper_halfwayToZeroThreshold_scores80() {
        // Half credit lost on the 40%-weighted slope term:
        // blend = 0.4*0.5 + 0.2*1 + 0.2*1 + 0.2*1 = 0.8 → 80.
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .straight, aimOffsetM: 0, playsLikeM: 5)
        let estimate = PuttEstimate(slopePct: 2 + SLOPE_ERROR_ZERO_PCT / 2, breakSide: .straight, aimOffsetM: 0, playsLikeM: 5)
        XCTAssertEqual(scoreEstimate(estimate, truth: truth).score, 80)
    }

    func testErrorsBeyondZeroThresholds_scoreFloorsAtZero_neverNegative() {
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let estimate = PuttEstimate(
            slopePct: 2 + SLOPE_ERROR_ZERO_PCT * 5,
            breakSide: .right,
            aimOffsetM: -0.3 + AIM_ERROR_ZERO_M * 5,
            playsLikeM: 8 + PACE_ERROR_ZERO_M * 5
        )
        XCTAssertEqual(scoreEstimate(estimate, truth: truth).score, 0)
    }

    func testSlopeOnlyRight_othersFullyMissed_scores40() {
        // Only the 40%-weighted slope term has credit; break/aim/pace all miss.
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let estimate = PuttEstimate(
            slopePct: 2,
            breakSide: .right,
            aimOffsetM: -0.3 + AIM_ERROR_ZERO_M * 2,
            playsLikeM: 8 + PACE_ERROR_ZERO_M * 2
        )
        XCTAssertEqual(scoreEstimate(estimate, truth: truth).score, 40)
    }

    func testEverythingButSlope_slopeFullyMissed_scores60() {
        // Slope (40% weight) fully misses; break/aim/pace (60% combined) are perfect.
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let estimate = PuttEstimate(
            slopePct: 2 + SLOPE_ERROR_ZERO_PCT * 2,
            breakSide: .left,
            aimOffsetM: -0.3,
            playsLikeM: 8
        )
        XCTAssertEqual(scoreEstimate(estimate, truth: truth).score, 60)
    }

    func testStraightTruthVsBreakEstimate_mismatchLowersScore() {
        let truth = PuttGroundTruth(slopePct: 0, breakSide: .straight, aimOffsetM: 0, playsLikeM: 5)
        let estimate = PuttEstimate(slopePct: 0, breakSide: .left, aimOffsetM: 0, playsLikeM: 5)
        XCTAssertLessThan(scoreEstimate(estimate, truth: truth).score, 100)
    }

    // MARK: - TS-computed golden cases
    //
    // Generated via `bun run` against the real `scoreEstimate()` in
    // web/src/planner/putt-estimate-score.ts (task's golden-fixture
    // allowance — not a checked-in generator script, six cases hard-coded
    // directly from the bun output).

    func testGolden_mixedErrors() {
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let estimate = PuttEstimate(slopePct: 3.5, breakSide: .right, aimOffsetM: 0.1, playsLikeM: 7.2)
        let result = scoreEstimate(estimate, truth: truth)
        XCTAssertEqual(result.slopeErrorPct, 1.5, accuracy: 1e-9)
        XCTAssertFalse(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 0.4, accuracy: 1e-9)
        XCTAssertEqual(result.paceErrorM, 0.8, accuracy: 1e-9)
        XCTAssertEqual(result.score, 31)
    }

    func testGolden_realisticNearMiss() {
        let truth = PuttGroundTruth(slopePct: 1.8, breakSide: .right, aimOffsetM: 0.22, playsLikeM: 5.4)
        let estimate = PuttEstimate(slopePct: 1.3, breakSide: .right, aimOffsetM: 0.35, playsLikeM: 5.9)
        let result = scoreEstimate(estimate, truth: truth)
        XCTAssertEqual(result.slopeErrorPct, 0.5, accuracy: 1e-9)
        XCTAssertTrue(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 0.13, accuracy: 1e-9)
        XCTAssertEqual(result.paceErrorM, 0.5, accuracy: 1e-9)
        XCTAssertEqual(result.score, 82)
    }

    func testGolden_straightPutt() {
        let truth = PuttGroundTruth(slopePct: 0, breakSide: .straight, aimOffsetM: 0, playsLikeM: 4.2)
        let estimate = PuttEstimate(slopePct: 0.4, breakSide: .straight, aimOffsetM: 0.05, playsLikeM: 4.0)
        let result = scoreEstimate(estimate, truth: truth)
        XCTAssertEqual(result.slopeErrorPct, 0.4, accuracy: 1e-9)
        XCTAssertTrue(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 0.05, accuracy: 1e-9)
        XCTAssertEqual(result.paceErrorM, 0.2, accuracy: 1e-9)
        XCTAssertEqual(result.score, 89)
    }

    func testGolden_worstCase() {
        let truth = PuttGroundTruth(slopePct: 2, breakSide: .left, aimOffsetM: -0.3, playsLikeM: 8)
        let estimate = PuttEstimate(slopePct: 12, breakSide: .right, aimOffsetM: 2.7, playsLikeM: 23)
        let result = scoreEstimate(estimate, truth: truth)
        XCTAssertEqual(result.slopeErrorPct, 10, accuracy: 1e-9)
        XCTAssertFalse(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 3, accuracy: 1e-9)
        XCTAssertEqual(result.paceErrorM, 15, accuracy: 1e-9)
        XCTAssertEqual(result.score, 0)
    }

    func testGolden_bigSteepBreakSlowGreen() {
        let truth = PuttGroundTruth(slopePct: 4.7, breakSide: .right, aimOffsetM: 0.58, playsLikeM: 12.3)
        let estimate = PuttEstimate(slopePct: 4.9, breakSide: .left, aimOffsetM: -0.12, playsLikeM: 10.1)
        let result = scoreEstimate(estimate, truth: truth)
        XCTAssertEqual(result.slopeErrorPct, 0.2, accuracy: 1e-9)
        XCTAssertFalse(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 0.7, accuracy: 1e-9)
        XCTAssertEqual(result.paceErrorM, 2.2, accuracy: 1e-9)
        XCTAssertEqual(result.score, 41)
    }
}
