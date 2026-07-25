import { describe, expect, test } from 'bun:test';
import { EXPECTED_STROKES_ANCHORS_M, HOLED_DISTANCE_M, shotsToHoleOut } from './expected-strokes';
import type { Lie } from './lie';
import {
    OVERDISPERSION_BY_LIE,
    distributionMean,
    strokesDistribution,
} from './score-distribution';

const LONG_GAME_LIES: readonly Exclude<Lie, 'penalty' | 'tee'>[] = [
    'fairway', 'rough', 'sand', 'recovery', 'green',
];

/** Anchor distances (m) per lie plus a set of between-anchor probes. */
function probeDistances(lie: Exclude<Lie, 'penalty'>): number[] {
    const anchors = EXPECTED_STROKES_ANCHORS_M[lie].map(([d]) => d);
    const between: number[] = [];
    for (let i = 1; i < anchors.length; i++) {
        between.push((anchors[i - 1]! + anchors[i]!) / 2); // midpoints (interpolated μ)
    }
    // A few beyond-last-anchor extrapolation points too.
    const last = anchors[anchors.length - 1]!;
    return [...anchors, ...between, last + 15, last + 60];
}

describe('strokesDistribution — mean pinned to the Broadie table (§V2)', () => {
    test('mean ≡ shotsToHoleOut to 1e-9 at every anchor and between, every lie', () => {
        for (const lie of LONG_GAME_LIES) {
            for (const d of probeDistances(lie)) {
                const pmf = strokesDistribution(d, lie);
                const mu = shotsToHoleOut(d, lie);
                expect(Math.abs(distributionMean(pmf) - mu)).toBeLessThan(1e-9);
            }
        }
    });

    test('penalty mean ≡ 1 + rough (D4), shape is rough shifted one stroke', () => {
        for (const d of [30, 90, 150, 220, 400]) {
            const pmf = strokesDistribution(d, 'penalty');
            expect(Math.abs(distributionMean(pmf) - shotsToHoleOut(d, 'penalty'))).toBeLessThan(1e-9);
            const rough = strokesDistribution(d, 'rough');
            expect(pmf[0]).toBe(0);
            for (let k = 0; k < rough.length; k++) expect(pmf[k + 1]).toBeCloseTo(rough[k]!, 15);
        }
    });
});

describe('strokesDistribution — proper pmf', () => {
    test('sums to 1 for every lie across a distance sweep', () => {
        for (const lie of [...LONG_GAME_LIES, 'penalty' as const]) {
            for (const d of [1, 15, 30, 55, 90, 137, 200, 305, 450]) {
                const sum = strokesDistribution(d, lie).reduce((a, b) => a + b, 0);
                expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
            }
        }
    });

    test('all masses are non-negative', () => {
        for (const lie of [...LONG_GAME_LIES, 'penalty' as const]) {
            for (const d of [1, 20, 60, 100, 137, 250, 400]) {
                for (const p of strokesDistribution(d, lie)) expect(p).toBeGreaterThanOrEqual(0);
            }
        }
    });

    test('holed ball (< HOLED_DISTANCE_M) is P(0) = 1', () => {
        const pmf = strokesDistribution(HOLED_DISTANCE_M / 2, 'green');
        expect(pmf).toEqual([1]);
        expect(distributionMean(pmf)).toBe(0);
    });

    test('support is {⌊μ⌋, ⌊μ⌋+1, ⌊μ⌋+2} with the overdispersion split', () => {
        const d = 150;
        const lie: Lie = 'rough';
        const mu = shotsToHoleOut(d, lie);
        const f = Math.floor(mu);
        const frac = mu - f;
        const w = OVERDISPERSION_BY_LIE[lie];
        const pmf = strokesDistribution(d, lie);
        expect(pmf[f]).toBeCloseTo(1 - frac + w * frac, 15);
        expect(pmf[f + 1]).toBeCloseTo(frac * (1 - 2 * w), 15);
        expect(pmf[f + 2]).toBeCloseTo(w * frac, 15);
    });

    test('an integer μ puts all mass on one stroke count', () => {
        // green at ~0.30 m (1 ft) has μ = 1.00 exactly (D20 tap-in anchor).
        const pmf = strokesDistribution(0.3048, 'green');
        expect(pmf[1]).toBeCloseTo(1, 12);
        expect(distributionMean(pmf)).toBeCloseTo(1, 12);
    });
});

describe('strokesDistribution — green one-putt anchor (§V2)', () => {
    test('P(1 putt) is the table-implied make% (≈ 2 − μ) inside ~15 ft', () => {
        // 10 ft = 3.05 m, μ = 1.61 ⇒ make% ≈ 0.39 with a tiny 3-putt tail.
        const d = 10 * 0.3048;
        const mu = shotsToHoleOut(d, 'green');
        const pmf = strokesDistribution(d, 'green');
        expect(pmf[1]).toBeCloseTo(2 - mu + OVERDISPERSION_BY_LIE.green * (mu - 1), 12);
        // Overwhelmingly one/two-putt; three-putt tail is small.
        expect(pmf[3] ?? 0).toBeLessThan(0.02);
    });

    test('long lag putts (floor 2) never one-putt', () => {
        // 60 ft = 18.3 m, μ = 2.21 ⇒ floor 2 ⇒ P(1) is 0 (no index-1 support).
        const pmf = strokesDistribution(60 * 0.3048, 'green');
        expect(pmf[1] ?? 0).toBe(0);
        expect(pmf[2]).toBeGreaterThan(0);
    });
});

describe('strokesDistribution — monotonicity (§V2, mirrors D18 for the mean)', () => {
    test('mean is non-decreasing in distance for fairway/rough/green', () => {
        for (const lie of ['fairway', 'rough', 'green'] as const) {
            let prev = -Infinity;
            for (let d = 5; d <= 250; d += 5) {
                const m = distributionMean(strokesDistribution(d, lie));
                expect(m).toBeGreaterThanOrEqual(prev - 1e-12);
                prev = m;
            }
        }
    });
});
