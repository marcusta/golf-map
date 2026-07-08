// Exact-tier rolling-ball putt integrator — the Phase-A keystone of
// docs/feature-putting-green-reading.md (§3.5–3.6, §7). Given a GreenSurface,
// a ball, a hole and a stimp, it sweeps candidate (aim bearing, initial
// speed) pairs, rolls a point-mass ball over the height field for each, and
// picks the pair that maximises a holed-probability heuristic minus a
// lag-distance penalty — the aim.ts EV framing, one dimension smaller.
//
// Physics model (doc §3.6, Penner-style):
//  - Small-slope point mass: a = −g·∇h  −  μ·g·v̂
//    (gravity along the negative height gradient, rolling resistance
//    opposing velocity). μ from stimp per §3.1: μ = 0.56 / stimpFt.
//  - Integration: fixed-step semi-implicit Euler at 10 ms, with the
//    friction term applied as an operator-split speed decrement
//    (max(0, |v| − μ·g·dt)) so friction can never reverse the velocity in
//    the low-speed end game. Accelerations on a green are ≤ ~1 m/s², so a
//    10 ms split-Euler step is well inside tolerance and the loop stays
//    plain arithmetic — trivially Swift-mirrorable (T17). RK4 buys nothing
//    here and costs three extra surface samples per step.
//  - Rest: the ball stops when speed < REST_SPEED_MPS on ground it can
//    hold (|∇h| ≤ μ); on steeper ground it keeps rolling (§3.4 degenerate
//    case), bounded by MAX_SIM_TIME_S.
//
// Capture model (doc §3.5) — B. W. Holmes, "Putting: How a golf ball and
// hole interact", Am. J. Phys. 59 (1991): a dead-center hit is captured
// only below a lip-out speed of ~1.31 m/s, and the effective capture
// half-width shrinks with arrival speed as
//     w(v) = R_hole · sqrt(1 − (v / v_lip)²),   0 at/above v_lip.
// A trajectory is deterministically "holed" when it passes within w(v) of
// the hole center.
//
// Solver: deterministic nested grid search — a coarse bearing × speed grid
// centered on the straight line, then REFINE passes re-gridding a shrinking
// window around the incumbent best. Same inputs → same read; no
// Math.random, no Date.now. v1 scores a SINGLE trajectory per candidate;
// dispersion sampling (Halton pairs per D14, see aim.ts standardNormalPairs)
// is explicitly future work per §3.6, and the holed-probability numbers
// below are heuristics standing in for it.
//
// Units & conventions (match shared/strategy and green-surface.ts):
//  - Coordinates: projected planar meters, {x east, y north}. Bearings
//    compass degrees, 0 = north, clockwise.
//  - aimOffsetM: signed lateral meters at the hole's range. Positive = aim
//    RIGHT of the hole as seen from the ball, negative = left.
//  - playsLikeM: flat-equivalent rollout of the chosen initial speed,
//    v₀² / (2·g·μ) — on a plane this reproduces §3.4's D + Δh/μ plus the
//    intended finish past the hole.
//  - Off coverage: if the surface returns null anywhere along a
//    trajectory, that trajectory stops there and the read degrades
//    explicitly (availability 'degraded'/'unavailable', minConfidence 0) —
//    never silently pretend the unknown ground is flat.

import { bearingToUnitVector, type Vec2 } from '../ellipse';
import { type GreenSurface } from './green-surface';
import { stimpToFriction } from './tour-read';

// ---------------------------------------------------------------------------
// Named constants. Everything in this block awaits empirical calibration —
// naive point-mass integration overestimates break ~2–3× (doc §9 Q2); the
// Landeryd practice-green session (level + chalk line) sets the real values.
// ---------------------------------------------------------------------------

const GRAVITY_MPS2 = 9.81;
/** Regulation hole radius (4.25 in diameter), meters. Doc §3.5. */
export const HOLE_RADIUS_M = 0.054;
/** Holmes 1991 dead-center capture speed limit, m/s (lip-out above it). */
export const LIP_OUT_SPEED_MPS = 1.31;
/** Fixed integrator step, seconds. */
const TIME_STEP_S = 0.01;
/** Hard cap on simulated time (bounds §3.4 never-stopping trajectories). */
const MAX_SIM_TIME_S = 20;
/** Below this speed on holdable ground (|∇h| ≤ μ) the ball is at rest. */
const REST_SPEED_MPS = 0.02;
/** Record every Nth integration step into the rendered path polyline. */
const PATH_RECORD_EVERY = 5;
/** Preferred finish past the hole on flat/uphill, meters (doc §3.5). */
const LAG_TARGET_M = 0.375;
/** Pace-preference width past the target (long side), meters. */
const LAG_SIGMA_LONG_M = 0.45;
/** Pace-preference width short of the target — "never up, never in". */
const LAG_SIGMA_SHORT_M = 0.2;
/** Lag penalty: heuristic strokes-cost per meter of miss rest distance. */
const LAG_PENALTY_PER_M = 0.08;
/** Distance damping of the holed-prob heuristic (≈50% make at 2 m). */
const PROB_HALF_DISTANCE_M = 2.0;
/** First-order aim estimate used ONLY to size the bearing sweep window:
 *  aim ≈ K · crossSlope · D · stimpFt meters (§3.2 shape, integrator k). */
const SWEEP_AIM_K = 1.2;
/** Bearing sweep clamp, degrees. */
const SWEEP_MIN_DEG = 6;
const SWEEP_MAX_DEG = 30;
/** Refinement window = this many coarse grid steps each side of the best. */
const REFINE_WINDOW_STEPS = 1.5;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PuttReadOptions {
    /** Half-sweep of aim bearings around the straight line, degrees.
     *  Default adapts to the first-order break estimate (see SWEEP_AIM_K). */
    sweepDeg?: number;
    /** Bearing candidates per grid pass (odd keeps the center exact). */
    bearingCandidates?: number;
    /** Speed candidates per grid pass. */
    speedCandidates?: number;
    /** Refinement passes after the coarse grid. */
    refinePasses?: number;
}

export interface PuttRead {
    /**
     * 'ok'          — chosen trajectory fully on covered surface.
     * 'degraded'    — trajectory left coverage mid-roll; read is partial,
     *                 minConfidence forced to 0. Show with a warning.
     * 'unavailable' — ball or hole is off coverage; no read at all.
     */
    availability: 'ok' | 'degraded' | 'unavailable';
    /** Compass bearing to start the ball on. */
    aimBearingDeg: number;
    /** Signed lateral aim offset at the hole's range, meters. + = right. */
    aimOffsetM: number;
    /** Chosen initial ball speed, m/s. */
    initialSpeedMps: number;
    /** Flat-equivalent rollout of the chosen speed: v₀²/(2gμ), meters. */
    playsLikeM: number;
    /** Heuristic holed probability, 0..1 (uncalibrated; see header). */
    holedProb: number;
    /**
     * False = §3.4 degenerate downhill: no putt both reaches the hole and
     * stops near it ("can't stop this one — lag to the low side").
     * True whenever the read is unavailable (no claim either way).
     */
    canStop: boolean;
    /** The single simulated trajectory was captured by the hole. */
    holed: boolean;
    /** Simulated ball path for rendering. Ends at the hole when holed. */
    path: Vec2[];
    /** Rest position ignoring capture; null if the ball never stops. */
    stopPoint: Vec2 | null;
    /** Signed along-line finish past the hole ignoring capture (m), or
     *  null when the ball never rests / leaves coverage first. */
    restBeyondHoleM: number | null;
    /** Min SurfaceSample.confidence along the chosen path (0 if degraded). */
    minConfidence: number;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Effective capture half-width for an arrival speed (Holmes 1991). */
export function captureRadiusM(speedMps: number): number {
    if (speedMps >= LIP_OUT_SPEED_MPS) return 0;
    const ratio = speedMps / LIP_OUT_SPEED_MPS;
    return HOLE_RADIUS_M * Math.sqrt(1 - ratio * ratio);
}

// ---------------------------------------------------------------------------
// Trajectory simulation
// ---------------------------------------------------------------------------

interface TrajectoryStats {
    /** Closest approach of the path to the hole center, meters. */
    closestApproachM: number;
    /** Ball speed at the closest approach, m/s. */
    speedAtClosestMps: number;
    /** Passed within captureRadiusM(speed) of the hole at some point. */
    holed: boolean;
    /** Rest position, or null if the ball never stopped (time cap / off). */
    restPoint: Vec2 | null;
    /** Last integrated position (== restPoint when the ball rested). */
    endPoint: Vec2;
    /** The surface returned null along the way; integration stopped there. */
    offCoverage: boolean;
    /** Min sample confidence seen along the trajectory. */
    minConfidence: number;
    /** Recorded polyline (only when requested), including start and end. */
    path: Vec2[] | null;
    /** path.length at the capture moment (for truncating a holed path). */
    capturedPathCount: number;
}

/** Distance from point q to the segment a→b (all planar meters). */
function segmentDistance(qx: number, qy: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
        t = ((qx - ax) * dx + (qy - ay) * dy) / lenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
    }
    const cx = ax + t * dx - qx;
    const cy = ay + t * dy - qy;
    return Math.sqrt(cx * cx + cy * cy);
}

function simulateTrajectory(
    surface: GreenSurface,
    start: Vec2,
    dir: Vec2,
    v0: number,
    hole: Vec2,
    mu: number,
    recordPath: boolean,
): TrajectoryStats {
    let px = start.x;
    let py = start.y;
    let vx = dir.x * v0;
    let vy = dir.y * v0;
    let minDist = Math.hypot(hole.x - px, hole.y - py);
    let speedAtMin = v0;
    let holed = false;
    let capturedPathCount = 0;
    let offCoverage = false;
    let minConfidence = 1;
    let restPoint: Vec2 | null = null;
    const path: Vec2[] | null = recordPath ? [{ x: px, y: py }] : null;

    const maxSteps = Math.round(MAX_SIM_TIME_S / TIME_STEP_S);
    const frictionDv = mu * GRAVITY_MPS2 * TIME_STEP_S;

    for (let step = 0; step < maxSteps; step++) {
        const sample = surface.sampleAt({ x: px, y: py });
        if (sample === null) {
            offCoverage = true;
            break;
        }
        if (sample.confidence < minConfidence) minConfidence = sample.confidence;

        // Rest: slow enough AND on ground rolling resistance can hold.
        const speedBefore = Math.hypot(vx, vy);
        const slope = Math.hypot(sample.gradX, sample.gradY);
        if (speedBefore < REST_SPEED_MPS && slope <= mu) {
            restPoint = { x: px, y: py };
            break;
        }

        // Semi-implicit Euler: gravity kick, then operator-split friction.
        vx += -GRAVITY_MPS2 * sample.gradX * TIME_STEP_S;
        vy += -GRAVITY_MPS2 * sample.gradY * TIME_STEP_S;
        const speed = Math.hypot(vx, vy);
        if (speed > 0) {
            const damped = Math.max(0, speed - frictionDv);
            vx *= damped / speed;
            vy *= damped / speed;
        }
        const nx = px + vx * TIME_STEP_S;
        const ny = py + vy * TIME_STEP_S;

        const speedNow = Math.hypot(vx, vy);
        const dist = segmentDistance(hole.x, hole.y, px, py, nx, ny);
        if (dist < minDist) {
            minDist = dist;
            speedAtMin = speedNow;
        }
        if (!holed && dist <= captureRadiusM(speedNow)) {
            holed = true;
            if (path !== null) capturedPathCount = path.length;
        }

        px = nx;
        py = ny;
        if (path !== null && (step + 1) % PATH_RECORD_EVERY === 0) {
            path.push({ x: px, y: py });
        }
    }

    const endPoint = restPoint ?? { x: px, y: py };
    if (path !== null) {
        const last = path[path.length - 1];
        if (last.x !== endPoint.x || last.y !== endPoint.y) {
            path.push({ x: endPoint.x, y: endPoint.y });
        }
    }
    return {
        closestApproachM: minDist,
        speedAtClosestMps: speedAtMin,
        holed,
        restPoint,
        endPoint,
        offCoverage,
        minConfidence,
        path,
        capturedPathCount,
    };
}

// ---------------------------------------------------------------------------
// Scoring — heuristic holed probability minus lag penalty (§3.5)
// ---------------------------------------------------------------------------

interface TrajectoryScore {
    score: number;
    holedProb: number;
    restBeyondHoleM: number | null;
}

function scoreTrajectory(
    stats: TrajectoryStats,
    hole: Vec2,
    alongX: number,
    alongY: number,
    holeDistanceM: number,
): TrajectoryScore {
    // Line quality: how central the pass is relative to the speed-shrunk
    // capture width. 1 dead center, 0.5 at the capture edge, →0 outside.
    const w = captureRadiusM(stats.speedAtClosestMps);
    const b = stats.closestApproachM;
    const lineProb = w > 0 ? Math.exp(-Math.LN2 * (b / w) * (b / w)) : 0;

    // Pace quality: prefer finishing LAG_TARGET_M past the hole, punishing
    // short harder than long ("never up, never in"). Emergent behavior:
    // on quick downhillers no candidate can finish near the target, so the
    // optimiser dies the ball at the hole (smallest achievable overshoot).
    let restBeyondHoleM: number | null = null;
    let paceProb = 0;
    if (stats.restPoint !== null) {
        restBeyondHoleM =
            (stats.restPoint.x - hole.x) * alongX + (stats.restPoint.y - hole.y) * alongY;
        const err = restBeyondHoleM - LAG_TARGET_M;
        const sigma = err < 0 ? LAG_SIGMA_SHORT_M : LAG_SIGMA_LONG_M;
        paceProb = Math.exp(-0.5 * (err / sigma) * (err / sigma));
    }

    // Distance damping: single-trajectory stand-in for dispersion (§3.6).
    const damp = PROB_HALF_DISTANCE_M / (PROB_HALF_DISTANCE_M + holeDistanceM);
    const holedProb = Math.min(1, Math.max(0, lineProb * paceProb * damp));

    // Miss cost: where the ball rests if not captured (comeback length).
    const miss = stats.restPoint ?? stats.endPoint;
    const missM = Math.hypot(miss.x - hole.x, miss.y - hole.y);
    const score = holedProb - LAG_PENALTY_PER_M * (1 - holedProb) * missM;
    return { score, holedProb, restBeyondHoleM };
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

function normalizeDeltaDeg(deg: number): number {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
}

interface Candidate {
    score: number;
    bearingDeg: number;
    v0: number;
}

function bestOnGrid(
    surface: GreenSurface,
    ball: Vec2,
    hole: Vec2,
    mu: number,
    alongX: number,
    alongY: number,
    holeDistanceM: number,
    centerBearingDeg: number,
    halfBearingDeg: number,
    bearingCount: number,
    centerV: number,
    halfV: number,
    speedCount: number,
    incumbent: Candidate | null,
): Candidate {
    let best = incumbent;
    for (let bi = 0; bi < bearingCount; bi++) {
        const bearing = bearingCount === 1
            ? centerBearingDeg
            : centerBearingDeg - halfBearingDeg + (2 * halfBearingDeg * bi) / (bearingCount - 1);
        const dir = bearingToUnitVector(bearing);
        for (let vi = 0; vi < speedCount; vi++) {
            const v0 = Math.max(
                0.05,
                speedCount === 1 ? centerV : centerV - halfV + (2 * halfV * vi) / (speedCount - 1),
            );
            const stats = simulateTrajectory(surface, ball, dir, v0, hole, mu, false);
            const { score } = scoreTrajectory(stats, hole, alongX, alongY, holeDistanceM);
            // Strictly-greater keeps the first (straightest-first order is
            // NOT guaranteed, but the comparison is deterministic).
            if (best === null || score > best.score) {
                best = { score, bearingDeg: bearing, v0 };
            }
        }
    }
    return best!;
}

/**
 * Read a putt: choose (aim bearing, initial speed) maximising the holed
 * probability heuristic minus the lag penalty, and report the read
 * (aim offset, rendered path, plays-like pace, §3.4 canStop flag).
 * Deterministic: identical inputs always return the identical read.
 */
export function readPutt(
    surface: GreenSurface,
    ball: Vec2,
    hole: Vec2,
    stimpFt: number,
    options?: PuttReadOptions,
): PuttRead {
    const mu = stimpToFriction(Math.max(1, stimpFt));
    const dx = hole.x - ball.x;
    const dy = hole.y - ball.y;
    const holeDistanceM = Math.hypot(dx, dy);
    const straightBearingDeg = Math.atan2(dx, dy) * RAD_TO_DEG;

    const ballSample = surface.sampleAt(ball);
    const holeSample = surface.sampleAt(hole);
    if (ballSample === null || holeSample === null || holeDistanceM < 1e-9) {
        return {
            availability: 'unavailable',
            aimBearingDeg: straightBearingDeg,
            aimOffsetM: 0,
            initialSpeedMps: 0,
            playsLikeM: 0,
            holedProb: 0,
            canStop: true,
            holed: false,
            path: [],
            stopPoint: null,
            restBeyondHoleM: null,
            minConfidence: 0,
        };
    }

    const alongX = dx / holeDistanceM;
    const alongY = dy / holeDistanceM;

    // §3.4 degenerate case, analytic: the straight-line energy balance
    // D + Δh/μ ≤ 0 means no speed both reaches the hole and stops nearby;
    // |∇h| > μ at the hole means the ball cannot rest there at all.
    const deltaH = holeSample.height - ballSample.height;
    const playsLikeStraightM = holeDistanceM + deltaH / mu;
    const holeSlope = Math.hypot(holeSample.gradX, holeSample.gradY);
    const canStop = playsLikeStraightM > 0 && holeSlope <= mu;

    // Bearing sweep window from the §3.2 first-order break estimate at the
    // midpoint (cross-slope component only), clamped.
    let sweepDeg = options?.sweepDeg;
    if (sweepDeg === undefined) {
        const mid = surface.sampleAt({ x: ball.x + dx / 2, y: ball.y + dy / 2 });
        let crossSlope = 0;
        if (mid !== null) {
            // Right unit vector of the line: (alongY, -alongX).
            crossSlope = Math.abs(mid.gradX * alongY - mid.gradY * alongX);
        }
        const aimEstM = SWEEP_AIM_K * crossSlope * holeDistanceM * stimpFt;
        sweepDeg = Math.min(
            SWEEP_MAX_DEG,
            Math.max(SWEEP_MIN_DEG, Math.atan((1.5 * aimEstM + 0.3) / holeDistanceM) * RAD_TO_DEG),
        );
    }

    // Speed window from rollout targets around the straight plays-like.
    const baseRolloutM = Math.max(playsLikeStraightM, 0.4 * holeDistanceM, 1);
    const rolloutLoM = Math.max(0.5, 0.6 * baseRolloutM);
    const rolloutHiM = 1.35 * baseRolloutM + 1.5;
    const vLo = Math.sqrt(2 * GRAVITY_MPS2 * mu * rolloutLoM);
    const vHi = Math.sqrt(2 * GRAVITY_MPS2 * mu * rolloutHiM);

    const bearingCount = Math.max(3, options?.bearingCandidates ?? 25);
    const speedCount = Math.max(3, options?.speedCandidates ?? 13);
    const refinePasses = Math.max(0, options?.refinePasses ?? 2);

    let halfBearing = sweepDeg;
    let halfV = (vHi - vLo) / 2;
    let best = bestOnGrid(
        surface, ball, hole, mu, alongX, alongY, holeDistanceM,
        straightBearingDeg, halfBearing, bearingCount,
        (vLo + vHi) / 2, halfV, speedCount,
        null,
    );
    for (let pass = 0; pass < refinePasses; pass++) {
        halfBearing = REFINE_WINDOW_STEPS * (2 * halfBearing / (bearingCount - 1));
        halfV = REFINE_WINDOW_STEPS * (2 * halfV / (speedCount - 1));
        best = bestOnGrid(
            surface, ball, hole, mu, alongX, alongY, holeDistanceM,
            best.bearingDeg, halfBearing, bearingCount,
            best.v0, halfV, speedCount,
            best,
        );
    }

    // Final roll of the winner, recording the path.
    const finalStats = simulateTrajectory(
        surface, ball, bearingToUnitVector(best.bearingDeg), best.v0, hole, mu, true,
    );
    const { holedProb, restBeyondHoleM } = scoreTrajectory(
        finalStats, hole, alongX, alongY, holeDistanceM,
    );

    let path = finalStats.path!;
    if (finalStats.holed) {
        path = path.slice(0, Math.max(1, finalStats.capturedPathCount));
        path.push({ x: hole.x, y: hole.y });
    }

    const deltaDeg = normalizeDeltaDeg(best.bearingDeg - straightBearingDeg);
    return {
        availability: finalStats.offCoverage ? 'degraded' : 'ok',
        aimBearingDeg: best.bearingDeg,
        aimOffsetM: holeDistanceM * Math.sin(deltaDeg * DEG_TO_RAD),
        initialSpeedMps: best.v0,
        playsLikeM: (best.v0 * best.v0) / (2 * GRAVITY_MPS2 * mu),
        holedProb,
        canStop,
        holed: finalStats.holed,
        path,
        stopPoint: finalStats.restPoint,
        restBeyondHoleM,
        minConfidence: finalStats.offCoverage ? 0 : finalStats.minConfidence,
    };
}
