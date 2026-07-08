import XCTest
@testable import GolfMap

/// Pure spot-level math against synthetic gravity/heading samples — no
/// CoreMotion. Flat = 0%, a known 2% tilt, and each fall-line quadrant.
final class SpotLevelMathTests: XCTestCase {

    private let acc = 1e-9

    // MARK: - Primitives

    func testFlatGravityIsZeroSlope() {
        // Perfectly flat, screen up: gravity straight out the back (0,0,-1).
        let slope = SpotLevelMath.slopeFractionFromGravity(gx: 0, gy: 0, gz: -1)
        XCTAssertEqual(slope, 0, accuracy: acc)
        XCTAssertEqual(SpotLevelMath.tiltDegrees(gx: 0, gy: 0, gz: -1), 0, accuracy: acc)
    }

    func testKnownTwoPercentSlope() {
        // 2% slope = rise/run 0.02 → tilt angle atan(0.02). Build a gravity
        // vector at exactly that tilt: horizontal magnitude / |z| = 0.02.
        let tiltRad = atan(0.02)
        // Gravity leaning toward +x (device right), unit length.
        let gx = sin(tiltRad)
        let gz = -cos(tiltRad)
        let slope = SpotLevelMath.slopeFractionFromGravity(gx: gx, gy: 0, gz: gz)
        XCTAssertEqual(slope * 100, 2.0, accuracy: 1e-6, "slope % should be 2")
        XCTAssertEqual(
            SpotLevelMath.tiltDegrees(gx: gx, gy: 0, gz: gz),
            tiltRad * 180 / .pi,
            accuracy: 1e-6
        )
    }

    // MARK: - Fall line quadrants (heading 0 → device axes are world axes)

    func testFallLineNorthEastSouthWest() {
        // With heading 0, device +y = north, +x = east. Gravity's horizontal
        // projection points DOWNHILL.
        // (gx=0, gy=+) → downhill toward +y = north = 0°.
        XCTAssertEqual(
            SpotLevelMath.fallLineBearingDegrees(gx: 0, gy: 0.02, headingDeg: 0),
            0, accuracy: 1e-9
        )
        // (gx=+, gy=0) → downhill toward +x = east = 90°.
        XCTAssertEqual(
            SpotLevelMath.fallLineBearingDegrees(gx: 0.02, gy: 0, headingDeg: 0),
            90, accuracy: 1e-9
        )
        // (gx=0, gy=-) → south = 180°.
        XCTAssertEqual(
            SpotLevelMath.fallLineBearingDegrees(gx: 0, gy: -0.02, headingDeg: 0),
            180, accuracy: 1e-9
        )
        // (gx=-, gy=0) → west = 270°.
        XCTAssertEqual(
            SpotLevelMath.fallLineBearingDegrees(gx: -0.02, gy: 0, headingDeg: 0),
            270, accuracy: 1e-9
        )
    }

    func testFallLineRotatesWithHeading() {
        // Downhill toward device +y, but the device top points east (heading
        // 90) → downhill is east = 90°.
        XCTAssertEqual(
            SpotLevelMath.fallLineBearingDegrees(gx: 0, gy: 0.02, headingDeg: 90),
            90, accuracy: 1e-9
        )
        // Same downhill, device pointing NW (heading 315): 315 + 0 = 315.
        XCTAssertEqual(
            SpotLevelMath.fallLineBearingDegrees(gx: 0, gy: 0.02, headingDeg: 315),
            315, accuracy: 1e-9
        )
    }

    func testWrap360() {
        XCTAssertEqual(SpotLevelMath.wrap360(370), 10, accuracy: acc)
        XCTAssertEqual(SpotLevelMath.wrap360(-10), 350, accuracy: acc)
        XCTAssertEqual(SpotLevelMath.wrap360(0), 0, accuracy: acc)
    }

    func testCircularMeanHandlesWrap() {
        // Mean of 350 and 10 is 0, not 180.
        XCTAssertEqual(SpotLevelMath.circularMeanDegrees([350, 10]), 0, accuracy: 1e-6)
        XCTAssertEqual(SpotLevelMath.circularMeanDegrees([80, 100]), 90, accuracy: 1e-6)
    }

    // MARK: - Reduce

    func testReduceFlatWindowIsZeroSlopeAndTinyStd() {
        let flat = SpotLevelMath.Sample(gx: 0, gy: 0, gz: -1, headingDeg: 0)
        let reading = SpotLevelMath.reduce(Array(repeating: flat, count: 100), durationS: 1.5)
        XCTAssertEqual(reading.slopePct, 0, accuracy: 1e-9)
        XCTAssertEqual(reading.tiltStdDeg, 0, accuracy: 1e-9)
        XCTAssertEqual(reading.sampleCount, 100)
        XCTAssertEqual(reading.durationS, 1.5, accuracy: acc)
    }

    func testReduceKnownSlopeAndBearing() {
        // 2% downhill toward east, device heading 0.
        let tiltRad = atan(0.02)
        let s = SpotLevelMath.Sample(
            gx: sin(tiltRad), gy: 0, gz: -cos(tiltRad), headingDeg: 0
        )
        let reading = SpotLevelMath.reduce(Array(repeating: s, count: 50), durationS: 1.5)
        XCTAssertEqual(reading.slopePct, 2.0, accuracy: 1e-6)
        XCTAssertEqual(reading.fallLineBearingDeg, 90, accuracy: 1e-6)
        XCTAssertEqual(reading.tiltStdDeg, 0, accuracy: 1e-9, "constant window has zero jitter")
    }

    func testReduceJitterRaisesStd() {
        // Alternate between two tilt levels → non-zero std-dev.
        let t1 = atan(0.02), t2 = atan(0.06)
        let a = SpotLevelMath.Sample(gx: sin(t1), gy: 0, gz: -cos(t1), headingDeg: 0)
        let b = SpotLevelMath.Sample(gx: sin(t2), gy: 0, gz: -cos(t2), headingDeg: 0)
        let reading = SpotLevelMath.reduce([a, b, a, b, a, b], durationS: 1.5)
        XCTAssertGreaterThan(reading.tiltStdDeg, 0)
    }

    func testReduceEmptyWindow() {
        let reading = SpotLevelMath.reduce([], durationS: 1.5)
        XCTAssertEqual(reading.sampleCount, 0)
        XCTAssertEqual(reading.slopePct, 0)
    }

    // MARK: - Verdict thresholds

    func testVerdictThresholds() {
        // Good compass throughout.
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.01, headingAccuracyDeg: 5), .green)
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.02, headingAccuracyDeg: 5), .green)
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.03, headingAccuracyDeg: 5), .yellow)
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.05, headingAccuracyDeg: 5), .yellow)
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.10, headingAccuracyDeg: 5), .red)
    }

    func testVerdictRefusesBadCompass() {
        // A perfectly still reading is still red if the compass is unusable.
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.001, headingAccuracyDeg: 100), .red)
        XCTAssertEqual(SpotLevelCapture.verdict(tiltStdDeg: 0.001, headingAccuracyDeg: nil), .red)
    }
}
