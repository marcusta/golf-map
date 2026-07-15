import XCTest
@testable import GolfMap

/// Unit tests for the origin-calibration value model (spec §6.4): confidence
/// decay (age × distance), the floor behaviour of `appliedBias`, the residual
/// gate state machine, and burst fix averaging. Pure value logic — every
/// assertion uses fixed `Date`s so nothing depends on wall-clock time.
final class OriginCalibrationTests: XCTestCase {

    // A fixed solve instant; `now` is always this plus an explicit offset.
    private let solvedAt = Date(timeIntervalSince1970: 1_000_000)
    private func now(minutes: Double) -> Date { solvedAt.addingTimeInterval(minutes * 60) }
    private func now(seconds: Double) -> Date { solvedAt.addingTimeInterval(seconds) }

    private func calibration(
        biasE: Double = 3,
        biasN: Double = -2,
        base: Double = 1,
        method: OriginCalibration.Method = .anchor,
        stale: Bool = false
    ) -> OriginCalibration {
        OriginCalibration(
            biasE: biasE,
            biasN: biasN,
            solvedAt: solvedAt,
            solvedNear: LatLon(lat: 0, lon: 0),
            method: method,
            baseConfidence: base,
            stale: stale
        )
    }

    // MARK: - Age decay

    func testAgeFactorTable() {
        let cases: [(minutes: Double, factor: Double)] = [
            (0, 1.0),
            (299.0 / 60, 1.0),   // 4:59
            (5, 1.0),            // 5:00
            (10, 0.5),           // midpoint of the 5→15 ramp
            (15, 0.0),
            (20, 0.0),           // clamped past zero-trust
        ]
        for c in cases {
            XCTAssertEqual(OriginCalibration.ageFactor(ageMinutes: c.minutes), c.factor,
                           accuracy: 1e-12, "age \(c.minutes) min")
        }
        // Negative age (now before solve) is treated as full trust.
        XCTAssertEqual(OriginCalibration.ageFactor(ageMinutes: -3), 1.0, accuracy: 1e-12)
    }

    // MARK: - Distance decay

    func testDistanceFactorTable() {
        let cases: [(distanceM: Double, factor: Double)] = [
            (0, 1.0),
            (100, 1.0),
            (300, 0.75),   // linear midpoint of the 100→500 ramp
            (500, 0.5),
            (800, 0.5),    // flat floor beyond 500
        ]
        for c in cases {
            XCTAssertEqual(OriginCalibration.distanceFactor(distanceM: c.distanceM), c.factor,
                           accuracy: 1e-12, "distance \(c.distanceM) m")
        }
    }

    // MARK: - Combined confidence

    func testConfidenceMultipliesBaseAgeDistance() {
        // base 0.8 · age(10 min)=0.5 · dist(300 m)=0.75 = 0.3
        let c = calibration(base: 0.8)
        XCTAssertEqual(c.confidence(now: now(minutes: 10), distanceFromSolveM: 300), 0.3,
                       accuracy: 1e-12)
    }

    func testConfidenceAtSolveIsBase() {
        let c = calibration(base: 0.62)
        XCTAssertEqual(c.confidence(now: now(minutes: 0), distanceFromSolveM: 0), 0.62,
                       accuracy: 1e-12)
    }

    func testStaleConfidenceIsAlwaysZero() {
        let c = calibration(base: 1, stale: true)
        XCTAssertEqual(c.confidence(now: now(minutes: 0), distanceFromSolveM: 0), 0)
        XCTAssertEqual(c.confidence(now: now(minutes: 1), distanceFromSolveM: 10), 0)
    }

    // MARK: - appliedBias floor behaviour

    func testAppliedBiasJustAboveFloorReturnsBias() {
        // base 1 · dist 0 · age 11 min → factor 0.4 ≥ 0.3 floor.
        let c = calibration(biasE: 3, biasN: -2, base: 1)
        let bias = c.appliedBias(now: now(minutes: 11), distanceFromSolveM: 0)
        XCTAssertEqual(bias?.e, 3)
        XCTAssertEqual(bias?.n, -2)
    }

    func testAppliedBiasAtFloorReturnsBias() {
        // age 12 min → 0.3 == floor → applied (floor is inclusive).
        let c = calibration(base: 1)
        XCTAssertNotNil(c.appliedBias(now: now(minutes: 12), distanceFromSolveM: 0))
        XCTAssertEqual(c.confidence(now: now(minutes: 12), distanceFromSolveM: 0), 0.3,
                       accuracy: 1e-12)
    }

    func testAppliedBiasJustBelowFloorIsNil() {
        // age 13 min → 0.2 < 0.3 floor → dropped.
        let c = calibration(base: 1)
        XCTAssertNil(c.appliedBias(now: now(minutes: 13), distanceFromSolveM: 0))
    }

    func testAppliedBiasStaleIsNil() {
        let c = calibration(base: 1, stale: true)
        XCTAssertNil(c.appliedBias(now: now(minutes: 0), distanceFromSolveM: 0))
    }

    // MARK: - Residual gate

    func testResidualConfirmedRefreshesAndBumpsConfidence() {
        let c = calibration(base: 0.5, method: .trilateration)
        let (updated, outcome) = c.registeringResidual(1.9, now: now(minutes: 3))
        XCTAssertEqual(outcome, .confirmed)
        XCTAssertEqual(updated.solvedAt, now(minutes: 3))
        XCTAssertEqual(updated.method, .residualRefresh)
        XCTAssertEqual(updated.baseConfidence, 0.8) // restored to at least 0.8
        XCTAssertFalse(updated.stale)
        // Bias vector itself is untouched by a refresh.
        XCTAssertEqual(updated.biasE, c.biasE)
        XCTAssertEqual(updated.biasN, c.biasN)
    }

    func testResidualConfirmNeverLowersHigherBaseConfidence() {
        let c = calibration(base: 0.95)
        let (updated, outcome) = c.registeringResidual(0.5, now: now(minutes: 1))
        XCTAssertEqual(outcome, .confirmed)
        XCTAssertEqual(updated.baseConfidence, 0.95) // max(0.95, 0.8)
    }

    func testResidualConfirmBoundaryAtTwoMeters() {
        let c = calibration(base: 0.5)
        let (updated, outcome) = c.registeringResidual(2.0, now: now(minutes: 1))
        XCTAssertEqual(outcome, .confirmed) // ≤ confirm is inclusive
        XCTAssertEqual(updated.method, .residualRefresh)
    }

    func testResidualInconclusiveLeavesCalibrationUnchanged() {
        let c = calibration(base: 0.5)
        let (updated, outcome) = c.registeringResidual(3.0, now: now(minutes: 1))
        XCTAssertEqual(outcome, .inconclusive)
        XCTAssertEqual(updated, c) // no field touched
    }

    func testResidualRejectBoundaryAtFourMeters() {
        let c = calibration(base: 0.5)
        let (updated, outcome) = c.registeringResidual(4.0, now: now(minutes: 1))
        XCTAssertEqual(outcome, .rejected) // ≥ reject is inclusive
        XCTAssertTrue(updated.stale)
    }

    func testResidualRejectMarksStale() {
        let c = calibration(base: 0.5)
        let (updated, outcome) = c.registeringResidual(5.0, now: now(minutes: 1))
        XCTAssertEqual(outcome, .rejected)
        XCTAssertTrue(updated.stale)
        // Everything else is preserved; only staleness flips.
        XCTAssertEqual(updated.biasE, c.biasE)
        XCTAssertEqual(updated.solvedAt, c.solvedAt)
    }

    func testResidualGateOnStaleIsInconclusiveAndTerminal() {
        let c = calibration(base: 0.9, stale: true)
        // Even an in-tolerance residual does not revive a stale calibration.
        let (confirmed, o1) = c.registeringResidual(1.0, now: now(minutes: 1))
        XCTAssertEqual(o1, .inconclusive)
        XCTAssertEqual(confirmed, c)
        // Nor does a large one change it further.
        let (rejected, o2) = c.registeringResidual(9.0, now: now(minutes: 1))
        XCTAssertEqual(o2, .inconclusive)
        XCTAssertEqual(rejected, c)
    }

    // MARK: - FixAverager

    func testFixAveragerNilBelowThreeFixes() {
        var avg = FixAverager()
        XCTAssertNil(avg.result)
        avg.add(e: 0, n: 0, horizontalAccuracyM: 3)
        XCTAssertEqual(avg.count, 1)
        XCTAssertNil(avg.result)
        avg.add(e: 6, n: 0, horizontalAccuracyM: 5)
        XCTAssertEqual(avg.count, 2)
        XCTAssertNil(avg.result)
    }

    func testFixAveragerMeanRmsAndWorstAccuracy() {
        var avg = FixAverager()
        avg.add(e: 0, n: 0, horizontalAccuracyM: 3)
        avg.add(e: 6, n: 0, horizontalAccuracyM: 5)
        avg.add(e: 0, n: 6, horizontalAccuracyM: 4)
        // Mean = (2, 2). Squared planar deviations: 8 + 20 + 20 = 48; /3 = 16.
        // RMS spread = 4. Worst accuracy = 5.
        let r = try! XCTUnwrap(avg.result)
        XCTAssertEqual(r.e, 2, accuracy: 1e-12)
        XCTAssertEqual(r.n, 2, accuracy: 1e-12)
        XCTAssertEqual(r.rmsSpreadM, 4, accuracy: 1e-12)
        XCTAssertEqual(r.worstAccuracyM, 5, accuracy: 1e-12)
        XCTAssertEqual(avg.count, 3)
    }

    func testFixAveragerZeroSpreadForCoincidentFixes() {
        var avg = FixAverager()
        avg.add(e: 10, n: -4, horizontalAccuracyM: 2)
        avg.add(e: 10, n: -4, horizontalAccuracyM: 6)
        avg.add(e: 10, n: -4, horizontalAccuracyM: 1)
        let r = try! XCTUnwrap(avg.result)
        XCTAssertEqual(r.e, 10, accuracy: 1e-12)
        XCTAssertEqual(r.n, -4, accuracy: 1e-12)
        XCTAssertEqual(r.rmsSpreadM, 0, accuracy: 1e-12)
        XCTAssertEqual(r.worstAccuracyM, 6, accuracy: 1e-12) // tracks the max, not the last
    }
}
