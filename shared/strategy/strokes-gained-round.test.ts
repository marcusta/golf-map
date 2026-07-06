import { describe, expect, test } from 'bun:test';
import { shotsToHoleOut } from './expected-strokes';
import {
    aggregateStrokesGained,
    categorize,
    distanceBand,
    holeStrokesGained,
    roundStrokesGained,
    type HoleRound,
    type RecordedStroke,
} from './strokes-gained-round';

const YD = 0.9144;
const HOLE = { x: 0, y: 0 };

function stroke(x: number, y: number, lie: RecordedStroke['lie'], opts: Partial<RecordedStroke> = {}): RecordedStroke {
    return {
        position: { x, y },
        lie,
        penaltyStrokes: opts.penaltyStrokes ?? 0,
        shotType: opts.shotType ?? 'full',
    };
}

describe('distanceBand', () => {
    test('boundaries: 0-30 / 30-100 / 100-150 / 150-200 / 200+', () => {
        expect(distanceBand(0)).toBe('0-30m');
        expect(distanceBand(29.9)).toBe('0-30m');
        expect(distanceBand(30)).toBe('30-100m');
        expect(distanceBand(99.9)).toBe('30-100m');
        expect(distanceBand(100)).toBe('100-150m');
        expect(distanceBand(149.9)).toBe('100-150m');
        expect(distanceBand(150)).toBe('150-200m');
        expect(distanceBand(199.9)).toBe('150-200m');
        expect(distanceBand(200)).toBe('200m+');
        expect(distanceBand(500)).toBe('200m+');
    });
});

describe('categorize', () => {
    test('stroke 0 on a par 4/5 is off-tee', () => {
        const s = stroke(400, 0, 'tee');
        expect(categorize(s, 0, 4, 400)).toBe('off-tee');
        expect(categorize(s, 0, 5, 400)).toBe('off-tee');
    });

    test('stroke 0 on a par 3 is NOT off-tee — falls through to approach/short by distance', () => {
        const s = stroke(160 * YD, 0, 'tee');
        expect(categorize(s, 0, 3, 160 * YD)).toBe('approach');
        const short = stroke(20, 0, 'tee');
        expect(categorize(short, 0, 3, 20)).toBe('short');
    });

    test('a recorded putt is putting regardless of distance', () => {
        const s = stroke(5, 0, 'green', { shotType: 'putt' });
        expect(categorize(s, 3, 4, 5)).toBe('putting');
        const longPutt = stroke(35, 0, 'green', { shotType: 'putt' });
        expect(categorize(longPutt, 3, 4, 35)).toBe('putting');
    });

    test('non-putt under 30 m is short; at/over 30 m is approach', () => {
        const near = stroke(29, 0, 'fairway');
        expect(categorize(near, 1, 4, 29)).toBe('short');
        const far = stroke(30, 0, 'fairway');
        expect(categorize(far, 1, 4, 30)).toBe('approach');
    });

    test('partial shot type still counts as approach/short (only "putt" is putting)', () => {
        const s = stroke(50, 0, 'fairway', { shotType: 'partial' });
        expect(categorize(s, 1, 4, 50)).toBe('approach');
    });
});

describe('holeStrokesGained — hand-computed fixtures', () => {
    test('a known 3-shot par-4 hole matches hand computation', () => {
        // Tee at 380 yd, drive to 150 yd fairway, approach to 5 ft green, holed.
        const d0 = 380 * YD;
        const d1 = 150 * YD;
        const d2 = 5 * 0.3048;

        const round: HoleRound = {
            par: 4,
            hole: HOLE,
            strokes: [
                stroke(d0, 0, 'tee'),
                stroke(d1, 0, 'fairway'),
                stroke(d2, 0, 'green', { shotType: 'putt' }),
            ],
        };

        const sg = holeStrokesGained(round);
        expect(sg).toHaveLength(3);

        const sg0 = shotsToHoleOut(d0, 'tee') - shotsToHoleOut(d1, 'fairway') - 1;
        const sg1 = shotsToHoleOut(d1, 'fairway') - shotsToHoleOut(d2, 'green') - 1;
        const sg2 = shotsToHoleOut(d2, 'green') - 0 - 1;

        expect(sg[0].strokesGained).toBeCloseTo(sg0, 12);
        expect(sg[1].strokesGained).toBeCloseTo(sg1, 12);
        expect(sg[2].strokesGained).toBeCloseTo(sg2, 12);

        expect(sg[0].category).toBe('off-tee');
        expect(sg[1].category).toBe('approach');
        expect(sg[2].category).toBe('putting');

        expect(sg[0].distanceBand).toBe('200m+');
        expect(sg[1].distanceBand).toBe('100-150m');
        expect(sg[2].distanceBand).toBe('0-30m');
    });

    test('a holed approach (last shot holes from the fairway) gains baseline(from) - 1', () => {
        const d0 = 100 * YD;
        const round: HoleRound = {
            par: 4,
            hole: HOLE,
            strokes: [stroke(d0, 0, 'fairway')],
        };
        const sg = holeStrokesGained(round);
        expect(sg).toHaveLength(1);
        expect(sg[0].strokesGained).toBeCloseTo(shotsToHoleOut(d0, 'fairway') - 1, 12);
    });

    test('a penalty stroke subtracts directly from that stroke\'s SG', () => {
        const d0 = 380 * YD;
        const d1 = 150 * YD;

        const clean: HoleRound = {
            par: 4,
            hole: HOLE,
            strokes: [stroke(d0, 0, 'tee'), stroke(d1, 0, 'fairway')],
        };
        const penalized: HoleRound = {
            par: 4,
            hole: HOLE,
            strokes: [stroke(d0, 0, 'tee', { penaltyStrokes: 1 }), stroke(d1, 0, 'fairway')],
        };

        const sgClean = holeStrokesGained(clean)[0].strokesGained;
        const sgPenalized = holeStrokesGained(penalized)[0].strokesGained;
        expect(sgPenalized).toBeCloseTo(sgClean - 1, 12);
    });

    test('a lost-ball penalty at the last recorded stroke still subtracts (even though it "holes")', () => {
        // Degenerate but valid input shape: last stroke incurs a penalty too.
        const d0 = 100 * YD;
        const round: HoleRound = {
            par: 4,
            hole: HOLE,
            strokes: [stroke(d0, 0, 'fairway', { penaltyStrokes: 2 })],
        };
        const sg = holeStrokesGained(round);
        expect(sg[0].strokesGained).toBeCloseTo(shotsToHoleOut(d0, 'fairway') - 1 - 2, 12);
    });

    test('distance is computed via the pure planar hypot, matching an off-axis hole position', () => {
        const holeAt = { x: 10, y: 10 };
        const p0 = { x: 10, y: 10 + 100 };
        const round: HoleRound = {
            par: 3,
            hole: holeAt,
            strokes: [{ position: p0, lie: 'tee', penaltyStrokes: 0, shotType: 'full' }],
        };
        const sg = holeStrokesGained(round);
        expect(sg[0].distanceM).toBeCloseTo(100, 9);
    });
});

describe('aggregateStrokesGained / roundStrokesGained', () => {
    test('category + distance-band bucketing sums and means correctly across a round', () => {
        const holeA: HoleRound = {
            par: 4,
            hole: HOLE,
            strokes: [
                stroke(380 * YD, 0, 'tee'),          // off-tee, 200m+
                stroke(150 * YD, 0, 'fairway'),      // approach, 100-150m
                stroke(5 * 0.3048, 0, 'green', { shotType: 'putt' }), // putting, 0-30m
            ],
        };
        const holeB: HoleRound = {
            par: 3,
            hole: HOLE,
            strokes: [
                stroke(160 * YD, 0, 'tee'),          // approach (par-3 tee, falls through), 100-150m
                stroke(4 * 0.3048, 0, 'green', { shotType: 'putt' }), // putting, 0-30m
            ],
        };

        const { perHole, summary } = roundStrokesGained([holeA, holeB]);
        expect(perHole).toHaveLength(2);
        expect(perHole[0]).toHaveLength(3);
        expect(perHole[1]).toHaveLength(2);

        const allShots = perHole.flat();
        expect(summary.total.count).toBe(5);
        const expectedTotal = allShots.reduce((s, x) => s + x.strokesGained, 0);
        expect(summary.total.totalStrokesGained).toBeCloseTo(expectedTotal, 9);
        expect(summary.total.meanStrokesGained).toBeCloseTo(expectedTotal / 5, 9);

        // Category buckets: off-tee has 1 entry (holeA stroke 0 only — holeB's
        // par-3 tee shot is NOT off-tee per categorize()).
        expect(summary.byCategory['off-tee'].count).toBe(1);
        expect(summary.byCategory.approach.count).toBe(2); // holeA fairway + holeB tee
        expect(summary.byCategory.putting.count).toBe(2);
        expect(summary.byCategory.short.count).toBe(0);

        // Distance-band buckets.
        expect(summary.byDistanceBand['200m+'].count).toBe(1);
        expect(summary.byDistanceBand['100-150m'].count).toBe(2);
        expect(summary.byDistanceBand['0-30m'].count).toBe(2);
        expect(summary.byDistanceBand['30-100m'].count).toBe(0);
        expect(summary.byDistanceBand['150-200m'].count).toBe(0);
    });

    test('aggregateStrokesGained over an empty list returns all-zero buckets', () => {
        const summary = aggregateStrokesGained([]);
        expect(summary.total.count).toBe(0);
        expect(summary.total.meanStrokesGained).toBe(0);
        for (const cat of Object.values(summary.byCategory)) {
            expect(cat.count).toBe(0);
        }
        for (const band of Object.values(summary.byDistanceBand)) {
            expect(band.count).toBe(0);
        }
    });
});
