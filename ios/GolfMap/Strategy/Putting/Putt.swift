import Foundation

/// Exact-tier rolling-ball putt integrator — faithful Swift port of
/// `shared/strategy/putting/putt.ts` (doc §3.5–3.6, §7). The two MUST stay
/// numerically identical: same constants, same split-Euler 10 ms step, same
/// Holmes capture model, same nested grid search (candidate counts,
/// refinement passes, strictly-greater tie-breaking), so results are
/// bit-comparable in Double. Ported tests + TS-generated goldens
/// (`putting-goldens.json`) pin the parity.
///
/// Given a GreenSurface, a ball, a hole and a stimp, it sweeps candidate
/// (aim bearing, initial speed) pairs, rolls a point-mass ball over the
/// height field for each, and picks the pair that maximises a
/// holed-probability heuristic minus a lag-distance penalty.
///
/// Physics model (doc §3.6, Penner-style):
///  - Small-slope point mass: a = −g·∇h − μ·g·v̂ (gravity along the negative
///    height gradient, rolling resistance opposing velocity). μ from stimp
///    per §3.1: μ = 0.56 / stimpFt.
///  - Integration: fixed-step semi-implicit Euler at 10 ms, with the
///    friction term applied as an operator-split speed decrement
///    (max(0, |v| − μ·g·dt)) so friction can never reverse the velocity in
///    the low-speed end game.
///  - Rest: the ball stops when speed < REST_SPEED_MPS on ground it can
///    hold (|∇h| ≤ μ); on steeper ground it keeps rolling (§3.4 degenerate
///    case), bounded by MAX_SIM_TIME_S.
///
/// Capture model (doc §3.5) — B. W. Holmes, Am. J. Phys. 59 (1991): a
/// dead-center hit is captured only below a lip-out speed of ~1.31 m/s, and
/// the effective capture half-width shrinks with arrival speed as
///     w(v) = R_hole · sqrt(1 − (v / v_lip)²),   0 at/above v_lip.
///
/// Solver: deterministic nested grid search — same inputs → same read; no
/// randomness, no clocks. v1 scores a SINGLE trajectory per candidate;
/// dispersion sampling is future work per §3.6.
///
/// Units & conventions (match shared/strategy and GreenSurface.swift):
///  - Coordinates: projected planar meters, {x east, y north}. Bearings
///    compass degrees, 0 = north, clockwise.
///  - aimOffsetM: signed lateral meters at the hole's range. Positive = aim
///    RIGHT of the hole as seen from the ball, negative = left.
///  - playsLikeM: flat-equivalent rollout of the chosen initial speed,
///    v₀² / (2·g·μ).
///  - Off coverage: if the surface returns nil anywhere along a trajectory,
///    that trajectory stops there and the read degrades explicitly
///    (availability .degraded/.unavailable, minConfidence 0) — never
///    silently pretend the unknown ground is flat.

// ---------------------------------------------------------------------------
// Named constants. Everything in this block awaits empirical calibration —
// naive point-mass integration overestimates break ~2–3× (doc §9 Q2); the
// Landeryd practice-green session (level + chalk line) sets the real values.
// ---------------------------------------------------------------------------

/// TS putt.ts has its own module-private GRAVITY_MPS2 (9.81, vs tour-read's
/// exported 9.8) — renamed here because Swift top-level scope is per-module.
private let PUTT_GRAVITY_MPS2 = 9.81
/// Regulation hole radius (4.25 in diameter), meters. Doc §3.5.
public let HOLE_RADIUS_M = 0.054
/// Holmes 1991 dead-center capture speed limit, m/s (lip-out above it).
public let LIP_OUT_SPEED_MPS = 1.31
/// Fixed integrator step, seconds.
private let TIME_STEP_S = 0.01
/// Hard cap on simulated time (bounds §3.4 never-stopping trajectories).
private let MAX_SIM_TIME_S = 20.0
/// Below this speed on holdable ground (|∇h| ≤ μ) the ball is at rest.
private let REST_SPEED_MPS = 0.02
/// Record every Nth integration step into the rendered path polyline.
private let PATH_RECORD_EVERY = 5
/// Preferred finish past the hole on flat/uphill, meters (doc §3.5).
private let LAG_TARGET_M = 0.375
/// Pace-preference width past the target (long side), meters.
private let LAG_SIGMA_LONG_M = 0.45
/// Pace-preference width short of the target — "never up, never in".
private let LAG_SIGMA_SHORT_M = 0.2
/// Lag penalty: heuristic strokes-cost per meter of miss rest distance.
private let LAG_PENALTY_PER_M = 0.08
/// Distance damping of the holed-prob heuristic (≈50% make at 2 m).
private let PROB_HALF_DISTANCE_M = 2.0
/// First-order aim estimate used ONLY to size the bearing sweep window:
/// aim ≈ K · crossSlope · D · stimpFt meters (§3.2 shape, integrator k).
private let SWEEP_AIM_K = 1.2
/// Bearing sweep clamp, degrees.
private let SWEEP_MIN_DEG = 6.0
private let SWEEP_MAX_DEG = 30.0
/// Refinement window = this many coarse grid steps each side of the best.
private let REFINE_WINDOW_STEPS = 1.5

private let DEG_TO_RAD = Double.pi / 180
private let RAD_TO_DEG = 180 / Double.pi
/// JS Math.LN2 (bit-equal to libm M_LN2; pinned as a literal for clarity).
private let LN2 = 0.6931471805599453

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

public struct PuttReadOptions: Sendable {
    /// Half-sweep of aim bearings around the straight line, degrees.
    /// Default adapts to the first-order break estimate (see SWEEP_AIM_K).
    public var sweepDeg: Double?
    /// Bearing candidates per grid pass (odd keeps the center exact).
    public var bearingCandidates: Int?
    /// Speed candidates per grid pass.
    public var speedCandidates: Int?
    /// Refinement passes after the coarse grid.
    public var refinePasses: Int?

    public init(
        sweepDeg: Double? = nil,
        bearingCandidates: Int? = nil,
        speedCandidates: Int? = nil,
        refinePasses: Int? = nil
    ) {
        self.sweepDeg = sweepDeg
        self.bearingCandidates = bearingCandidates
        self.speedCandidates = speedCandidates
        self.refinePasses = refinePasses
    }
}

public enum PuttAvailability: String, Sendable {
    /// Chosen trajectory fully on covered surface.
    case ok
    /// Trajectory left coverage mid-roll; read is partial, minConfidence
    /// forced to 0. Show with a warning.
    case degraded
    /// Ball or hole is off coverage; no read at all.
    case unavailable
}

public struct PuttRead: Equatable, Sendable {
    public var availability: PuttAvailability
    /// Compass bearing to start the ball on.
    public var aimBearingDeg: Double
    /// Signed lateral aim offset at the hole's range, meters. + = right.
    public var aimOffsetM: Double
    /// Chosen initial ball speed, m/s.
    public var initialSpeedMps: Double
    /// Flat-equivalent rollout of the chosen speed: v₀²/(2gμ), meters.
    public var playsLikeM: Double
    /// Heuristic holed probability, 0..1 (uncalibrated; see header).
    public var holedProb: Double
    /// False = §3.4 degenerate downhill: no putt both reaches the hole and
    /// stops near it ("can't stop this one — lag to the low side").
    /// True whenever the read is unavailable (no claim either way).
    public var canStop: Bool
    /// The single simulated trajectory was captured by the hole.
    public var holed: Bool
    /// Simulated ball path for rendering. Ends at the hole when holed.
    public var path: [Vec2]
    /// Rest position ignoring capture; nil if the ball never stops.
    public var stopPoint: Vec2?
    /// Signed along-line finish past the hole ignoring capture (m), or nil
    /// when the ball never rests / leaves coverage first.
    public var restBeyondHoleM: Double?
    /// Min SurfaceSample.confidence along the chosen path (0 if degraded).
    public var minConfidence: Double
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/// Effective capture half-width for an arrival speed (Holmes 1991).
public func captureRadiusM(_ speedMps: Double) -> Double {
    if speedMps >= LIP_OUT_SPEED_MPS { return 0 }
    let ratio = speedMps / LIP_OUT_SPEED_MPS
    return HOLE_RADIUS_M * (1 - ratio * ratio).squareRoot()
}

// ---------------------------------------------------------------------------
// Trajectory simulation
// ---------------------------------------------------------------------------

private struct TrajectoryStats {
    /// Closest approach of the path to the hole center, meters.
    var closestApproachM: Double
    /// Ball speed at the closest approach, m/s.
    var speedAtClosestMps: Double
    /// Passed within captureRadiusM(speed) of the hole at some point.
    var holed: Bool
    /// Rest position, or nil if the ball never stopped (time cap / off).
    var restPoint: Vec2?
    /// Last integrated position (== restPoint when the ball rested).
    var endPoint: Vec2
    /// The surface returned nil along the way; integration stopped there.
    var offCoverage: Bool
    /// Min sample confidence seen along the trajectory.
    var minConfidence: Double
    /// Recorded polyline (only when requested), including start and end.
    var path: [Vec2]?
    /// path.count at the capture moment (for truncating a holed path).
    var capturedPathCount: Int
}

/// Distance from point q to the segment a→b (all planar meters).
private func segmentDistance(
    _ qx: Double, _ qy: Double,
    _ ax: Double, _ ay: Double,
    _ bx: Double, _ by: Double
) -> Double {
    let dx = bx - ax
    let dy = by - ay
    let lenSq = dx * dx + dy * dy
    var t = 0.0
    if lenSq > 0 {
        t = ((qx - ax) * dx + (qy - ay) * dy) / lenSq
        if t < 0 { t = 0 } else if t > 1 { t = 1 }
    }
    let cx = ax + t * dx - qx
    let cy = ay + t * dy - qy
    return (cx * cx + cy * cy).squareRoot()
}

private func simulateTrajectory(
    surface: some GreenSurface,
    start: Vec2,
    dir: Vec2,
    v0: Double,
    hole: Vec2,
    mu: Double,
    recordPath: Bool
) -> TrajectoryStats {
    var px = start.x
    var py = start.y
    var vx = dir.x * v0
    var vy = dir.y * v0
    var minDist = hypot(hole.x - px, hole.y - py)
    var speedAtMin = v0
    var holed = false
    var capturedPathCount = 0
    var offCoverage = false
    var minConfidence = 1.0
    var restPoint: Vec2? = nil
    var path: [Vec2]? = recordPath ? [Vec2(x: px, y: py)] : nil

    let maxSteps = Int((MAX_SIM_TIME_S / TIME_STEP_S).rounded())
    let frictionDv = mu * PUTT_GRAVITY_MPS2 * TIME_STEP_S

    for step in 0..<maxSteps {
        guard let sample = surface.sampleAt(Vec2(x: px, y: py)) else {
            offCoverage = true
            break
        }
        if sample.confidence < minConfidence { minConfidence = sample.confidence }

        // Rest: slow enough AND on ground rolling resistance can hold.
        let speedBefore = hypot(vx, vy)
        let slope = hypot(sample.gradX, sample.gradY)
        if speedBefore < REST_SPEED_MPS && slope <= mu {
            restPoint = Vec2(x: px, y: py)
            break
        }

        // Semi-implicit Euler: gravity kick, then operator-split friction.
        vx += -PUTT_GRAVITY_MPS2 * sample.gradX * TIME_STEP_S
        vy += -PUTT_GRAVITY_MPS2 * sample.gradY * TIME_STEP_S
        let speed = hypot(vx, vy)
        if speed > 0 {
            let damped = max(0, speed - frictionDv)
            vx *= damped / speed
            vy *= damped / speed
        }
        let nx = px + vx * TIME_STEP_S
        let ny = py + vy * TIME_STEP_S

        let speedNow = hypot(vx, vy)
        let dist = segmentDistance(hole.x, hole.y, px, py, nx, ny)
        if dist < minDist {
            minDist = dist
            speedAtMin = speedNow
        }
        if !holed && dist <= captureRadiusM(speedNow) {
            holed = true
            if path != nil { capturedPathCount = path!.count }
        }

        px = nx
        py = ny
        if path != nil && (step + 1) % PATH_RECORD_EVERY == 0 {
            path!.append(Vec2(x: px, y: py))
        }
    }

    let endPoint = restPoint ?? Vec2(x: px, y: py)
    if path != nil {
        let last = path![path!.count - 1]
        if last.x != endPoint.x || last.y != endPoint.y {
            path!.append(Vec2(x: endPoint.x, y: endPoint.y))
        }
    }
    return TrajectoryStats(
        closestApproachM: minDist,
        speedAtClosestMps: speedAtMin,
        holed: holed,
        restPoint: restPoint,
        endPoint: endPoint,
        offCoverage: offCoverage,
        minConfidence: minConfidence,
        path: path,
        capturedPathCount: capturedPathCount
    )
}

// ---------------------------------------------------------------------------
// Scoring — heuristic holed probability minus lag penalty (§3.5)
// ---------------------------------------------------------------------------

private struct TrajectoryScore {
    var score: Double
    var holedProb: Double
    var restBeyondHoleM: Double?
}

private func scoreTrajectory(
    _ stats: TrajectoryStats,
    hole: Vec2,
    alongX: Double,
    alongY: Double,
    holeDistanceM: Double
) -> TrajectoryScore {
    // Line quality: how central the pass is relative to the speed-shrunk
    // capture width. 1 dead center, 0.5 at the capture edge, →0 outside.
    let w = captureRadiusM(stats.speedAtClosestMps)
    let b = stats.closestApproachM
    let lineProb = w > 0 ? exp(-LN2 * (b / w) * (b / w)) : 0

    // Pace quality: prefer finishing LAG_TARGET_M past the hole, punishing
    // short harder than long ("never up, never in"). Emergent behavior:
    // on quick downhillers no candidate can finish near the target, so the
    // optimiser dies the ball at the hole (smallest achievable overshoot).
    var restBeyondHoleM: Double? = nil
    var paceProb = 0.0
    if let rest = stats.restPoint {
        let beyond = (rest.x - hole.x) * alongX + (rest.y - hole.y) * alongY
        restBeyondHoleM = beyond
        let err = beyond - LAG_TARGET_M
        let sigma = err < 0 ? LAG_SIGMA_SHORT_M : LAG_SIGMA_LONG_M
        paceProb = exp(-0.5 * (err / sigma) * (err / sigma))
    }

    // Distance damping: single-trajectory stand-in for dispersion (§3.6).
    let damp = PROB_HALF_DISTANCE_M / (PROB_HALF_DISTANCE_M + holeDistanceM)
    let holedProb = min(1, max(0, lineProb * paceProb * damp))

    // Miss cost: where the ball rests if not captured (comeback length).
    let miss = stats.restPoint ?? stats.endPoint
    let missM = hypot(miss.x - hole.x, miss.y - hole.y)
    let score = holedProb - LAG_PENALTY_PER_M * (1 - holedProb) * missM
    return TrajectoryScore(score: score, holedProb: holedProb, restBeyondHoleM: restBeyondHoleM)
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

private func normalizeDeltaDeg(_ deg: Double) -> Double {
    var d = deg.truncatingRemainder(dividingBy: 360)
    if d > 180 { d -= 360 }
    if d <= -180 { d += 360 }
    return d
}

private struct Candidate {
    var score: Double
    var bearingDeg: Double
    var v0: Double
}

private func bestOnGrid(
    surface: some GreenSurface,
    ball: Vec2,
    hole: Vec2,
    mu: Double,
    alongX: Double,
    alongY: Double,
    holeDistanceM: Double,
    centerBearingDeg: Double,
    halfBearingDeg: Double,
    bearingCount: Int,
    centerV: Double,
    halfV: Double,
    speedCount: Int,
    incumbent: Candidate?
) -> Candidate {
    var best = incumbent
    for bi in 0..<bearingCount {
        let bearing = bearingCount == 1
            ? centerBearingDeg
            : centerBearingDeg - halfBearingDeg
                + (2 * halfBearingDeg * Double(bi)) / Double(bearingCount - 1)
        let dir = bearingToUnitVector(bearing)
        for vi in 0..<speedCount {
            let v0 = max(
                0.05,
                speedCount == 1
                    ? centerV
                    : centerV - halfV + (2 * halfV * Double(vi)) / Double(speedCount - 1)
            )
            let stats = simulateTrajectory(
                surface: surface, start: ball, dir: dir, v0: v0, hole: hole, mu: mu,
                recordPath: false
            )
            let score = scoreTrajectory(
                stats, hole: hole, alongX: alongX, alongY: alongY, holeDistanceM: holeDistanceM
            ).score
            // Strictly-greater keeps the first (straightest-first order is
            // NOT guaranteed, but the comparison is deterministic).
            if best == nil || score > best!.score {
                best = Candidate(score: score, bearingDeg: bearing, v0: v0)
            }
        }
    }
    return best!
}

/// Read a putt: choose (aim bearing, initial speed) maximising the holed
/// probability heuristic minus the lag penalty, and report the read
/// (aim offset, rendered path, plays-like pace, §3.4 canStop flag).
/// Deterministic: identical inputs always return the identical read.
public func readPutt(
    surface: some GreenSurface,
    ball: Vec2,
    hole: Vec2,
    stimpFt: Double,
    options: PuttReadOptions? = nil
) -> PuttRead {
    let mu = stimpToFriction(max(1, stimpFt))
    let dx = hole.x - ball.x
    let dy = hole.y - ball.y
    let holeDistanceM = hypot(dx, dy)
    let straightBearingDeg = atan2(dx, dy) * RAD_TO_DEG

    let ballSample = surface.sampleAt(ball)
    let holeSample = surface.sampleAt(hole)
    guard let ballSample, let holeSample, holeDistanceM >= 1e-9 else {
        return PuttRead(
            availability: .unavailable,
            aimBearingDeg: straightBearingDeg,
            aimOffsetM: 0,
            initialSpeedMps: 0,
            playsLikeM: 0,
            holedProb: 0,
            canStop: true,
            holed: false,
            path: [],
            stopPoint: nil,
            restBeyondHoleM: nil,
            minConfidence: 0
        )
    }

    let alongX = dx / holeDistanceM
    let alongY = dy / holeDistanceM

    // §3.4 degenerate case, analytic: the straight-line energy balance
    // D + Δh/μ ≤ 0 means no speed both reaches the hole and stops nearby;
    // |∇h| > μ at the hole means the ball cannot rest there at all.
    let deltaH = holeSample.height - ballSample.height
    let playsLikeStraightM = holeDistanceM + deltaH / mu
    let holeSlope = hypot(holeSample.gradX, holeSample.gradY)
    let canStop = playsLikeStraightM > 0 && holeSlope <= mu

    // Bearing sweep window from the §3.2 first-order break estimate at the
    // midpoint (cross-slope component only), clamped.
    let sweepDeg: Double
    if let explicit = options?.sweepDeg {
        sweepDeg = explicit
    } else {
        let mid = surface.sampleAt(Vec2(x: ball.x + dx / 2, y: ball.y + dy / 2))
        var crossSlope = 0.0
        if let mid {
            // Right unit vector of the line: (alongY, -alongX).
            crossSlope = abs(mid.gradX * alongY - mid.gradY * alongX)
        }
        let aimEstM = SWEEP_AIM_K * crossSlope * holeDistanceM * stimpFt
        sweepDeg = min(
            SWEEP_MAX_DEG,
            max(SWEEP_MIN_DEG, atan((1.5 * aimEstM + 0.3) / holeDistanceM) * RAD_TO_DEG)
        )
    }

    // Speed window from rollout targets around the straight plays-like.
    let baseRolloutM = max(playsLikeStraightM, max(0.4 * holeDistanceM, 1))
    let rolloutLoM = max(0.5, 0.6 * baseRolloutM)
    let rolloutHiM = 1.35 * baseRolloutM + 1.5
    let vLo = (2 * PUTT_GRAVITY_MPS2 * mu * rolloutLoM).squareRoot()
    let vHi = (2 * PUTT_GRAVITY_MPS2 * mu * rolloutHiM).squareRoot()

    let bearingCount = max(3, options?.bearingCandidates ?? 25)
    let speedCount = max(3, options?.speedCandidates ?? 13)
    let refinePasses = max(0, options?.refinePasses ?? 2)

    var halfBearing = sweepDeg
    var halfV = (vHi - vLo) / 2
    var best = bestOnGrid(
        surface: surface, ball: ball, hole: hole, mu: mu,
        alongX: alongX, alongY: alongY, holeDistanceM: holeDistanceM,
        centerBearingDeg: straightBearingDeg, halfBearingDeg: halfBearing,
        bearingCount: bearingCount,
        centerV: (vLo + vHi) / 2, halfV: halfV, speedCount: speedCount,
        incumbent: nil
    )
    for _ in 0..<refinePasses {
        halfBearing = REFINE_WINDOW_STEPS * (2 * halfBearing / Double(bearingCount - 1))
        halfV = REFINE_WINDOW_STEPS * (2 * halfV / Double(speedCount - 1))
        best = bestOnGrid(
            surface: surface, ball: ball, hole: hole, mu: mu,
            alongX: alongX, alongY: alongY, holeDistanceM: holeDistanceM,
            centerBearingDeg: best.bearingDeg, halfBearingDeg: halfBearing,
            bearingCount: bearingCount,
            centerV: best.v0, halfV: halfV, speedCount: speedCount,
            incumbent: best
        )
    }

    // Final roll of the winner, recording the path.
    let finalStats = simulateTrajectory(
        surface: surface, start: ball, dir: bearingToUnitVector(best.bearingDeg),
        v0: best.v0, hole: hole, mu: mu, recordPath: true
    )
    let finalScore = scoreTrajectory(
        finalStats, hole: hole, alongX: alongX, alongY: alongY, holeDistanceM: holeDistanceM
    )

    var path = finalStats.path!
    if finalStats.holed {
        path = Array(path.prefix(max(1, finalStats.capturedPathCount)))
        path.append(Vec2(x: hole.x, y: hole.y))
    }

    let deltaDeg = normalizeDeltaDeg(best.bearingDeg - straightBearingDeg)
    return PuttRead(
        availability: finalStats.offCoverage ? .degraded : .ok,
        aimBearingDeg: best.bearingDeg,
        aimOffsetM: holeDistanceM * sin(deltaDeg * DEG_TO_RAD),
        initialSpeedMps: best.v0,
        playsLikeM: (best.v0 * best.v0) / (2 * PUTT_GRAVITY_MPS2 * mu),
        holedProb: finalScore.holedProb,
        canStop: canStop,
        holed: finalStats.holed,
        path: path,
        stopPoint: finalStats.restPoint,
        restBeyondHoleM: finalScore.restBeyondHoleM,
        minConfidence: finalStats.offCoverage ? 0 : finalStats.minConfidence
    )
}
