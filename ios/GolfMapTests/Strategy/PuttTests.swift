import XCTest
@testable import GolfMap

/// Port of `shared/strategy/putting/putt.test.ts` — the golden-putt suite
/// for the exact-tier integrator (doc §7 Phase A): flat, single-plane
/// cross-slope at 3 stimps, uphill/downhill pace and break ordering,
/// double-breaker, can't-stop downhill, determinism, and off-coverage
/// degradation. The tunable constants in Putt.swift are NOT yet empirically
/// calibrated (doc §9 Q2), so these tests assert structure, ordering and
/// generous tolerances — never exact real-world break values. Bit-level
/// TS parity is covered separately by PuttingGoldenParityTests.
final class PuttTests: XCTestCase {

    private static let ball = Vec2(x: 0, y: 0)
    private static let hole10m = Vec2(x: 0, y: 10) // straight putt due north

    /// Smooth analytic double-breaker: h = a·x·(y − midY). Cross-slope along
    /// the x=0 line is a·(y − midY) — one way before midY, the other after.
    private struct DoubleBreaker: GreenSurface {
        let a: Double
        let midY: Double

        func sampleAt(_ p: Vec2) -> SurfaceSample? {
            SurfaceSample(
                height: a * p.x * (p.y - midY),
                gradX: a * (p.y - midY),
                gradY: a * p.x,
                confidence: 1
            )
        }
    }

    /// Coverage mask: inner surface, but nil where the predicate says so.
    private struct Masked<Inner: GreenSurface>: GreenSurface {
        let inner: Inner
        let covered: @Sendable (Vec2) -> Bool

        func sampleAt(_ p: Vec2) -> SurfaceSample? {
            covered(p) ? inner.sampleAt(p) : nil
        }
    }

    // MARK: - flat putt

    private static let flatRead = readPutt(
        surface: PlaneSurface(slopePct: 0, fallLineBearingDeg: 0),
        ball: ball, hole: hole10m, stimpFt: 10
    )

    func testFlatIsAvailableHoledAndCanStop() {
        let read = Self.flatRead
        XCTAssertEqual(read.availability, .ok)
        XCTAssertTrue(read.holed)
        XCTAssertTrue(read.canStop)
        XCTAssertEqual(read.minConfidence, 1)
        XCTAssertGreaterThan(read.holedProb, 0)
    }

    func testFlatZeroBreakStraightAimStraightPath() {
        let read = Self.flatRead
        XCTAssertLessThan(abs(read.aimOffsetM), 0.02)
        for p in read.path {
            XCTAssertLessThan(abs(p.x), 0.02)
        }
    }

    func testFlatPlaysLikeIsDistancePlusFinishWindow() throws {
        // Rollout = 10 m to the hole + preferred 0.30–0.45 m past (§3.5).
        let read = Self.flatRead
        XCTAssertGreaterThan(read.playsLikeM, 10.05)
        XCTAssertLessThan(read.playsLikeM, 11.0)
        let restBeyond = try XCTUnwrap(read.restBeyondHoleM)
        XCTAssertGreaterThan(restBeyond, 0.2)
        XCTAssertLessThan(restBeyond, 0.6)
    }

    func testFlatPlaysLikeIsExactlyTheFlatEquivalentOfTheChosenSpeed() {
        let read = Self.flatRead
        let mu = stimpToFriction(10)
        let expected = (read.initialSpeedMps * read.initialSpeedMps) / (2 * 9.81 * mu)
        XCTAssertEqual(read.playsLikeM, expected, accuracy: 5e-10)
    }

    func testFlatPathEndsAtTheHoleWhenHoled() {
        let read = Self.flatRead
        let last = read.path[read.path.count - 1]
        XCTAssertLessThan(hypot(last.x - Self.hole10m.x, last.y - Self.hole10m.y), 0.01)
    }

    // MARK: - single-plane cross-slope (2% downhill east, putt north)

    // Ball drifts east (+x), so the aim must be WEST of the hole: negative
    // aimOffsetM (positive = right = east for a northbound putt).
    private static let crossSlopeOffsets: [Double] = {
        let surface = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90)
        return [8.0, 10.0, 12.0].map {
            readPutt(surface: surface, ball: ball, hole: hole10m, stimpFt: $0).aimOffsetM
        }
    }()

    func testCrossSlopeBreakDirectionIsTheUphillSideAtEveryStimp() {
        for off in Self.crossSlopeOffsets {
            XCTAssertLessThan(off, -0.05)
        }
    }

    func testCrossSlopeBreakMagnitudeIncreasesWithStimp() {
        let (off8, off10, off12) = (
            Self.crossSlopeOffsets[0], Self.crossSlopeOffsets[1], Self.crossSlopeOffsets[2]
        )
        XCTAssertGreaterThan(abs(off10), abs(off8))
        XCTAssertGreaterThan(abs(off12), abs(off10))
    }

    func testCrossSlopeStimpScalingIsRoughlyLinear() {
        // First order aim ∝ stimp: 12/8 = 1.5. Integrator + capture model
        // bend it; accept a generous band around linear.
        let ratio = abs(Self.crossSlopeOffsets[2]) / abs(Self.crossSlopeOffsets[0])
        XCTAssertGreaterThan(ratio, 1.1)
        XCTAssertLessThan(ratio, 2.5)
    }

    func testCrossSlopePathBowsToTheAimSideAndReturnsToTheHole() {
        let surface = PlaneSurface(slopePct: 2, fallLineBearingDeg: 90)
        let read = readPutt(surface: surface, ball: Self.ball, hole: Self.hole10m, stimpFt: 10)
        XCTAssertEqual(read.availability, .ok)
        let minX = read.path.map(\.x).min()!
        XCTAssertLessThan(minX, -0.05) // swings west of the ball–hole line
        let last = read.path[read.path.count - 1]
        XCTAssertLessThan(abs(last.x), 0.25) // finishes near the line
    }

    // MARK: - uphill / downhill along the line (§3.3, §3.4)

    func testUphillPlaysLikeMatchesFirstOrderWithinTolerance() {
        // 2% up along the whole line: Δh = +0.2 m → +3.57 m (§3.4).
        let d = 10.0
        let mu = 0.56 / 10.0
        let up = PlaneSurface(slopePct: 2, fallLineBearingDeg: 180)
        let read = readPutt(surface: up, ball: Self.ball, hole: Self.hole10m, stimpFt: 10)
        let expected = d + (0.02 * d) / mu // 13.57
        XCTAssertTrue(read.canStop)
        XCTAssertGreaterThan(read.playsLikeM, expected - 0.2)
        XCTAssertLessThan(read.playsLikeM, expected + 1.2) // + finish window
    }

    func testDownhillPlaysLikeMatchesFirstOrderWithinTolerance() {
        let d = 10.0
        let mu = 0.56 / 10.0
        let down = PlaneSurface(slopePct: 2, fallLineBearingDeg: 0)
        let read = readPutt(surface: down, ball: Self.ball, hole: Self.hole10m, stimpFt: 10)
        let expected = d - (0.02 * d) / mu // 6.43
        XCTAssertTrue(read.canStop)
        XCTAssertGreaterThan(read.playsLikeM, expected - 0.2)
        XCTAssertLessThan(read.playsLikeM, expected + 1.2)
    }

    func testSameCrossSlopeBreaksMoreDownhillThanUphill() {
        // Fall line 45° = downhill putt, 135° = uphill putt; both leave the
        // same eastward cross-slope component on a northbound line.
        let downhill = PlaneSurface(slopePct: 2, fallLineBearingDeg: 45)
        let uphill = PlaneSurface(slopePct: 2, fallLineBearingDeg: 135)
        let offDown = readPutt(
            surface: downhill, ball: Self.ball, hole: Self.hole10m, stimpFt: 10
        ).aimOffsetM
        let offUp = readPutt(
            surface: uphill, ball: Self.ball, hole: Self.hole10m, stimpFt: 10
        ).aimOffsetM
        XCTAssertLessThan(offDown, 0) // both aim west (uphill side)
        XCTAssertLessThan(offUp, 0)
        XCTAssertGreaterThan(abs(offDown), abs(offUp) * 1.2)
    }

    // MARK: - double-breaker

    // 2% cross-slope east at the ball flipping to 2% west at the hole.
    private static let doubleBreakerD = 10.0
    private static let doubleBreakerRead = readPutt(
        surface: DoubleBreaker(a: 0.004, midY: doubleBreakerD / 2),
        ball: ball, hole: Vec2(x: 0, y: doubleBreakerD), stimpFt: 10
    )

    func testDoubleBreakerPathCurvesOneWayThenTheOther() {
        let read = Self.doubleBreakerRead
        let d = Self.doubleBreakerD
        XCTAssertEqual(read.availability, .ok)
        let path = read.path
        XCTAssertGreaterThan(path.count, 8)
        // Signed turning (cross product of consecutive segments): eastward
        // push = clockwise = negative in the first half, positive after.
        var firstHalf = 0.0
        var secondHalf = 0.0
        for i in 0..<(path.count - 2) {
            let ax = path[i + 1].x - path[i].x
            let ay = path[i + 1].y - path[i].y
            let bx = path[i + 2].x - path[i + 1].x
            let by = path[i + 2].y - path[i + 1].y
            let cross = ax * by - ay * bx
            if path[i + 1].y < d / 2 {
                firstHalf += cross
            } else {
                secondHalf += cross
            }
        }
        XCTAssertLessThan(firstHalf, 0)
        XCTAssertGreaterThan(secondHalf, 0)
    }

    func testDoubleBreakerStillFinishesAtTheHole() {
        let read = Self.doubleBreakerRead
        let last = read.path[read.path.count - 1]
        XCTAssertLessThan(hypot(last.x, last.y - Self.doubleBreakerD), 0.5)
    }

    // MARK: - can't-stop downhill (§3.4 degenerate case)

    func testSlopeSteeperThanMuDownhillCannotStopAndHasNoRestPoint() {
        // 6% downhill at stimp 12 (μ ≈ 0.047): Δh/μ < −D and the ball
        // cannot rest anywhere on the plane.
        let chute = PlaneSurface(slopePct: 6, fallLineBearingDeg: 0)
        let read = readPutt(surface: chute, ball: Self.ball, hole: Self.hole10m, stimpFt: 12)
        XCTAssertEqual(read.availability, .ok)
        XCTAssertFalse(read.canStop)
        XCTAssertNil(read.stopPoint)
        XCTAssertNil(read.restBeyondHoleM)
    }

    func testGentleDownhillIsStillStoppable() {
        let down = PlaneSurface(slopePct: 2, fallLineBearingDeg: 0)
        XCTAssertTrue(
            readPutt(surface: down, ball: Self.ball, hole: Self.hole10m, stimpFt: 10).canStop
        )
    }

    // MARK: - determinism

    func testSameInputsTwiceGiveIdenticalRead() {
        let surface = PlaneSurface(slopePct: 2.5, fallLineBearingDeg: 70)
        let a = readPutt(surface: surface, ball: Vec2(x: 3, y: -2), hole: Vec2(x: -1, y: 9),
                         stimpFt: 11)
        let b = readPutt(surface: surface, ball: Vec2(x: 3, y: -2), hole: Vec2(x: -1, y: 9),
                         stimpFt: 11)
        XCTAssertEqual(b, a)
    }

    // MARK: - coverage degradation

    func testHoleOffCoverageIsUnavailableWithEmptyPath() {
        let flat = PlaneSurface(slopePct: 0, fallLineBearingDeg: 0)
        let nearBallOnly = Masked(inner: flat) { p in hypot(p.x, p.y) < 3 }
        let read = readPutt(surface: nearBallOnly, ball: Self.ball, hole: Self.hole10m,
                            stimpFt: 10)
        XCTAssertEqual(read.availability, .unavailable)
        XCTAssertEqual(read.path, [])
        XCTAssertEqual(read.holedProb, 0)
        XCTAssertEqual(read.minConfidence, 0)
    }

    func testCoverageGapMidLineIsDegradedWithZeroConfidence() {
        // Ball and hole covered, but a scanned-corridor gap at 4 < y < 6:
        // every trajectory exits coverage before the hole.
        let flat = PlaneSurface(slopePct: 0, fallLineBearingDeg: 0)
        let gapped = Masked(inner: flat) { p in p.y <= 4 || p.y >= 6 }
        let read = readPutt(surface: gapped, ball: Self.ball, hole: Self.hole10m, stimpFt: 10)
        XCTAssertEqual(read.availability, .degraded)
        XCTAssertEqual(read.minConfidence, 0)
        XCTAssertFalse(read.holed)
        // Path stops at the gap edge instead of pretending flat beyond it.
        let last = read.path[read.path.count - 1]
        XCTAssertLessThan(last.y, 6)
    }

    func testSurfaceConfidencePropagatesToMinConfidence() {
        let soft = PlaneSurface(slopePct: 1, fallLineBearingDeg: 90, confidence: 0.7)
        let read = readPutt(surface: soft, ball: Self.ball, hole: Self.hole10m, stimpFt: 10)
        XCTAssertEqual(read.minConfidence, 0.7, accuracy: 5e-10)
    }
}
