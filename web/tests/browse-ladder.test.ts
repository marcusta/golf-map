import { describe, expect, test } from 'bun:test';
import {
    bearingBetween,
    browseForwardRoute,
    browseTargetActivation,
    buildBrowseLadder,
} from '../src/planner/browse-ladder';

describe('planner browse ladder', () => {
    test('sorts point targets from an arbitrary origin and keeps promotable positions', () => {
        const origin = { x: 10, y: 20, elevation: 5 };
        const rows = buildBrowseLadder({
            origin,
            bearingDeg: 0,
            points: [
                { id: 'green', label: 'Green', role: 'green_center', point: { x: 10, y: 120, elevation: 7 } },
                { id: 'aim', label: 'Aim', role: 'aim', point: { x: 10, y: 70, elevation: 6 } },
            ],
        });

        expect(rows.map(row => row.id)).toEqual(['aim:aim', 'green:green_center']);
        expect(rows[0]?.lineM).toBeCloseTo(50);
        expect(rows[0]?.position).toEqual({ x: 10, y: 70, elevation: 6 });
        expect(rows[0]?.playsAsM).toBeCloseTo(51);
    });

    test('hazard front and carry are concrete points usable as the next origin', () => {
        const origin = { x: 0, y: 0 };
        const rows = buildBrowseLadder({
            origin,
            bearingDeg: 0,
            points: [],
            hazards: [{
                id: 'bunker',
                label: 'Bunker',
                ring: { kind: 'bunker', points: [
                    { x: -5, y: 40 }, { x: 5, y: 40 }, { x: 5, y: 55 }, { x: -5, y: 55 },
                ] },
            }],
        });

        expect(rows.map(row => row.id)).toEqual([
            'bunker:hazard_front', 'bunker:hazard_carry',
        ]);
        expect(rows.map(row => row.position)).toEqual([{ x: 0, y: 40 }, { x: 0, y: 55 }]);
    });

    test('bearing uses compass degrees', () => {
        expect(bearingBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
        expect(bearingBetween({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(180);
    });

    test('ordinary map and ladder clicks inspect without changing the origin', () => {
        expect(browseTargetActivation('map')).toBe('inspect');
        expect(browseTargetActivation('ladder')).toBe('inspect');
    });
});

describe('browseForwardRoute', () => {
    // A right-angle dogleg: tee at origin, corner aim to the east, green to the
    // north of the corner. Sized so the tee sits well BEYOND the 230 m routing
    // gate (tee→green ≈ 424 m) — routed cases must not collapse straight.
    const tee = { x: 0, y: 0 };
    const corner = { x: 300, y: 0 };
    const green = { x: 300, y: 300 };

    test('origin at the tee (beyond the gate) keeps the corner — routed polyline through the elbow', () => {
        const route = browseForwardRoute(tee, tee, [corner], green);
        expect(route).toEqual([tee, corner, green]);
    });

    test('origin past the corner near the green collapses to [origin, green]', () => {
        const origin = { x: 300, y: 220 };
        const route = browseForwardRoute(origin, tee, [corner], green);
        expect(route).toEqual([origin, green]);
    });

    test('first-leg bearing differs from origin→green when a corner is ahead', () => {
        const route = browseForwardRoute(tee, tee, [corner], green);
        const firstLeg = bearingBetween(tee, route[1]!);
        const straight = bearingBetween(tee, green);
        // First leg heads due east to the corner (90°); the straight cut is NE (45°).
        expect(firstLeg).toBeCloseTo(90);
        expect(straight).toBeCloseTo(45);
        expect(Math.abs(firstLeg - straight)).toBeGreaterThan(1);
    });

    test('kept-aim count recovers source aims via the suffix slice', () => {
        const first = { x: 120, y: 0 };
        const aims = [first, corner];
        // Standing between the two aims, still >230 m out: the first aim is
        // passed, the corner is ahead.
        const origin = { x: 210, y: 0 };
        const route = browseForwardRoute(origin, tee, aims, green);
        const keptCount = route.length - 2;
        expect(keptCount).toBe(1);
        expect(aims.slice(aims.length - keptCount)).toEqual([corner]);
    });

    test('no tee supplied still routes through an aim that is genuinely ahead', () => {
        // Without a tee the chainage route starts at the first aim, so the
        // origin must sit behind it (negative chainage) to keep it. Placed south
        // of the corner, on the backward extension of the corner→green leg.
        const origin = { x: 300, y: -150 };
        const route = browseForwardRoute(origin, undefined, [corner], green);
        expect(route).toEqual([origin, corner, green]);
    });

    test('within the routing gate the line goes straight even when an aim is still ahead', () => {
        // The on-device report: origin 90 m from the green with an aim ~20 m
        // ahead along the routing (kept by the chainage filter) — at 90 m the
        // next shot targets the green, so the drawn line must not kink.
        const holeTee = { x: 0, y: 0 };
        const aim = { x: 112, y: 191 };
        const holeGreen = { x: 150, y: 250 };
        const origin = { x: 96, y: 178 }; // origin→green = 90 m ≤ 230 m gate
        const route = browseForwardRoute(origin, holeTee, [aim], holeGreen);
        expect(route).toEqual([origin, holeGreen]);
        expect(route.length - 2).toBe(0); // suffix convention: 0 aims kept when gated
    });

    test('thresholdM override is respected', () => {
        // Same report geometry, gate tightened below the 90 m origin→green
        // distance: the chainage filter applies again and the kept aim returns.
        const holeTee = { x: 0, y: 0 };
        const aim = { x: 112, y: 191 };
        const holeGreen = { x: 150, y: 250 };
        const origin = { x: 96, y: 178 };
        const route = browseForwardRoute(origin, holeTee, [aim], holeGreen, undefined, 80);
        expect(route).toEqual([origin, aim, holeGreen]);
    });
});
