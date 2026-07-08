import XCTest
@testable import GolfMap

/// Pure-geometry tests for the putt-read helpers: the Tour Read input
/// derivation (parity with `web/src/planner/putt-read.service.ts`
/// `deriveTourReadGroundTruth` semantics, asserted on analytic planes) and
/// the map-overlay projection (aim point formula, marker/reference presence).
final class PuttReadGeometryTests: XCTestCase {

    private let ball = Vec2(x: 0, y: 0)
    private let hole10N = Vec2(x: 0, y: 10) // 10 m putt due north

    // MARK: - deriveTourReadInputs

    func testCrossSlopePlaneDerivesSlopeAndBreakSide() throws {
        // 2% downhill toward EAST; putt due north → falls right, no grade.
        let surface = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90)
        let inputs = try XCTUnwrap(
            PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: hole10N)
        )
        XCTAssertEqual(inputs.distanceM, 10, accuracy: 1e-12)
        XCTAssertEqual(inputs.slopePct, 2, accuracy: 1e-9)
        XCTAssertTrue(inputs.breakToRight)
        XCTAssertEqual(inputs.gradeDeltaM, 0, accuracy: 1e-9)
    }

    func testCrossSlopeWestFallLineBreaksLeft() throws {
        let surface = PlaneSurface(slopePct: 3, fallLineBearingDeg: 270)
        let inputs = try XCTUnwrap(
            PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: hole10N)
        )
        XCTAssertEqual(inputs.slopePct, 3, accuracy: 1e-9)
        XCTAssertFalse(inputs.breakToRight)
    }

    func testDownhillPlaneDerivesNegativeGradeAndZeroCross() throws {
        // Falls due NORTH: the north putt is straight downhill, no cross-slope.
        let surface = PlaneSurface(slopePct: 2, fallLineBearingDeg: 0)
        let inputs = try XCTUnwrap(
            PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: hole10N)
        )
        XCTAssertEqual(inputs.gradeDeltaM, -0.2, accuracy: 1e-9)
        XCTAssertEqual(inputs.slopePct, 0, accuracy: 1e-9)
    }

    func testDerivationMatchesTourReadAssembly() throws {
        let surface = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90)
        let derived = try XCTUnwrap(
            PuttReadGeometry.deriveTourRead(
                surface: surface, ball: ball, hole: hole10N, stimpFt: 10
            )
        )
        let inputs = try XCTUnwrap(
            PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: hole10N)
        )
        let direct = tourRead(
            distanceM: inputs.distanceM,
            gradeDeltaM: inputs.gradeDeltaM,
            slopePct: inputs.slopePct,
            stimpFt: 10,
            breakToRight: inputs.breakToRight
        )
        XCTAssertEqual(derived, direct)
    }

    func testOffCoverageBallReturnsNil() {
        struct NoSurface: GreenSurface {
            func sampleAt(_ p: Vec2) -> SurfaceSample? { nil }
        }
        XCTAssertNil(
            PuttReadGeometry.deriveTourReadInputs(
                surface: NoSurface(), ball: ball, hole: hole10N
            )
        )
    }

    func testZeroLengthPuttReturnsNil() {
        let surface = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90)
        XCTAssertNil(
            PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: ball)
        )
    }

    func testMidLineCoverageGapIsSkippedNotFatal() throws {
        // Plane with a hole in coverage mid-line; ball/hole ends covered.
        struct Gappy: GreenSurface {
            let inner = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90)
            func sampleAt(_ p: Vec2) -> SurfaceSample? {
                (p.y > 4 && p.y < 6) ? nil : inner.sampleAt(p)
            }
        }
        let inputs = try XCTUnwrap(
            PuttReadGeometry.deriveTourReadInputs(surface: Gappy(), ball: ball, hole: hole10N)
        )
        // Remaining samples still read the plane's uniform cross-slope.
        XCTAssertEqual(inputs.slopePct, 2, accuracy: 1e-9)
    }

    // MARK: - Overlay projection

    /// A minimal settled read for projection tests (internal memberwise init).
    private func syntheticRead(aimBearingDeg: Double) -> PuttRead {
        PuttRead(
            availability: .ok,
            aimBearingDeg: aimBearingDeg,
            aimOffsetM: 0.5,
            initialSpeedMps: 2,
            playsLikeM: 10,
            holedProb: 0.3,
            canStop: true,
            holed: false,
            path: [Vec2(x: 0, y: 0), Vec2(x: 0.1, y: 5), Vec2(x: 0, y: 10)],
            stopPoint: Vec2(x: 0, y: 10.3),
            restBeyondHoleM: 0.3,
            minConfidence: 0.45
        )
    }

    /// EPSG:3006 coordinates for the projection tests — mid-Sweden so the
    /// WGS84 round-trip is well-conditioned (same fixture spirit as
    /// AnalysisOverlayGeometryTests).
    private let ballE = Vec2(x: 538_000, y: 6_480_000)
    private var holeE: Vec2 { Vec2(x: 538_000, y: 6_480_010) }

    func testOverlayWithReadCarriesPathReferenceMarkersAndAim() {
        let overlay = PuttReadGeometry.overlay(
            ball: ballE, hole: holeE, read: syntheticRead(aimBearingDeg: 0), soft: true
        )
        XCTAssertEqual(overlay.path.count, 3)
        XCTAssertEqual(overlay.reference.count, 2)
        XCTAssertNotNil(overlay.ball)
        XCTAssertNotNil(overlay.hole)
        XCTAssertNotNil(overlay.aim)
        XCTAssertTrue(overlay.soft)
    }

    func testAimPointIsStartBearingCarriedToHoleRange() throws {
        // Aim 10° left of due north from the ball, range 10 m (web formula:
        // ball + bearingUnitVector × range).
        let read = syntheticRead(aimBearingDeg: -10)
        let aim = try XCTUnwrap(
            PuttReadGeometry.aimPoint(ball: ballE, hole: holeE, read: read)
        )
        let dir = bearingToUnitVector(-10)
        XCTAssertEqual(aim.x, ballE.x + dir.x * 10, accuracy: 1e-9)
        XCTAssertEqual(aim.y, ballE.y + dir.y * 10, accuracy: 1e-9)
        // Sanity: aim sits LEFT (west) of the hole.
        XCTAssertLessThan(aim.x, holeE.x)
    }

    func testOverlayWithoutReadKeepsMarkersAndReferenceOnly() {
        let overlay = PuttReadGeometry.overlay(ball: ballE, hole: holeE, read: nil, soft: false)
        XCTAssertTrue(overlay.path.isEmpty)
        XCTAssertNil(overlay.aim)
        XCTAssertEqual(overlay.reference.count, 2)
        XCTAssertNotNil(overlay.ball)
        XCTAssertNotNil(overlay.hole)
    }

    func testOverlayUnavailableReadDropsPathAndAim() {
        var read = syntheticRead(aimBearingDeg: 0)
        read.availability = .unavailable
        let overlay = PuttReadGeometry.overlay(ball: ballE, hole: holeE, read: read, soft: false)
        XCTAssertTrue(overlay.path.isEmpty)
        XCTAssertNil(overlay.aim)
        XCTAssertNotNil(overlay.ball)
    }

    func testOverlayHoleOnlyBeforeBallPlaced() {
        let overlay = PuttReadGeometry.overlay(ball: nil, hole: holeE, read: nil, soft: false)
        XCTAssertNil(overlay.ball)
        XCTAssertNotNil(overlay.hole)
        XCTAssertTrue(overlay.reference.isEmpty)
        XCTAssertTrue(overlay.path.isEmpty)
    }
}
