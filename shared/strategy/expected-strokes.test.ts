import { describe, expect, test } from 'bun:test';
import {
    EXPECTED_STROKES_ANCHORS_M,
    HOLED_DISTANCE_M,
    shotsToHoleOut,
    strokesGained,
} from './expected-strokes';
import { lieFromFeatureType } from './lie';

const YD = 0.9144;
const FT = 0.3048;

describe('shotsToHoleOut', () => {
    test('holed: below the holed threshold → 0 for every lie', () => {
        for (const lie of ['tee', 'fairway', 'rough', 'sand', 'recovery', 'green', 'penalty'] as const) {
            expect(shotsToHoleOut(0, lie)).toBe(0);
            expect(shotsToHoleOut(HOLED_DISTANCE_M / 2, lie)).toBe(0);
        }
    });

    test('known anchors hit exactly (source-unit conversions)', () => {
        expect(shotsToHoleOut(100 * YD, 'fairway')).toBeCloseTo(2.80, 9);
        expect(shotsToHoleOut(400 * YD, 'tee')).toBeCloseTo(3.99, 9);
        expect(shotsToHoleOut(8 * FT, 'green')).toBeCloseTo(1.5, 9);
        expect(shotsToHoleOut(100 * YD, 'recovery')).toBeCloseTo(3.8, 9);
    });

    test('linear interpolation between anchors', () => {
        // Fairway 100 yd = 2.80, 120 yd = 2.85 → 110 yd = 2.825.
        expect(shotsToHoleOut(110 * YD, 'fairway')).toBeCloseTo(2.825, 9);
    });

    test('monotonic non-decreasing in distance (fairway/rough/green only — D18)', () => {
        for (const lie of ['fairway', 'rough', 'green'] as const) {
            let prev = 0;
            for (let d = 1; d <= 550; d += 1) {
                const s = shotsToHoleOut(d, lie);
                expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
                prev = s;
            }
        }
    });

    test('lie ordering at mid range (135 m): penalty > recovery > sand > rough > fairway', () => {
        const d = 135;
        const penalty = shotsToHoleOut(d, 'penalty');
        const recovery = shotsToHoleOut(d, 'recovery');
        const sand = shotsToHoleOut(d, 'sand');
        const rough = shotsToHoleOut(d, 'rough');
        const fairway = shotsToHoleOut(d, 'fairway');
        expect(penalty).toBeGreaterThan(recovery);
        expect(recovery).toBeGreaterThan(sand);
        expect(sand).toBeGreaterThan(rough);
        expect(rough).toBeGreaterThan(fairway);
    });

    test('greenside quirk preserved (18 m): sand EASIER than rough (D18)', () => {
        expect(shotsToHoleOut(18, 'sand')).toBeLessThan(shotsToHoleOut(18, 'rough'));
    });

    test('penalty = 1 + rough at the same distance (D4)', () => {
        for (const d of [30, 135, 250]) {
            expect(shotsToHoleOut(d, 'penalty')).toBeCloseTo(1 + shotsToHoleOut(d, 'rough'), 12);
        }
    });

    test('below first anchor clamps to the first anchor (D20)', () => {
        const [firstD, firstS] = EXPECTED_STROKES_ANCHORS_M.fairway[0];
        expect(shotsToHoleOut(firstD / 2, 'fairway')).toBeCloseTo(firstS, 12);
        // Tap-in putt prices at the synthetic 1 ft anchor, not the 3 ft value.
        expect(shotsToHoleOut(0.2, 'green')).toBeCloseTo(1.0, 12);
    });

    test('beyond last anchor extrapolates finitely and keeps increasing', () => {
        const anchors = EXPECTED_STROKES_ANCHORS_M.fairway;
        const [lastD, lastS] = anchors[anchors.length - 1];
        const beyond = shotsToHoleOut(lastD + 50, 'fairway');
        expect(Number.isFinite(beyond)).toBe(true);
        expect(beyond).toBeGreaterThan(lastS);
    });
});

describe('strokesGained', () => {
    test('holing a shot gains baseline(from) − 1', () => {
        const from = shotsToHoleOut(2, 'green');
        expect(strokesGained(2, 'green', 0, 'green')).toBeCloseTo(from - 1, 12);
    });

    test('a shot that goes nowhere loses exactly one stroke', () => {
        expect(strokesGained(150, 'rough', 150, 'rough')).toBeCloseTo(-1, 12);
    });

    test('fairway-finder beats water off the tee', () => {
        const start = 380 * YD;
        const inFairway = strokesGained(start, 'tee', 150 * YD, 'fairway');
        const inWater = strokesGained(start, 'tee', 150 * YD, 'penalty');
        expect(inFairway).toBeGreaterThan(inWater);
        expect(inFairway - inWater).toBeCloseTo(
            shotsToHoleOut(150 * YD, 'penalty') - shotsToHoleOut(150 * YD, 'fairway'),
            12,
        );
    });
});

describe('lieFromFeatureType', () => {
    test('maps the full feature palette per DECADE §4.1 / D1', () => {
        expect(lieFromFeatureType('tee')).toBe('fairway');
        expect(lieFromFeatureType('fairway')).toBe('fairway');
        expect(lieFromFeatureType('green')).toBe('green');
        expect(lieFromFeatureType('semi_rough')).toBe('rough');
        expect(lieFromFeatureType('rough')).toBe('rough');
        expect(lieFromFeatureType('deep_rough')).toBe('recovery');
        expect(lieFromFeatureType('bunker')).toBe('sand');
        expect(lieFromFeatureType('water')).toBe('penalty');
        expect(lieFromFeatureType('water_creek')).toBe('penalty');
        expect(lieFromFeatureType('outside')).toBe('penalty');
        expect(lieFromFeatureType('path')).toBe('fairway');
    });

    test('unknown feature types fall back to rough', () => {
        expect(lieFromFeatureType('clubhouse')).toBe('rough');
        expect(lieFromFeatureType('')).toBe('rough');
    });
});
