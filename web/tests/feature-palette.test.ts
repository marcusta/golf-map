import { test, expect, describe } from 'bun:test';
import {
    FEATURE_TYPES,
    SURROUND_PAIRINGS,
    TYPE_Z_ORDER,
    typeSortKeyExpression,
} from '../src/draw/feature-palette';

describe('SURROUND_PAIRINGS (ported prototype table)', () => {
    test('exact pairing values', () => {
        expect(SURROUND_PAIRINGS.tee).toEqual({ targetType: 'semi_rough', expandAmount: 0.5 });
        expect(SURROUND_PAIRINGS.fairway).toEqual({ targetType: 'semi_rough', expandAmount: 1 });
        expect(SURROUND_PAIRINGS.green).toEqual({ targetType: 'fairway', expandAmount: 0.5 });
        expect(SURROUND_PAIRINGS.semi_rough).toEqual({ targetType: 'rough', expandAmount: 5 });
        expect(SURROUND_PAIRINGS.rough).toEqual({ targetType: 'deep_rough', expandAmount: 8 });
    });

    test('types without a golf-sensible surround map to null', () => {
        for (const type of ['bunker', 'water', 'water_creek', 'deep_rough', 'path', 'outside'] as const) {
            expect(SURROUND_PAIRINGS[type]).toBeNull();
        }
    });

    test('every feature type has an entry; targets are valid types', () => {
        for (const type of FEATURE_TYPES) {
            const pairing = SURROUND_PAIRINGS[type];
            expect(pairing !== undefined).toBe(true);
            if (pairing) {
                expect(FEATURE_TYPES).toContain(pairing.targetType);
                expect(pairing.expandAmount).toBeGreaterThan(0);
            }
        }
    });

    test('surround targets always render BELOW their source (z-order sanity)', () => {
        for (const type of FEATURE_TYPES) {
            const pairing = SURROUND_PAIRINGS[type];
            if (!pairing) continue;
            expect(TYPE_Z_ORDER.indexOf(pairing.targetType)).toBeLessThan(TYPE_Z_ORDER.indexOf(type));
        }
    });
});

describe('TYPE_Z_ORDER', () => {
    test('covers every feature type exactly once, in the specified order', () => {
        expect([...TYPE_Z_ORDER].sort()).toEqual([...FEATURE_TYPES].sort());
        expect(TYPE_Z_ORDER).toEqual([
            'outside', 'deep_rough', 'rough', 'semi_rough', 'fairway',
            'tee', 'green', 'bunker', 'water', 'water_creek', 'path',
        ]);
    });

    test('sort-key expression maps bunker above fairway', () => {
        const expr = typeSortKeyExpression();
        // ['match', ['get','type'], t0, 0, t1, 1, ..., fallback]
        const idx = (type: string) => expr[expr.indexOf(type) + 1] as number;
        expect(idx('bunker')).toBeGreaterThan(idx('fairway'));
        expect(idx('green')).toBeGreaterThan(idx('semi_rough'));
        expect(expr[expr.length - 1]).toBe(-1); // unknown types below everything
    });
});
