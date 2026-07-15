import XCTest
@testable import GolfMap

/// State-machine tests for `CalibrationSession` (spec §6.2 / §6.3). Synthetic
/// geometry with exact means / distances, and fixed `Date`s, so every assertion
/// is deterministic — the session owns no clock. Mirrors the synthetic-truth
/// style of `TrilaterationTests` and `OriginCalibrationTests`.
@MainActor
final class CalibrationSessionTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 2_000_000)
    private func at(_ seconds: Double) -> Date { t0.addingTimeInterval(seconds) }

    // MARK: - Anchor flow (§6.2)

    private let anchor = Vec2(x: 500_000, y: 6_480_000)
    /// The burst's exact mean fix — chosen so `bias = anchor − mean = (−3, +2)`.
    private let meanFix = Vec2(x: 500_003, y: 6_479_998)

    /// Feed 8 fixes symmetric about `meanFix` (so the average is exact) with the
    /// given per-axis `deviation` and reported `accuracy`. Dates are t0+0…t0+7 s.
    private func feedAnchorBurst(_ s: CalibrationSession, deviation: Double, accuracy: Double) {
        let devs: [(Double, Double)] = [
            (1, 1), (1, -1), (-1, 1), (-1, -1),
            (1, 1), (1, -1), (-1, 1), (-1, -1),
        ]
        for (i, d) in devs.enumerated() {
            s.addFix(e: meanFix.x + d.0 * deviation,
                     n: meanFix.y + d.1 * deviation,
                     horizontalAccuracyM: accuracy,
                     at: at(Double(i)))
        }
    }

    func testAnchorCleanCaptureSolvesExactBias() {
        let s = CalibrationSession()
        s.beginAnchor(at: anchor, quality: .mapped)
        feedAnchorBurst(s, deviation: 0.5, accuracy: 5)

        let cal = try! XCTUnwrap(s.anchorResult)
        XCTAssertEqual(cal.biasE, -3, accuracy: 1e-9)
        XCTAssertEqual(cal.biasN, 2, accuracy: 1e-9)
        XCTAssertEqual(cal.method, .anchor)
        XCTAssertFalse(s.captureQualityWarning)
        // Clean capture: base confidence is the tier's, untouched.
        XCTAssertEqual(cal.baseConfidence, 0.8, accuracy: 1e-12)
        // solvedNear is the anchor projected to WGS84; solvedAt is the last fix.
        XCTAssertEqual(cal.solvedNear, Sweref99TM.toWGS84(x: anchor.x, y: anchor.y))
        XCTAssertEqual(cal.solvedAt, at(7))
    }

    func testAnchorQualityTiersMapToBaseConfidences() {
        let cases: [(CalibrationSession.AnchorQuality, Double)] = [
            (.surveyed, 0.95),
            (.mapped, 0.8),
            (.weak, 0.6),
        ]
        for (quality, expected) in cases {
            let s = CalibrationSession()
            s.beginAnchor(at: anchor, quality: quality)
            feedAnchorBurst(s, deviation: 0.5, accuracy: 5)
            let cal = try! XCTUnwrap(s.anchorResult)
            XCTAssertEqual(cal.baseConfidence, expected, accuracy: 1e-12, "\(quality)")
        }
    }

    func testAnchorJitteryCaptureWarnsAndReducesConfidence() {
        let s = CalibrationSession()
        s.beginAnchor(at: anchor, quality: .mapped)
        // deviation 2 m → RMS spread √8 ≈ 2.83 m > 2 m jitter threshold.
        feedAnchorBurst(s, deviation: 2, accuracy: 5)

        XCTAssertTrue(s.captureQualityWarning)
        let cal = try! XCTUnwrap(s.anchorResult)
        // Bias is still the exact mean-diff; only confidence is penalised.
        XCTAssertEqual(cal.biasE, -3, accuracy: 1e-9)
        XCTAssertEqual(cal.biasN, 2, accuracy: 1e-9)
        XCTAssertEqual(cal.baseConfidence, 0.8 * 0.7, accuracy: 1e-12)
    }

    func testAnchorPoorAccuracyAloneWarnsAndReducesConfidence() {
        let s = CalibrationSession()
        s.beginAnchor(at: anchor, quality: .surveyed)
        // Tight spread but a bad-accuracy burst (canopy multipath).
        feedAnchorBurst(s, deviation: 0.5, accuracy: 12)

        XCTAssertTrue(s.captureQualityWarning)
        let cal = try! XCTUnwrap(s.anchorResult)
        XCTAssertEqual(cal.baseConfidence, 0.95 * 0.7, accuracy: 1e-12)
    }

    func testAnchorResultNilUntilRequiredFixes() {
        let s = CalibrationSession()
        s.beginAnchor(at: anchor, quality: .mapped)
        // Seven fixes: not yet enough.
        for i in 0..<7 {
            s.addFix(e: meanFix.x, n: meanFix.y, horizontalAccuracyM: 5, at: at(Double(i)))
        }
        XCTAssertNil(s.anchorResult)
        XCTAssertEqual(s.fixProgress, 7.0 / 8.0, accuracy: 1e-12)
        s.addFix(e: meanFix.x, n: meanFix.y, horizontalAccuracyM: 5, at: at(7))
        XCTAssertEqual(s.fixProgress, 1.0, accuracy: 1e-12)
        XCTAssertNotNil(s.anchorResult)
    }

    // MARK: - Trilateration flow (§6.3)

    private let truePos = Vec2(x: 500_000, y: 6_480_000)
    /// Raw fix = truth displaced by (−3.2, +2.1) → solved bias (3.2, −2.1).
    private var rawFix: Vec2 { Vec2(x: truePos.x - 3.2, y: truePos.y + 2.1) }

    private func shot(to feature: Vec2, extraM: Double = 0) -> (Vec2, Double) {
        let dx = feature.x - truePos.x
        let dy = feature.y - truePos.y
        return (feature, (dx * dx + dy * dy).squareRoot() + extraM)
    }

    private func addShot(_ s: CalibrationSession, _ shot: (Vec2, Double)) {
        s.addShot(featurePlanar: shot.0, laserDistanceM: shot.1)
    }

    func testTrilaterationCleanSolveRecoversBiasAndBaseConfidence() {
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(10))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))     // due north
        addShot(s, shot(to: Vec2(x: truePos.x + 120, y: truePos.y)))     // due east

        let result = try! XCTUnwrap(s.trilaterationResult)
        XCTAssertEqual(result.calibration.biasE, 3.2, accuracy: 1e-3)
        XCTAssertEqual(result.calibration.biasN, -2.1, accuracy: 1e-3)
        XCTAssertEqual(result.calibration.method, .trilateration)
        XCTAssertEqual(result.calibration.solvedAt, at(10))
        XCTAssertFalse(result.solution.weakAxis)
        // Clean fit: rms ≈ 0 → base = 0.85 · 1 · 1.
        XCTAssertEqual(result.calibration.baseConfidence, 0.85, accuracy: 1e-3)
        // solvedNear is the solved position projected to WGS84.
        XCTAssertEqual(result.calibration.solvedNear,
                       Sweref99TM.toWGS84(x: result.solution.positionPlanar.x,
                                          y: result.solution.positionPlanar.y))
    }

    func testTrilaterationRmsScalesBaseConfidence() {
        // Opposing north/south pair both read 0.5 m long → rms = √0.125.
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150), extraM: 0.5))
        addShot(s, shot(to: Vec2(x: truePos.x + 120, y: truePos.y)))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y - 130), extraM: 0.5))
        addShot(s, shot(to: Vec2(x: truePos.x - 110, y: truePos.y)))

        let result = try! XCTUnwrap(s.trilaterationResult)
        XCTAssertFalse(result.solution.weakAxis)
        let expected = 0.85 * (1 - (0.125).squareRoot() / 3)
        XCTAssertEqual(result.calibration.baseConfidence, expected, accuracy: 1e-3)
    }

    func testTrilaterationBadFitFloorsAtMinFitFactor() {
        // Opposing pair both 3 m long → rms = √4.5 ≈ 2.12, driving
        // 1 − rms/3 ≈ 0.29 below the 0.4 floor.
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150), extraM: 3))
        addShot(s, shot(to: Vec2(x: truePos.x + 120, y: truePos.y)))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y - 130), extraM: 3))
        addShot(s, shot(to: Vec2(x: truePos.x - 110, y: truePos.y)))

        let result = try! XCTUnwrap(s.trilaterationResult)
        XCTAssertFalse(result.solution.weakAxis)
        XCTAssertEqual(result.calibration.baseConfidence, 0.85 * 0.4, accuracy: 1e-3)
    }

    func testTrilaterationWeakAxisHalvesConfidence() {
        // Two collinear (both due north) features → weak axis.
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 220)))

        let result = try! XCTUnwrap(s.trilaterationResult)
        XCTAssertTrue(result.solution.weakAxis)
        // Clean fit (rms ≈ 0), weak axis → 0.85 · 1 · 0.5.
        XCTAssertEqual(result.calibration.baseConfidence, 0.85 * 0.5, accuracy: 1e-3)
    }

    func testAngularSpreadOrthogonalIsAboutNinety() throws {
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        XCTAssertNil(s.angularSpreadDeg) // no shots yet
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))
        XCTAssertNil(s.angularSpreadDeg) // one shot: nothing to compare
        addShot(s, shot(to: Vec2(x: truePos.x + 120, y: truePos.y)))
        XCTAssertEqual(try XCTUnwrap(s.angularSpreadDeg), 90, accuracy: 2)
    }

    func testAngularSpreadNearCollinearIsSmall() throws {
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 220)))
        let spread = try XCTUnwrap(s.angularSpreadDeg)
        XCTAssertLessThan(spread, CalibrationSession.Constants.minAngularSpreadDeg)
        XCTAssertGreaterThanOrEqual(spread, 0)
    }

    func testTrilaterationResultNilBelowTwoShots() {
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        XCTAssertNil(s.trilaterationResult)
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))
        XCTAssertNil(s.trilaterationResult)
    }

    func testRemoveShotDropsResultBackBelowThreshold() {
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))
        addShot(s, shot(to: Vec2(x: truePos.x + 120, y: truePos.y)))
        XCTAssertNotNil(s.trilaterationResult)
        XCTAssertEqual(s.shots.count, 2)
        s.removeShot(at: 1)
        XCTAssertEqual(s.shots.count, 1)
        XCTAssertNil(s.trilaterationResult)
        s.removeShot(at: 9) // out of range: ignored
        XCTAssertEqual(s.shots.count, 1)
    }

    // MARK: - Phase transitions + reset

    func testPhaseTransitionsAndFlowIsolation() {
        let s = CalibrationSession()
        XCTAssertEqual(s.phase, .idle)

        s.beginAnchor(at: anchor, quality: .mapped)
        XCTAssertEqual(s.phase, .anchor)
        // A shot in the anchor phase is ignored.
        s.addShot(featurePlanar: Vec2(x: truePos.x, y: truePos.y + 150), laserDistanceM: 150)
        XCTAssertTrue(s.shots.isEmpty)

        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        XCTAssertEqual(s.phase, .trilateration)
        // A fix in the trilateration phase is ignored (fixProgress stays 0).
        s.addFix(e: meanFix.x, n: meanFix.y, horizontalAccuracyM: 5, at: at(0))
        XCTAssertEqual(s.fixProgress, 0)
        XCTAssertNil(s.anchorResult)
    }

    func testBeginAnchorClearsPriorTrilaterationShots() {
        let s = CalibrationSession()
        s.beginTrilateration(rawFixPlanar: rawFix, at: at(0))
        addShot(s, shot(to: Vec2(x: truePos.x, y: truePos.y + 150)))
        s.beginAnchor(at: anchor, quality: .mapped)
        XCTAssertTrue(s.shots.isEmpty)
        XCTAssertNil(s.trilaterationResult)
    }

    func testResetClearsEverything() {
        let s = CalibrationSession()
        s.beginAnchor(at: anchor, quality: .surveyed)
        feedAnchorBurst(s, deviation: 0.5, accuracy: 5)
        XCTAssertNotNil(s.anchorResult)

        s.reset()
        XCTAssertEqual(s.phase, .idle)
        XCTAssertEqual(s.fixProgress, 0)
        XCTAssertFalse(s.captureQualityWarning)
        XCTAssertNil(s.anchorResult)
        XCTAssertNil(s.trilaterationResult)
        XCTAssertNil(s.angularSpreadDeg)
        XCTAssertTrue(s.shots.isEmpty)
    }
}
