import XCTest
@testable import GolfMap

/// Port of `shared/strategy/putting/tour-read.test.ts` — worked examples
/// straight from docs/feature-putting-green-reading.md §3.1–3.4. Same test
/// intents and tolerances as the TS suite; bit-level parity is covered
/// separately by PuttingGoldenParityTests.
final class TourReadTests: XCTestCase {

    // MARK: - §3.1 friction from stimp

    func testStimp10GivesMuAboutPoint056() {
        XCTAssertEqual(stimpToFriction(10), 0.056, accuracy: 5e-4)
    }

    func testMuScalesAsOneOverStimpExactly() {
        // μ(S) = μ(10)·10/S — the 1/S shape is exact regardless of the constant.
        let mu10 = stimpToFriction(10)
        XCTAssertEqual(stimpToFriction(12), mu10 * 10 / 12, accuracy: 5e-10)
        XCTAssertEqual(stimpToFriction(8), mu10 * 10 / 8, accuracy: 5e-10)
    }

    // MARK: - §3.2 Tour Read aim

    func testReferenceFormulaPacesTimesTwoMinusOneTimesSlope() {
        // 4 paces, 2% → (4×2−1)×2 = 14 inches (the doc "14 in" example).
        XCTAssertEqual(tourReadAimInchesAtReference(4, 2), 14, accuracy: 5e-10)
        // 6 paces, 1.5% → (11)×1.5 = 16.5.
        XCTAssertEqual(tourReadAimInchesAtReference(6, 1.5), 16.5, accuracy: 5e-10)
    }

    func testSub1PacePuttClampsThePaceTermAtZero() {
        XCTAssertEqual(tourReadAimInchesAtReference(0.25, 3), 0) // 2×0.25−1 = −0.5 → 0
        XCTAssertEqual(tourReadAimInchesAtReference(0.5, 3), 0) // exactly 0
    }

    func testStimpScalingPlusMinus10PercentPerFootFromReference() {
        XCTAssertEqual(stimpBreakScale(10), 1.0, accuracy: 5e-10)
        XCTAssertEqual(stimpBreakScale(11), 1.1, accuracy: 5e-10)
        XCTAssertEqual(stimpBreakScale(9), 0.9, accuracy: 5e-10)
        XCTAssertEqual(stimpBreakScale(12), 1.2, accuracy: 5e-10)
        // Applied: 14 in at reference → 15.4 in at stimp 11.
        XCTAssertEqual(tourReadAimInches(4, 2, 11), 15.4, accuracy: 5e-7)
        XCTAssertEqual(tourReadAimInches(4, 2, 9), 12.6, accuracy: 5e-7)
    }

    // MARK: - §3.3 uphill/downhill break multiplier

    private let mu10 = stimpToFriction(10) // ≈ 0.056

    func testTwoPercentDownhillAtStimp10MultipliesByAbout155() {
        XCTAssertEqual(breakMultiplier(mu: mu10, gradeFraction: -0.02), 1.55, accuracy: 0.05)
    }

    func testTwoPercentUphillAtStimp10MultipliesByAbout074() {
        XCTAssertEqual(breakMultiplier(mu: mu10, gradeFraction: 0.02), 0.74, accuracy: 0.05)
    }

    func testFlatMultipliesByOne() {
        XCTAssertEqual(breakMultiplier(mu: mu10, gradeFraction: 0), 1, accuracy: 5e-10)
    }

    func testDownhillGradeAtOrBeyondMuDiverges() {
        XCTAssertEqual(breakMultiplier(mu: mu10, gradeFraction: -mu10), .infinity)
        XCTAssertEqual(breakMultiplier(mu: mu10, gradeFraction: -0.1), .infinity)
    }

    // MARK: - §3.4 plays-like putt length

    func test10mRising03mAtStimp10PlaysAbout154m() {
        let r = playsLikeLength(distanceM: 10, gradeDeltaM: 0.3, mu: mu10)
        XCTAssertEqual(r.playsLikeMeters, 15.36, accuracy: 0.05)
        XCTAssertTrue(r.canStop)
    }

    func testDownhillPlaysShorter() {
        let r = playsLikeLength(distanceM: 10, gradeDeltaM: -0.2, mu: mu10)
        XCTAssertLessThan(r.playsLikeMeters, 10)
        XCTAssertTrue(r.canStop)
    }

    func testDegenerateDownhillCannotStop() {
        // Δh = −1 m, μ ≈ 0.056 → Δh/μ ≈ −17.9 m, well past a 10 m putt.
        let r = playsLikeLength(distanceM: 10, gradeDeltaM: -1, mu: mu10)
        XCTAssertFalse(r.canStop)
        XCTAssertLessThanOrEqual(r.playsLikeMeters, 0)
    }

    // MARK: - assembled tourRead

    func testSignConventionBreakRightAimsLeftNegativeOffset() {
        let r = tourRead(distanceM: 10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10,
                         breakToRight: true) // breaks left→right
        XCTAssertEqual(r.aimSide, .right)
        XCTAssertLessThan(r.aimOffsetMeters, 0)
        XCTAssertGreaterThan(r.aimInches, 0)
    }

    func testSignConventionBreakLeftAimsRightPositiveOffset() {
        let r = tourRead(distanceM: 10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10,
                         breakToRight: false) // breaks right→left
        XCTAssertEqual(r.aimSide, .left)
        XCTAssertGreaterThan(r.aimOffsetMeters, 0)
    }

    func testFlatCrossSlopeIsStraightWithZeroOffset() {
        let r = tourRead(distanceM: 10, gradeDeltaM: 0, slopePct: 0, stimpFt: 10,
                         breakToRight: true)
        XCTAssertEqual(r.aimSide, .straight)
        XCTAssertEqual(r.aimOffsetMeters, 0)
        XCTAssertEqual(r.aimInches, 0)
    }

    func testAimOffsetMetersMatchesAimInchesConversion() {
        let r = tourRead(distanceM: 10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10,
                         breakToRight: true)
        XCTAssertEqual(abs(r.aimOffsetMeters), inchesToMeters(r.aimInches), accuracy: 5e-13)
    }

    func testPacesConvenienceMatchesMetersEntry() {
        let fromM = tourRead(distanceM: 4 * PACE_METERS, gradeDeltaM: 0.1, slopePct: 2,
                             stimpFt: 11, breakToRight: true)
        let fromP = tourReadFromPaces(4, gradeDeltaM: 0.1, slopePct: 2, stimpFt: 11,
                                      breakToRight: true)
        XCTAssertEqual(fromP.aimInches, fromM.aimInches, accuracy: 5e-13)
        XCTAssertEqual(fromP.playsLikeMeters, fromM.playsLikeMeters, accuracy: 5e-13)
    }

    func testCantStopDownhillCarriesCanStopFalseAndAFiniteAim() {
        let r = tourRead(distanceM: 10, gradeDeltaM: -1, slopePct: 2, stimpFt: 10,
                         breakToRight: true)
        XCTAssertFalse(r.canStop)
        XCTAssertTrue(r.aimOffsetMeters.isFinite)
        XCTAssertEqual(r.aimOffsetMeters, 0) // diverging multiplier → aim capped to 0
    }

    // MARK: - verbal formatter

    func testImperial14InLeft() {
        // ~4 paces (3.66 m), 2% break right→left → aim left, 14 in.
        let r = tourReadFromPaces(4, gradeDeltaM: 0, slopePct: 2, stimpFt: 10,
                                  breakToRight: false)
        let v = formatTourRead(r, units: .imperial)
        XCTAssertEqual(v.aim, "14 in left")
    }

    func testMetricAim35CmLeft() {
        let r = tourReadFromPaces(4, gradeDeltaM: 0, slopePct: 2, stimpFt: 10,
                                  breakToRight: false)
        let v = formatTourRead(r, units: .metric)
        XCTAssertEqual(v.aim, "aim 35 cm left") // 14 in = 35.56 cm → 35
    }

    func testMetricPaceLinePlaysLike154m() {
        let r = tourRead(distanceM: 10, gradeDeltaM: 0.3, slopePct: 2, stimpFt: 10,
                         breakToRight: true)
        let v = formatTourRead(r, units: .metric)
        XCTAssertEqual(v.pace, "plays like 15.4 m")
    }

    func testImperialPaceLineUsesFeet() {
        let r = tourRead(distanceM: 10, gradeDeltaM: 0, slopePct: 0, stimpFt: 10,
                         breakToRight: true) // 10 m flat = 32.8 ft
        let v = formatTourRead(r, units: .imperial)
        XCTAssertEqual(v.pace, "plays like 33 ft")
    }

    func testCantStopMessageInBothUnitSystems() {
        let r = tourRead(distanceM: 10, gradeDeltaM: -1, slopePct: 2, stimpFt: 10,
                         breakToRight: true)
        let expected = "can't stop this one — lag to the low side"
        XCTAssertEqual(formatTourRead(r, units: .metric).pace, expected)
        XCTAssertEqual(formatTourRead(r, units: .imperial).pace, expected)
    }

    func testCombinedJoinsAimAndPace() {
        let r = tourReadFromPaces(4, gradeDeltaM: 0.3, slopePct: 2, stimpFt: 10,
                                  breakToRight: false)
        let v = formatTourRead(r, units: .imperial)
        XCTAssertEqual(v.combined, "\(v.aim) · \(v.pace)")
    }
}
