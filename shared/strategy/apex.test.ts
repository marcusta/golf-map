import { describe, expect, test } from 'bun:test';
import { AMATEUR_APEX_SCALE, APEX_TABLE, apexHeightM, tableApexM } from './apex';

describe('tableApexM — tour anchors and interpolation', () => {
    test('hits the anchors exactly', () => {
        for (const { carryM, apexM } of APEX_TABLE) expect(tableApexM(carryM)).toBe(apexM);
    });

    test('interpolates linearly between anchors', () => {
        // 120 → 26, 150 → 28: midway is 27.
        expect(tableApexM(135)).toBeCloseTo(27, 6);
        // 50 → 12, 90 → 22: 70 m is 17.
        expect(tableApexM(70)).toBeCloseTo(17, 6);
    });

    test('clamps beyond both ends', () => {
        expect(tableApexM(20)).toBe(12);
        expect(tableApexM(300)).toBe(30);
    });

    test('non-positive carry is 0', () => {
        expect(tableApexM(0)).toBe(0);
        expect(tableApexM(-5)).toBe(0);
        expect(tableApexM(Number.NaN)).toBe(0);
    });

    test('is monotonically non-decreasing in carry', () => {
        let prev = 0;
        for (let c = 10; c <= 260; c += 5) {
            const a = tableApexM(c);
            expect(a).toBeGreaterThanOrEqual(prev);
            prev = a;
        }
    });
});

describe('apexHeightM — amateur scale and club overrides', () => {
    test('defaults to the amateur scale on the table', () => {
        expect(apexHeightM(150)).toBeCloseTo(28 * AMATEUR_APEX_SCALE, 6);
        expect(AMATEUR_APEX_SCALE).toBe(0.85);
    });

    test('apexScale 1 returns tour numbers', () => {
        expect(apexHeightM(200, undefined, { apexScale: 1 })).toBe(30);
    });

    test('a club with a measured apex wins over the table and is not scaled', () => {
        expect(apexHeightM(150, { apexM: 19 })).toBe(19);
        expect(apexHeightM(150, { apexM: 19 }, { apexScale: 0.5 })).toBe(19);
    });

    test('a null/invalid club apex falls back to the table', () => {
        expect(apexHeightM(150, { apexM: null })).toBeCloseTo(28 * AMATEUR_APEX_SCALE, 6);
        expect(apexHeightM(150, { apexM: 0 })).toBeCloseTo(28 * AMATEUR_APEX_SCALE, 6);
        expect(apexHeightM(150, { category: 'iron', loftDeg: 34 })).toBeCloseTo(28 * AMATEUR_APEX_SCALE, 6);
    });
});
