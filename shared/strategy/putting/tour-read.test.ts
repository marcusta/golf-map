import { describe, expect, test } from 'bun:test';
import {
    breakMultiplier,
    formatTourRead,
    inchesToMeters,
    PACE_METERS,
    playsLikeLength,
    stimpBreakScale,
    stimpToFriction,
    tourRead,
    tourReadAimInches,
    tourReadAimInchesAtReference,
    tourReadFromPaces,
} from './tour-read';

// Worked examples straight from docs/feature-putting-green-reading.md §3.1–3.4.

describe('§3.1 friction from stimp', () => {
    test('stimp 10 → μ ≈ 0.056', () => {
        expect(stimpToFriction(10)).toBeCloseTo(0.056, 3);
    });

    test('μ scales as 1/S_ft (exact)', () => {
        // μ(S) = μ(10)·10/S — the 1/S shape is exact regardless of the constant.
        const mu10 = stimpToFriction(10);
        expect(stimpToFriction(12)).toBeCloseTo((mu10 * 10) / 12, 9);
        expect(stimpToFriction(8)).toBeCloseTo((mu10 * 10) / 8, 9);
    });
});

describe('§3.2 Tour Read aim', () => {
    test('reference formula: (paces × 2 − 1) × slope%', () => {
        // 4 paces, 2% → (4×2−1)×2 = 14 inches (the doc "14 in" example).
        expect(tourReadAimInchesAtReference(4, 2)).toBeCloseTo(14, 9);
        // 6 paces, 1.5% → (11)×1.5 = 16.5.
        expect(tourReadAimInchesAtReference(6, 1.5)).toBeCloseTo(16.5, 9);
    });

    test('sub-1-pace putt clamps the (paces×2−1) term at 0', () => {
        expect(tourReadAimInchesAtReference(0.25, 3)).toBe(0); // 2×0.25−1 = −0.5 → 0
        expect(tourReadAimInchesAtReference(0.5, 3)).toBe(0); // exactly 0
    });

    test('stimp scaling ±10% per foot from reference', () => {
        expect(stimpBreakScale(10)).toBeCloseTo(1.0, 9);
        expect(stimpBreakScale(11)).toBeCloseTo(1.1, 9);
        expect(stimpBreakScale(9)).toBeCloseTo(0.9, 9);
        expect(stimpBreakScale(12)).toBeCloseTo(1.2, 9);
        // Applied: 14 in at reference → 15.4 in at stimp 11.
        expect(tourReadAimInches(4, 2, 11)).toBeCloseTo(15.4, 6);
        expect(tourReadAimInches(4, 2, 9)).toBeCloseTo(12.6, 6);
    });
});

describe('§3.3 uphill/downhill break multiplier', () => {
    const mu = stimpToFriction(10); // ≈ 0.056

    test('2% downhill at stimp 10 → ×~1.55 (loose)', () => {
        expect(breakMultiplier(mu, -0.02)).toBeCloseTo(1.55, 1);
    });

    test('2% uphill at stimp 10 → ×~0.74 (loose)', () => {
        expect(breakMultiplier(mu, 0.02)).toBeCloseTo(0.74, 1);
    });

    test('flat → ×1', () => {
        expect(breakMultiplier(mu, 0)).toBeCloseTo(1, 9);
    });

    test('downhill grade ≥ μ diverges (ball never stops)', () => {
        expect(breakMultiplier(mu, -mu)).toBe(Number.POSITIVE_INFINITY);
        expect(breakMultiplier(mu, -0.1)).toBe(Number.POSITIVE_INFINITY);
    });
});

describe('§3.4 plays-like putt length', () => {
    const mu = stimpToFriction(10);

    test('10 m rising 0.3 m at stimp 10 → plays ≈ 15.4 m', () => {
        const { playsLikeMeters, canStop } = playsLikeLength(10, 0.3, mu);
        expect(playsLikeMeters).toBeCloseTo(15.36, 1);
        expect(canStop).toBe(true);
    });

    test('downhill plays shorter', () => {
        const { playsLikeMeters, canStop } = playsLikeLength(10, -0.2, mu);
        expect(playsLikeMeters).toBeLessThan(10);
        expect(canStop).toBe(true);
    });

    test('degenerate downhill (Δh/μ ≤ −D) → canStop false', () => {
        // Δh = −1 m, μ ≈ 0.056 → Δh/μ ≈ −17.9 m, well past a 10 m putt.
        const { playsLikeMeters, canStop } = playsLikeLength(10, -1, mu);
        expect(canStop).toBe(false);
        expect(playsLikeMeters).toBeLessThanOrEqual(0);
    });
});

describe('assembled tourRead', () => {
    test('assembled read converts elevation delta to grade fraction for break', () => {
        // Both putts climb at the same 2% grade, so their grade multiplier must
        // be identical regardless of length. The assembled API receives Δh in
        // meters and is responsible for dividing by distance.
        const fiveMeters = tourRead(5, 0.1, 2, 10, true);
        const tenMeters = tourRead(10, 0.2, 2, 10, true);
        const expected = breakMultiplier(stimpToFriction(10), 0.02);
        expect(fiveMeters.breakMultiplier).toBeCloseTo(expected, 12);
        expect(tenMeters.breakMultiplier).toBeCloseTo(expected, 12);
    });

    test('sign convention: break-right aims LEFT (negative offset)', () => {
        const r = tourRead(10, 0, 2, 10, true); // breaks left→right
        expect(r.breakSide).toBe('right');
        expect(r.aimOffsetMeters).toBeLessThan(0);
        expect(r.aimInches).toBeGreaterThan(0);
    });

    test('sign convention: break-left aims RIGHT (positive offset)', () => {
        const r = tourRead(10, 0, 2, 10, false); // breaks right→left
        expect(r.breakSide).toBe('left');
        expect(r.aimOffsetMeters).toBeGreaterThan(0);
    });

    test('flat cross-slope → straight, zero offset', () => {
        const r = tourRead(10, 0, 0, 10, true);
        expect(r.breakSide).toBe('straight');
        expect(r.aimOffsetMeters).toBe(0);
        expect(r.aimInches).toBe(0);
    });

    test('aimOffsetMeters matches aimInches conversion', () => {
        const r = tourRead(10, 0, 2, 10, true);
        expect(Math.abs(r.aimOffsetMeters)).toBeCloseTo(inchesToMeters(r.aimInches), 12);
    });

    test('paces convenience matches meters entry', () => {
        const fromM = tourRead(4 * PACE_METERS, 0.1, 2, 11, true);
        const fromP = tourReadFromPaces(4, 0.1, 2, 11, true);
        expect(fromP.aimInches).toBeCloseTo(fromM.aimInches, 12);
        expect(fromP.playsLikeMeters).toBeCloseTo(fromM.playsLikeMeters, 12);
    });

    test('plays-like matches the GSPro calibration anchors (stimp 11)', () => {
        // The two fit anchors behind PLAYS_LIKE_FRICTION_CONSTANT: 8 cm rise →
        // ~+1.0 m plays-like, and 29 cm over 8 m → ~+3.6–3.7 m.
        const small = tourRead(6, 0.08, 0, 11, true);
        expect(small.playsLikeMeters - 6).toBeCloseTo(1.0, 1);
        const big = tourRead(8, 0.29, 0, 11, true);
        expect(big.playsLikeMeters - 8).toBeCloseTo(3.6, 0);
        expect(big.playsLikeMeters).toBeCloseTo(11.63, 1);
    });

    test('can\'t-stop verdict stays on the physical μ, not the calibrated one', () => {
        // Δh = −0.6 on 10 m: 10 − 0.6/0.056 < 0 (can't stop physically), but
        // 10 − 0.6/0.088 > 0 — a calibrated-μ canStop would wrongly say true.
        const r = tourRead(10, -0.6, 0, 10, true);
        expect(r.canStop).toBe(false);
    });

    test('can\'t-stop downhill carries canStop false and a finite aim', () => {
        const r = tourRead(10, -1, 2, 10, true);
        expect(r.canStop).toBe(false);
        expect(Number.isFinite(r.aimOffsetMeters)).toBe(true);
        expect(r.aimOffsetMeters).toBe(0); // diverging multiplier → aim capped to 0
    });
});

describe('verbal formatter', () => {
    test('verbal aim side follows the signed aim offset, not the break direction', () => {
        const breaksRight = tourRead(10, 0, 2, 10, true);
        expect(breaksRight.aimOffsetMeters).toBeLessThan(0);
        expect(formatTourRead(breaksRight, 'metric').aim).toEndWith('left');

        const breaksLeft = tourRead(10, 0, 2, 10, false);
        expect(breaksLeft.aimOffsetMeters).toBeGreaterThan(0);
        expect(formatTourRead(breaksLeft, 'metric').aim).toEndWith('right');
    });

    test('imperial: "14 in left"', () => {
        // ~4 paces (3.66 m), 2% break left→right → aim left, 14 in.
        const r = tourReadFromPaces(4, 0, 2, 10, true);
        const v = formatTourRead(r, 'imperial');
        expect(v.aim).toBe('14 in left');
    });

    test('metric: "aim 35 cm left"', () => {
        const r = tourReadFromPaces(4, 0, 2, 10, true);
        const v = formatTourRead(r, 'metric');
        expect(v.aim).toBe('aim 35 cm left'); // 14 in = 35.56 cm → 35
    });

    test('metric pace line: "plays like 13.4 m"', () => {
        // 10 m + 0.3/0.088 (calibrated plays-like μ at stimp 10) = 13.41.
        const r = tourRead(10, 0.3, 2, 10, true);
        const v = formatTourRead(r, 'metric');
        expect(v.pace).toBe('plays like 13.4 m');
    });

    test('imperial pace line uses feet', () => {
        const r = tourRead(10, 0, 0, 10, true); // 10 m flat = 32.8 ft
        const v = formatTourRead(r, 'imperial');
        expect(v.pace).toBe('plays like 33 ft');
    });

    test('can\'t-stop message in both unit systems', () => {
        const r = tourRead(10, -1, 2, 10, true);
        const expected = "can't stop this one — lag to the low side";
        expect(formatTourRead(r, 'metric').pace).toBe(expected);
        expect(formatTourRead(r, 'imperial').pace).toBe(expected);
    });

    test('combined joins aim and pace', () => {
        const r = tourReadFromPaces(4, 0.3, 2, 10, false);
        const v = formatTourRead(r, 'imperial');
        expect(v.combined).toBe(`${v.aim} · ${v.pace}`);
    });
});
