import { describe, expect, test } from 'bun:test';
import { runCaddy } from './run';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from './rule';
import { exampleLongParRule } from './rules/example-long-par';

// Minimal context factory — the caddy evaluator itself reads only `hole` and
// `risk`; the rest is present to satisfy the type. Rules under test carry
// their own advice, so most fields stay empty.
function ctx(overrides: Partial<CaddyContext> = {}): CaddyContext {
    return {
        leg: 'approach',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: { kind: 'green', points: [] },
            center: { x: 0, y: 100 },
            front: { x: 0, y: 95 },
            back: { x: 0, y: 105 },
        },
        distances: [],
        hazards: [],
        clubs: [],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...overrides,
    };
}

/** A rule that emits exactly the advice items it is handed. */
function ruleEmitting(id: string, ...advice: CaddyAdvice[]): CaddyRule {
    return {
        id,
        appliesTo: () => true,
        evaluate: () => advice,
    };
}

function advice(over: Partial<CaddyAdvice> & { ruleId: string }): CaddyAdvice {
    return {
        kind: 'warning',
        priority: 1,
        confidence: 1,
        headline: over.headline ?? `advice-${over.ruleId}`,
        ...over,
    };
}

describe('runCaddy — ranking', () => {
    test('orders by priority × confidence, descending', () => {
        const low = advice({ ruleId: 'low', priority: 2, confidence: 0.4, headline: 'low' }); // 0.8
        const mid = advice({ ruleId: 'mid', priority: 3, confidence: 0.5, headline: 'mid' }); // 1.5
        const high = advice({ ruleId: 'high', priority: 4, confidence: 1, headline: 'high' }); // 4.0
        const out = runCaddy(
            ctx(),
            [ruleEmitting('low', low), ruleEmitting('high', high), ruleEmitting('mid', mid)],
        );
        expect(out.map((a) => a.ruleId)).toEqual(['high', 'mid', 'low']);
    });

    test('a higher priority can be outranked by higher confidence', () => {
        const a = advice({ ruleId: 'a', priority: 5, confidence: 0.3, headline: 'a' }); // 1.5
        const b = advice({ ruleId: 'b', priority: 2, confidence: 1, headline: 'b' }); // 2.0
        const out = runCaddy(ctx(), [ruleEmitting('a', a), ruleEmitting('b', b)]);
        expect(out.map((a) => a.ruleId)).toEqual(['b', 'a']);
    });
});

describe('runCaddy — vetoes', () => {
    test('a veto demotes the targeted advice below all non-vetoed advice', () => {
        // aggressive has the HIGHEST raw rank (4.0) but is vetoed by safety.
        const aggressive = advice({ ruleId: 'attack', priority: 4, confidence: 1, headline: 'attack' });
        const safety = advice({
            ruleId: 'safety',
            priority: 1,
            confidence: 1, // rank 1.0 < 4.0
            headline: 'lay up',
            vetoes: ['attack'],
        });
        const neutral = advice({ ruleId: 'neutral', priority: 2, confidence: 1, headline: 'neutral' }); // 2.0
        const out = runCaddy(
            ctx(),
            [ruleEmitting('attack', aggressive), ruleEmitting('safety', safety), ruleEmitting('neutral', neutral)],
        );
        // attack is demoted to last despite its high rank; safety + neutral rank normally above it.
        expect(out.map((a) => a.ruleId)).toEqual(['neutral', 'safety', 'attack']);
        expect(out.map((a) => a.ruleId).at(-1)).toBe('attack');
    });

    test('a veto against an absent rule is a harmless no-op', () => {
        const safety = advice({ ruleId: 'safety', headline: 'safe', vetoes: ['ghost-rule'] });
        const out = runCaddy(ctx(), [ruleEmitting('safety', safety)]);
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('safety');
    });
});

describe('runCaddy — empty / gating', () => {
    test('no rules → no advice', () => {
        expect(runCaddy(ctx(), [])).toEqual([]);
    });

    test('rules that all gate out → no advice', () => {
        const never: CaddyRule = { id: 'never', appliesTo: () => false, evaluate: () => [advice({ ruleId: 'never' })] };
        expect(runCaddy(ctx(), [never])).toEqual([]);
    });

    test('empty context (par-3, no data) still runs the example rule cleanly to no advice', () => {
        // example-long-par gates on par ≥ 5; a par-3 context yields nothing.
        expect(runCaddy(ctx({ hole: { par: 3, index: 1 } }), [exampleLongParRule])).toEqual([]);
    });
});

describe('runCaddy — deterministic dedupe / equal ranks', () => {
    test('two equal priority×confidence advices rank deterministically (by ruleId)', () => {
        // Same rank (2.0) but distinct ruleIds → stable order by ruleId asc.
        const zulu = advice({ ruleId: 'zulu', priority: 2, confidence: 1, headline: 'z' });
        const alpha = advice({ ruleId: 'alpha', priority: 2, confidence: 1, headline: 'a' });
        const forward = runCaddy(ctx(), [ruleEmitting('zulu', zulu), ruleEmitting('alpha', alpha)]);
        const reversed = runCaddy(ctx(), [ruleEmitting('alpha', alpha), ruleEmitting('zulu', zulu)]);
        expect(forward.map((a) => a.ruleId)).toEqual(['alpha', 'zulu']);
        // Order is independent of rule input order — fully deterministic.
        expect(reversed.map((a) => a.ruleId)).toEqual(['alpha', 'zulu']);
    });

    test('identical recommendations (same ruleId+kind+headline) dedupe to one', () => {
        const dup = advice({ ruleId: 'dup', kind: 'club', priority: 2, confidence: 1, headline: 'same' });
        // One rule emitting the same advice twice.
        const out = runCaddy(ctx(), [ruleEmitting('dup', dup, { ...dup })]);
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('dup');
    });

    test('same ruleId+kind but different headline are kept as distinct advice', () => {
        const a = advice({ ruleId: 'r', kind: 'club', headline: 'club up' });
        const b = advice({ ruleId: 'r', kind: 'club', headline: 'club down' });
        const out = runCaddy(ctx(), [ruleEmitting('r', a, b)]);
        expect(out).toHaveLength(2);
    });
});

describe('runCaddy — risk weighting (D12/D16)', () => {
    test('riskWeighted advice floats up as riskAversion rises', () => {
        const safety = advice({ ruleId: 'safety', priority: 2, confidence: 1, headline: 'safe', riskWeighted: true });
        const bold = advice({ ruleId: 'bold', priority: 1.4, confidence: 1, headline: 'bold' });
        const rules = [ruleEmitting('safety', safety), ruleEmitting('bold', bold)];

        // riskAversion 0: safety effective priority = 2 × 0.5 = 1.0 < bold 1.4 → bold first.
        const calm = runCaddy(ctx({ risk: { riskAversion: 0 } }), rules);
        expect(calm.map((a) => a.ruleId)).toEqual(['bold', 'safety']);

        // riskAversion 1: safety effective priority = 2 × 1.0 = 2.0 > bold 1.4 → safety first.
        const scared = runCaddy(ctx({ risk: { riskAversion: 1 } }), rules);
        expect(scared.map((a) => a.ruleId)).toEqual(['safety', 'bold']);
    });
});

describe('exampleLongParRule', () => {
    test('fires on a par 5 and stays silent on a par 4', () => {
        expect(runCaddy(ctx({ hole: { par: 5, index: 2 } }), [exampleLongParRule])).toHaveLength(1);
        expect(runCaddy(ctx({ hole: { par: 4, index: 2 } }), [exampleLongParRule])).toEqual([]);
    });
});
