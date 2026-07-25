// Closeout score distribution (feature-hole-sim-and-variants.md, decision V2)
// — the Broadie expected-strokes table, upgraded from a MEAN to a pmf over
// integer strokes-to-hole-out. This is the "distributionised expected
// strokes" the whole-hole simulator draws from whenever a rollout leaves the
// authored script (§V1): it prices the rest of the hole with the SAME
// baseline every EV number on screen already trusts, but as a spread instead
// of a point.
//
// Construction (deterministic, NO sampling):
//   μ  = shotsToHoleOut(distanceM, lie)                    — table value, unchanged
//   f  = ⌊μ⌋,  frac = μ − f
//   support {f, f+1, f+2}, masses:
//     P(f+2) = w · frac                 (w = per-lie overdispersion weight)
//     P(f+1) = frac · (1 − 2w)
//     P(f)   = 1 − frac + w · frac
//   ⇒ Σ P = 1 and Σ k·P(k) = f + frac = μ EXACTLY (mean-pinned, any w).
//
// The per-lie overdispersion weight `w` is the ONE tunable: it decides how
// much of the fractional mean-excess sits at f+2 (a "blow-up" bucket) versus
// f+1. Green tightest, recovery loosest — the §8.1 proposed values, marked
// below as calibration targets for the player model (feature-player-model.md
// §V9 will fit these against real dispersions).
//
// GREEN one-putt anchor (§V2): because the green floor is 1 for any putt
// inside ~15 ft (μ < 2) and μ comes straight from Broadie's putting row,
// P(f)=P(1)=1−frac(1−w) IS the make% implied by the putting table
// (≈ 2−μ, the two-putt-max make rate, with a tiny w·frac three-putt tail).
// We deliberately do NOT read the uncalibrated green-reading holed-prob curve
// (putt.ts §3.5) — the table's own mean is the only anchor until that curve
// is calibrated. Beyond ~15 ft the floor rises to 2 and P(1 putt) is 0, as it
// should be (you do not one-putt from 60 ft).
//
// PENALTY (§V1.5 / D4): a penalty lie closes out as 1 + rough at the same
// distance. We build it as the rough pmf shifted up one stroke, so the mean
// is exactly 1 + μ_rough and the SHAPE is rough's — no separate penalty
// overdispersion constant is needed (its table entry below is unused).
//
// Conventions match the rest of shared/strategy: pure, zero-dep, projected
// meters in, integer-indexed pmf out. Swift-mirrorable (no closures, no
// table state) when an on-course consumer needs live distributions.

import { HOLED_DISTANCE_M, shotsToHoleOut } from './expected-strokes';
import type { Lie } from './lie';

/**
 * Per-lie OVERDISPERSION weights — the fraction of the fractional mean-excess
 * placed in the f+2 ("blow-up") bucket (§8.1 proposed values). CALIBRATION
 * TARGETS: feature-player-model.md (§V9) refits these against real per-player
 * dispersions; the sim inherits whatever they become with zero code change.
 *
 *   green   .02  tap-ins and lag putts are tight
 *   fairway .08  a clean full-swing lie
 *   rough   .12  chunkier miss tail
 *   sand    .15  awkward-distance blow-ups
 *   recovery.25  punch-outs fan the widest
 *
 * `tee` reuses the fairway weight (a teed full swing; the 'tee' Lie only ever
 * prices shot 1 and is never a landing lie). `penalty` is unused — penalty
 * distributions are built by shifting rough (see module header / D4).
 */
export const OVERDISPERSION_BY_LIE: Readonly<Record<Lie, number>> = {
    green: 0.02,
    fairway: 0.08,
    tee: 0.08,
    rough: 0.12,
    sand: 0.15,
    recovery: 0.25,
    penalty: 0.12,
};

/**
 * Probability mass function over INTEGER strokes to hole out from
 * `distanceM` on `lie`. Index k = P(hole out in exactly k strokes); the
 * array is dense from index 0 up to its last non-zero support point.
 *
 * - `distanceM < HOLED_DISTANCE_M` ⇒ already holed ⇒ `[1]` (index 0 = P(0)).
 * - Otherwise index 0 is 0 and mass lives on {⌊μ⌋, ⌊μ⌋+1, ⌊μ⌋+2} (§V2),
 *   with the mean pinned exactly to `shotsToHoleOut(distanceM, lie)`.
 *
 * The returned pmf always sums to 1 and its mean equals the table μ to
 * floating-point exactness (property-pinned).
 */
export function strokesDistribution(distanceM: number, lie: Lie): ReadonlyArray<number> {
    if (distanceM < HOLED_DISTANCE_M) return [1];

    // D4: penalty closes out as 1 + rough(distance). Shift the rough pmf up
    // one stroke — mean becomes 1 + μ_rough, shape stays rough's.
    if (lie === 'penalty') {
        const rough = strokesDistribution(distanceM, 'rough');
        const shifted = new Array<number>(rough.length + 1).fill(0);
        for (let k = 0; k < rough.length; k++) shifted[k + 1] = rough[k]!;
        return shifted;
    }

    const mu = shotsToHoleOut(distanceM, lie);
    const f = Math.floor(mu);
    const frac = mu - f;
    const w = OVERDISPERSION_BY_LIE[lie];

    const pmf = new Array<number>(f + 3).fill(0);
    // Integer mean (frac ~ 0): all mass at f, no spread to invent.
    if (frac <= 0) {
        pmf[f] = 1;
        return pmf;
    }
    pmf[f] = 1 - frac + w * frac;
    pmf[f + 1] = frac * (1 - 2 * w);
    pmf[f + 2] = w * frac;
    return pmf;
}

/**
 * Mean of a pmf (Σ k·P(k)) — a convenience for callers/tests that want to
 * assert the mean-pinning property without re-deriving the index math.
 */
export function distributionMean(pmf: ReadonlyArray<number>): number {
    let mean = 0;
    for (let k = 0; k < pmf.length; k++) mean += k * pmf[k]!;
    return mean;
}
