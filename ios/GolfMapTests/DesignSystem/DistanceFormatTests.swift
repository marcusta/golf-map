import XCTest
@testable import GolfMap

/// `DistanceFormat` / `DistanceUnit` — the single meters → display-unit
/// conversion point every on-course view routes through. Internal math is
/// always metric; these tests pin down the rounding behavior at the display
/// boundary (whole units both ways, nil-safe, exact yard conversion).
final class DistanceFormatTests: XCTestCase {

    // MARK: - Meters passthrough

    func testMetersRoundsToWholeNumber() {
        XCTAssertEqual(DistanceFormat.wholeUnits(182.0, unit: .meters), 182)
        XCTAssertEqual(DistanceFormat.wholeUnits(182.4, unit: .meters), 182)
        XCTAssertEqual(DistanceFormat.wholeUnits(182.5, unit: .meters), 183) // round-half-up
        XCTAssertEqual(DistanceFormat.wholeUnits(182.6, unit: .meters), 183)
    }

    func testMetersStringMatchesWholeUnits() {
        XCTAssertEqual(DistanceFormat.string(182.4, unit: .meters), "182")
        XCTAssertEqual(DistanceFormat.string(182, unit: .meters), "182")
    }

    // MARK: - Yard conversion

    func testYardsConvertsAndRounds() {
        // 100 m = 109.36 yd → 109.
        XCTAssertEqual(DistanceFormat.wholeUnits(100.0, unit: .yards), 109)
        // 182 m = 199.06 yd → 199.
        XCTAssertEqual(DistanceFormat.wholeUnits(182.0, unit: .yards), 199)
        // Exact yard boundary: 1 yard = 0.9144 m.
        XCTAssertEqual(DistanceFormat.wholeUnits(0.9144, unit: .yards), 1)
    }

    func testYardsRoundHalfUp() {
        // Find a meters value landing exactly on a .5 yard boundary and
        // confirm it rounds away from zero like the meters case.
        let halfYardMeters = 0.9144 * 10.5 // 10.5 yards
        XCTAssertEqual(DistanceFormat.wholeUnits(halfYardMeters, unit: .yards), 11)
    }

    func testYardsZero() {
        XCTAssertEqual(DistanceFormat.wholeUnits(0, unit: .yards), 0)
        XCTAssertEqual(DistanceFormat.wholeUnits(0, unit: .meters), 0)
    }

    // MARK: - Int overloads

    func testIntOverloadMatchesDoubleOverload() {
        XCTAssertEqual(DistanceFormat.wholeUnits(182, unit: .yards), DistanceFormat.wholeUnits(182.0, unit: .yards))
        XCTAssertEqual(DistanceFormat.string(182, unit: .meters), DistanceFormat.string(182.0, unit: .meters))
    }

    // MARK: - Nil safety

    func testNilMetersRendersDash() {
        let meters: Int? = nil
        XCTAssertEqual(DistanceFormat.string(meters, unit: .meters), "–")
        XCTAssertEqual(DistanceFormat.string(meters, unit: .yards), "–")
        XCTAssertEqual(DistanceFormat.stringWithUnit(meters, unit: .meters), "–")
    }

    func testNilDoubleMetersRendersDash() {
        let meters: Double? = nil
        XCTAssertEqual(DistanceFormat.string(meters, unit: .meters), "–")
        XCTAssertEqual(DistanceFormat.stringWithUnit(meters, unit: .yards), "–")
    }

    func testPresentValueDoesNotRenderDash() {
        let meters: Int? = 150
        XCTAssertEqual(DistanceFormat.string(meters, unit: .meters), "150")
    }

    // MARK: - stringWithUnit

    func testStringWithUnitAppendsAbbreviation() {
        XCTAssertEqual(DistanceFormat.stringWithUnit(182, unit: .meters), "182 m")
        XCTAssertEqual(DistanceFormat.stringWithUnit(182, unit: .yards), "199 yd")
    }

    // MARK: - DistanceUnit

    func testDistanceUnitAbbreviations() {
        XCTAssertEqual(DistanceUnit.meters.abbreviation, "m")
        XCTAssertEqual(DistanceUnit.yards.abbreviation, "yd")
    }

    func testDistanceUnitLabels() {
        XCTAssertEqual(DistanceUnit.meters.label, "Meters")
        XCTAssertEqual(DistanceUnit.yards.label, "Yards")
    }

    func testDistanceUnitRawValueRoundTrips() {
        XCTAssertEqual(DistanceUnit(rawValue: "meters"), .meters)
        XCTAssertEqual(DistanceUnit(rawValue: "yards"), .yards)
        XCTAssertNil(DistanceUnit(rawValue: "bogus"))
    }
}
