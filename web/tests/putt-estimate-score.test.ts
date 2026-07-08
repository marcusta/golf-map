import { test, expect } from 'bun:test';
import {
    scoreEstimate,
    SLOPE_ERROR_ZERO_PCT,
    PACE_ERROR_ZERO_M,
    AIM_ERROR_ZERO_M,
    type PuttEstimate,
    type PuttGroundTruth,
} from '../src/planner/putt-estimate-score';

// Pure scoring for the training loop — a "hard algorithm" unit (TESTING.md
// rule 3): estimate vs computed-read ground truth, per-field errors + a score.

const TRUTH: PuttGroundTruth = {
    slopePct: 2,
    breakSide: 'left',
    aimOffsetM: -0.3, // aim left
    playsLikeM: 8,
};

const perfect: PuttEstimate = {
    slopePct: 2,
    breakSide: 'left',
    aimOffsetM: -0.3,
    playsLikeM: 8,
};

test('a perfect estimate scores 100 with zero errors', () => {
    const s = scoreEstimate(perfect, TRUTH);
    expect(s.slopeErrorPct).toBe(0);
    expect(s.breakSideCorrect).toBe(true);
    expect(s.aimErrorM).toBe(0);
    expect(s.paceErrorM).toBe(0);
    expect(s.score).toBe(100);
});

test('per-field errors are the exact unsigned differences', () => {
    const s = scoreEstimate(
        { slopePct: 3.5, breakSide: 'right', aimOffsetM: 0.1, playsLikeM: 7.2 },
        TRUTH,
    );
    expect(s.slopeErrorPct).toBeCloseTo(1.5, 10);
    expect(s.breakSideCorrect).toBe(false); // estimated right, actual left
    expect(s.aimErrorM).toBeCloseTo(0.4, 10); // |0.1 − (−0.3)|
    expect(s.paceErrorM).toBeCloseTo(0.8, 10); // |7.2 − 8|
});

test('a straight-vs-break side mismatch counts as a break-side miss', () => {
    const s = scoreEstimate({ ...perfect, breakSide: 'straight' }, TRUTH);
    expect(s.breakSideCorrect).toBe(false);
    expect(s.score).toBeLessThan(100);
});

test('slope credit tapers linearly to zero at the zero-error threshold', () => {
    // Only slope is off, by exactly the zero-at distance → slope credit 0.
    // score = 100 × (breakSide 0.2 + aim 0.2 + pace 0.2) = 60.
    const halfway = scoreEstimate(
        { ...perfect, slopePct: 2 + SLOPE_ERROR_ZERO_PCT },
        TRUTH,
    );
    expect(halfway.slopeErrorPct).toBeCloseTo(SLOPE_ERROR_ZERO_PCT, 10);
    expect(halfway.score).toBe(60);

    // Half the zero-at distance → half slope credit → +20 over the floor.
    const partial = scoreEstimate(
        { ...perfect, slopePct: 2 + SLOPE_ERROR_ZERO_PCT / 2 },
        TRUTH,
    );
    expect(partial.score).toBe(80);
});

test('errors beyond the zero thresholds never push the score negative', () => {
    const worst = scoreEstimate(
        {
            slopePct: 2 + SLOPE_ERROR_ZERO_PCT * 5,
            breakSide: 'right',
            aimOffsetM: TRUTH.aimOffsetM + AIM_ERROR_ZERO_M * 5,
            playsLikeM: TRUTH.playsLikeM + PACE_ERROR_ZERO_M * 5,
        },
        TRUTH,
    );
    expect(worst.score).toBe(0);
    expect(worst.slopeErrorPct).toBeGreaterThan(0);
});

test('slope carries more weight than any single other field', () => {
    // Nail everything but slope (which is a full miss) vs nail slope but miss
    // everything else fully. Slope-only should score higher (0.4 > 0.6? no —
    // slope weight 0.4; the OTHER three sum to 0.6). So slope-only = 40,
    // everything-but-slope = 60. Assert the weighting is as documented.
    const slopeOnly = scoreEstimate(
        {
            slopePct: 2,
            breakSide: 'right',
            aimOffsetM: TRUTH.aimOffsetM + AIM_ERROR_ZERO_M,
            playsLikeM: TRUTH.playsLikeM + PACE_ERROR_ZERO_M,
        },
        TRUTH,
    );
    expect(slopeOnly.score).toBe(40);
});
