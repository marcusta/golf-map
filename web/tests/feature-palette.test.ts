import { test, expect, describe } from 'bun:test';
import {
    FEATURE_TYPES,
    DIGIT_FEATURE_TYPES,
    digitForFeatureType,
    DRAW_FILL_OPACITY,
    NICE_FILL_OPACITY,
    SURROUND_PAIRINGS,
    TYPE_Z_ORDER,
    typeSortKeyExpression,
} from '../src/draw/feature-palette';

test('draw-mode fills carry enough color to distinguish surface types while tracing', () => {
    expect(DRAW_FILL_OPACITY).toBeGreaterThan(0.8);
    expect(DRAW_FILL_OPACITY).toBeLessThan(0.9);
});

test('nice-mode fill opacity keeps the orthophoto visible', () => {
    expect(NICE_FILL_OPACITY).toBe(0.4);
});


describe('SURROUND_PAIRINGS (ported prototype table)', () => {
    test('exact pairing values', () => {
        expect(SURROUND_PAIRINGS.tee).toEqual({ targetType: 'semi_rough', expandAmount: 0.5 });
        expect(SURROUND_PAIRINGS.fairway).toEqual({ targetType: 'semi_rough', expandAmount: 1 });
        expect(SURROUND_PAIRINGS.green).toEqual({ targetType: 'fairway', expandAmount: 0.5 });
        expect(SURROUND_PAIRINGS.semi_rough).toEqual({ targetType: 'rough', expandAmount: 5 });
        expect(SURROUND_PAIRINGS.rough).toEqual({ targetType: 'deep_rough', expandAmount: 8 });
    });

    test('types without a golf-sensible surround map to null', () => {
        for (const type of [
            'bunker',
            'water',
            'water_creek',
            'deep_rough',
            'trees',
            'penalty_red',
            'penalty_yellow',
            'oob',
            'path',
            'outside',
        ] as const) {
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

describe('DIGIT_FEATURE_TYPES (keyboard type switching)', () => {
    test('exact digit → type mapping, panel order (T39)', () => {
        expect(DIGIT_FEATURE_TYPES).toEqual({
            '1': 'tee',
            '2': 'fairway',
            '3': 'green',
            '4': 'bunker',
            '5': 'semi_rough',
            '6': 'rough',
            '7': 'deep_rough',
            '8': 'trees',
            '9': 'water',
            '0': 'water_creek',
        });
    });

    test('digits 1–9 then 0 follow FEATURE_TYPES panel order', () => {
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
        keys.forEach((k, i) => expect(DIGIT_FEATURE_TYPES[k]).toBe(FEATURE_TYPES[i]));
    });

    test('the five rules/misc types stay panel-only (no digit)', () => {
        for (const type of ['penalty_yellow', 'penalty_red', 'oob', 'path', 'outside'] as const) {
            expect(digitForFeatureType(type)).toBeUndefined();
            expect(Object.values(DIGIT_FEATURE_TYPES)).not.toContain(type);
        }
    });

    test('digitForFeatureType is the inverse of the mapping', () => {
        for (const [digit, type] of Object.entries(DIGIT_FEATURE_TYPES)) {
            expect(digitForFeatureType(type)).toBe(digit);
        }
    });

    test('every mapped type is a real feature type; ten distinct types', () => {
        const mapped = Object.values(DIGIT_FEATURE_TYPES);
        expect(mapped.length).toBe(10);
        expect(new Set(mapped).size).toBe(10);
        for (const type of mapped) expect(FEATURE_TYPES).toContain(type);
    });
});

describe('TYPE_Z_ORDER', () => {
    test('covers every feature type exactly once, in the specified order', () => {
        expect([...TYPE_Z_ORDER].sort()).toEqual([...FEATURE_TYPES].sort());
        expect(TYPE_Z_ORDER).toEqual([
            'outside', 'deep_rough', 'rough', 'semi_rough', 'fairway',
            'tee', 'green', 'trees', 'bunker', 'water', 'water_creek',
            'penalty_yellow', 'penalty_red', 'oob', 'path',
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
