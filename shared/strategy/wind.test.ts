import { describe, expect, test } from 'bun:test';
import { MPS_TO_MPH, mphToMps, mpsToMph } from './units';
import { adjustedCarryM, crosswindDriftM, playsAsM, windComponents, windEffect } from './wind';

// All spec fixtures are stated in mph; the API takes m/s, so tests convert
// with the exact v1 constant. The mph→m/s→mph roundtrip is FP-exact for
// every fixture speed (verified), so the strict >18 branch tests are safe.
const mps = (mph: number) => mphToMps(mph);

describe('units', () => {
    test('exact v1 constant and inverse conversions', () => {
        expect(MPS_TO_MPH).toBe(2.23694);
        expect(mpsToMph(10)).toBeCloseTo(22.3694, 12);
        expect(mphToMps(22.3694)).toBeCloseTo(10, 12);
        expect(mpsToMph(mphToMps(18))).toBe(18); // roundtrip exact — guards the >18 strictness
    });
});

describe('windComponents — v1 decomposition', () => {
    test('wind FROM shot bearing = full headwind (negative headTail)', () => {
        const c = windComponents(mps(10), 0, 0);
        expect(c.headTailMph).toBeCloseTo(-10, 9);
        expect(c.crosswindMph).toBeCloseTo(0, 9);
    });

    test('wind from behind = full tailwind (positive headTail)', () => {
        const c = windComponents(mps(20), 180, 0);
        expect(c.headTailMph).toBeCloseTo(20, 9);
        expect(c.crosswindMph).toBeCloseTo(0, 9);
    });

    test('sign convention: wind from shot-LEFT → positive crosswind (drifts right)', () => {
        const c = windComponents(mps(10), 270, 0); // wind from due west, shot due north
        expect(c.crosswindMph).toBeCloseTo(10, 9);
        expect(c.headTailMph).toBeCloseTo(0, 9);
    });

    test('wind from shot-RIGHT → negative crosswind', () => {
        const c = windComponents(mps(10), 90, 0);
        expect(c.crosswindMph).toBeCloseTo(-10, 9);
    });

    test('fixture C decomposition: windDir 45, bearing 0, 15 mph', () => {
        const c = windComponents(mps(15), 45, 0);
        expect(c.headTailMph).toBeCloseTo(-10.606601717798213, 6);
        expect(c.crosswindMph).toBeCloseTo(-10.606601717798213, 6);
    });

    test('normalization handles negative relative angles and bearings > 360 inputs', () => {
        const a = windComponents(mps(10), 10, 350); // rel = (10 − 350 + 180) = −160 → 200
        const b = windComponents(mps(10), 370, 350);
        expect(a.headTailMph).toBeCloseTo(b.headTailMph, 12);
        expect(a.crosswindMph).toBeCloseTo(b.crosswindMph, 12);
    });
});

describe('windEffect — exact v1 curve', () => {
    test('fixture A: 10 mph pure headwind → effect −0.10, Driver 218.7 m', () => {
        const e = windEffect(mps(10), 0, 0);
        expect(e).toBeCloseTo(-0.1, 9);
        expect(adjustedCarryM(243, e)).toBeCloseTo(218.7, 9);
    });

    test('fixture B: 20 mph pure tailwind (>18) → effect +0.068, 7i 165.54 m', () => {
        const e = windEffect(mps(20), 180, 0);
        expect(e).toBeCloseTo(0.068, 9);
        expect(adjustedCarryM(155, e)).toBeCloseTo(165.54, 9);
    });

    test('fixture C: 15 mph quartering headwind → Driver 217.2259578 m', () => {
        const e = windEffect(mps(15), 45, 0);
        expect(e).toBeCloseTo(-0.10606601717798213, 9);
        expect(adjustedCarryM(243, e)).toBeCloseTo(217.2259578, 6);
    });

    test('fixture F: 18→19 mph headwind discontinuity (strict >, total speed)', () => {
        const e18 = windEffect(mps(18), 0, 0);
        const e19 = windEffect(mps(19), 0, 0);
        expect(e18).toBeCloseTo(-0.18, 9); // 18 mph is NOT > 18 → ×0.01
        expect(e19).toBeCloseTo(-0.247, 9); // ×0.013 applied to the whole component
        expect(adjustedCarryM(243, e18)).toBeCloseTo(199.26, 9);
        expect(adjustedCarryM(243, e19)).toBeCloseTo(182.979, 9);
    });

    test('the >18 threshold uses TOTAL speed, not the component', () => {
        // 20 mph total, quartering: |headTail| = 14.14 < 18, but total > 18 → harsh rate.
        const { headTailMph } = windComponents(mps(20), 45, 0);
        expect(windEffect(mps(20), 45, 0)).toBeCloseTo(headTailMph * 0.013, 12);
    });

    test('tailwind discontinuity: 18 mph ×0.005 vs 19 mph ×0.0034', () => {
        expect(windEffect(mps(18), 180, 0)).toBeCloseTo(0.09, 9);
        expect(windEffect(mps(19), 180, 0)).toBeCloseTo(19 * 0.0034, 9);
    });

    test('zero wind → zero effect', () => {
        expect(windEffect(0, 123, 45)).toBeCloseTo(0, 12);
    });
});

describe('adjustedCarryM / playsAsM — forward vs inverse forms', () => {
    test('fixture D: 150 m at 8 mph pure headwind plays as 163.0434783 m', () => {
        const e = windEffect(mps(8), 0, 0);
        expect(e).toBeCloseTo(-0.08, 9);
        expect(playsAsM(150, e)).toBeCloseTo(163.0434783, 6);
    });

    test('inverse is division, not ×(1−e)', () => {
        expect(playsAsM(150, -0.08)).toBeCloseTo(150 / 0.92, 12);
        expect(playsAsM(150, -0.08)).not.toBeCloseTo(150 * 1.08, 2);
    });
});

describe('crosswindDriftM — v1.1 extension', () => {
    test('drift = carry × crosswind_mph × 0.005, sign follows crosswind', () => {
        expect(crosswindDriftM(243, 10)).toBeCloseTo(12.15, 12); // from left → right drift
        expect(crosswindDriftM(243, -10)).toBeCloseTo(-12.15, 12);
        expect(crosswindDriftM(243, 0)).toBe(0);
    });
});
