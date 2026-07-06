import { describe, expect, test } from 'bun:test';
import { runCaddy } from '../run';
import { type CaddyContext, type FlatRing, type GreenSlopeSummary } from '../rule';
import {
    FALL_LINE_ALIGN_TOLERANCE_DEG,
    FRONT_CLEAN_WINDOW_M,
    MIN_FALL_LINE_PCT,
    greenSlopeHalfRule,
} from './green-slope-half';

// Geometry for every test: the player stands at the origin and plays NORTH to
// a green centred at (0, 100) with its front edge at (0, 95). A green that
// falls BACK-TO-FRONT tilts downhill toward the player — that is due SOUTH,
// compass bearing 180°. So a summary with fallLineBearingDeg ≈ 180 is aligned
// with this shot; 90° (cross-slope) or 0° (front-to-back) is not.

function summary(over: Partial<GreenSlopeSummary> = {}): GreenSlopeSummary {
    return {
        fallLineBearingDeg: 180, // back-to-front for a north-playing shot
        fallLinePct: 4,
        frontHalfPct: 4,
        backHalfPct: 4,
        ...over,
    };
}

function ctx(over: Partial<CaddyContext> = {}): CaddyContext {
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
        greenSlope: summary(),
        hazards: [],
        clubs: [],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

/** An axis-aligned rectangle FlatRing (bunker/water) for hazard placement. */
function box(minX: number, minY: number, maxX: number, maxY: number, kind = 'bunker'): FlatRing {
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

const run = (c: CaddyContext) => runCaddy(c, [greenSlopeHalfRule]);

describe('green-slope-half — fires', () => {
    test('aligned back-to-front + steep + front-clean ⇒ short-half advice', () => {
        const out = run(ctx());
        expect(out).toHaveLength(1);
        expect(out[0].ruleId).toBe('green-slope-half');
        expect(out[0].kind).toBe('target-half');
        expect(out[0].headline).toContain('short half');
        // Anchored at the green front where the advice draws.
        expect(out[0].anchor).toEqual({ x: 0, y: 95 });
    });

    test('a diagonal fall line inside the alignment cone still fires', () => {
        // 180° is dead-on; 180 − 40 = 140° is 40° off, inside the 45° cone.
        expect(FALL_LINE_ALIGN_TOLERANCE_DEG).toBeGreaterThan(40);
        const out = run(ctx({ greenSlope: summary({ fallLineBearingDeg: 140 }) }));
        expect(out).toHaveLength(1);
    });

    test('steeper + better-aligned green is higher confidence', () => {
        const shallowish = run(ctx({ greenSlope: summary({ fallLinePct: MIN_FALL_LINE_PCT + 0.2 }) }));
        const steep = run(ctx({ greenSlope: summary({ fallLinePct: 6 }) }));
        expect(steep[0].confidence).toBeGreaterThan(shallowish[0].confidence);
    });
});

describe('green-slope-half — suppressed', () => {
    test('a hazard within the front window suppresses the advice (D9)', () => {
        // Front edge is 95 m out; a bunker straddling y∈[70,80] sits well
        // inside the last 30 m before the front (windowStart = 65 m).
        expect(FRONT_CLEAN_WINDOW_M).toBe(30);
        const bunker = box(-5, 70, 5, 80);
        expect(run(ctx({ hazards: [bunker] }))).toEqual([]);
    });

    test('a hazard BEYOND the front window does not suppress', () => {
        // A bunker short of the window (y∈[40,50], well before windowStart 65)
        // is not in the final 30 m, so the advice still fires.
        const bunker = box(-5, 40, 5, 50);
        expect(run(ctx({ hazards: [bunker] }))).toHaveLength(1);
    });

    test('shallow slope (< 3%) ⇒ no advice', () => {
        expect(run(ctx({ greenSlope: summary({ fallLinePct: MIN_FALL_LINE_PCT - 0.5 }) }))).toEqual([]);
    });

    test('wrong fall-line direction (cross-slope) ⇒ no advice', () => {
        // 90° off the reverse bearing — a cross-slope, not back-to-front.
        expect(run(ctx({ greenSlope: summary({ fallLineBearingDeg: 90 }) }))).toEqual([]);
    });

    test('front-to-back green (fall line away from player) ⇒ no advice', () => {
        // 0° = the green falls AWAY (front-to-back); short-half advice is wrong.
        expect(run(ctx({ greenSlope: summary({ fallLineBearingDeg: 0 }) }))).toEqual([]);
    });
});

describe('green-slope-half — gating', () => {
    test('non-approach leg does not apply', () => {
        expect(greenSlopeHalfRule.appliesTo(ctx({ leg: 'tee' }))).toBe(false);
        expect(greenSlopeHalfRule.appliesTo(ctx({ leg: 'recovery' }))).toBe(false);
    });

    test('missing greenSlope does not apply', () => {
        expect(greenSlopeHalfRule.appliesTo(ctx({ greenSlope: undefined }))).toBe(false);
        expect(run(ctx({ greenSlope: undefined }))).toEqual([]);
    });
});
