import XCTest
@testable import GolfMap

/// One-to-one port of `shared/strategy/apex.test.ts`.
final class ApexTests: XCTestCase {

    // MARK: - tableApexM

    func testHitsTheAnchorsExactly() {
        for anchor in Apex.table {
            XCTAssertEqual(Apex.tableApexM(anchor.carryM), anchor.apexM)
        }
    }

    func testInterpolatesLinearlyBetweenAnchors() {
        XCTAssertEqual(Apex.tableApexM(135), 27, accuracy: 1e-6)
        XCTAssertEqual(Apex.tableApexM(70), 17, accuracy: 1e-6)
    }

    func testClampsBeyondBothEnds() {
        XCTAssertEqual(Apex.tableApexM(20), 12)
        XCTAssertEqual(Apex.tableApexM(300), 30)
    }

    func testNonPositiveCarryIsZero() {
        XCTAssertEqual(Apex.tableApexM(0), 0)
        XCTAssertEqual(Apex.tableApexM(-5), 0)
        XCTAssertEqual(Apex.tableApexM(.nan), 0)
    }

    func testMonotonicallyNonDecreasingInCarry() {
        var prev = 0.0
        var c = 10.0
        while c <= 260 {
            let a = Apex.tableApexM(c)
            XCTAssertGreaterThanOrEqual(a, prev)
            prev = a
            c += 5
        }
    }

    // MARK: - apexHeightM

    func testDefaultsToTheAmateurScaleOnTheTable() {
        XCTAssertEqual(Apex.apexHeightM(150), 28 * Apex.amateurApexScale, accuracy: 1e-6)
        XCTAssertEqual(Apex.amateurApexScale, 0.85)
    }

    func testApexScaleOneReturnsTourNumbers() {
        XCTAssertEqual(Apex.apexHeightM(200, apexScale: 1), 30)
    }

    func testMeasuredClubApexWinsAndIsNotScaled() {
        XCTAssertEqual(Apex.apexHeightM(150, club: Apex.ClubHint(apexM: 19)), 19)
        XCTAssertEqual(Apex.apexHeightM(150, club: Apex.ClubHint(apexM: 19), apexScale: 0.5), 19)
    }

    func testInvalidClubApexFallsBackToTheTable() {
        let expected = 28 * Apex.amateurApexScale
        XCTAssertEqual(Apex.apexHeightM(150, club: Apex.ClubHint(apexM: nil)), expected, accuracy: 1e-6)
        XCTAssertEqual(Apex.apexHeightM(150, club: Apex.ClubHint(apexM: 0)), expected, accuracy: 1e-6)
        XCTAssertEqual(
            Apex.apexHeightM(150, club: Apex.ClubHint(category: "iron", loftDeg: 34)),
            expected, accuracy: 1e-6
        )
    }
}
