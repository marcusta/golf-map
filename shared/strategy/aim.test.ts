import { describe, expect, test } from 'bun:test';
import { defaultSweepDeg, optimizeAim, standardNormalPairs, type AimOptions } from './aim';
import type { FlatRing } from './corridor';
import { ringPolygon } from './ellipse';

// Test course, planar meters, shot due north (bearing 0): origin (0,0),
// club carries 150 with 20 m full lateral dispersion → landing zone around
// (0, 150), σ_along = 3 m, σ_lateral = 5 m (sigmaScale 2 default).

const club = { name: '7i', carryM: 150, dispersionM: 20 };
const greenCenter = { x: 0, y: 150 };

const rect = (minX: number, maxX: number, minY: number, maxY: number, kind: string): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

/** Water hugging the left edge of the landing zone. */
const waterLeft = rect(-25, -3, 135, 165, 'water');

const base: AimOptions = {
    origin: { x: 0, y: 0 },
    club,
    targetBearingDeg: 0,
    surfaces: [],
    greenCenter,
};

describe('optimizeAim', () => {
    test('water left of the line → best aim shifts right, cutting the penalty share', () => {
        const result = optimizeAim({ ...base, surfaces: [waterLeft] });
        expect(result.bestBearingDeg).toBeGreaterThan(0);

        const leftmost = result.perCandidate[0];
        expect(leftmost.bearingDeg).toBeLessThan(0);
        expect(leftmost.expectedStrokes).toBeGreaterThan(result.best.expectedStrokes);
        expect(leftmost.breakdown.penalty ?? 0).toBeGreaterThan(result.breakdown.penalty ?? 0);
    });

    test('no hazards → aim stays (near) straight at the target', () => {
        const result = optimizeAim(base);
        // Off-line aims only increase the remaining distance, so the
        // straight candidate wins (exactly, given the D15 tie-break).
        expect(Math.abs(result.bestBearingDeg)).toBeLessThan(1e-9);
    });

    test('deterministic: identical inputs → identical results (D14)', () => {
        const a = optimizeAim({ ...base, surfaces: [waterLeft] });
        const b = optimizeAim({ ...base, surfaces: [waterLeft] });
        expect(b).toEqual(a);
    });

    test('breakdown fractions sum to 1 for every candidate', () => {
        const result = optimizeAim({ ...base, surfaces: [waterLeft] });
        for (const candidate of result.perCandidate) {
            const total = Object.values(candidate.breakdown).reduce((s, f) => s + (f ?? 0), 0);
            expect(total).toBeCloseTo(1, 12);
        }
    });

    test('tailStrokes ≥ expectedStrokes; riskAversion never aims closer to trouble (D16)', () => {
        const pureEV = optimizeAim({ ...base, surfaces: [waterLeft] });
        for (const candidate of pureEV.perCandidate) {
            expect(candidate.tailStrokes).toBeGreaterThanOrEqual(candidate.expectedStrokes);
        }
        const riskAverse = optimizeAim({ ...base, surfaces: [waterLeft], riskAversion: 1 });
        expect(riskAverse.bestBearingDeg).toBeGreaterThanOrEqual(pureEV.bestBearingDeg);
    });

    test('hitting the green prices better than the same zone as rough fallback', () => {
        const green: FlatRing = { kind: 'green', points: ringPolygon(greenCenter, 12) };
        const withGreen = optimizeAim({ ...base, surfaces: [green], candidates: 1 });
        const allRough = optimizeAim({ ...base, candidates: 1 });
        expect(withGreen.breakdown.green ?? 0).toBeGreaterThan(0.9);
        expect(withGreen.best.expectedStrokes).toBeLessThan(allRough.best.expectedStrokes);
    });

    test('nesting resolves smallest-area-first: bunker inside fairway wins (D17)', () => {
        const fairway = rect(-50, 50, 100, 200, 'fairway');
        const bunker = rect(-16, 16, 139, 161, 'bunker');
        const result = optimizeAim({ ...base, surfaces: [fairway, bunker], candidates: 1 });
        expect(result.breakdown.sand ?? 0).toBeGreaterThan(0.95);
    });

    test('single candidate: sweep collapses to the target bearing', () => {
        const result = optimizeAim({ ...base, candidates: 1, targetBearingDeg: 42 });
        expect(result.perCandidate).toHaveLength(1);
        expect(result.bestBearingDeg).toBe(42);
    });
});

describe('defaultSweepDeg (D15)', () => {
    test('~1.5 lateral semi-axes each side for a mid iron', () => {
        // atan(0.75 · 20 / 150) ≈ 5.71°.
        expect(defaultSweepDeg(club)).toBeCloseTo(5.71, 1);
    });

    test('clamped to [4°, 15°]', () => {
        expect(defaultSweepDeg({ carryM: 250, dispersionM: 5 })).toBe(4);
        expect(defaultSweepDeg({ carryM: 60, dispersionM: 60 })).toBe(15);
    });
});

describe('standardNormalPairs (D14)', () => {
    test('deterministic, ~zero mean, ~unit variance', () => {
        const pairs = standardNormalPairs(512);
        expect(standardNormalPairs(512)).toEqual(pairs);

        let sum1 = 0, sum2 = 0, sq1 = 0, sq2 = 0;
        for (const [z1, z2] of pairs) {
            sum1 += z1; sum2 += z2; sq1 += z1 * z1; sq2 += z2 * z2;
        }
        const n = pairs.length;
        expect(sum1 / n).toBeCloseTo(0, 1);
        expect(sum2 / n).toBeCloseTo(0, 1);
        expect(sq1 / n).toBeCloseTo(1, 1);
        expect(sq2 / n).toBeCloseTo(1, 1);
    });
});
