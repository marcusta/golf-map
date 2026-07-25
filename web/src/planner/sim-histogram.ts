// Presentation helpers for the simulate panel (feature-hole-sim-and-variants
// §5): turn a `simulateChain` pmf into the five par-relative buckets the
// histogram renders — P(eagle)…P(double+) — plus the small label formatters
// the panel and the E2E hooks share.
//
// Pure: no DOM, no signals, no MapLibre. `simulateChain` already returns a
// DENSE pmf indexed by integer hole score (index k = P(hole out in exactly k
// strokes)), so bucketing is a straight regroup around par — no re-binning of
// continuous values, no interpolation. The two open ends carry the tails:
// everything at or below par−2 lands in "Eagle+", everything at or above
// par+2 lands in "Double+". That keeps the bucket set FIXED (5 rows) whatever
// the pmf's range, so stacked branch comparison rows line up column-for-column.

/** One histogram row: a par-relative bucket and the probability mass in it. */
export interface ScoreBucket {
    /** The bucket's stroke count (the edge score for the two open buckets). */
    strokes: number;
    /** Par-relative offset: -2 = eagle-or-better … +2 = double-or-worse. */
    relative: number;
    /** Display label ("Eagle+", "Birdie", "Par", "Bogey", "Double+"). */
    label: string;
    /** Probability mass in the bucket (0..1). */
    prob: number;
    /** True for the two cumulative ends (their label carries the "+"). */
    open: boolean;
}

/** Lowest par-relative bucket (cumulative: eagle or better). */
export const BUCKET_MIN_RELATIVE = -2;
/** Highest par-relative bucket (cumulative: double bogey or worse). */
export const BUCKET_MAX_RELATIVE = 2;

/**
 * Golf's name for a par-relative score (-2 → "Eagle", +1 → "Bogey"). Beyond
 * the named range it degrades to a signed count ("+4"), which only shows up
 * in tooltips — the histogram itself never goes past ±2.
 */
export function parRelativeLabel(relative: number): string {
    switch (relative) {
        case -4: return 'Condor';
        case -3: return 'Albatross';
        case -2: return 'Eagle';
        case -1: return 'Birdie';
        case 0: return 'Par';
        case 1: return 'Bogey';
        case 2: return 'Double bogey';
        case 3: return 'Triple bogey';
        default: return relative > 0 ? `+${relative}` : String(relative);
    }
}

/** Bucket labels: the open ends get a "+" ("Eagle+" = eagle or better). */
function bucketLabel(relative: number): string {
    if (relative === BUCKET_MIN_RELATIVE) return 'Eagle+';
    if (relative === BUCKET_MAX_RELATIVE) return 'Double+';
    return parRelativeLabel(relative);
}

/**
 * The five par-relative buckets for a pmf. Mass below the lowest bucket folds
 * into it and mass above the highest folds into that one, so the returned
 * probabilities always sum to the pmf's total mass (1 for a real result).
 *
 * `par` is the hole's par; a branch that starts partway down the hole must be
 * simulated from the tee-equivalent (its `strokesBefore` added into the pmf by
 * the caller) for the labels to mean anything — see `shiftPmf`.
 */
export function buildHistogram(pmf: readonly number[], par: number): ScoreBucket[] {
    const buckets: ScoreBucket[] = [];
    for (let relative = BUCKET_MIN_RELATIVE; relative <= BUCKET_MAX_RELATIVE; relative++) {
        const strokes = par + relative;
        let prob = 0;
        if (relative === BUCKET_MIN_RELATIVE) {
            for (let k = 0; k <= strokes; k++) prob += pmf[k] ?? 0;
        } else if (relative === BUCKET_MAX_RELATIVE) {
            for (let k = strokes; k < pmf.length; k++) prob += pmf[k] ?? 0;
        } else {
            prob = pmf[strokes] ?? 0;
        }
        buckets.push({
            strokes,
            relative,
            label: bucketLabel(relative),
            prob,
            open: relative === BUCKET_MIN_RELATIVE || relative === BUCKET_MAX_RELATIVE,
        });
    }
    return buckets;
}

/**
 * Shift a pmf by the strokes already played to reach the branch's decision
 * point, so a mid-hole branch's distribution is expressed in HOLE SCORE (what
 * par-relative labels mean) rather than strokes-from-here. `strokesBefore` is
 * the option chip's own field, so panel and chip stay in the same units (O4).
 */
export function shiftPmf(pmf: readonly number[], strokesBefore: number): number[] {
    if (strokesBefore <= 0) return [...pmf];
    const out = new Array<number>(pmf.length + strokesBefore).fill(0);
    for (let k = 0; k < pmf.length; k++) out[k + strokesBefore] = pmf[k];
    return out;
}

/** "78%" — the panel's one probability format (rounded, no decimals). */
export function formatPercent(prob: number): string {
    return `${Math.round(prob * 100)}%`;
}

/** §5's survival readout: "plan survives: 78%". */
export function onScriptLabel(onScriptRate: number): string {
    return `plan survives: ${formatPercent(onScriptRate)}`;
}

/** "mean 4.31" — shown beside the branch's existing EV chip (they should agree). */
export function meanLabel(mean: number): string {
    return `mean ${mean.toFixed(2)}`;
}
