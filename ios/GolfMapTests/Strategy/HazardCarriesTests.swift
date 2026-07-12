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
}
