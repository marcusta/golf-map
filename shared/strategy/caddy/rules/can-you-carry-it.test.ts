import { describe, expect, test } from 'bun:test';
import { type ClubSpec } from '../../club';
import { type FlatRing } from '../../corridor';
import { runCaddy } from '../run';
import { type CaddyContext } from '../rule';
import { CLUB_UP_MAX_PAST_TARGET_M, canYouCarryItRule } from './can-you-carry-it';

function club(name: string, carryM: number, dispersionM = 18): ClubSpec {
    return { name, carryM, dispersionM };
}

/** Axis-aligned box ring straddling the +y shot line. */
function box(kind: string, minY: number, maxY: number, halfWidth = 15): FlatRing {
    return {
        kind,
        points: [
            { x: -halfWidth, y: minY },
            { x: halfWidth, y: minY },
            { x: halfWidth, y: maxY },
            { x: -halfWidth, y: maxY },
        ],
    };
}

function ctx(over: Partial<CaddyContext> = {}): CaddyContext {
    return {
        leg: 'approach',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: { kind: 'green', points: [] },
            center: { x: 0, y: 150 },
            front: { x: 0, y: 145 },
            back: { x: 0, y: 155 },
        },
        distances: [],
        hazards: [box('bunker', 130, 145)],
        clubs: [club('6 iron', 152, 16), club('5 iron', 166, 18), club('9 iron', 120, 14)],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [canYouCarryItRule]);

describe('can-you-carry-it — the landing window vs the hazard interval', () => {
    test('flirting with a front bunker clubs up when a longer club carries it', () => {
        // 6i at 152: band 144.4–159.6 overlaps the 130–145 bunker; the 5i's
        // short miss (157.7) clears the far edge and lands within the
        // overshoot allowance.
        const out = run(ctx());
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('can-you-carry-it');
        expect(out[0].kind).toBe('club');
        expect(out[0].headline).toContain("Can't carry the bunker with the 6 iron");
        expect(out[0].headline).toContain('club up to the 5 iron');
        // Anchored at the carry-to point (the far edge).
        expect(out[0].anchor).toEqual({ x: 0, y: 145 });
        expect(out[0].riskWeighted).toBe(true);
    });

    test('lays up when no club carries within the overshoot allowance', () => {
        // Same bunker but the only longer club flies far past the target.
        const out = run(ctx({
            clubs: [club('6 iron', 152, 16), club('driver', 230, 60), club('9 iron', 120, 14)],
        }));
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('layup');
        expect(out[0].headline).toContain('lay up short with the 9 iron');
        expect(230 - 152).toBeGreaterThan(CLUB_UP_MAX_PAST_TARGET_M);
        // Anchored at the near edge (stay short of it).
        expect(out[0].anchor).toEqual({ x: 0, y: 130 });
    });

    test('plain warning when neither remedy exists in the bag', () => {
        const out = run(ctx({ clubs: [club('6 iron', 152, 16)] }));
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('warning');
        expect(out[0].headline).toContain('in play with the 6 iron');
    });

    test('a clean carry stays quiet', () => {
        // Bunker 60–80 m out: the 6i band (144.4–159.6) clears it entirely.
        expect(run(ctx({ hazards: [box('bunker', 60, 80)] }))).toEqual([]);
    });

    test('a hazard past the landing window stays quiet', () => {
        expect(run(ctx({ hazards: [box('water', 170, 190)] }))).toEqual([]);
    });

    test('a hazard off the shot line stays quiet', () => {
        const off: FlatRing = {
            kind: 'bunker',
            points: [
                { x: 40, y: 130 }, { x: 60, y: 130 },
                { x: 60, y: 145 }, { x: 40, y: 145 },
            ],
        };
        expect(run(ctx({ hazards: [off] }))).toEqual([]);
    });

    test('water outranks sand (priority 4 vs 3)', () => {
        const sand = run(ctx())[0];
        const water = run(ctx({ hazards: [box('water', 130, 145)] }))[0];
        expect(sand.priority).toBe(3);
        expect(water.priority).toBe(4);
        expect(water.headline).toContain('water');
    });

    test('the most-overlapping crossed hazard wins', () => {
        // A sliver at the band's edge vs a ring eating the middle of it.
        const sliver = box('bunker', 155, 170);
        const middle = box('water', 145, 152);
        const out = run(ctx({ hazards: [sliver, middle] }));
        expect(out).toHaveLength(1);
        expect(out[0].headline).toContain('water');
    });

    test('follows the recommended aim bearing when an AimResult is present', () => {
        // Straight line crosses the bunker; the recommended aim (90° — due
        // east) misses it entirely, so the rule prices the aimed line.
        const aim = {
            bestBearingDeg: 90,
            best: { bearingDeg: 90, expectedStrokes: 3, tailStrokes: 3, score: 3, breakdown: {} },
            perCandidate: [],
            breakdown: {},
        };
        expect(run(ctx({ aim: aim as CaddyContext['aim'] }))).toEqual([]);
    });

    test('headwind pulls the band back into a hazard the calm shot clears', () => {
        // Bunker 118–136 m: calm 6i band 144.4–159.6 clears it; a 6 m/s
        // headwind shortens the band into the ring.
        const hazards = [box('bunker', 118, 136)];
        expect(run(ctx({ hazards }))).toEqual([]);
        const out = run(ctx({ hazards, wind: { speedMps: 6, directionDeg: 0 } }));
        expect(out).toHaveLength(1);
    });
});

describe('can-you-carry-it — gating', () => {
    test('no clubs does not apply', () => {
        expect(canYouCarryItRule.appliesTo(ctx({ clubs: [] }))).toBe(false);
    });

    test('no hazards does not apply', () => {
        expect(canYouCarryItRule.appliesTo(ctx({ hazards: [] }))).toBe(false);
    });

    test('already at the target emits nothing', () => {
        expect(run(ctx({
            target: {
                greenPoly: { kind: 'green', points: [] },
                center: { x: 0, y: 0 },
                front: { x: 0, y: 0 },
                back: { x: 0, y: 0 },
            },
        }))).toEqual([]);
    });
});
