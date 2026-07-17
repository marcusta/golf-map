import { describe, expect, test } from 'bun:test';
import { optimizeAim } from './aim';
import { par5AttackRule } from './caddy/rules/par5-attack';
import { type CaddyContext } from './caddy/rule';
import { type ClubSpec } from './club';
import { type FlatRing } from './corridor';
import { shotsToHoleOut } from './expected-strokes';
import { scoreOptionChain } from './option-chain';

function box(kind: string, minX: number, minY: number, maxX: number, maxY: number): FlatRing {
    return {
        kind,
        points: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
        ],
    };
}

// ── The par-5 agreement fixture (O4) ─────────────────────────────────────────
//
// SHARED between the par-5 attack rule and scoreOptionChain: one reachable
// green at 190 m with water flanking the right side of the landing pattern
// (topmost in the D23 stack, so the green/water overlap prices as water).
// Exactly one strategy survives the rule's enumeration (go-in-2: the lone
// 3-wood reaches and the centre-line carry is clear; no club sits within the
// lay-up tolerance and there is no on-line pinch), so the rule's advice
// unambiguously prices the same two-shot chain the option scorer sees:
// dispersion-sampled shot 1, expected-strokes table for everything after.

const AGREEMENT_GREEN = box('green', -18, 180, 18, 200);
const AGREEMENT_WATER = box('water', 10, 150, 90, 210);
const AGREEMENT_CENTER = { x: 0, y: 190 };
const AGREEMENT_CLUB: ClubSpec = { name: '3 wood', carryM: 185, dispersionM: 24 };
/** Rule-facing surfaces order (par5-attack builds [...hazards, greenPoly]). */
const AGREEMENT_SURFACES: readonly FlatRing[] = [AGREEMENT_WATER, AGREEMENT_GREEN];

function agreementCaddyContext(): CaddyContext {
    return {
        leg: 'layup',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: AGREEMENT_GREEN,
            center: AGREEMENT_CENTER,
            front: { x: 0, y: 180 },
            back: { x: 0, y: 200 },
        },
        distances: [],
        hazards: [AGREEMENT_WATER],
        clubs: [AGREEMENT_CLUB],
        hole: { par: 5, index: 1 },
        risk: { riskAversion: 0 },
    };
}

function agreementChain() {
    return scoreOptionChain(
        [{ origin: { x: 0, y: 0 }, landing: AGREEMENT_CENTER, club: AGREEMENT_CLUB }],
        {
            surfaces: AGREEMENT_SURFACES,
            greenCenter: AGREEMENT_CENTER,
            fallbackLie: 'fairway', // the rule's fallback — shared fixture parity
        },
    );
}

describe('scoreOptionChain — par-5 attack agreement fixture (O4)', () => {
    test('all three outputs pin to the goldens', () => {
        const chain = agreementChain();
        // Goldens: deterministic (D14 Halton sampling), generated 2026-07-17.
        expect(chain.expectedStrokes).toBeCloseTo(2.9498874708458747, 12);
        expect(chain.tailStrokes).toBeCloseTo(3.3586981801681906, 12);
        expect(chain.penaltyProb).toBe(0.015625); // 2 / 128 samples in the water
    });

    test('the chain equals the rule\'s optimizeAim pricing plus the shot itself', () => {
        // The rule's ev is aim.best.score ( = expectedStrokes at riskAversion
        // 0) WITHOUT the stroke that plays the shot — a constant that cancels
        // in its strategy argmin. The chain prices hole-out from the decision
        // point, so it carries the +1.
        const aim = optimizeAim({
            origin: { x: 0, y: 0 },
            club: AGREEMENT_CLUB,
            targetBearingDeg: 0,
            surfaces: AGREEMENT_SURFACES,
            greenCenter: AGREEMENT_CENTER,
            riskAversion: 0,
            fallbackLie: 'fairway',
        });
        const chain = agreementChain();
        expect(chain.expectedStrokes).toBe(1 + aim.best.expectedStrokes);
        expect(chain.tailStrokes).toBe(1 + aim.best.tailStrokes);
        expect(chain.penaltyProb).toBe(aim.breakdown.penalty ?? 0);
    });

    test('the rule\'s own advice quotes the same EV the chain carries', () => {
        const advice = par5AttackRule.evaluate(agreementCaddyContext());
        expect(advice).toHaveLength(1);
        expect(advice[0].kind).toBe('aim'); // go-in-2 — the attack chain
        const chain = agreementChain();
        expect(advice[0].detail).toContain(
            `prices at ${(chain.expectedStrokes - 1).toFixed(2)} expected strokes`,
        );
    });
});

// ── Depth-n composition ──────────────────────────────────────────────────────

const HOLE_GREEN = box('green', -14, 340, 14, 368);
const HOLE_WATER = box('water', 18, 120, 70, 260);
const HOLE_FAIRWAY = box('fairway', -30, 0, 16, 330);
const HOLE_CENTER = { x: 0, y: 354 };
const HOLE_SURFACES: readonly FlatRing[] = [HOLE_WATER, HOLE_GREEN, HOLE_FAIRWAY];
const DRIVER: ClubSpec = { name: 'Driver', carryM: 230, dispersionM: 32 };
const WEDGE: ClubSpec = { name: 'PW', carryM: 120, dispersionM: 12 };

describe('scoreOptionChain — chain composition', () => {
    test('a clubless leg is the point estimate: 1 + table, zero tail spread, zero penalty', () => {
        const chain = scoreOptionChain(
            [{ origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 } }],
            { surfaces: HOLE_SURFACES, greenCenter: HOLE_CENTER },
        );
        // Landing classifies as fairway (inside HOLE_FAIRWAY), 124 m out.
        const expected = 1 + shotsToHoleOut(124, 'fairway');
        expect(chain.expectedStrokes).toBe(expected);
        expect(chain.tailStrokes).toBe(expected); // zero spread
        expect(chain.penaltyProb).toBe(0);
        expect(chain.perLeg[0].breakdown).toBeUndefined();
    });

    test('depth-2 goldens: driver + wedge chain pins EV and tail', () => {
        const chain = scoreOptionChain(
            [
                { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
                { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
            ],
            { surfaces: HOLE_SURFACES, greenCenter: HOLE_CENTER },
        );
        // Goldens: deterministic (D14), generated 2026-07-17.
        expect(chain.expectedStrokes).toBeCloseTo(3.7644195986954427, 12);
        expect(chain.tailStrokes).toBeCloseTo(3.9382800287517497, 12);
        expect(chain.perLeg).toHaveLength(2);
    });

    test('the chain telescopes: Σ(legEV − baseline) + last baseline', () => {
        const chain = scoreOptionChain(
            [
                { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
                { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
            ],
            { surfaces: HOLE_SURFACES, greenCenter: HOLE_CENTER },
        );
        const last = chain.perLeg[chain.perLeg.length - 1];
        const expected = chain.perLeg.reduce(
            (sum, leg) => sum + leg.expectedStrokes - leg.baselineStrokes,
            last.baselineStrokes,
        );
        expect(chain.expectedStrokes).toBeCloseTo(expected, 12);
        // A clubbed leg costs at least its own stroke relative to the point
        // estimate it replaces (dispersion can only price ≥ the aim's mean
        // improvement is bounded by the table's convexity in practice here).
        expect(chain.perLeg[0].expectedStrokes - chain.perLeg[0].baselineStrokes)
            .toBeGreaterThan(0.9);
    });

    test('tail spreads compose in quadrature across legs', () => {
        const chain = scoreOptionChain(
            [
                { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
                { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
            ],
            { surfaces: HOLE_SURFACES, greenCenter: HOLE_CENTER },
        );
        const rss = Math.sqrt(chain.perLeg.reduce((sum, leg) => {
            const spread = leg.tailStrokes - leg.expectedStrokes;
            return sum + spread * spread;
        }, 0));
        expect(chain.tailStrokes).toBeCloseTo(chain.expectedStrokes + rss, 12);
        // Strictly less than the additive (comonotone) bound when both legs
        // carry spread — quadrature is the point of the composition rule.
        const additive = chain.perLeg.reduce(
            (sum, leg) => sum + leg.tailStrokes - leg.expectedStrokes, 0);
        expect(chain.tailStrokes - chain.expectedStrokes).toBeLessThan(additive);
    });

    test('penalty aggregates as 1 − Π(1 − legPenaltyProb) with real leg penalties', () => {
        // Water flanks BOTH sides of both landing zones so no candidate aim
        // in either leg's sweep escapes it entirely.
        const waterRight = box('water', 6, 100, 60, 360);
        const waterLeft = box('water', -60, 100, -6, 360);
        const surfaces: readonly FlatRing[] = [waterRight, waterLeft, HOLE_GREEN, HOLE_FAIRWAY];
        const chain = scoreOptionChain(
            [
                { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
                { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
            ],
            { surfaces, greenCenter: HOLE_CENTER },
        );
        const [p1, p2] = chain.perLeg.map(leg => leg.penaltyProb);
        expect(p1).toBeGreaterThan(0);
        expect(p2).toBeGreaterThan(0);
        expect(chain.penaltyProb).toBeCloseTo(1 - (1 - p1) * (1 - p2), 12);
        expect(chain.penaltyProb).toBeGreaterThan(Math.max(p1, p2));
    });

    test('an empty chain scores as zeros (nothing to play)', () => {
        const chain = scoreOptionChain([], { surfaces: HOLE_SURFACES, greenCenter: HOLE_CENTER });
        expect(chain).toEqual({ expectedStrokes: 0, tailStrokes: 0, penaltyProb: 0, perLeg: [] });
    });

    test('wind reaches the per-leg optimizeAim pricing', () => {
        const legs = [
            { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
        ];
        const calm = scoreOptionChain(legs, { surfaces: HOLE_SURFACES, greenCenter: HOLE_CENTER });
        const headwind = scoreOptionChain(legs, {
            surfaces: HOLE_SURFACES,
            greenCenter: HOLE_CENTER,
            wind: { speedMps: 8, directionDeg: 0 }, // straight down the shot line
        });
        expect(headwind.expectedStrokes).not.toBe(calm.expectedStrokes);
    });
});
