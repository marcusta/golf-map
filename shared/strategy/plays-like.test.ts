import { describe, expect, test } from 'bun:test';
import { pathSegmentStats, pathTotals, segmentStats, type StrategyPoint } from './plays-like';

// Fixtures A–C from the iOS PlaysLike tests (recon plays-like doc);
// points are (x=e, y=n, elevation) in meters, accuracy 1e-6.

const p = (x: number, y: number, elevation?: number | null): StrategyPoint =>
    elevation === undefined ? { x, y } : { x, y, elevation };

describe('segmentStats', () => {
    test('fixture A uphill: (0,0,50) → (100,0,60) plays like 110', () => {
        const s = segmentStats(p(0, 0, 50), p(100, 0, 60));
        expect(s.horizontalM).toBeCloseTo(100, 9);
        expect(s.elevationDeltaM!).toBeCloseTo(10, 9);
        expect(s.straightLineM!).toBeCloseTo(100.4987562, 6);
        expect(s.slopeDeg!).toBeCloseTo(5.71059314, 6);
        expect(s.slopePct!).toBeCloseTo(10, 9);
        expect(s.playsLikeSimpleM!).toBeCloseTo(110, 9);
    });

    test('fixture B downhill: (0,0,60) → (0,100,50) plays like 90', () => {
        const s = segmentStats(p(0, 0, 60), p(0, 100, 50));
        expect(s.horizontalM).toBeCloseTo(100, 9);
        expect(s.elevationDeltaM!).toBeCloseTo(-10, 9);
        expect(s.playsLikeSimpleM!).toBeCloseTo(90, 9);
        expect(s.slopePct!).toBeCloseTo(10, 9); // slope magnitudes are unsigned
        expect(s.slopeDeg!).toBeCloseTo(5.71059314, 6);
    });

    test('missing elevation (undefined or null) → only horizontal', () => {
        for (const s of [
            segmentStats(p(0, 0), p(100, 0, 60)),
            segmentStats(p(0, 0, 50), p(100, 0, null)),
            segmentStats(p(0, 0, null), p(100, 0)),
        ]) {
            expect(s.horizontalM).toBeCloseTo(100, 9);
            expect(s.elevationDeltaM).toBeUndefined();
            expect(s.straightLineM).toBeUndefined();
            expect(s.slopeDeg).toBeUndefined();
            expect(s.slopePct).toBeUndefined();
            expect(s.playsLikeSimpleM).toBeUndefined();
        }
    });

    test('zero elevation delta → plays like the horizontal distance', () => {
        const s = segmentStats(p(0, 0, 20), p(60, 80, 20));
        expect(s.horizontalM).toBeCloseTo(100, 9);
        expect(s.playsLikeSimpleM!).toBeCloseTo(100, 9);
        expect(s.slopeDeg!).toBeCloseTo(0, 12);
    });

    test('zero-run guard: coincident points with elevation delta → slopePct 0', () => {
        const s = segmentStats(p(0, 0, 10), p(0, 0, 15));
        expect(s.horizontalM).toBe(0);
        expect(s.slopePct).toBe(0); // guarded, not NaN/Infinity
        expect(s.slopeDeg!).toBeCloseTo(90, 9); // atan2(5, 0)
        expect(s.playsLikeSimpleM!).toBeCloseTo(5, 12);
    });
});

describe('pathSegmentStats / pathTotals', () => {
    const fixtureC = [p(0, 0, 10), p(100, 0, 20), p(200, 0, 15)];

    test('fixture C path: totals 200 / +5 / 205, measuredSegments 2', () => {
        const t = pathTotals(fixtureC);
        expect(t.horizontalM).toBeCloseTo(200, 9);
        expect(t.elevationDeltaM!).toBeCloseTo(5, 9);
        expect(t.straightLineM!).toBeCloseTo(100.4987562 + 100.1249219, 6); // sum of chords
        expect(t.playsLikeSimpleM!).toBeCloseTo(205, 9);
        expect(t.measuredSegments).toBe(2);
        expect(t.totalSegments).toBe(2);
        expect(t.slopePct!).toBeCloseTo(2.5, 9); // |+5| over 200 measured run
    });

    test('pathSegmentStats returns points.length − 1 entries', () => {
        expect(pathSegmentStats(fixtureC).length).toBe(2);
        expect(pathSegmentStats([p(0, 0)]).length).toBe(0);
        expect(pathSegmentStats([]).length).toBe(0);
    });

    test('mixed path: horizontal sums all segments, elevation only measured ones', () => {
        // Middle point unmeasured → both adjacent segments drop out of elevation totals.
        const t = pathTotals([p(0, 0, 10), p(100, 0), p(200, 0, 15), p(200, 100, 25)]);
        expect(t.horizontalM).toBeCloseTo(300, 9);
        expect(t.measuredSegments).toBe(1); // only (200,0,15)→(200,100,25)
        expect(t.totalSegments).toBe(3);
        expect(t.elevationDeltaM!).toBeCloseTo(10, 9);
        expect(t.playsLikeSimpleM!).toBeCloseTo(110, 9);
        expect(t.slopePct!).toBeCloseTo(10, 9); // 10 rise over the 100 m measured run
    });

    test('no measured segments → elevation totals undefined, horizontal kept', () => {
        const t = pathTotals([p(0, 0), p(100, 0), p(200, 0)]);
        expect(t.horizontalM).toBeCloseTo(200, 9);
        expect(t.elevationDeltaM).toBeUndefined();
        expect(t.straightLineM).toBeUndefined();
        expect(t.slopeDeg).toBeUndefined();
        expect(t.slopePct).toBeUndefined();
        expect(t.playsLikeSimpleM).toBeUndefined();
        expect(t.measuredSegments).toBe(0);
        expect(t.totalSegments).toBe(2);
    });

    test('empty and single-point paths', () => {
        expect(pathTotals([]).totalSegments).toBe(0);
        expect(pathTotals([]).horizontalM).toBe(0);
        expect(pathTotals([p(1, 2, 3)]).totalSegments).toBe(0);
    });
});
