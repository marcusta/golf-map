import { describe, expect, test } from 'bun:test';
import { type ClubSpec } from '../../club';
import { type FlatRing } from '../../corridor';
import { runCaddy } from '../run';
import { type CaddyContext } from '../rule';
import { par5AttackRule } from './par5-attack';

function club(name: string, carryM: number, dispersionM = 18): ClubSpec {
    return { name, carryM, dispersionM };
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
    const center = { x: 0, y: 235 };
    return {
        leg: 'layup',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: box('green', -15, center.y - 10, 15, center.y + 10),
            center,
            front: { x: 0, y: center.y - 10 },
            back: { x: 0, y: center.y + 10 },
        },
        distances: [],
        hazards: [],
        clubs: [],
        hole: { par: 5, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

const run = (c: CaddyContext) => runCaddy(c, [par5AttackRule]);

describe('par5-attack — strategy ranking', () => {
    test('an awkward ~42 m leftover loses to a full ~100 m wedge lay-up', () => {
        const out = run(ctx({
            clubs: [
                club('full wedge lay-up club', 135, 16), // leaves 100 m
                club('pinch club', 193, 60), // leaves 42 m
            ],
            hazards: [
                // Centre-line pinch starts at 203 m, so the lay-back strategy
                // targets 193 m and leaves about 42 m.
                box('water', -4, 203, 4, 212),
                // The pinch narrows hard around the 193 m landing zone, so
                // the two-shot chain prices its lateral tail into penalty.
                box('water', 7, 170, 80, 220),
                box('water', -80, 170, -7, 220),
            ],
        }));

        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('layup');
        expect(out[0].headline).toContain('100 m');
        expect(out[0].headline).toContain('42 m');
    });

    test('topmost greenside hazards price above the green under D23 stack order', () => {
        const out = run(ctx({
            target: {
                greenPoly: box('green', -100, 150, 100, 230),
                center: { x: 0, y: 190 },
                front: { x: 0, y: 150 },
                back: { x: 0, y: 230 },
            },
            hazards: [
                // Fixture isolates the D23 overlap rule: this hazard is above
                // the green in the caller-provided stack and covers the attack
                // landing area, but the selected club can still carry it.
                box('water', -100, 150, 100, 230),
            ],
            clubs: [
                club('3 wood', 220, 24), // maxCarryM = 231 m, clears the far edge
                club('full wedge lay-up club', 90, 12), // leaves 100 m
            ],
        }));

        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('layup');
        expect(out[0].headline).toContain('100 m');
        expect(out[0].headline).not.toContain('Attack the green in two');
    });
});

describe('par5-attack — go-in-2 candidate gate', () => {
    test('go-in-2 appears when max carry reaches the green and the carry clears', () => {
        const out = run(ctx({
            target: {
                greenPoly: box('green', -18, 180, 18, 200),
                center: { x: 0, y: 190 },
                front: { x: 0, y: 180 },
                back: { x: 0, y: 200 },
            },
            clubs: [
                club('3 wood', 185, 24), // maxCarryM = 194.25 m, enough for 190 m
                club('lay-up wedge', 90, 12),
            ],
        }));

        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('aim');
        expect(out[0].headline).toContain('Attack the green in two');
    });

    test('go-in-2 is dropped when max carry does not reach the green', () => {
        const out = run(ctx({
            target: {
                greenPoly: box('green', -18, 180, 18, 200),
                center: { x: 0, y: 190 },
                front: { x: 0, y: 180 },
                back: { x: 0, y: 200 },
            },
            clubs: [
                club('short wood', 170, 24), // maxCarryM = 178.5 m, short of 190 m
                club('lay-up wedge', 90, 12),
            ],
        }));

        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('layup');
        expect(out[0].headline).not.toContain('Attack the green in two');
    });

    test('go-in-2 is dropped when the front carry does not clear', () => {
        const out = run(ctx({
            target: {
                greenPoly: box('green', -18, 180, 18, 200),
                center: { x: 0, y: 190 },
                front: { x: 0, y: 180 },
                back: { x: 0, y: 200 },
            },
            clubs: [
                club('3 wood', 185, 24), // reaches 190 but not the far edge of this water
                club('lay-up wedge', 90, 12),
            ],
            hazards: [box('water', -8, 188, 8, 198)],
        }));

        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('layup');
        expect(out[0].headline).not.toContain('Attack the green in two');
    });
});

describe('par5-attack — gating', () => {
    test('non-par-5 holes do not apply', () => {
        expect(par5AttackRule.appliesTo(ctx({ hole: { par: 4, index: 1 } }))).toBe(false);
    });
});
