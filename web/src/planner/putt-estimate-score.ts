// Pure scoring for the putting training loop (feature-putting-green-reading.md
// §5.1). Before revealing the computed read, practice mode asks the player for
// their own read (slope %, break side, aim offset, plays-like pace); this
// scores that estimate against the computed read's ground truth. Zero-dep and
// deterministic so it can be mirrored to Swift (T17) alongside the rest of the
// putting math — DO NOT reach for DOM, signals, or the network here.
//
// Ground truth: slope % and break side come from the SAME GreenSurface the read
// used (the `deriveTourReadGroundTruth` bundle in putt-read.service.ts), aim
// from the integrator's computed aim offset, pace from its plays-like length —
// so the player is scored against exactly the numbers the app would have shown.

import type { BreakSide } from '../../../shared/strategy';

/** The player's read, entered before the reveal. */
export interface PuttEstimate {
    /** Cross-slope magnitude along the line, % (unsigned — matches the read). */
    slopePct: number;
    /** Which way the player thinks it breaks (= the side to aim). */
    breakSide: BreakSide;
    /** Signed aim offset, meters. + = right of the hole, − = left (read convention). */
    aimOffsetM: number;
    /** Plays-like / pace estimate, meters. */
    playsLikeM: number;
}

/** The computed read's ground truth for the same putt. */
export interface PuttGroundTruth {
    slopePct: number;
    breakSide: BreakSide;
    aimOffsetM: number;
    playsLikeM: number;
}

/** Per-field errors plus an overall 0..100 score. */
export interface PuttEstimateScore {
    /** |estimated − actual| slope %, unsigned. */
    slopeErrorPct: number;
    /** True when the estimated break side matched the computed one. */
    breakSideCorrect: boolean;
    /** |estimated − actual| aim offset, meters (unsigned). */
    aimErrorM: number;
    /** |estimated − actual| plays-like length, meters (unsigned). */
    paceErrorM: number;
    /** Overall 0..100 (100 = perfect); a legible blend of the four fields. */
    score: number;
}

/**
 * Slope error at which the slope component of the score reaches 0. 2% is a full
 * miss on the precision budget (doc §4: 0.2° tilt = 0.35% flips a subtle read),
 * so 2% off is "no better than a guess". Linear taper below it.
 */
export const SLOPE_ERROR_ZERO_PCT = 2;
/** Pace error (m) at which the pace component reaches 0. */
export const PACE_ERROR_ZERO_M = 3;
/** Aim error (m) at which the aim component reaches 0. */
export const AIM_ERROR_ZERO_M = 0.6;

/** Weights of the four components in the overall score (sum to 1). Slope leads
 *  — it's the skill that stays legal in competition (doc §5.1). */
export const SCORE_WEIGHTS = { slope: 0.4, breakSide: 0.2, aim: 0.2, pace: 0.2 } as const;

/** Linear 1..0 credit for an error, clamped: 0 error → 1, ≥ zeroAt → 0. */
function credit(error: number, zeroAt: number): number {
    return Math.max(0, 1 - error / zeroAt);
}

/**
 * Score one estimate against the computed read. Pure — same inputs, same score.
 * The overall `score` is a weighted blend (slope-led) mapped to 0..100; the
 * per-field errors are always exact so the UI can show the raw miss too.
 */
export function scoreEstimate(
    estimate: PuttEstimate,
    truth: PuttGroundTruth,
): PuttEstimateScore {
    const slopeErrorPct = Math.abs(estimate.slopePct - truth.slopePct);
    const breakSideCorrect = estimate.breakSide === truth.breakSide;
    const aimErrorM = Math.abs(estimate.aimOffsetM - truth.aimOffsetM);
    const paceErrorM = Math.abs(estimate.playsLikeM - truth.playsLikeM);

    const blend =
        SCORE_WEIGHTS.slope * credit(slopeErrorPct, SLOPE_ERROR_ZERO_PCT) +
        SCORE_WEIGHTS.breakSide * (breakSideCorrect ? 1 : 0) +
        SCORE_WEIGHTS.aim * credit(aimErrorM, AIM_ERROR_ZERO_M) +
        SCORE_WEIGHTS.pace * credit(paceErrorM, PACE_ERROR_ZERO_M);

    return {
        slopeErrorPct,
        breakSideCorrect,
        aimErrorM,
        paceErrorM,
        score: Math.round(blend * 100),
    };
}
