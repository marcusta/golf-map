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

// ---------------------------------------------------------------------------
// windEffect — Ballnamic plays-as calibration grid (2026-07).
//
// Independent oracle: the raw table verbatim from the spec (yards of plays-as
// adjustment, hurting = added / helping = subtracted). Distance nodes ascending.
// ---------------------------------------------------------------------------
const DIST_NODES = [115, 140, 162.5, 187.5, 225, 285];
const SPEED_NODES = [5, 10, 15, 20, 25];
const HURT_YD = [
    [5, 11, 18, 26, 35], // 115
    [6, 12, 20, 28, 38], // 140
    [6, 14, 23, 32, 43], // 162.5
    [7, 15, 24, 35, 47], // 187.5
    [5, 11, 19, 28, 38], // 225
    [4, 9, 15, 21, 28], // 285
];
const HELP_YD = [
    [4, 8, 11, 14, 16], // 115
    [5, 9, 12, 15, 17], // 140
    [5, 10, 13, 16, 18], // 162.5
    [6, 10, 14, 17, 18], // 187.5
    [4, 6, 8, 8, 7], // 225
    [4, 7, 9, 11, 12], // 285
];
const yd = (y: number) => y * 0.9144;
const toYd = (m: number) => m / 0.9144;

describe('windEffect — Ballnamic calibration grid', () => {
    test('reproduces all 60 table cells within 0.01 yd (plays-as form)', () => {
        for (let i = 0; i < DIST_NODES.length; i++) {
            const D = yd(DIST_NODES[i]);
            for (let j = 0; j < SPEED_NODES.length; j++) {
                const speed = mphToMps(SPEED_NODES[j]);
                // Hurting: dead headwind (windDir == bearing).
                const eHurt = windEffect(speed, 0, 0, D);
                const gotHurt = toYd(playsAsM(D, eHurt));
                expect(Math.abs(gotHurt - (DIST_NODES[i] + HURT_YD[i][j]))).toBeLessThan(0.01);
                // Helping: dead tailwind (windDir == bearing + 180).
                const eHelp = windEffect(speed, 180, 0, D);
                const gotHelp = toYd(playsAsM(D, eHelp));
                expect(Math.abs(gotHelp - (DIST_NODES[i] - HELP_YD[i][j]))).toBeLessThan(0.01);
            }
        }
    });

    test('sign convention: headwind lengthens plays-as, tailwind shortens', () => {
        const D = yd(160);
        const head = windEffect(mps(15), 0, 0, D); // hurting → negative
        const tail = windEffect(mps(15), 180, 0, D); // helping → positive
        expect(head).toBeLessThan(0);
        expect(tail).toBeGreaterThan(0);
        expect(playsAsM(D, head)).toBeGreaterThan(D); // plays longer
        expect(playsAsM(D, tail)).toBeLessThan(D); // plays shorter
    });

    test('dead crosswind → zero effect', () => {
        // cos(90°) is ~6e-17 in FP, so the head component is negligibly small,
        // not bit-exact zero — the effect is likewise negligible.
        expect(windEffect(mps(15), 270, 0, yd(160))).toBeCloseTo(0, 12);
        expect(windEffect(mps(15), 90, 0, yd(160))).toBeCloseTo(0, 12);
    });

    test('zero wind / non-positive distance → zero effect', () => {
        expect(windEffect(0, 123, 45, yd(160))).toBe(0);
        expect(windEffect(mps(15), 0, 0, 0)).toBe(0);
        expect(windEffect(mps(15), 0, 0, -50)).toBe(0);
    });

    test('distance below 115 yd clamps to the 115 row', () => {
        const e = windEffect(mps(10), 0, 0, yd(100)); // 10 mph head, hurting
        const a = HURT_YD[0][1] / DIST_NODES[0]; // 115 row @ 10 mph = 11/115
        expect(e).toBeCloseTo(-a / (1 + a), 9);
    });

    test('distance above 285 yd clamps to the 285 row', () => {
        const e = windEffect(mps(10), 0, 0, yd(320));
        const a = HURT_YD[5][1] / DIST_NODES[5]; // 285 row @ 10 mph = 9/285
        expect(e).toBeCloseTo(-a / (1 + a), 9);
    });

    test('component below 5 mph interpolates linearly from a=0 at 0 mph', () => {
        const e = windEffect(mphToMps(2.5), 0, 0, yd(140)); // half of the 5-mph column
        const a = 0.5 * (HURT_YD[1][0] / DIST_NODES[1]); // ½ · 6/140
        expect(e).toBeCloseTo(-a / (1 + a), 9);
    });

    test('component above 25 mph hurting extrapolates, capped at the 35-mph value', () => {
        const e = windEffect(mphToMps(40), 0, 0, yd(140)); // 40 mph head → capped at 35
        const v3 = HURT_YD[1][3]; // 20 mph col = 28
        const v4 = HURT_YD[1][4]; // 25 mph col = 38
        const cappedYd = v4 + ((35 - 25) / 5) * (v4 - v3); // 38 + 2·10 = 58
        const a = cappedYd / DIST_NODES[1];
        expect(e).toBeCloseTo(-a / (1 + a), 9);
    });

    test('component above 25 mph helping clamps to the 25-mph column', () => {
        const e = windEffect(mphToMps(40), 180, 0, yd(140)); // 40 mph tail → clamp to 25
        const a = HELP_YD[1][4] / DIST_NODES[1]; // 17/140
        expect(e).toBeCloseTo(a / (1 - a), 9);
    });

    test('interpolation smoke: a mid-grid point lies between its node neighbors', () => {
        const mid = windEffect(mphToMps(12.5), 0, 0, yd(150)); // hurting, negative
        // Bracketed by speed at the same distance (more head wind → more negative).
        expect(mid).toBeLessThan(windEffect(mphToMps(10), 0, 0, yd(150)));
        expect(mid).toBeGreaterThan(windEffect(mphToMps(15), 0, 0, yd(150)));
        // Bracketed by distance at the same speed.
        const loD = windEffect(mphToMps(12.5), 0, 0, yd(140));
        const hiD = windEffect(mphToMps(12.5), 0, 0, yd(162.5));
        expect(mid).toBeLessThanOrEqual(Math.max(loD, hiD) + 1e-12);
        expect(mid).toBeGreaterThanOrEqual(Math.min(loD, hiD) - 1e-12);
    });
});

describe('adjustedCarryM / playsAsM — forward vs inverse forms', () => {
    test('inverse is division, not ×(1−e)', () => {
        expect(playsAsM(150, -0.08)).toBeCloseTo(150 / 0.92, 12);
        expect(playsAsM(150, -0.08)).not.toBeCloseTo(150 * 1.08, 2);
    });

    test('forward and plays-as use the same effect sign', () => {
        // A hurting headwind shortens carry (× (1+e), e<0) and lengthens the
        // plays-as target (÷ (1+e)); both driven by the same negative e.
        const e = windEffect(mps(12), 0, 0, yd(200));
        expect(e).toBeLessThan(0);
        expect(adjustedCarryM(200, e)).toBeLessThan(200);
        expect(playsAsM(yd(200), e)).toBeGreaterThan(yd(200));
    });
});

describe('crosswindDriftM — v1.1 extension', () => {
    test('drift = carry × crosswind_mph × 0.005, sign follows crosswind', () => {
        expect(crosswindDriftM(243, 10)).toBeCloseTo(12.15, 12); // from left → right drift
        expect(crosswindDriftM(243, -10)).toBeCloseTo(-12.15, 12);
        expect(crosswindDriftM(243, 0)).toBe(0);
    });
});
