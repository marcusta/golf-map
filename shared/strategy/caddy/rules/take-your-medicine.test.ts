import { describe, expect, test } from 'bun:test';
import { type ClubSpec } from '../../club';
import { runCaddy } from '../run';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';
import { takeYourMedicineRule } from './take-your-medicine';

function club(name: string, carryM: number, dispersionM = 18): ClubSpec {
    return { name, carryM, dispersionM };
}

function ctx(over: Partial<CaddyContext> = {}): CaddyContext {
    return {
        leg: 'recovery',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: { kind: 'green', points: [] },
            center: { x: 0, y: 180 }, // 180 m to the green from jail
            front: { x: 0, y: 175 },
            back: { x: 0, y: 185 },
        },
        distances: [],
        hazards: [],
        clubs: [club('wedge', 90, 12), club('9 iron', 120, 14)],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [takeYourMedicineRule]);

describe('take-your-medicine — fires from a recovery lie', () => {
    test('recommends the punch-out over forcing it', () => {
        const out = run(ctx());
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('take-your-medicine');
        expect(out[0].kind).toBe('layup');
        expect(out[0].headline).toContain('medicine');
        // Uses the shortest club to escape.
        expect(out[0].headline).toContain('wedge');
    });

    test('the medicine outcome prices better than the hero outcome (uses shotsToHoleOut)', () => {
        const out = run(ctx());
        // Detail cites both EVs; the recommendation only fires when medicine < hero,
        // so its presence proves the table-backed comparison favoured the escape.
        expect(out[0].detail).toContain('prices at');
    });
});

describe('take-your-medicine — gating', () => {
    test('non-recovery leg does not apply', () => {
        expect(takeYourMedicineRule.appliesTo(ctx({ leg: 'approach' }))).toBe(false);
        expect(takeYourMedicineRule.appliesTo(ctx({ leg: 'tee' }))).toBe(false);
    });

    test('no clubs does not apply', () => {
        expect(takeYourMedicineRule.appliesTo(ctx({ clubs: [] }))).toBe(false);
    });

    test('already at the green (no remaining) emits nothing', () => {
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

describe('take-your-medicine — vetoes the aggressive line', () => {
    const attack: CaddyRule = {
        id: 'specific-target',
        appliesTo: () => true,
        evaluate: (): CaddyAdvice[] => [{
            ruleId: 'specific-target',
            kind: 'aim',
            priority: 10,
            confidence: 1,
            headline: 'Go for the green.',
        }],
    };

    test('from jail, medicine demotes the attack', () => {
        const out = runCaddy(ctx(), [attack, takeYourMedicineRule]);
        expect(out).toHaveLength(2);
        expect(out[0].ruleId).toBe('take-your-medicine');
        expect(out[1].ruleId).toBe('specific-target');
    });
});
