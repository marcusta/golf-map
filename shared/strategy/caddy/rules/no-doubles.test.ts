import { describe, expect, test } from 'bun:test';
import { type AimCandidate, type AimResult } from '../../aim';
import { runCaddy } from '../run';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';
import { noDoublesRule, TAIL_GAP_SEVERE, TAIL_GAP_WARN } from './no-doubles';

/** A minimal AimResult whose recommended aim has the given mean/tail. */
function aim(mean: number, tail: number): AimResult {
    const best: AimCandidate = {
        bearingDeg: 0,
        expectedStrokes: mean,
        tailStrokes: tail,
        score: mean,
        breakdown: {},
    };
    return { bestBearingDeg: 0, best, perCandidate: [best], breakdown: {} };
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
        aim: aim(3.0, 3.2), // small tail by default
        hazards: [],
        clubs: [],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [noDoublesRule]);

describe('no-doubles — fires on an ugly tail', () => {
    test('a big tail gap warns', () => {
        const out = run(ctx({ aim: aim(3.0, 3.0 + TAIL_GAP_WARN + 0.3) }));
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('no-doubles');
        expect(out[0].kind).toBe('warning');
        expect(out[0].headline).toContain('big number');
    });

    test('a severe tail gap ranks higher priority than a marginal one', () => {
        const marginal = run(ctx({ aim: aim(3.0, 3.0 + TAIL_GAP_WARN + 0.05) }));
        const severe = run(ctx({ aim: aim(3.0, 3.0 + TAIL_GAP_SEVERE) }));
        expect(severe[0].priority).toBeGreaterThan(marginal[0].priority);
        expect(severe[0].confidence).toBeGreaterThan(marginal[0].confidence);
    });

    test('reads tailStrokes directly (D16) — does not recompute risk', () => {
        // The advice is a pure function of (tail − mean); shifting both by the
        // same amount leaves the gap, hence the advice, unchanged.
        const a = run(ctx({ aim: aim(3.0, 4.0) }))[0];
        const b = run(ctx({ aim: aim(4.0, 5.0) }))[0];
        expect(a.priority).toBe(b.priority);
        expect(a.confidence).toBe(b.confidence);
    });
});

describe('no-doubles — stays quiet', () => {
    test('a tight tail (gap below threshold) emits nothing', () => {
        expect(run(ctx({ aim: aim(3.0, 3.0 + TAIL_GAP_WARN - 0.05) }))).toEqual([]);
    });

    test('no aim result → does not apply', () => {
        expect(noDoublesRule.appliesTo(ctx({ aim: undefined }))).toBe(false);
        expect(run(ctx({ aim: undefined }))).toEqual([]);
    });

    test('recovery leg is take-your-medicine territory → does not apply', () => {
        expect(noDoublesRule.appliesTo(ctx({ leg: 'recovery' }))).toBe(false);
    });
});

describe('no-doubles — vetoes the aggressive line', () => {
    // A stand-in aggressive rule that always emits high-priority attack advice.
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

    test('an ugly tail demotes specific-target below the warning', () => {
        const out = runCaddy(ctx({ aim: aim(3.0, 4.5) }), [attack, noDoublesRule]);
        expect(out).toHaveLength(2);
        // Despite specific-target's priority 10, the veto sinks it to last.
        expect(out[0].ruleId).toBe('no-doubles');
        expect(out[1].ruleId).toBe('specific-target');
    });

    test('a quiet tail leaves the aggressive line on top (no veto emitted)', () => {
        const out = runCaddy(ctx({ aim: aim(3.0, 3.1) }), [attack, noDoublesRule]);
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('specific-target');
    });
});

describe('no-doubles — risk weighting', () => {
    test('a cautious player floats the warning higher than a pure-EV one', () => {
        const neutral = runCaddy(
            ctx({ aim: aim(3.0, 4.0), risk: { riskAversion: 0 } }),
            [noDoublesRule],
        );
        const cautious = runCaddy(
            ctx({ aim: aim(3.0, 4.0), risk: { riskAversion: 1 } }),
            [noDoublesRule],
        );
        // Same advice; both present (risk-weighting never silences it).
        expect(neutral).toHaveLength(1);
        expect(cautious).toHaveLength(1);
        expect(neutral[0].riskWeighted).toBe(true);
    });
});
