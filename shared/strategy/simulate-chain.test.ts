import { describe, expect, test } from 'bun:test';
import { optimizeAim } from './aim';
import type { ClubSpec } from './club';
import type { FlatRing } from './corridor';
import type { ChainLeg, ChainScoreContext } from './option-chain';
import { scoreOptionChain } from './option-chain';
import { DEFAULT_ROLLOUTS, simulateChain } from './simulate-chain';

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

function bearingDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

/**
 * Enrich a leg with the recommended aim (optimizeAim's bestBearingDeg) — the
 * production enrich pass. The sim aims here so a rollout samples around the
 * SAME aim scoreOptionChain priced the branch at (§V1 step 1).
 */
function enrich(
    origin: { x: number; y: number },
    landing: { x: number; y: number },
    club: ClubSpec,
    ctx: ChainScoreContext,
): ChainLeg {
    const aim = optimizeAim({
        origin,
        club,
        targetBearingDeg: bearingDeg(origin, landing),
        surfaces: ctx.surfaces,
        greenCenter: ctx.greenCenter,
        fallbackLie: ctx.fallbackLie ?? 'rough',
        ...(ctx.wind !== undefined
            ? { windSpeedMps: ctx.wind.speedMps, windDirectionDeg: ctx.wind.directionDeg }
            : {}),
    });
    return { origin, landing, club, recommendedBearingDeg: aim.bestBearingDeg };
}

// ── Keystone agreement fixture (§4) ──────────────────────────────────────────
//
// On authored branches of a reference hole, mean(simulateChain) must land
// within a PINNED tolerance of scoreOptionChain().expectedStrokes. They are
// DIFFERENT models — telescoped table EV vs rollout with a closeout pmf — so
// exact equality is neither expected nor wanted. The divergence has two
// documented sources:
//
//   1. ON-SCRIPT RE-ORIGIN. The sim replays each later leg from the actual
//      sampled landing, so a tee miss makes the approach genuinely harder;
//      scoreOptionChain telescopes, re-pricing every leg from its FIXED
//      authored landing. Misses compound in the sim ⇒ multi-leg branches read
//      slightly higher. (Zero for single-leg branches — nothing to re-origin.)
//   2. PMF-VS-MEAN CLOSEOUT + finite-N sampling. The sim draws INTEGER
//      closeouts (§V2 pmf, mean pinned to the table μ) and Monte-Carlos the
//      geometry with a counter-based Gaussian; scoreOptionChain integrates the
//      continuous table μ over optimizeAim's 128-point Halton quasi-random
//      continuation. Equal in expectation; the residual is sampling method + N.
//
// Both are sub-0.05 stroke on the fixture below. Anything outside AGREEMENT_TOL
// is a real bug in one model. (Observed 2026-07-25: single-leg −0.024,
// depth-2 +0.021; tolerance pinned with headroom.)
const AGREEMENT_TOL = 0.06;

describe('simulateChain — keystone agreement fixture (§4)', () => {
    // Single-leg par-5 attack: reachable green at 190 m, water flanking the
    // right (topmost in the D23 stack). Shared with the option-chain O4 fixture.
    const GREEN = box('green', -18, 180, 18, 200);
    const WATER = box('water', 10, 150, 90, 210);
    const CENTER = { x: 0, y: 190 };
    const THREE_WOOD: ClubSpec = { name: '3 wood', carryM: 185, dispersionM: 24 };
    const attackCtx: ChainScoreContext = {
        surfaces: [WATER, GREEN],
        greenCenter: CENTER,
        fallbackLie: 'fairway',
    };

    test('single-leg attack branch: sim mean ≈ chain EV', () => {
        const leg = enrich({ x: 0, y: 0 }, CENTER, THREE_WOOD, attackCtx);
        const chain = scoreOptionChain([leg], attackCtx);
        const sim = simulateChain([leg], attackCtx);
        expect(Math.abs(sim.mean - chain.expectedStrokes)).toBeLessThan(AGREEMENT_TOL);
        // A single-leg branch always "plays as drawn" — one shot then closeout.
        expect(sim.onScriptRate).toBe(1);
    });

    // Depth-2 par-4: driver to a fairway landing, wedge to the green, water
    // pinching the right of the drive zone.
    const HOLE_GREEN = box('green', -14, 340, 14, 368);
    const HOLE_WATER = box('water', 18, 120, 70, 260);
    const HOLE_FAIRWAY = box('fairway', -30, 0, 16, 330);
    const HOLE_CENTER = { x: 0, y: 354 };
    const DRIVER: ClubSpec = { name: 'Driver', carryM: 230, dispersionM: 32 };
    const WEDGE: ClubSpec = { name: 'PW', carryM: 120, dispersionM: 12 };
    const holeCtx: ChainScoreContext = {
        surfaces: [HOLE_WATER, HOLE_GREEN, HOLE_FAIRWAY],
        greenCenter: HOLE_CENTER,
    };

    test('depth-2 driver+wedge branch: sim mean ≈ chain EV', () => {
        const legs = [
            enrich({ x: 0, y: 0 }, { x: 0, y: 230 }, DRIVER, holeCtx),
            enrich({ x: 0, y: 230 }, { x: 0, y: 350 }, WEDGE, holeCtx),
        ];
        const chain = scoreOptionChain(legs, holeCtx);
        const sim = simulateChain(legs, holeCtx);
        expect(Math.abs(sim.mean - chain.expectedStrokes)).toBeLessThan(AGREEMENT_TOL);
        // The plan almost always survives (fairway is wide, wedge reaches).
        expect(sim.onScriptRate).toBeGreaterThan(0.9);
    });
});

// ── Determinism (V3) ─────────────────────────────────────────────────────────

describe('simulateChain — deterministic (V3, no Date/Math.random)', () => {
    const GREEN = box('green', -14, 340, 14, 368);
    const FAIRWAY = box('fairway', -30, 0, 16, 330);
    const CTX: ChainScoreContext = { surfaces: [GREEN, FAIRWAY], greenCenter: { x: 0, y: 354 } };
    const DRIVER: ClubSpec = { name: 'Driver', carryM: 230, dispersionM: 32 };
    const WEDGE: ClubSpec = { name: 'PW', carryM: 120, dispersionM: 12 };
    const legs: ChainLeg[] = [
        { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
        { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
    ];

    test('same inputs ⇒ identical histogram and mean', () => {
        const a = simulateChain(legs, CTX);
        const b = simulateChain(legs, CTX);
        expect(a.pmf).toEqual(b.pmf);
        expect(a.mean).toBe(b.mean);
        expect(a.onScriptRate).toBe(b.onScriptRate);
        expect(a.perLegLandings).toEqual(b.perLegLandings);
    });

    test('a different seed moves the histogram (RNG is actually used)', () => {
        const a = simulateChain(legs, CTX, { seed: 1 });
        const b = simulateChain(legs, CTX, { seed: 2 });
        expect(a.pmf).not.toEqual(b.pmf);
    });

    test('P(double+) is seed-stable to < 1 pp at N=800 (pins N)', () => {
        const pAtLeast = (pmf: readonly number[], k: number) =>
            pmf.slice(k).reduce((s, p) => s + p, 0);
        const vals = [1, 2, 3, 4, 5, 6].map((seed) => pAtLeast(simulateChain(legs, CTX, { seed }).pmf, 6));
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThan(0.01);
    });
});

// ── Output shape & rollout mechanics ─────────────────────────────────────────

describe('simulateChain — output shape', () => {
    const GREEN = box('green', -14, 340, 14, 368);
    const FAIRWAY = box('fairway', -30, 0, 16, 330);
    const CTX: ChainScoreContext = { surfaces: [GREEN, FAIRWAY], greenCenter: { x: 0, y: 354 } };
    const DRIVER: ClubSpec = { name: 'Driver', carryM: 230, dispersionM: 32 };
    const WEDGE: ClubSpec = { name: 'PW', carryM: 120, dispersionM: 12 };
    const legs: ChainLeg[] = [
        { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
        { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
    ];

    test('pmf sums to 1, mean matches Σ k·pmf[k], one landing cloud per leg', () => {
        const sim = simulateChain(legs, CTX);
        expect(Math.abs(sim.pmf.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-12);
        const meanFromPmf = sim.pmf.reduce((acc, p, k) => acc + k * p, 0);
        expect(sim.mean).toBeCloseTo(meanFromPmf, 9);
        expect(sim.perLegLandings).toHaveLength(2);
        expect(sim.perLegLandings[0]!.length).toBe(DEFAULT_ROLLOUTS); // leg 0 always played
        expect(sim.rollouts).toBe(DEFAULT_ROLLOUTS);
    });

    test('maxLandingsPerLeg caps the scatter but not the pmf', () => {
        const capped = simulateChain(legs, CTX, { maxLandingsPerLeg: 50 });
        expect(capped.perLegLandings[0]!.length).toBe(50);
        const full = simulateChain(legs, CTX);
        expect(capped.mean).toBe(full.mean); // pmf/mean use every rollout
    });

    test('an empty chain simulates as a certain zero (nothing to play)', () => {
        const sim = simulateChain([], CTX);
        expect(sim.pmf).toEqual([1]);
        expect(sim.mean).toBe(0);
        expect(sim.perLegLandings).toEqual([]);
    });

    test('a clubless final leg is a deterministic point-estimate landing', () => {
        // Clubless leg lands exactly on its authored point (no dispersion).
        const sim = simulateChain(
            [{ origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 } }],
            CTX,
        );
        for (const p of sim.perLegLandings[0]!) {
            expect(p.x).toBe(0);
            expect(p.y).toBe(230);
        }
    });
});

describe('simulateChain — off-script closeout (§V4)', () => {
    test('water flanking both sides drives the plan off script and inflates the score', () => {
        const waterR = box('water', 6, 100, 60, 360);
        const waterL = box('water', -60, 100, -6, 360);
        const GREEN = box('green', -14, 340, 14, 368);
        const FAIRWAY = box('fairway', -30, 0, 16, 330);
        const ctx: ChainScoreContext = {
            surfaces: [waterR, waterL, GREEN, FAIRWAY],
            greenCenter: { x: 0, y: 354 },
        };
        const DRIVER: ClubSpec = { name: 'Driver', carryM: 230, dispersionM: 60 };
        const WEDGE: ClubSpec = { name: 'PW', carryM: 120, dispersionM: 12 };
        const legs: ChainLeg[] = [
            { origin: { x: 0, y: 0 }, landing: { x: 0, y: 230 }, club: DRIVER },
            { origin: { x: 0, y: 230 }, landing: { x: 0, y: 350 }, club: WEDGE },
        ];
        const sim = simulateChain(legs, ctx);
        // Many drives find water → off script well below 1.
        expect(sim.onScriptRate).toBeLessThan(0.9);
    });
});

describe('simulateChain — performance gate (§6: 800 × 4-leg < 100 ms)', () => {
    test('measures and reports the number', () => {
        const GREEN = box('green', -14, 348, 14, 360);
        const FAIRWAY = box('fairway', -40, 0, 40, 345);
        const ctx: ChainScoreContext = { surfaces: [GREEN, FAIRWAY], greenCenter: { x: 0, y: 354 } };
        const IRON: ClubSpec = { name: 'iron', carryM: 120, dispersionM: 14 };
        const legs: ChainLeg[] = [
            { origin: { x: 0, y: 0 }, landing: { x: 0, y: 118 }, club: IRON },
            { origin: { x: 0, y: 118 }, landing: { x: 0, y: 236 }, club: IRON },
            { origin: { x: 0, y: 236 }, landing: { x: 0, y: 300 }, club: IRON },
            { origin: { x: 0, y: 300 }, landing: { x: 0, y: 354 }, club: IRON },
        ];
        simulateChain(legs, ctx, { rollouts: 800 }); // warm
        const t0 = performance.now();
        const iters = 10;
        for (let i = 0; i < iters; i++) simulateChain(legs, ctx, { rollouts: 800 });
        const avgMs = (performance.now() - t0) / iters;
        // eslint-disable-next-line no-console
        console.log(`[perf] simulateChain 800 rollouts × 4-leg branch: ${avgMs.toFixed(2)} ms`);
        expect(avgMs).toBeLessThan(100);
    });
});
