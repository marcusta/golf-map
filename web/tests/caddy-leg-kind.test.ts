import { describe, expect, test } from 'bun:test';
import { caddyLegKind } from '../src/planner/planner-tool.service';

// The LOCKED caddy leg-contract (feature-smart-caddy.md / T10). If this
// mapping drifts, rules silently never fire — par5-attack gates on 'layup',
// the approach rules on 'approach', take-your-medicine on 'recovery'.

describe('caddyLegKind — locked leg contract', () => {
    test('the tee shot is "tee"', () => {
        expect(caddyLegKind({ index: 0, toKind: 'shot', par: 4, originLie: 'tee' })).toBe('tee');
    });

    test('a leg landing on the green is "approach" (par 4)', () => {
        expect(caddyLegKind({ index: 1, toKind: 'green', par: 4, originLie: 'fairway' })).toBe('approach');
    });

    test('a par-3 tee shot into the green is "approach" (green wins over tee)', () => {
        expect(caddyLegKind({ index: 0, toKind: 'green', par: 3, originLie: 'tee' })).toBe('approach');
    });

    test('the par-5 SECOND shot (index 1, not into the green) is "layup"', () => {
        expect(caddyLegKind({ index: 1, toKind: 'shot', par: 5, originLie: 'fairway' })).toBe('layup');
    });

    test('a par-5 approach (into the green) is still "approach", not "layup"', () => {
        expect(caddyLegKind({ index: 2, toKind: 'green', par: 5, originLie: 'fairway' })).toBe('approach');
    });

    test('a par-4 index-1 shot that does NOT reach the green maps to "tee" (full shot)', () => {
        expect(caddyLegKind({ index: 1, toKind: 'shot', par: 4, originLie: 'fairway' })).toBe('tee');
    });

    test('a recovery origin lie is "recovery" and wins over position', () => {
        // Even the tee shot, if somehow from a recovery lie, punches out.
        expect(caddyLegKind({ index: 0, toKind: 'shot', par: 5, originLie: 'recovery' })).toBe('recovery');
        // A par-5 second shot from jail is medicine, not a layup decision.
        expect(caddyLegKind({ index: 1, toKind: 'shot', par: 5, originLie: 'recovery' })).toBe('recovery');
        // Even an approach from a recovery lie: get back in play first.
        expect(caddyLegKind({ index: 2, toKind: 'green', par: 5, originLie: 'recovery' })).toBe('recovery');
    });
});
