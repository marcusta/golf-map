// Pure helpers behind the simulate panel's histogram (feature-hole-sim-and-
// variants §5): par-relative bucketing, the mid-hole pmf shift, and the label
// formats the panel and the E2E hooks share.

import { test, expect, describe } from 'bun:test';
import {
    BUCKET_MAX_RELATIVE,
    BUCKET_MIN_RELATIVE,
    buildHistogram,
    formatPercent,
    meanLabel,
    onScriptLabel,
    parRelativeLabel,
    shiftPmf,
} from '../src/planner/sim-histogram';

/** pmf indexed by hole score: index k = P(holed in exactly k). */
function pmfFrom(entries: Record<number, number>): number[] {
    const max = Math.max(...Object.keys(entries).map(Number));
    const out = new Array<number>(max + 1).fill(0);
    for (const [k, p] of Object.entries(entries)) out[Number(k)] = p;
    return out;
}

describe('buildHistogram', () => {
    test('always returns the five fixed par-relative rows, in order', () => {
        const buckets = buildHistogram(pmfFrom({ 4: 1 }), 4);
        expect(buckets).toHaveLength(5);
        expect(buckets.map(b => b.relative)).toEqual([-2, -1, 0, 1, 2]);
        expect(buckets.map(b => b.label))
            .toEqual(['Eagle+', 'Birdie', 'Par', 'Bogey', 'Double+']);
        // Fixed rows are what lets stacked branch comparison line up column
        // for column, whatever range each branch's pmf happens to span.
        expect(buckets[0].relative).toBe(BUCKET_MIN_RELATIVE);
        expect(buckets[4].relative).toBe(BUCKET_MAX_RELATIVE);
    });

    test('interior buckets take the exact pmf entry for that score', () => {
        const buckets = buildHistogram(pmfFrom({ 3: 0.2, 4: 0.5, 5: 0.3 }), 4);
        expect(buckets[1].prob).toBeCloseTo(0.2, 10); // birdie = 3
        expect(buckets[2].prob).toBeCloseTo(0.5, 10); // par = 4
        expect(buckets[3].prob).toBeCloseTo(0.3, 10); // bogey = 5
        expect(buckets[2].strokes).toBe(4);
    });

    test('the open ends are CUMULATIVE tails, so the buckets keep all the mass', () => {
        // par 4: a hole-out in 1 and in 2 both belong in "Eagle+"; 6 and 9 both
        // in "Double+". Nothing may be dropped — the histogram is a full
        // distribution, not a window onto one.
        const pmf = pmfFrom({ 1: 0.05, 2: 0.05, 4: 0.4, 6: 0.3, 9: 0.2 });
        const buckets = buildHistogram(pmf, 4);
        expect(buckets[0].prob).toBeCloseTo(0.1, 10);
        expect(buckets[4].prob).toBeCloseTo(0.5, 10);
        expect(buckets.reduce((sum, b) => sum + b.prob, 0)).toBeCloseTo(1, 10);
        expect(buckets[0].open).toBe(true);
        expect(buckets[4].open).toBe(true);
        expect(buckets[2].open).toBe(false);
    });

    test('par shifts which strokes each bucket names', () => {
        const pmf = pmfFrom({ 3: 0.5, 5: 0.5 });
        expect(buildHistogram(pmf, 3).map(b => b.strokes)).toEqual([1, 2, 3, 4, 5]);
        expect(buildHistogram(pmf, 5).map(b => b.strokes)).toEqual([3, 4, 5, 6, 7]);
        // Par 3 with mass at 5 = double or worse; par 5 with mass at 3 = eagle+.
        expect(buildHistogram(pmf, 3)[4].prob).toBeCloseTo(0.5, 10);
        expect(buildHistogram(pmf, 5)[0].prob).toBeCloseTo(0.5, 10);
    });

    test('a short pmf simply leaves the upper buckets empty (no out-of-range reads)', () => {
        const buckets = buildHistogram([0, 0, 1], 4); // only a 2 is possible
        expect(buckets[0].prob).toBeCloseTo(1, 10);
        expect(buckets.slice(1).every(b => b.prob === 0)).toBe(true);
    });
});

describe('shiftPmf', () => {
    test('expresses a mid-hole branch in HOLE SCORE by pushing mass up', () => {
        // 2 strokes already played: "1 more from here" is a hole score of 3.
        expect(shiftPmf([0, 0.7, 0.3], 2)).toEqual([0, 0, 0, 0.7, 0.3]);
    });

    test('is a copy, not an alias, and a no-op at the tee', () => {
        const pmf = [0, 1];
        const out = shiftPmf(pmf, 0);
        expect(out).toEqual([0, 1]);
        expect(out).not.toBe(pmf);
        expect(shiftPmf(pmf, -1)).toEqual([0, 1]);
    });

    test('shift + bucket puts a mid-hole branch under the right par-relative label', () => {
        // One stroke played, then a 3 more → 4 = par on a par 4.
        const buckets = buildHistogram(shiftPmf([0, 0, 0, 1], 1), 4);
        expect(buckets[2].prob).toBeCloseTo(1, 10);
    });
});

describe('labels', () => {
    test('parRelativeLabel names the golf scores and degrades to a signed count', () => {
        expect(parRelativeLabel(-3)).toBe('Albatross');
        expect(parRelativeLabel(-2)).toBe('Eagle');
        expect(parRelativeLabel(-1)).toBe('Birdie');
        expect(parRelativeLabel(0)).toBe('Par');
        expect(parRelativeLabel(1)).toBe('Bogey');
        expect(parRelativeLabel(2)).toBe('Double bogey');
        expect(parRelativeLabel(3)).toBe('Triple bogey');
        expect(parRelativeLabel(5)).toBe('+5');
        expect(parRelativeLabel(-5)).toBe('-5');
    });

    test('percent / survival / mean formats', () => {
        expect(formatPercent(0.784)).toBe('78%');
        expect(formatPercent(1)).toBe('100%');
        expect(onScriptLabel(0.78)).toBe('plan survives: 78%');
        expect(meanLabel(4.3149)).toBe('mean 4.31');
    });
});
