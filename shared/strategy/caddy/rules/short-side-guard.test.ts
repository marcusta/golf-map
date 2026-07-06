import { describe, expect, test } from 'bun:test';
import { type AimCandidate, type AimResult } from '../../aim';
import { type FlatRing } from '../../corridor';
import { type Lie } from '../../lie';
import { runCaddy } from '../run';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';
import {
    SHORT_SIDE_TROUBLE_SEVERE,
    SHORT_SIDE_TROUBLE_SHARE,
    shortSideGuardRule,
} from './short-side-guard';

/** An AimResult whose recommended aim has the given lie breakdown. */
function aim(breakdown: Partial<Record<Lie, number>>): AimResult {
    const best: AimCandidate = {
        bearingDeg: 0,
        expectedStrokes: 3,
        tailStrokes: 3,
        score: 3,
        breakdown,
    };
    return { bestBearingDeg: 0, best, perCandidate: [best], breakdown };
}

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
        aim: aim({ green: 0.7, sand: 0.3 }),
        hazards: [box('bunker', 5, 140, 12, 150)],
        clubs: [],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [shortSideGuardRule]);

describe('short-side-guard — fires', () => {
    test('trouble share over threshold ⇒ aim-fat advice anchored at green centre', () => {
        const out = run(ctx());
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('short-side-guard');
        expect(out[0].kind).toBe('aim');
        expect(out[0].headline).toContain('fat side');
        expect(out[0].anchor).toEqual({ x: 0, y: 150 });
    });

    test('sand + water + recovery all count toward the trouble share', () => {
        const out = run(ctx({ aim: aim({ green: 0.85, sand: 0.05, penalty: 0.05, recovery: 0.05 }) }));
        expect(out).toHaveLength(1); // 0.15 combined > threshold
    });

    test('a heavier trouble share ranks higher priority', () => {
        const light = run(ctx({ aim: aim({ green: 0.9, sand: SHORT_SIDE_TROUBLE_SHARE + 0.01 }) }));
        const heavy = run(ctx({ aim: aim({ green: 0.7, sand: SHORT_SIDE_TROUBLE_SEVERE }) }));
        expect(heavy[0].priority).toBeGreaterThan(light[0].priority);
    });
});

describe('short-side-guard — stays quiet', () => {
    test('trouble share below threshold ⇒ no advice', () => {
        expect(run(ctx({ aim: aim({ green: 0.97, sand: 0.03 }) }))).toEqual([]);
    });

    test('no hazards on the hole ⇒ does not apply', () => {
        expect(shortSideGuardRule.appliesTo(ctx({ hazards: [] }))).toBe(false);
    });

    test('non-approach leg ⇒ does not apply', () => {
        expect(shortSideGuardRule.appliesTo(ctx({ leg: 'tee' }))).toBe(false);
        expect(shortSideGuardRule.appliesTo(ctx({ leg: 'recovery' }))).toBe(false);
    });

    test('no aim result ⇒ does not apply', () => {
        expect(shortSideGuardRule.appliesTo(ctx({ aim: undefined }))).toBe(false);
    });
});

describe('short-side-guard — vetoes the aggressive line', () => {
    const attack: CaddyRule = {
        id: 'specific-target',
        appliesTo: () => true,
        evaluate: (): CaddyAdvice[] => [{
            ruleId: 'specific-target',
            kind: 'aim',
            priority: 10,
            confidence: 1,
            headline: 'Fire at the pin.',
        }],
    };

    test('a short-side risk demotes specific-target below the guard', () => {
        const out = runCaddy(ctx({ aim: aim({ green: 0.6, sand: 0.4 }) }), [attack, shortSideGuardRule]);
        expect(out).toHaveLength(2);
        expect(out[0].ruleId).toBe('short-side-guard');
        expect(out[1].ruleId).toBe('specific-target');
    });
});
