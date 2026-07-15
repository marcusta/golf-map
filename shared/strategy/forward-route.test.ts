import { describe, expect, test } from 'bun:test';
import {
    AIM_ROUTING_THRESHOLD_M,
    forwardAims,
    forwardRoutePoints,
    gatedForwardRoutePoints,
    projectedRouteChainage,
} from './forward-route';
import { type StrategyPoint } from './plays-like';

const p = (x: number, y: number): StrategyPoint => ({ x, y });

// The canonical 90° dogleg: tee north 250 m to the corner, then east 150 m
// to the green.
const TEE = p(0, 0);
const CORNER = p(0, 250);
const GREEN = p(150, 250);

describe('projectedRouteChainage — nearest point on the route, as meters along it', () => {
    test('route with fewer than 2 points has no legs → 0', () => {
        expect(projectedRouteChainage([], p(10, 10))).toBe(0);
        expect(projectedRouteChainage([p(5, 5)], p(10, 10))).toBe(0);
    });

    test('point on a leg projects to its exact chainage', () => {
        expect(projectedRouteChainage([TEE, CORNER, GREEN], p(0, 100))).toBeCloseTo(100, 12);
        expect(projectedRouteChainage([TEE, CORNER, GREEN], p(60, 250))).toBeCloseTo(310, 12);
    });

    test('point beyond the last vertex clamps to total route length', () => {
        expect(projectedRouteChainage([TEE, CORNER, GREEN], p(200, 250))).toBeCloseTo(400, 12);
    });

    test('point before the first vertex projects to NEGATIVE chainage (open route start)', () => {
        // The first leg clamps t to (-inf, 1]: 50 m behind the tee along the
        // first leg's line is chainage -50, not 0.
        expect(projectedRouteChainage([TEE, CORNER, GREEN], p(0, -50))).toBeCloseTo(-50, 12);
        // Off-axis behind the start still projects onto the backward extension.
        expect(projectedRouteChainage([TEE, CORNER, GREEN], p(30, -40))).toBeCloseTo(-40, 12);
    });

    test('zero-length legs (duplicate vertices) are skipped, chainage unchanged', () => {
        const route = [p(0, 0), p(0, 100), p(0, 100), p(0, 200)];
        expect(projectedRouteChainage(route, p(5, 150))).toBeCloseTo(150, 12);
    });

    test('exact tie between two legs resolves to the LATER leg', () => {
        // Elbow at (0,100): origin (10, 90) is exactly 10 m from both legs.
        const route = [p(0, 0), p(0, 100), p(100, 100)];
        // Earlier leg candidate: (0, 90) → chainage 90. Later leg candidate:
        // (10, 100) → chainage 110. Both 10 m away; later wins.
        expect(projectedRouteChainage(route, p(10, 90))).toBeCloseTo(110, 12);
    });
});

describe('forwardAims — the suffix of aims still ahead along the routing', () => {
    test('at the tee of a 90° dogleg every aim is kept', () => {
        const input = { origin: TEE, tee: TEE, aims: [CORNER], green: GREEN };
        expect(forwardAims(input)).toEqual([CORNER]);
        expect(forwardRoutePoints(input)).toEqual([TEE, CORNER, GREEN]);
    });

    test('the bug scenario: past the corner, ~94 m out, off the first leg → corner drops', () => {
        // Standing on the second leg, ~94 m from the green and 56 m from the
        // first leg: the origin projects onto the second leg (chainage 306),
        // well past the corner (chainage 250) → the line goes straight at
        // the green instead of snaking back through the dogleg.
        const origin = p(56, 248);
        const input = { origin, tee: TEE, aims: [CORNER], green: GREEN };
        expect(forwardAims(input)).toEqual([]);
        expect(forwardRoutePoints(input)).toEqual([origin, GREEN]);
    });

    test('midway along the first leg but offset into the rough → corner kept', () => {
        const origin = p(25, 120); // projects to (0, 120), chainage 120 < 245
        const input = { origin, tee: TEE, aims: [CORNER], green: GREEN };
        expect(forwardAims(input)).toEqual([CORNER]);
        expect(forwardRoutePoints(input)).toEqual([origin, CORNER, GREEN]);
    });

    test('origin exactly at an aim vertex: that aim drops (margin), later aims kept', () => {
        const aim1 = p(0, 250);
        const aim2 = p(150, 250);
        const green = p(150, 400);
        const input = { origin: aim1, tee: TEE, aims: [aim1, aim2], green };
        expect(forwardAims(input)).toEqual([aim2]);
        expect(forwardRoutePoints(input)).toEqual([aim1, aim2, green]);
    });

    test('double dogleg, origin past the first corner only → first drops, second kept', () => {
        const aim1 = p(0, 250);
        const aim2 = p(150, 250);
        const green = p(150, 400);
        const origin = p(60, 252); // projects onto leg 2 at chainage 310
        const input = { origin, tee: TEE, aims: [aim1, aim2], green };
        expect(forwardAims(input)).toEqual([aim2]);
        expect(forwardRoutePoints(input)).toEqual([origin, aim2, green]);
    });

    test('marginM: aim 3 m ahead of the projection drops at default 5, kept at 2', () => {
        const aim = p(0, 100);
        const green = p(0, 200);
        const origin = p(0, 97); // projection chainage 97; aim chainage 100
        expect(forwardAims({ origin, tee: TEE, aims: [aim], green })).toEqual([]);
        expect(forwardAims({ origin, tee: TEE, aims: [aim], green, marginM: 2 })).toEqual([aim]);
        // The comparison is strict: exactly marginM ahead is still "passed".
        expect(forwardAims({ origin, tee: TEE, aims: [aim], green, marginM: 3 })).toEqual([]);
    });

    test('no tee, origin behind the first aim: ALL aims kept (negative chainage)', () => {
        // Without a tee the route starts at the first aim, but the route
        // start is open-ended: an origin behind it projects to NEGATIVE
        // chainage (-50 here), so aim1 (chainage 0) is still 50 m ahead and
        // every aim is kept — the ladder shows the full remaining route.
        const aim1 = p(0, 100);
        const aim2 = p(0, 150);
        const green = p(0, 200);
        const origin = p(0, 50); // 50 m behind the route start → s = -50
        expect(forwardAims({ origin, aims: [aim1, aim2], green })).toEqual([aim1, aim2]);
        expect(forwardRoutePoints({ origin, aims: [aim1, aim2], green })).toEqual([origin, aim1, aim2, green]);
    });

    test('origin behind the tee on a teed route: negative chainage, all aims kept', () => {
        // Standing 30 m behind the tee box: projection is chainage -30 on the
        // open first leg, every aim (corner at 250) stays ahead.
        const origin = p(0, -30);
        const input = { origin, tee: TEE, aims: [CORNER], green: GREEN };
        expect(projectedRouteChainage([TEE, CORNER, GREEN], origin)).toBeCloseTo(-30, 12);
        expect(forwardAims(input)).toEqual([CORNER]);
        expect(forwardRoutePoints(input)).toEqual([origin, CORNER, GREEN]);
    });

    test('zero-length legs (duplicate aim vertices) do not break the filter', () => {
        const aim = p(0, 100);
        const green = p(0, 200);
        const origin = p(0, 50);
        const out = forwardAims({ origin, tee: TEE, aims: [aim, aim], green });
        expect(out).toEqual([aim, aim]); // both at chainage 100 > 50 + 5
    });

    test('empty aims → [] and forwardRoutePoints = [origin, green]', () => {
        const origin = p(3, 4);
        const green = p(0, 200);
        expect(forwardAims({ origin, tee: TEE, aims: [], green })).toEqual([]);
        expect(forwardRoutePoints({ origin, tee: TEE, aims: [], green })).toEqual([origin, green]);
    });

    test('gate: within the routing threshold the line goes straight even past a kept aim', () => {
        // The on-course report scenario: origin ~90 m from the green with an
        // aim ~20 m ahead (nearly collinear, between origin and green). The
        // chainage filter KEEPS the aim — it is genuinely ahead — but at 90 m
        // the next shot targets the green, so the drawn line gate ignores it.
        const green = p(150, 250);
        const aim = p(112, 191); // ~21 m ahead of origin's projection, ~70 m from green
        const origin = p(96, 178); // exactly 90 m from green
        const input = { origin, tee: TEE, aims: [aim], green };
        expect(forwardAims(input)).toEqual([aim]); // kept by chainage…
        expect(gatedForwardRoutePoints(input)).toEqual([origin, green]); // …gated straight
    });

    test('gate: beyond the threshold the routed line is unchanged', () => {
        const input = { origin: TEE, tee: TEE, aims: [CORNER], green: GREEN }; // tee→green 291.5 m > 230
        expect(gatedForwardRoutePoints(input)).toEqual([TEE, CORNER, GREEN]);
    });

    test('gate: custom thresholdM overrides the default', () => {
        const input = { origin: TEE, tee: TEE, aims: [CORNER], green: GREEN };
        expect(gatedForwardRoutePoints({ ...input, thresholdM: 300 })).toEqual([TEE, GREEN]);
        // Sanity: the default constant is the iOS GPS-mode default.
        expect(AIM_ROUTING_THRESHOLD_M).toBe(230);
    });

    test('elbow-interior tie biases to the later leg → corner drops', () => {
        // (10, 90) is exactly 10 m from both legs of the tee→(0,100)→(100,100)
        // elbow. Tie-to-later puts the projection at chainage 110; the corner
        // (chainage 100) drops. Had the tie gone to the EARLIER leg (chainage
        // 90) the corner would have been kept (100 > 90 + 5) — this case pins
        // the deliberate straight-at-the-green bias.
        const corner = p(0, 100);
        const green = p(100, 100);
        const origin = p(10, 90);
        const input = { origin, tee: TEE, aims: [corner], green };
        expect(forwardAims(input)).toEqual([]);
        expect(forwardRoutePoints(input)).toEqual([origin, green]);
    });
});
