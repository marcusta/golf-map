import XCTest
@testable import GolfMap

/// Scorecard aggregation over recorded strokes (docs/feature-shot-capture.md
/// §2: a shot row = one stroke, penalties ride on the causing stroke).
final class ScorecardTests: XCTestCase {

    private func hole(_ number: Int, par: Int) -> HoleRecord {
        HoleRecord(id: "h\(number)", courseId: "c1", number: number, par: par)
    }

    private func shot(
        hole: Int,
        order: Int,
        type: ShotType = .full,
        penalties: Int = 0
    ) -> ShotRecord {
        ShotRecord(
            roundId: "r1",
            holeNumber: hole,
            sortOrder: order,
            lat: 58.35,
            lon: 15.72,
            shotType: type,
            penaltyStrokes: penalties,
            recordedAt: "2026-07-12T10:0\(order):00Z"
        )
    }

    func testHoleLineCountsStrokesPuttsAndPenalties() throws {
        let card = Scorecard.build(
            holes: [hole(1, par: 4)],
            shots: [
                shot(hole: 1, order: 0),                       // drive
                shot(hole: 1, order: 1, penalties: 1),         // approach into water
                shot(hole: 1, order: 2),                       // drop-zone shot
                shot(hole: 1, order: 3, type: .putt),
                shot(hole: 1, order: 4, type: .putt),
            ]
        )
        let line = try XCTUnwrap(card.line(holeNumber: 1))
        XCTAssertEqual(line.strokes, 5)
        XCTAssertEqual(line.putts, 2)
        XCTAssertEqual(line.penalties, 1)
        XCTAssertEqual(line.score, 6, "score = strokes + penalty strokes")
        XCTAssertEqual(line.vsPar, 2)
    }

    func testUnplayedHolesAreExcludedFromVsPar() {
        let card = Scorecard.build(
            holes: [hole(1, par: 4), hole(2, par: 3)],
            shots: [
                shot(hole: 1, order: 0),
                shot(hole: 1, order: 1, type: .putt),
                shot(hole: 1, order: 2, type: .putt),          // par-4 in 3 → −1
            ]
        )
        XCTAssertEqual(card.line(holeNumber: 1)?.vsPar, -1)
        XCTAssertNil(card.line(holeNumber: 2)?.vsPar, "unplayed hole has no vs-par")
        XCTAssertEqual(card.total.holesPlayed, 1)
        XCTAssertEqual(card.total.vsPar, -1, "only played holes count toward the total")
        XCTAssertEqual(card.total.score, 3)
    }

    func testFrontBackAndTotalSplitAtHoleNine() {
        var holes: [HoleRecord] = []
        var shots: [ShotRecord] = []
        for number in 1...18 {
            holes.append(hole(number, par: 4))
            // Bogey golf: 4 strokes + 1 putt each hole.
            for order in 0..<4 { shots.append(shot(hole: number, order: order)) }
            shots.append(shot(hole: number, order: 4, type: .putt))
        }
        let card = Scorecard.build(holes: holes, shots: shots)
        XCTAssertEqual(card.front.holesPlayed, 9)
        XCTAssertEqual(card.front.score, 45)
        XCTAssertEqual(card.front.vsPar, 9)
        XCTAssertEqual(card.back.score, 45)
        XCTAssertEqual(card.total.score, 90)
        XCTAssertEqual(card.total.putts, 18)
        XCTAssertEqual(card.total.vsPar, 18)
    }

    func testEmptyRoundHasNoVsPar() {
        let card = Scorecard.build(holes: [hole(1, par: 4)], shots: [])
        XCTAssertNil(card.total.vsPar)
        XCTAssertEqual(card.total.score, 0)
        XCTAssertFalse(card.lines[0].played)
    }

    func testVsParFormatting() {
        XCTAssertEqual(Scorecard.formatVsPar(nil), "–")
        XCTAssertEqual(Scorecard.formatVsPar(0), "E")
        XCTAssertEqual(Scorecard.formatVsPar(3), "+3")
        XCTAssertEqual(Scorecard.formatVsPar(-2), "-2")
    }

    func testHolesSortByNumberRegardlessOfInputOrder() {
        let card = Scorecard.build(
            holes: [hole(3, par: 5), hole(1, par: 4), hole(2, par: 3)],
            shots: []
        )
        XCTAssertEqual(card.lines.map(\.holeNumber), [1, 2, 3])
        XCTAssertEqual(card.lines.map(\.par), [4, 3, 5])
    }
}
