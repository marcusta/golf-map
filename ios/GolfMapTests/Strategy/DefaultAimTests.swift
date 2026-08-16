import XCTest
@testable import GolfMap

/// D-HF1/D-HF2 golden cases (docs/feature-hole-select-framing.md): default
/// aim resolution per hole class — pure planar geometry, identity plays-like
/// unless the case is about the plays-like clamp. Floating-point assertions
/// are accuracy-based (macOS libm may differ in the last ulps).
final class DefaultAimTests: XCTestCase {

    private let origin = Vec2(x: 0, y: 0)

    /// Axis-aligned rectangle ring (CCW, implicitly closed).
    private func rect(_ minX: Double, _ minY: Double, _ maxX: Double, _ maxY: Double) -> [Vec2] {
        [
            Vec2(x: minX, y: minY), Vec2(x: maxX, y: minY),
            Vec2(x: maxX, y: maxY), Vec2(x: minX, y: maxY),
        ]
    }

    private func input(
        green: Vec2,
        fairways: [[Vec2]] = [],
        aimPoints: [Vec2] = [],
        planLanding: Vec2? = nil,
        longestCarryM: Double = 220,
        dispersion: @escaping (Double) -> Double = { _ in 30 },
        playsLike: ((Vec2) -> Double)? = nil
    ) -> DefaultAim.Input {
        let o = origin
        return DefaultAim.Input(
            origin: o,
            greenCenter: green,
            fairways: fairways,
            aimPoints: aimPoints,
            planLanding: planLanding,
            longestCarryM: longestCarryM,
            lateralDispersionM: dispersion,
            playsLikeM: playsLike ?? { p in hypot(p.x - o.x, p.y - o.y) }
        )
    }

    // MARK: - D-HF1 resolution order

    func testShortPar3GreenWithinCarryAimsAtGreenCenter() {
        let green = Vec2(x: 0, y: 150)
        let aim = DefaultAim.resolve(input(green: green))
        XCTAssertEqual(aim.x, green.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, green.y, accuracy: 1e-9)
    }

    func testPlanLandingWinsEvenWhenGreenIsReachable() {
        let plan = Vec2(x: 12, y: 205)
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 180), // reachable — plan still wins (rule 1)
            fairways: [rect(-30, 40, 30, 350)],
            planLanding: plan
        ))
        XCTAssertEqual(aim.x, plan.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, plan.y, accuracy: 1e-9)
    }

    func testEmptyBagDefaultsToGreenCenterUnclamped() {
        let green = Vec2(x: 0, y: 400)
        let aim = DefaultAim.resolve(input(green: green, longestCarryM: 0))
        XCTAssertEqual(aim.x, green.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, green.y, accuracy: 1e-9)
    }

    // MARK: - D-HF1 rule 2: curated furniture aim points

    func testFurnitureAimPointBeatsTheRingWalk() {
        // The ring walk would land at (0, 220) in the centered fairway; the
        // curated aim point (off the chord — a dogleg line) must win.
        let aimPoint = Vec2(x: 40, y: 200)
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            fairways: [rect(-30, 40, 30, 380)],
            aimPoints: [aimPoint]
        ))
        XCTAssertEqual(aim.x, aimPoint.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, aimPoint.y, accuracy: 1e-9)
    }

    func testFarthestReachableAimPointWins() {
        // Two curated points within the 220 carry: pick the one nearest
        // AT-OR-BELOW the carry (the farthest reachable), not the first.
        let far = Vec2(x: 40, y: 200)
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            aimPoints: [Vec2(x: 0, y: 100), far]
        ))
        XCTAssertEqual(aim.x, far.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, far.y, accuracy: 1e-9)
    }

    func testAimPointsBeyondCarryFallBackAlongFirstAimBearing() {
        // Single curated point 300 m out (beyond the 220 carry): the aim is
        // the longest carry along the origin -> FIRST-aim bearing — the
        // curated direction, not the origin -> green chord.
        let aimPoint = Vec2(x: 150, y: 260) // raw ~300.17 (identity plays-like)
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            aimPoints: [aimPoint]
        ))
        let scale = 220.0 / hypot(aimPoint.x, aimPoint.y)
        XCTAssertEqual(aim.x, aimPoint.x * scale, accuracy: 1e-6)
        XCTAssertEqual(aim.y, aimPoint.y * scale, accuracy: 1e-6)
    }

    func testReachableAimPointWinsOverReachableGreen() {
        // Green plays 180 (reachable) but a curated aim point exists: the
        // curated line wins (rule 2 sits above the green clamp).
        let aimPoint = Vec2(x: 30, y: 150)
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 180),
            aimPoints: [aimPoint]
        ))
        XCTAssertEqual(aim.x, aimPoint.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, aimPoint.y, accuracy: 1e-9)
    }

    // MARK: - D-HF2 ring walk

    func testLongHoleCleanFairwayLandsAtCarryFairwayCentered() {
        // Fairway band offset laterally (x in -10...50): the aim must be the
        // arc-segment MIDPOINT — middle of the fairway, not on the green line.
        let carry = 220.0
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            fairways: [rect(-10, 40, 50, 380)],
            longestCarryM: carry
        ))
        // Independent derivation: boundary offsets are where the circle
        // crosses x = -10 and x = 50; midpoint bearing between them.
        let d1 = asin(-10.0 / carry)
        let d2 = asin(50.0 / carry)
        let mid = (d1 + d2) / 2
        XCTAssertEqual(aim.x, carry * sin(mid), accuracy: 1e-6)
        XCTAssertEqual(aim.y, carry * cos(mid), accuracy: 1e-6)
        XCTAssertEqual(hypot(aim.x, aim.y), carry, accuracy: 1e-6, "first ring wins — no step-down")
    }

    func testDoglegStepsDownToTheCorner() {
        // Fairway ends at y = 158 (the corner): rings at 220...160 miss it
        // (the circle only meets |x| <= 25 at y >= 158.03); 155 is the first
        // ring with a passing arc — centered on the line.
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            fairways: [rect(-25, 40, 25, 158)]
        ))
        XCTAssertEqual(aim.x, 0, accuracy: 1e-6)
        XCTAssertEqual(aim.y, 155, accuracy: 1e-6)
    }

    func testSliverFairwayFailsWidthGateAndStepsDown() {
        // A 8 m-wide sliver spans the long rings (arc ~8 m < 30 m gate); the
        // wide fairway below it is the first landable cross-section at 165.
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            fairways: [
                rect(-4, 175, 4, 300), // sliver: hit first, never wide enough
                rect(-40, 100, 40, 168), // wide: first full containment at 165
            ]
        ))
        XCTAssertEqual(aim.x, 0, accuracy: 1e-6)
        XCTAssertEqual(aim.y, 165, accuracy: 1e-6)
    }

    func testSegmentClosestToGreenLineWinsOverOffLineSegment() {
        // Two fairways cross the full-carry ring; the aim must sit in the one
        // whose arc midpoint is nearest the origin -> green-center line.
        let aim = DefaultAim.resolve(input(
            green: Vec2(x: 0, y: 400),
            fairways: [
                rect(60, 150, 140, 260), // off-line, also intersects r=220
                rect(-30, 210, 30, 260), // centered on the line
            ]
        ))
        XCTAssertEqual(aim.x, 0, accuracy: 1e-6)
        XCTAssertEqual(aim.y, 220, accuracy: 1e-6)
    }

    func testNoFairwayDataFallsBackToBearingAtLongestCarry() {
        let aim = DefaultAim.resolve(input(green: Vec2(x: 300, y: 400)))
        // Along the origin -> green bearing, at the longest carry.
        let scale = 220.0 / 500.0
        XCTAssertEqual(aim.x, 300 * scale, accuracy: 1e-6)
        XCTAssertEqual(aim.y, 400 * scale, accuracy: 1e-6)
    }

    // MARK: - Plays-like clamp (D-HF1 rule 3)

    func testClampUsesPlaysLikeNotHorizontal() {
        // 210 m horizontal but plays 241.5 uphill: within carry horizontally,
        // beyond it plays-like -> NOT the green center.
        let uphill: (Vec2) -> Double = { p in hypot(p.x, p.y) * 1.15 }
        let green = Vec2(x: 0, y: 210)
        let aim = DefaultAim.resolve(input(
            green: green,
            fairways: [rect(-40, 40, 40, 205)],
            playsLike: uphill
        ))
        XCTAssertNotEqual(aim.y, green.y, accuracy: 0.5,
                          "horizontal clamp would have aimed at the green")
        // Ring radii are ground distances that PLAY like the walked carry:
        // first ring = 220 plays-like -> 220 / 1.15 ground meters.
        XCTAssertEqual(aim.x, 0, accuracy: 1e-6)
        XCTAssertEqual(aim.y, 220 / 1.15, accuracy: 1e-6)
    }

    func testDownhillPlaysLikeUnlocksGreenCenter() {
        // 240 m horizontal playing 216 downhill: the green IS the default.
        let green = Vec2(x: 0, y: 240)
        let aim = DefaultAim.resolve(input(
            green: green,
            playsLike: { p in hypot(p.x, p.y) * 0.9 }
        ))
        XCTAssertEqual(aim.x, green.x, accuracy: 1e-9)
        XCTAssertEqual(aim.y, green.y, accuracy: 1e-9)
    }
}
