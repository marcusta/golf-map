// Expected strokes to hole out ("shots to hole out") — the DECADE plan's
// Phase-A keystone. Pure lookup + linear interpolation over the published
// Broadie PGA-Tour baseline (Mark Broadie, *Every Shot Counts*), converted
// to meters. One table, no skill tiers (decision D3: player skill enters
// via the player's own carry/dispersion inputs; a uniform skill offset
// cancels in aim argmin anyway).
//
// Units: meters in, strokes out. Anchor tables below are written in the
// SOURCE units (yards for full shots, feet for putting) and converted once
// at module init — keeps every number greppable against the book.
//
// Table quirks are real and preserved (decision D18): the tee row dips
// 120→140 yd, sand has the awkward-distance hump (60–140 yd), recovery is
// flat-ish below 140 yd. Do not "fix" them; monotonicity guarantees apply
// to fairway/rough/green only. Values reproduced from the published table
// to ±0.03 strokes pending the D19 verification pass — aim decisions are
// robust to that band, strokes-gained REPORTING is not.
//
// Boundary rules (decision D20): d < 0.05 m → 0 (holed); below the first
// anchor → clamp to the first anchor; above the last → linear
// extrapolation along the final segment.
//
// Penalty (decision D4): penalty = 1 + rough at the same distance
// (stroke-and-drop near the point of entry, rough-equivalent lie, no
// drop-back distance in v1).

import type { Lie } from './lie';

const YD = 0.9144; // meters per yard
const FT = 0.3048; // meters per foot

/** [distance, expectedStrokes] anchors, distance in SOURCE units. */
type Anchors = readonly (readonly [number, number])[];

// --- Broadie PGA-Tour baseline, source units -------------------------------

// Off the tee (yards). Includes the real 120→140 dip (short par-3s).
const TEE_YD: Anchors = [
    [100, 2.92], [120, 2.99], [140, 2.97], [160, 2.99], [180, 3.05],
    [200, 3.12], [220, 3.17], [240, 3.25], [260, 3.45], [280, 3.65],
    [300, 3.71], [320, 3.79], [340, 3.86], [360, 3.92], [380, 3.96],
    [400, 3.99], [420, 4.02], [440, 4.08], [460, 4.17], [480, 4.28],
    [500, 4.41], [520, 4.54], [540, 4.65], [560, 4.74], [580, 4.79],
    [600, 4.82],
];

// Fairway (yards).
const FAIRWAY_YD: Anchors = [
    [20, 2.40], [40, 2.60], [60, 2.70], [80, 2.75], [100, 2.80],
    [120, 2.85], [140, 2.91], [160, 2.98], [180, 3.08], [200, 3.19],
    [220, 3.32], [240, 3.45], [260, 3.58], [280, 3.69], [300, 3.78],
    [320, 3.84], [340, 3.88], [360, 3.95], [380, 4.03], [400, 4.11],
    [420, 4.15], [440, 4.20], [460, 4.29], [480, 4.40], [500, 4.53],
    [520, 4.66], [540, 4.78], [560, 4.86], [580, 4.91], [600, 4.94],
];

// Rough (yards).
const ROUGH_YD: Anchors = [
    [20, 2.59], [40, 2.78], [60, 2.91], [80, 2.96], [100, 3.02],
    [120, 3.08], [140, 3.15], [160, 3.23], [180, 3.31], [200, 3.42],
    [220, 3.53], [240, 3.64], [260, 3.74], [280, 3.83], [300, 3.90],
    [320, 3.95], [340, 4.02], [360, 4.11], [380, 4.21], [400, 4.30],
    [420, 4.34], [440, 4.39], [460, 4.48], [480, 4.59], [500, 4.72],
    [520, 4.85], [540, 4.97], [560, 5.05], [580, 5.10], [600, 5.13],
];

// Sand (yards). Greenside sand (20 yd) is EASIER than greenside rough;
// the 60–140 yd hump is the awkward-distance zone. Both are real.
const SAND_YD: Anchors = [
    [20, 2.53], [40, 2.82], [60, 3.15], [80, 3.24], [100, 3.23],
    [120, 3.21], [140, 3.22], [160, 3.28], [180, 3.40], [200, 3.55],
    [220, 3.70], [240, 3.84], [260, 3.93], [280, 4.00], [300, 4.04],
    [320, 4.12], [340, 4.26], [360, 4.41], [380, 4.55], [400, 4.69],
    [420, 4.73], [440, 4.78], [460, 4.87], [480, 4.98], [500, 5.11],
    [520, 5.24], [540, 5.36], [560, 5.44], [580, 5.49], [600, 5.52],
];

// Recovery (yards) — trees / forced punch-out. Flat-ish below 140 yd
// (the punch-out costs what it costs regardless of remaining distance).
const RECOVERY_YD: Anchors = [
    [100, 3.80], [120, 3.78], [140, 3.80], [160, 3.81], [180, 3.82],
    [200, 3.87], [220, 3.92], [240, 3.97], [260, 4.03], [280, 4.10],
    [300, 4.20], [320, 4.31], [340, 4.44], [360, 4.56], [380, 4.66],
    [400, 4.75], [420, 4.79], [440, 4.84], [460, 4.93], [480, 5.04],
    [500, 5.17], [520, 5.30], [540, 5.42], [560, 5.50], [580, 5.55],
    [600, 5.58],
];

// Putting (FEET). The 1 ft anchor is synthetic (decision D20): from ≤1 ft
// pros hole ~100%, so tap-ins price at 1.00 instead of the 3 ft value.
const GREEN_FT: Anchors = [
    [1, 1.00], [3, 1.04], [4, 1.13], [5, 1.23], [6, 1.34], [7, 1.42],
    [8, 1.50], [9, 1.56], [10, 1.61], [15, 1.78], [20, 1.87], [30, 1.98],
    [40, 2.06], [50, 2.14], [60, 2.21], [90, 2.40],
];

// --- Converted-to-meters anchors (exported for tests / SG analytics) -------

function toMeters(anchors: Anchors, unit: number): Anchors {
    return anchors.map(([d, s]) => [d * unit, s] as const);
}

/**
 * Baseline anchors in METERS per lie row. `penalty` has no row — it is
 * derived (1 + rough, decision D4). Exposed for tests and future
 * strokes-gained analytics; treat as read-only.
 */
export const EXPECTED_STROKES_ANCHORS_M: Readonly<Record<Exclude<Lie, 'penalty'>, Anchors>> = {
    tee: toMeters(TEE_YD, YD),
    fairway: toMeters(FAIRWAY_YD, YD),
    rough: toMeters(ROUGH_YD, YD),
    sand: toMeters(SAND_YD, YD),
    recovery: toMeters(RECOVERY_YD, YD),
    green: toMeters(GREEN_FT, FT),
};

/** Distance below which the ball counts as holed (decision D20), meters. */
export const HOLED_DISTANCE_M = 0.05;

/**
 * Expected strokes to hole out from `distanceM` on `lie` (Broadie PGA-Tour
 * baseline). Linear interpolation between anchors; boundary rules per
 * decision D20; penalty per decision D4 (1 + rough).
 */
export function shotsToHoleOut(distanceM: number, lie: Lie): number {
    if (distanceM < HOLED_DISTANCE_M) return 0;
    if (lie === 'penalty') return 1 + shotsToHoleOut(distanceM, 'rough');

    const anchors = EXPECTED_STROKES_ANCHORS_M[lie];
    const first = anchors[0];
    if (distanceM <= first[0]) return first[1];

    for (let i = 1; i < anchors.length; i++) {
        const [d1, s1] = anchors[i];
        if (distanceM <= d1) {
            const [d0, s0] = anchors[i - 1];
            return s0 + ((distanceM - d0) / (d1 - d0)) * (s1 - s0);
        }
    }

    // Beyond the last anchor: extrapolate along the final segment.
    const [dA, sA] = anchors[anchors.length - 2];
    const [dB, sB] = anchors[anchors.length - 1];
    return sB + ((distanceM - dB) / (dB - dA)) * (sB - sA);
}

/**
 * Strokes gained by ONE shot that moved the ball from (fromM, fromLie) to
 * (toM, toLie): baseline(from) − baseline(to) − 1. A holed shot (toM below
 * HOLED_DISTANCE_M) gains baseline(from) − 1. Positive = better than the
 * baseline player's average shot from there.
 */
export function strokesGained(fromM: number, fromLie: Lie, toM: number, toLie: Lie): number {
    return shotsToHoleOut(fromM, fromLie) - shotsToHoleOut(toM, toLie) - 1;
}
