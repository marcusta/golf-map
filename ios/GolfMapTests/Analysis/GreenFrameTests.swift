import XCTest
@testable import GolfMap

/// Exact-geometry tests for the green-local frame (spec §3): synthetic
/// polygons with hand-computed expected coordinates, both axis-aligned and
/// rotated, plus the laser-depth bisection and its clamp/mismatch flags.
final class GreenFrameTests: XCTestCase {

    /// 20 m wide × 30 m deep rectangle, front edge y=0, tee due south on the
    /// centre line → depth axis = north, lateral axis = east.
    private func rectangleFrame() -> GreenFrame {
        let ring = [
            Vec2(x: 0, y: 0), Vec2(x: 20, y: 0),
            Vec2(x: 20, y: 30), Vec2(x: 0, y: 30),
        ]
        let frame = GreenFrame(
            outerRing: ring,
            teePlanar: Vec2(x: 10, y: -100),
            greenCenterPlanar: Vec2(x: 10, y: 15)
        )
        return frame!
    }

    // MARK: - Frame construction

    func testRectangleFrameAxesAndExtents() {
        let frame = rectangleFrame()
        XCTAssertEqual(frame.depthM, 30, accuracy: 1e-9)
        XCTAssertEqual(frame.depthAxis.x, 0, accuracy: 1e-12)
        XCTAssertEqual(frame.depthAxis.y, 1, accuracy: 1e-12)
        // Facing north, the player's right is east.
        XCTAssertEqual(frame.lateralAxis.x, 1, accuracy: 1e-12)
        XCTAssertEqual(frame.lateralAxis.y, 0, accuracy: 1e-12)
        XCTAssertEqual(frame.width(atDepth: 15), 20, accuracy: 1e-9)
    }

    func testDegenerateInputsReturnNil() {
        let ring = [Vec2(x: 0, y: 0), Vec2(x: 20, y: 0), Vec2(x: 20, y: 30), Vec2(x: 0, y: 30)]
        XCTAssertNil(GreenFrame(
            outerRing: [Vec2(x: 0, y: 0), Vec2(x: 1, y: 1)],
            teePlanar: Vec2(x: 0, y: -100), greenCenterPlanar: Vec2(x: 0, y: 0)
        ))
        // Tee on top of the green centre: no line of play.
        XCTAssertNil(GreenFrame(
            outerRing: ring,
            teePlanar: Vec2(x: 10, y: 15), greenCenterPlanar: Vec2(x: 10, y: 15)
        ))
    }

    // MARK: - point(depthM:lateralFraction:)

    func testPointOnRectangle() {
        let frame = rectangleFrame()
        // Depth 10, quarter across from the left: x = 0 + 0.25·20 = 5, y = 10.
        let p = frame.point(depthM: 10, lateralFraction: 0.25)
        XCTAssertEqual(p.x, 5, accuracy: 1e-6)
        XCTAssertEqual(p.y, 10, accuracy: 1e-6)
        // Clamping: negative depth → front edge, fraction > 1 → right edge.
        let clamped = frame.point(depthM: -5, lateralFraction: 2)
        XCTAssertEqual(clamped.y, 0, accuracy: 1e-6)
        XCTAssertEqual(clamped.x, 20, accuracy: 1e-6)
    }

    func testTrapezoidWidthVariesWithDepth() {
        // Width 20 at the front tapering to 10 at the back.
        let ring = [
            Vec2(x: 0, y: 0), Vec2(x: 20, y: 0),
            Vec2(x: 15, y: 30), Vec2(x: 5, y: 30),
        ]
        let frame = GreenFrame(
            outerRing: ring,
            teePlanar: Vec2(x: 10, y: -100),
            greenCenterPlanar: Vec2(x: 10, y: 15)
        )!
        XCTAssertEqual(frame.width(atDepth: 0), 20, accuracy: 0.1)
        XCTAssertEqual(frame.width(atDepth: 15), 15, accuracy: 1e-6)
        XCTAssertEqual(frame.width(atDepth: 30), 10, accuracy: 0.1)
        // Left edge at depth 15 sits at x = 2.5.
        let p = frame.point(depthM: 15, lateralFraction: 0)
        XCTAssertEqual(p.x, 2.5, accuracy: 1e-6)
        XCTAssertEqual(p.y, 15, accuracy: 1e-6)
    }

    func testRotatedFrameRoundTrips() {
        // The same rectangle rotated 45°: build by rotating every input point;
        // frame-space queries must be rotation-invariant.
        func rot(_ v: Vec2) -> Vec2 {
            let c = (0.5 as Double).squareRoot()
            return Vec2(x: c * v.x - c * v.y, y: c * v.x + c * v.y)
        }
        let ring = [
            Vec2(x: 0, y: 0), Vec2(x: 20, y: 0),
            Vec2(x: 20, y: 30), Vec2(x: 0, y: 30),
        ].map(rot)
        let frame = GreenFrame(
            outerRing: ring,
            teePlanar: rot(Vec2(x: 10, y: -100)),
            greenCenterPlanar: rot(Vec2(x: 10, y: 15))
        )!
        XCTAssertEqual(frame.depthM, 30, accuracy: 1e-9)
        XCTAssertEqual(frame.width(atDepth: 15), 20, accuracy: 1e-9)
        let expected = rot(Vec2(x: 5, y: 10))
        let p = frame.point(depthM: 10, lateralFraction: 0.25)
        XCTAssertEqual(p.x, expected.x, accuracy: 1e-6)
        XCTAssertEqual(p.y, expected.y, accuracy: 1e-6)
    }

    func testKidneyGreenResolvesToOnSurfaceInterval() {
        // A notch cut into the right side at mid depth: the cross-section is
        // the on-surface span from the left edge to the notch tip (x = 12),
        // NOT the outer envelope — every lateral fraction must land on the
        // putting surface. The smaller-lobe case is covered by dragging in
        // the confirm UI.
        let ring = [
            Vec2(x: 0, y: 0), Vec2(x: 20, y: 0),
            Vec2(x: 20, y: 12), Vec2(x: 12, y: 15), Vec2(x: 20, y: 18),
            Vec2(x: 20, y: 30), Vec2(x: 0, y: 30),
        ]
        let frame = GreenFrame(
            outerRing: ring,
            teePlanar: Vec2(x: 10, y: -100),
            greenCenterPlanar: Vec2(x: 10, y: 15)
        )!
        XCTAssertEqual(frame.width(atDepth: 15), 12, accuracy: 1e-6)
        // Right edge at the notch depth = the notch tip, on the surface.
        let p = frame.point(depthM: 15, lateralFraction: 1)
        XCTAssertEqual(p.x, 12, accuracy: 1e-6)
    }

    func testTwoLobedCrossSectionPicksWiderLobe() {
        // A U-shaped green: a bay cut into the front edge (x 6…12, reaching
        // depth 20) splits shallow cross-sections into two lobes — left
        // x 0…6 (6 m), right x 12…20 (8 m). The lateral range must be the
        // wider right lobe, never a bridge across the bay (a fraction there
        // would place the pin off the surface).
        let ring = [
            Vec2(x: 0, y: 0), Vec2(x: 6, y: 0),
            Vec2(x: 6, y: 20), Vec2(x: 12, y: 20),
            Vec2(x: 12, y: 0), Vec2(x: 20, y: 0),
            Vec2(x: 20, y: 30), Vec2(x: 0, y: 30),
        ]
        let frame = GreenFrame(
            outerRing: ring,
            teePlanar: Vec2(x: 10, y: -100),
            greenCenterPlanar: Vec2(x: 10, y: 15)
        )!
        // Depth 10 crosses both bay walls: lateral (relative to the tee line
        // x = 10) crossings −10, −4, 2, 10 → intervals 6 m and 8 m wide.
        let range = frame.lateralRange(atDepth: 10)!
        XCTAssertEqual(range.left, 2, accuracy: 1e-6)
        XCTAssertEqual(range.right, 10, accuracy: 1e-6)
    }

    // MARK: - Laser depth solve

    func testLaserDepthOnCentreLine() {
        let frame = rectangleFrame()
        let origin = Vec2(x: 10, y: -100)
        // Front edge is 100 m out; 110 m ⇒ 10 m deep.
        let solved = frame.laserDepth(originPlanar: origin, distanceM: 110, lateralFraction: 0.5)
        XCTAssertEqual(solved.depthM, 10, accuracy: 0.01)
        XCTAssertFalse(solved.clamped)
    }

    func testLaserDepthOffCentre() {
        let frame = rectangleFrame()
        let origin = Vec2(x: 10, y: -100)
        // Target x = 5 (fraction 0.25): distance to depth 10 is
        // √(5² + 110²) = 110.1136…; the solve must invert that exactly.
        let d = (25.0 + 110.0 * 110.0).squareRoot()
        let solved = frame.laserDepth(originPlanar: origin, distanceM: d, lateralFraction: 0.25)
        XCTAssertEqual(solved.depthM, 10, accuracy: 0.01)
        XCTAssertFalse(solved.clamped)
    }

    func testLaserDepthClampsShortAndLong() {
        let frame = rectangleFrame()
        let origin = Vec2(x: 10, y: -100)
        let short = frame.laserDepth(originPlanar: origin, distanceM: 95, lateralFraction: 0.5)
        XCTAssertEqual(short.depthM, 0, accuracy: 1e-9)
        XCTAssertTrue(short.clamped)
        let long = frame.laserDepth(originPlanar: origin, distanceM: 140, lateralFraction: 0.5)
        XCTAssertEqual(long.depthM, 30, accuracy: 1e-9)
        XCTAssertTrue(long.clamped)
    }
}

/// PinPhrase → PinSpec resolution (spec §3.1) against the same synthetic
/// rectangle, covering every phrase mode and the clamp flags.
final class PinPlacementSolverTests: XCTestCase {

    private func rectangleFrame() -> GreenFrame {
        GreenFrame(
            outerRing: [
                Vec2(x: 0, y: 0), Vec2(x: 20, y: 0),
                Vec2(x: 20, y: 30), Vec2(x: 0, y: 30),
            ],
            teePlanar: Vec2(x: 10, y: -100),
            greenCenterPlanar: Vec2(x: 10, y: 15)
        )!
    }

    func testSheetResolvesBothAxes() {
        let r = PinPlacementSolver.resolve(
            phrase: .sheet(depthFromFrontM: 4, lateralFromLeftM: 5),
            frame: rectangleFrame(),
            originPlanar: nil
        )!
        XCTAssertEqual(r.spec.depthFromFrontM, 4, accuracy: 1e-9)
        XCTAssertEqual(r.spec.lateralFraction, 0.25, accuracy: 1e-6)
        XCTAssertEqual(r.spec.source, .sheet)
        XCTAssertFalse(r.clamped)
    }

    func testSheetClampsBeyondGreen() {
        let r = PinPlacementSolver.resolve(
            phrase: .sheet(depthFromFrontM: 35, lateralFromLeftM: 25),
            frame: rectangleFrame(),
            originPlanar: nil
        )!
        XCTAssertEqual(r.spec.depthFromFrontM, 30, accuracy: 1e-9)
        XCTAssertEqual(r.spec.lateralFraction, 1, accuracy: 1e-9)
        XCTAssertTrue(r.clamped)
    }

    func testLaserResolvesDepthAndDefaultsLateralToMiddle() {
        let r = PinPlacementSolver.resolve(
            phrase: .laser(distanceM: 110, lateralFraction: nil),
            frame: rectangleFrame(),
            originPlanar: Vec2(x: 10, y: -100)
        )!
        XCTAssertEqual(r.spec.depthFromFrontM, 10, accuracy: 0.01)
        XCTAssertEqual(r.spec.lateralFraction, PinWordFractions.middle, accuracy: 1e-9)
        XCTAssertEqual(r.spec.source, .laser)
    }

    func testLaserWithoutOriginReturnsNil() {
        XCTAssertNil(PinPlacementSolver.resolve(
            phrase: .laser(distanceM: 110, lateralFraction: nil),
            frame: rectangleFrame(),
            originPlanar: nil
        ))
    }

    func testLaserMismatchSetsClampedFlag() {
        let r = PinPlacementSolver.resolve(
            phrase: .laser(distanceM: 95, lateralFraction: PinWordFractions.far),
            frame: rectangleFrame(),
            originPlanar: Vec2(x: 10, y: -100)
        )!
        XCTAssertEqual(r.spec.depthFromFrontM, 0, accuracy: 1e-9)
        XCTAssertTrue(r.clamped)
    }

    func testVisualMapsFractions() {
        let r = PinPlacementSolver.resolve(
            phrase: .visual(
                depthFraction: PinWordFractions.farEdge,
                lateralFraction: PinWordFractions.nearEdge
            ),
            frame: rectangleFrame(),
            originPlanar: nil
        )!
        XCTAssertEqual(r.spec.depthFromFrontM, 0.95 * 30, accuracy: 1e-9)
        XCTAssertEqual(r.spec.lateralFraction, 0.05, accuracy: 1e-9)
        XCTAssertEqual(r.spec.source, .visual)
    }

    func testHybridExactDepthWordLateral() {
        let r = PinPlacementSolver.resolve(
            phrase: .hybrid(depthFromFrontM: 6, lateralFraction: 0.675),
            frame: rectangleFrame(),
            originPlanar: nil
        )!
        XCTAssertEqual(r.spec.depthFromFrontM, 6, accuracy: 1e-9)
        XCTAssertEqual(r.spec.lateralFraction, 0.675, accuracy: 1e-9)
        XCTAssertEqual(r.spec.source, .sheet)
        XCTAssertFalse(r.clamped)
    }

    func testPinWGS84RoundTripsThroughProjection() {
        // Build a frame around a real-world green (Sweref planar), place the
        // pin, and verify the WGS84 result projects back onto the frame point.
        let center = Sweref99TM.fromWGS84(LatLon(lat: 58.41, lon: 15.62))
        let ring = [
            Vec2(x: center.x - 10, y: center.y - 15), Vec2(x: center.x + 10, y: center.y - 15),
            Vec2(x: center.x + 10, y: center.y + 15), Vec2(x: center.x - 10, y: center.y + 15),
        ]
        let frame = GreenFrame(
            outerRing: ring,
            teePlanar: Vec2(x: center.x, y: center.y - 120),
            greenCenterPlanar: Vec2(x: center.x, y: center.y)
        )!
        let spec = PinSpec(depthFromFrontM: 12, lateralFraction: 0.3, source: .sheet)
        let pin = PinPlacementSolver.pinWGS84(spec: spec, frame: frame)
        let back = Sweref99TM.fromWGS84(pin)
        let expected = frame.point(depthM: 12, lateralFraction: 0.3)
        XCTAssertEqual(back.x, expected.x, accuracy: 0.01)
        XCTAssertEqual(back.y, expected.y, accuracy: 0.01)
    }
}
