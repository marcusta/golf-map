import { describe, expect, test } from 'bun:test';
import { type AimCandidate, type AimResult } from '../../aim';
import { type ClubSpec } from '../../club';
import { type Lie } from '../../lie';
import { runCaddy } from '../run';
import { type CaddyContext } from '../rule';
import { noDoublesRule } from './no-doubles';
import { specificTargetRule } from './specific-target';

function club(name: string, carryM: number, dispersionM = 18): ClubSpec {
    return { name, carryM, dispersionM };
}

function aim(bearingDeg: number, breakdown: Partial<Record<Lie, number>>, tail = 3): AimResult {
    const best: AimCandidate = {
        bearingDeg,
        expectedStrokes: 3,
        tailStrokes: tail,
        score: 3,
        breakdown,
    };
    return { bestBearingDeg: bearingDeg, best, perCandidate: [best], breakdown };
}

function ctx(over: Partial<CaddyContext> = {}): CaddyContext {
    return {
        leg: 'approach',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: { kind: 'green', points: [] },
            center: { x: 0, y: 150 }, // due north, 150 m
            front: { x: 0, y: 145 },
            back: { x: 0, y: 155 },
        },
        distances: [],
        aim: aim(0, { green: 0.9, rough: 0.1 }),
        hazards: [],
        clubs: [club('7 iron', 150, 16), club('6 iron', 165, 18), club('8 iron', 138, 15)],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [specificTargetRule]);

describe('specific-target — fires on an approach', () => {
    test('names the centre club and projects a ghost aim anchor', () => {
        const out = run(ctx());
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('specific-target');
        expect(out[0].kind).toBe('aim');
        // 150 m to a due-north green → the 7 iron (150 m) is the number.
        expect(out[0].headline).toContain('7 iron');
        // Anchor is the recommended bearing (0° = north) projected 150 m.
        expect(out[0].anchor!.x).toBeCloseTo(0, 3);
        expect(out[0].anchor!.y).toBeCloseTo(150, 3);
    });

    test('detail brackets the number front/back when the bag straddles it', () => {
        // A 156 m number sits strictly between the 7 iron (150, back) and the
        // 6 iron (165, front) → the bracket note appears.
        const out = run(ctx({
            target: {
                greenPoly: { kind: 'green', points: [] },
                center: { x: 0, y: 156 },
                front: { x: 0, y: 151 },
                back: { x: 0, y: 161 },
            },
        }));
        expect(out[0].detail).toContain('6 iron'); // front (shortest that reaches)
        expect(out[0].detail).toContain('7 iron'); // back (longest that stays short)
        expect(out[0].detail).toContain('front');
    });

    test('confidence rises with the green-hit share', () => {
        const shaky = run(ctx({ aim: aim(0, { green: 0.4, rough: 0.6 }) }));
        const sure = run(ctx({ aim: aim(0, { green: 0.95, rough: 0.05 }) }));
        expect(sure[0].confidence).toBeGreaterThan(shaky[0].confidence);
    });
});

describe('specific-target — gating', () => {
    test('non-approach leg does not apply', () => {
        expect(specificTargetRule.appliesTo(ctx({ leg: 'tee' }))).toBe(false);
        expect(specificTargetRule.appliesTo(ctx({ leg: 'layup' }))).toBe(false);
    });

    test('no aim result does not apply', () => {
        expect(specificTargetRule.appliesTo(ctx({ aim: undefined }))).toBe(false);
    });
});

describe('specific-target — the safety rules veto it', () => {
    test('an ugly tail from no-doubles demotes the committed line', () => {
        const out = runCaddy(
            ctx({ aim: aim(0, { green: 0.9 }, /*tail*/ 4.5) }),
            [specificTargetRule, noDoublesRule],
        );
        expect(out).toHaveLength(2);
        expect(out[0].ruleId).toBe('no-doubles');
        expect(out[1].ruleId).toBe('specific-target');
    });
});
