import { buildTreeStemIndex } from '../../tree-stems';
import { describe, expect, test } from 'bun:test';
import { type ClubSpec } from '../../club';
import { type TreeFeatureInput } from '../../tree-clearance';
import { runCaddy } from '../run';
import { type CaddyContext } from '../rule';
import { TREES_BLOCKED_PRIORITY, TREES_MARGINAL_PRIORITY, overTheTreesRule } from './over-the-trees';

function club(name: string, carryM: number, dispersionM = 18): ClubSpec {
    return { name, carryM, dispersionM };
}

/** Axis-aligned tree box straddling the +y shot line. */
function trees(minY: number, maxY: number, heightP90M: number | null, halfWidth = 15): TreeFeatureInput {
    return {
        type: 'trees',
        points: [
            { x: -halfWidth, y: minY },
            { x: halfWidth, y: minY },
            { x: halfWidth, y: maxY },
            { x: -halfWidth, y: maxY },
        ],
        attributes: heightP90M === null ? null : { heightP90M },
    };
}

function ctx(over: Partial<CaddyContext> = {}): CaddyContext {
    return {
        leg: 'tee',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: { kind: 'green', points: [] },
            center: { x: 0, y: 150 },
            front: { x: 0, y: 145 },
            back: { x: 0, y: 155 },
        },
        distances: [],
        hazards: [],
        clubs: [club('7 iron', 150)],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        apexM: 24,
        // 150 m carry, apex 24 m at 93 m: the ball is ~20 m up at 55 m, so a
        // 17 m canopy clears by ~3 m (over the 2 m margin).
        trees: [trees(55, 65, 17)],
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [overTheTreesRule]);

describe('over-the-trees — blocked and marginal crossings', () => {
    test('a canopy taller than the flight is blocked', () => {
        const out = run(ctx({ trees: [trees(55, 65, 30)] }));
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('over-the-trees');
        expect(out[0].kind).toBe('warning');
        expect(out[0].priority).toBe(TREES_BLOCKED_PRIORITY);
        expect(out[0].riskWeighted).toBe(true);
        expect(out[0].headline).toMatch(/^Trees 30 m high at 55 m, ball at about \d+ m: blocked, aim left\/right or lay up\.$/);
        // Anchored on the line at the worst point (the entry, where the ball is lowest).
        expect(out[0].anchor?.x).toBeCloseTo(0, 6);
        expect(out[0].anchor?.y).toBeCloseTo(55, 6);
    });

    test('a canopy just under the flight is a marginal note', () => {
        // Ball at 55 m ≈ 20 m (apex 24 at 93 m): a 19 m canopy clears by ~1 m.
        const out = run(ctx({ trees: [trees(55, 65, 19)] }));
        expect(out).toHaveLength(1);
        expect(out[0].priority).toBe(TREES_MARGINAL_PRIORITY);
        expect(out[0].headline).toContain('to spare over the trees');
        expect(out[0].headline).toContain('Trees 19 m high at 55 m');
    });

    test('a clean clearance stays quiet', () => {
        expect(run(ctx({ trees: [trees(55, 65, 10)] }))).toEqual([]);
    });

    test('hand-drawn trees without height stay quiet', () => {
        expect(run(ctx({ trees: [trees(55, 65, null)] }))).toEqual([]);
    });

    test('trees past the carry are rollout hazards, not flight obstacles', () => {
        expect(run(ctx({ trees: [trees(160, 180, 40)] }))).toEqual([]);
    });

    test('trees off the line stay quiet', () => {
        const off: TreeFeatureInput = {
            type: 'trees',
            points: [{ x: 40, y: 55 }, { x: 60, y: 55 }, { x: 60, y: 65 }, { x: 40, y: 65 }],
            attributes: { heightP90M: 40 },
        };
        expect(run(ctx({ trees: [off] }))).toEqual([]);
    });

    test('shotCarryM overrides the closest-club carry', () => {
        // With the bag's 150 m club the 30 m canopy at 55 m blocks; a 60 m
        // pitch (apex 24 → lands short of the trees) never reaches it.
        expect(run(ctx({ trees: [trees(55, 65, 30)] }))).toHaveLength(1);
        expect(run(ctx({ trees: [trees(55, 65, 30)], shotCarryM: 50 }))).toEqual([]);
    });

    test('rising ground under the trees lifts the canopy top', () => {
        // Flat: 17 m canopy at 55–65 m clears (ball ~20 m). Ground 5 m higher
        // under the trees than at the origin: the top is 22 m, blocked.
        expect(run(ctx())).toEqual([]);
        const out = run(ctx({ groundAt: (d: number) => (d >= 50 ? 5 : 0) }));
        expect(out).toHaveLength(1);
        expect(out[0].headline).toContain('blocked');
    });

    test('follows the recommended aim bearing when an AimResult is present', () => {
        const aim = {
            bestBearingDeg: 90,
            best: { bearingDeg: 90, expectedStrokes: 3, tailStrokes: 3, score: 3, breakdown: {} },
            perCandidate: [],
            breakdown: {},
        };
        expect(run(ctx({ trees: [trees(55, 65, 30)], aim: aim as CaddyContext['aim'] }))).toEqual([]);
    });
});

describe('over-the-trees — gating', () => {
    test('no trees does not apply', () => {
        expect(overTheTreesRule.appliesTo(ctx({ trees: [] }))).toBe(false);
        expect(overTheTreesRule.appliesTo(ctx({ trees: undefined }))).toBe(false);
    });

    test('no apex does not apply', () => {
        expect(overTheTreesRule.appliesTo(ctx({ apexM: undefined }))).toBe(false);
        expect(overTheTreesRule.appliesTo(ctx({ apexM: 0 }))).toBe(false);
    });

    test('no clubs and no shotCarryM does not apply; shotCarryM alone does', () => {
        expect(overTheTreesRule.appliesTo(ctx({ clubs: [] }))).toBe(false);
        expect(overTheTreesRule.appliesTo(ctx({ clubs: [], shotCarryM: 150 }))).toBe(true);
    });
});


test('stem index uses absolute ground and stays silent without origin elevation', () => {
    const trees = buildTreeStemIndex([{x:0,y:60,heightM:30,crownRadiusM:5,groundM:80}]);
    expect(run(ctx({trees, originGroundM:80, originGroundKnown:true}))).toHaveLength(1);
    expect(run(ctx({trees, originGroundKnown:false}))).toHaveLength(0);
    expect(run(ctx({trees:buildTreeStemIndex([])}))).toHaveLength(0);
});
