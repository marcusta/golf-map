import XCTest
@testable import GolfMap

/// Hazard-carry row assembly (Part A) — pure planar geometry over
/// `HazardCarries.along`: rings the primary line crosses become front/carry
/// rows, non-crossing rings contribute nothing, and the nearest-ahead cap +
/// ordering hold. These are RAW measured distances (no plays-like / wind), so
/// they are never competition-gated (see `HazardCarriesCompetitionTests`).
final class HazardCarriesTests: XCTestCase {

    /// Axis-aligned rectangle ring, same winding as the golden generator.
    private func box(_ minX: Double, _ minY: Double, _ maxX: Double, _ maxY: Double,
                     _ kind: String = "bunker") -> FlatRing {
        FlatRing(
            points: [
                Vec2(x: minX, y: minY),
                Vec2(x: maxX, y: minY),
                Vec2(x: maxX, y: maxY),
                Vec2(x: minX, y: maxY),
            ],
            kind: kind
        )
    }

    // Playing due north: origin (0,0) → target (0,100).
    private let origin = Vec2(x: 0, y: 0)
    private let target = Vec2(x: 0, y: 100)

    func testRingCrossingTheLineBecomesAFrontCarryRow() {
        let rows = HazardCarries.along(
            origin: origin, target: target, hazards: [box(-5, 50, 5, 60, "water")]
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].label, "Water")
        XCTAssertEqual(rows[0].kind, "water")
        XCTAssertEqual(rows[0].frontM, 50)
        XCTAssertEqual(rows[0].carryM, 60)
    }

    func testRingBesideTheLineIsOmitted() {
        // A bunker off to the east, never crossed by the northbound line.
        let rows = HazardCarries.along(
            origin: origin, target: target, hazards: [box(20, 50, 30, 60)]
        )
        XCTAssertTrue(rows.isEmpty)
    }

    func testRingBeyondTheTargetIsOmitted() {
        // The line is capped at the target distance (100 m); a hazard past the
        // green (y ≥ 120) is not a carry to reach the target.
        let rows = HazardCarries.along(
            origin: origin, target: target, hazards: [box(-5, 120, 5, 130)]
        )
        XCTAssertTrue(rows.isEmpty)
    }

    func testNearestFirstOrderingAndCap() {
        let far = box(-5, 80, 5, 85, "bunker")
        let near = box(-5, 20, 5, 25, "water")
        let mid = box(-5, 50, 5, 55, "bunker")
        let rows = HazardCarries.along(
            origin: origin, target: target, hazards: [far, near, mid], cap: 2
        )
        // Sorted by front distance; capped to the two nearest ahead.
        XCTAssertEqual(rows.map(\.frontM), [20, 50])
        XCTAssertEqual(rows.map(\.label), ["Water", "Bunker"])
    }

    func testNoHazardsNoRows() {
        XCTAssertTrue(HazardCarries.along(origin: origin, target: target, hazards: []).isEmpty)
    }

    func testDegenerateLineNoRows() {
        // origin == target → no line to cast.
        let rows = HazardCarries.along(
            origin: origin, target: origin, hazards: [box(-5, 50, 5, 60)]
        )
        XCTAssertTrue(rows.isEmpty)
    }

    // MARK: - nearLine (corridor variant: off-line hazards get in, with a side)

    func testNearLineCrossedRingIsOnLine() {
        let rows = HazardCarries.nearLine(
            origin: origin, target: target, hazards: [box(-5, 50, 5, 60, "water")]
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].side, .onLine)
        XCTAssertEqual(rows[0].displayLabel, "Water")
        XCTAssertEqual(rows[0].frontM, 50)
        XCTAssertEqual(rows[0].carryM, 60)
    }

    func testNearLineOffsetBunkerIsIncludedWithSide() {
        // A fairway bunker a bit EAST of the northbound line (10–25 m off) — the
        // ray never crosses it, but it's within the corridor → included, right.
        let rows = HazardCarries.nearLine(
            origin: origin, target: target, hazards: [box(10, 40, 25, 55)]
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].side, .right)
        XCTAssertEqual(rows[0].displayLabel, "R Bunker")
        XCTAssertEqual(rows[0].frontM, 40) // near along-line edge
        XCTAssertEqual(rows[0].carryM, 55) // far along-line edge
        // Centroid focuses the actual bunker, not a point on the line.
        XCTAssertEqual(rows[0].centroid.x, 17.5, accuracy: 1e-9)
        XCTAssertEqual(rows[0].centroid.y, 47.5, accuracy: 1e-9)
    }

    func testNearLineWestBunkerIsLeft() {
        let rows = HazardCarries.nearLine(
            origin: origin, target: target, hazards: [box(-25, 40, -10, 55)]
        )
        XCTAssertEqual(rows.first?.side, .left)
        XCTAssertEqual(rows.first?.displayLabel, "L Bunker")
    }

    func testNearLineBeyondCorridorIsExcluded() {
        // 50 m off the line, corridor half-width 35 → dropped.
        let rows = HazardCarries.nearLine(
            origin: origin, target: target, hazards: [box(50, 40, 60, 55)],
            corridorHalfWidthM: 35
        )
        XCTAssertTrue(rows.isEmpty)
    }

    func testNearLinePastTargetIsExcluded() {
        let rows = HazardCarries.nearLine(
            origin: origin, target: target, hazards: [box(10, 120, 25, 130)]
        )
        XCTAssertTrue(rows.isEmpty)
    }

    // MARK: - nearLines (two-line: routed dogleg + direct cut)

    // Sharp dogleg east: routed bends through (60,50); direct is straight north.
    private var directLine: [Vec2] { [Vec2(x: 0, y: 0), Vec2(x: 0, y: 100)] }
    private var routedLine: [Vec2] { [Vec2(x: 0, y: 0), Vec2(x: 60, y: 50), Vec2(x: 0, y: 100)] }

    func testNearLinesRoutedLineAddsDoglegHazard() {
        let apex = box(54, 44, 66, 56) // centroid (60,50) — at the dogleg apex
        XCTAssertTrue(HazardCarries.nearLines([directLine], hazards: [apex]).isEmpty,
                      "60 m off the direct line")
        XCTAssertEqual(HazardCarries.nearLines([routedLine, directLine], hazards: [apex]).count, 1,
                       "but it sits on the routed line → in play")
    }

    func testNearLinesDirectLineAddsCornerCutHazard() {
        let corner = box(-6, 44, 6, 56) // centroid (0,50) — on the straight cut
        XCTAssertTrue(HazardCarries.nearLines([routedLine], hazards: [corner]).isEmpty,
                      "~38 m off the routed line")
        XCTAssertEqual(HazardCarries.nearLines([routedLine, directLine], hazards: [corner]).count, 1,
                       "but it sits on the direct cut line → in play")
    }

    func testNearLineExtraAheadIncludesGreensideBunker() {
        // A bunker just past the green centre (105–115 m vs a 100 m target) is
        // dropped by default but caught with a margin — greenside bunkers sit
        // around/behind the centre.
        let box = box(-5, 105, 5, 115)
        XCTAssertTrue(HazardCarries.nearLine(origin: origin, target: target, hazards: [box]).isEmpty)
        let rows = HazardCarries.nearLine(origin: origin, target: target, hazards: [box], extraAheadM: 40)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].side, .onLine)
    }

    // MARK: - extent(of:along:) — the tap-a-shape readout

    func testExtentOnLineRingReportsChainageWindow() {
        let line = [Vec2(x: 0, y: 0), Vec2(x: 0, y: 300)]
        let extent = HazardCarries.extent(of: box(-10, 120, 10, 150), along: [line])
        XCTAssertEqual(extent?.carry.frontM, 120)
        XCTAssertEqual(extent?.carry.carryM, 150)
        XCTAssertEqual(extent?.carry.side, .onLine)
        // Edge points sit ON the play line at the two chainages.
        XCTAssertEqual(extent?.frontPoint.y ?? -1, 120, accuracy: 1e-9)
        XCTAssertEqual(extent?.carryPoint.y ?? -1, 150, accuracy: 1e-9)
        XCTAssertEqual(extent?.frontPoint.x ?? -1, 0, accuracy: 1e-9)
    }

    func testExtentSideRingIsNeverCorridorFiltered() {
        // 30–50 m right of the line — nearLines would drop it at the default
        // corridor, but a tapped shape always answers.
        let line = [Vec2(x: 0, y: 0), Vec2(x: 0, y: 300)]
        let extent = HazardCarries.extent(of: box(30, 80, 50, 110), along: [line])
        XCTAssertEqual(extent?.carry.frontM, 80)
        XCTAssertEqual(extent?.carry.carryM, 110)
        XCTAssertEqual(extent?.carry.side, .right)
    }

    func testExtentRingPastTheLineEndStillMeasures() {
        // Past the target (no ahead-gate for an explicit tap).
        let line = [Vec2(x: 0, y: 0), Vec2(x: 0, y: 100)]
        let extent = HazardCarries.extent(of: box(-5, 130, 5, 160), along: [line])
        XCTAssertEqual(extent?.carry.frontM, 130)
        XCTAssertEqual(extent?.carry.carryM, 160)
        // Edge points extrapolate along the last segment past the line end.
        XCTAssertEqual(extent?.frontPoint.y ?? -1, 130, accuracy: 1e-9)
        XCTAssertEqual(extent?.carryPoint.y ?? -1, 160, accuracy: 1e-9)
    }

    func testExtentRingBehindOriginReturnsNilAndStraddleClampsFront() {
        let line = [Vec2(x: 0, y: 0), Vec2(x: 0, y: 300)]
        XCTAssertNil(HazardCarries.extent(of: box(-5, -80, 5, -40), along: [line]))
        let straddling = HazardCarries.extent(of: box(-5, -20, 5, 30), along: [line])
        XCTAssertEqual(straddling?.carry.frontM, 0)
        XCTAssertEqual(straddling?.carry.carryM, 30)
    }

    func testExtentFromRayReportsEntryExitOnTheRingLips() {
        // Tap the middle of a bunker due north: entry 120, exit 150, points
        // ON the ring boundary, no side tag (the ray points at the shape).
        let extent = HazardCarries.extent(
            of: box(-10, 120, 10, 150), fromRay: Vec2(x: 0, y: 0), through: Vec2(x: 0, y: 135)
        )
        XCTAssertEqual(extent?.carry.frontM, 120)
        XCTAssertEqual(extent?.carry.carryM, 150)
        XCTAssertEqual(extent?.carry.side, .onLine)
        XCTAssertEqual(extent?.frontPoint.y ?? -1, 120, accuracy: 1e-9)
        XCTAssertEqual(extent?.carryPoint.y ?? -1, 150, accuracy: 1e-9)
    }

    func testExtentFromRayOffAxisShapeAndInsideOrigin() {
        // Off to the north-east: measured along the diagonal ray at it.
        let diagonal = HazardCarries.extent(
            of: box(90, 90, 110, 110), fromRay: Vec2(x: 0, y: 0), through: Vec2(x: 100, y: 100)
        )
        XCTAssertEqual(Double(diagonal?.carry.frontM ?? -1), (90.0 * 90 + 90 * 90).squareRoot(), accuracy: 1)
        XCTAssertEqual(Double(diagonal?.carry.carryM ?? -1), (110.0 * 110 + 110 * 110).squareRoot(), accuracy: 1)

        // Standing inside the ring: front 0 at the origin, carry = the exit.
        let inside = HazardCarries.extent(
            of: box(-10, -10, 10, 30), fromRay: Vec2(x: 0, y: 5), through: Vec2(x: 0, y: 20)
        )
        XCTAssertEqual(inside?.carry.frontM, 0)
        XCTAssertEqual(inside?.carry.carryM, 25)
        XCTAssertEqual(inside?.frontPoint.y ?? -1, 5, accuracy: 1e-9)

        // Degenerate ray (origin == through) → nil.
        XCTAssertNil(HazardCarries.extent(
            of: box(-5, 10, 5, 20), fromRay: Vec2(x: 0, y: 0), through: Vec2(x: 0, y: 0)
        ))
    }

    func testExtentMeasuresAlongNearestOfSeveralLines() {
        // Dogleg: routed line turns east at (0, 100); direct line cuts the
        // corner. A ring on the second routed leg measures 100 + 50..70.
        let routed = [Vec2(x: 0, y: 0), Vec2(x: 0, y: 100), Vec2(x: 200, y: 100)]
        let direct = [Vec2(x: 0, y: 0), Vec2(x: 200, y: 100)]
        let extent = HazardCarries.extent(of: box(50, 95, 70, 105), along: [routed, direct])
        XCTAssertEqual(extent?.carry.frontM, 150)
        XCTAssertEqual(extent?.carry.carryM, 170)
        XCTAssertEqual(extent?.carry.side, .onLine)
        // Edge points sit on the routed second leg, past the corner.
        XCTAssertEqual(extent?.frontPoint.x ?? -1, 50, accuracy: 1e-9)
        XCTAssertEqual(extent?.frontPoint.y ?? -1, 100, accuracy: 1e-9)
        XCTAssertEqual(extent?.carryPoint.x ?? -1, 70, accuracy: 1e-9)
    }
}
