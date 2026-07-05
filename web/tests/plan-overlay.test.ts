import { test, expect, describe } from 'bun:test';
import {
    buildHolePlan,
    buildPlanGeojson,
    gateEndpoints,
    gateLabel,
    legLabel,
    nearestLegFoot,
    perpendicularFoot,
    planarBearingDeg,
    type HolePlanInput,
} from '../src/planner/plan-overlay';
import {
    adjustedCarryM,
    dispersionEllipse,
    segmentStats,
    windEffect,
} from '../../shared/strategy';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import type { Club } from '../../shared/api/clubs.gen';
import type { PlanShot, PlanGate } from '../../shared/api/game-plans.gen';
import type { Feature, LineString, Point, Polygon } from 'geojson';

// Landeryd-ish base, EPSG:3006 meters.
const BASE = wgs84ToSweref99tm(58.4015, 15.5658);

/** WGS84 point `northM` meters north / `eastM` east of BASE. */
function at(northM: number, eastM = 0): { lat: number; lon: number } {
    return sweref99tmToWgs84(BASE.x + eastM, BASE.y + northM);
}

function club(id: string, name: string, carryM: number, dispersionM: number, sortOrder = 0): Club {
    return { id, userId: null, name, carryM, dispersionM, sortOrder, version: 1 };
}

const DRIVER = club('c-d', 'Driver', 200, 40, 0);
const IRON7 = club('c-7', '7 Iron', 150, 20, 1);

function shot(id: string, pos: { lat: number; lon: number }, opts: {
    sortOrder?: number;
    clubId?: string | null;
    elevation?: number | null;
} = {}): PlanShot {
    return {
        id,
        gamePlanHoleId: 'h1',
        sortOrder: opts.sortOrder ?? 0,
        lat: pos.lat,
        lon: pos.lon,
        elevation: opts.elevation ?? null,
        clubId: opts.clubId ?? null,
        label: null,
        version: 1,
    };
}

function gate(id: string, pos: { lat: number; lon: number }, directionDeg: number,
    left = 30, right = 30): PlanGate {
    return {
        id,
        gamePlanHoleId: 'h1',
        lat: pos.lat,
        lon: pos.lon,
        directionDeg,
        halfWidthLeftM: left,
        halfWidthRightM: right,
        source: 'manual',
        sortOrder: 0,
        version: 1,
    };
}

/** tee at BASE (elev 10) → shot 200 m north (elev 5) → green 350 m north (elev 0). */
function northInput(overrides: Partial<HolePlanInput> = {}): HolePlanInput {
    return {
        tee: { ...at(0), elevation: 10 },
        shots: [shot('s1', at(200), { clubId: DRIVER.id, elevation: 5 })],
        green: { ...at(350), elevation: 0 },
        clubs: [DRIVER, IRON7],
        preferredClubId: null,
        wind: null,
        ...overrides,
    };
}

// ── Planning model ─────────────────────────────────────────────────────────

describe('buildHolePlan', () => {
    test('nodes tee→shots→green; legs with planar bearings and distances', () => {
        const plan = buildHolePlan(northInput());
        expect(plan.nodes.map(n => n.kind)).toEqual(['tee', 'shot', 'green']);
        expect(plan.legs).toHaveLength(2);
        expect(plan.legs[0].horizontalM).toBeCloseTo(200, 3);
        expect(plan.legs[1].horizontalM).toBeCloseTo(150, 3);
        expect(plan.legs[0].bearingDeg).toBeCloseTo(0, 4);
        expect(plan.legs[1].bearingDeg).toBeCloseTo(0, 4);
        expect(plan.totalHorizontalM).toBeCloseTo(350, 3);
    });

    test('plays-like per leg matches shared/strategy segmentStats on the node elevations', () => {
        const plan = buildHolePlan(northInput());
        const [teeNode, shotNode, greenNode] = plan.nodes;
        const expected0 = segmentStats(teeNode, shotNode);
        const expected1 = segmentStats(shotNode, greenNode);
        expect(plan.legs[0].playsLikeM).toBe(expected0.playsLikeSimpleM);
        expect(plan.legs[1].playsLikeM).toBe(expected1.playsLikeSimpleM);
        expect(plan.legs[0].playsLikeM).toBeCloseTo(195, 3); // 200 + (5 − 10)
        expect(plan.totalPlaysLikeM).toBeCloseTo(340, 3); // 350 − 10 elevation drop
    });

    test('missing elevation degrades plays-like to undefined, horizontal stays', () => {
        const plan = buildHolePlan(northInput({
            shots: [shot('s1', at(200), { clubId: DRIVER.id, elevation: null })],
        }));
        expect(plan.legs[0].playsLikeM).toBeUndefined();
        expect(plan.legs[0].horizontalM).toBeCloseTo(200, 3);
        expect(plan.totalPlaysLikeM).toBeUndefined();
    });

    test('leg club = landing shot club; ellipse anchors at the ORIGIN node (shared math)', () => {
        const wind = { speedMps: 5, directionDeg: 0 }; // dead headwind on a north shot
        const plan = buildHolePlan(northInput({ wind }));
        const leg = plan.legs[0];
        expect(leg.club?.id).toBe(DRIVER.id);

        const expected = dispersionEllipse({
            origin: { x: plan.nodes[0].x, y: plan.nodes[0].y },
            bearingDeg: leg.bearingDeg,
            club: DRIVER,
            windSpeedMps: wind.speedMps,
            windDirectionDeg: wind.directionDeg,
        });
        expect(leg.ellipse?.center.x).toBeCloseTo(expected.center.x, 9);
        expect(leg.ellipse?.center.y).toBeCloseTo(expected.center.y, 9);
        expect(leg.ellipse?.semiLengthM).toBe(expected.semiLengthM);
        expect(leg.ellipse?.semiLateralM).toBe(expected.semiLateralM);
        expect(leg.ellipse?.polygon).toEqual(expected.polygon);

        // Wind-adjusted carry matches the shared wind curve exactly.
        const effect = windEffect(wind.speedMps, wind.directionDeg, leg.bearingDeg);
        expect(effect).toBeLessThan(0); // headwind
        expect(leg.windEffect).toBe(effect);
        expect(leg.adjustedCarryM).toBe(adjustedCarryM(DRIVER.carryM, effect));
    });

    test('tee leg falls back to preferredClubId; later clubless legs get no ellipse', () => {
        const plan = buildHolePlan(northInput({
            shots: [shot('s1', at(200), { clubId: null, elevation: 5 })],
            preferredClubId: IRON7.id,
        }));
        expect(plan.legs[0].club?.id).toBe(IRON7.id); // tee-leg fallback
        expect(plan.legs[0].ellipse).toBeDefined();
        expect(plan.legs[1].club).toBeNull(); // shot → green: no landing shot, no fallback
        expect(plan.legs[1].ellipse).toBeUndefined();
        expect(plan.legs[1].adjustedCarryM).toBeUndefined();
    });

    test('par-3 (zero shots): single tee→green leg uses the preferred club', () => {
        const plan = buildHolePlan(northInput({
            shots: [],
            green: { ...at(150), elevation: 10 },
            preferredClubId: IRON7.id,
        }));
        expect(plan.legs).toHaveLength(1);
        expect(plan.legs[0].club?.id).toBe(IRON7.id);
        expect(plan.legs[0].remainingToGreenM).toBeCloseTo(0, 6);
    });

    test('remaining-to-green after each node is the straight-line to the green center', () => {
        const plan = buildHolePlan(northInput({
            shots: [shot('s1', at(200, 50), { clubId: DRIVER.id })],
        }));
        // From the shot (200 N, 50 E) to the green (350 N, 0 E): hypot(150, 50).
        expect(plan.legs[0].remainingToGreenM).toBeCloseTo(Math.hypot(150, 50), 3);
        expect(plan.legs[1].remainingToGreenM).toBeCloseTo(0, 6);
    });

    test('no tee and no green: legs run between the shots that exist', () => {
        const plan = buildHolePlan(northInput({
            tee: null,
            green: null,
            shots: [
                shot('s1', at(0), { sortOrder: 0 }),
                shot('s2', at(100), { sortOrder: 1 }),
            ],
        }));
        expect(plan.nodes.map(n => n.kind)).toEqual(['shot', 'shot']);
        expect(plan.legs).toHaveLength(1);
        expect(plan.legs[0].remainingToGreenM).toBeUndefined();
    });
});

describe('planarBearingDeg', () => {
    test('compass quadrants', () => {
        const o = { x: 0, y: 0 };
        expect(planarBearingDeg(o, { x: 0, y: 10 })).toBeCloseTo(0, 9);
        expect(planarBearingDeg(o, { x: 10, y: 0 })).toBeCloseTo(90, 9);
        expect(planarBearingDeg(o, { x: 0, y: -10 })).toBeCloseTo(180, 9);
        expect(planarBearingDeg(o, { x: -10, y: 0 })).toBeCloseTo(270, 9);
        expect(planarBearingDeg(o, { x: 10, y: 10 })).toBeCloseTo(45, 9);
    });
});

// ── Gate placement math ────────────────────────────────────────────────────

describe('perpendicularFoot / nearestLegFoot', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };

    test('projects onto the segment interior', () => {
        const { point, t } = perpendicularFoot({ x: 40, y: 25 }, a, b);
        expect(point).toEqual({ x: 40, y: 0 });
        expect(t).toBeCloseTo(0.4, 9);
    });

    test('clamps beyond the endpoints', () => {
        expect(perpendicularFoot({ x: -50, y: 10 }, a, b).point).toEqual({ x: 0, y: 0 });
        expect(perpendicularFoot({ x: 150, y: 10 }, a, b).t).toBe(1);
    });

    test('degenerate zero-length segment returns the start', () => {
        const { point, t } = perpendicularFoot({ x: 5, y: 5 }, a, a);
        expect(point).toEqual({ x: 0, y: 0 });
        expect(t).toBe(0);
    });

    test('nearestLegFoot picks the closest leg', () => {
        const plan = buildHolePlan(northInput()); // legs 0→200 N and 200→350 N
        // A point 20 m east at 300 m north is nearest to the SECOND leg.
        const p = { x: BASE.x + 20, y: BASE.y + 300 };
        const foot = nearestLegFoot(p, plan.legs);
        expect(foot?.legIndex).toBe(1);
        expect(foot?.distM).toBeCloseTo(20, 3);
        expect(foot?.point.y).toBeCloseTo(BASE.y + 300, 3);
    });
});

describe('gateEndpoints', () => {
    test('ruler is perpendicular to the corridor axis; left = axis − 90°', () => {
        // Axis due north → left endpoint west, right endpoint east.
        const { left, right } = gateEndpoints({ x: 100, y: 100 }, 0, 24, 31);
        expect(left.x).toBeCloseTo(76, 9);
        expect(left.y).toBeCloseTo(100, 9);
        expect(right.x).toBeCloseTo(131, 9);
        expect(right.y).toBeCloseTo(100, 9);
    });

    test('asymmetric widths follow a rotated axis', () => {
        // Axis due east (90°) → left is north (+y), right is south (−y).
        const { left, right } = gateEndpoints({ x: 0, y: 0 }, 90, 10, 20);
        expect(left.x).toBeCloseTo(0, 9);
        expect(left.y).toBeCloseTo(10, 9);
        expect(right.x).toBeCloseTo(0, 9);
        expect(right.y).toBeCloseTo(-20, 9);
    });
});

// ── Overlay GeoJSON ────────────────────────────────────────────────────────

describe('buildPlanGeojson', () => {
    const byRole = (features: Feature[], role: string) =>
        features.filter(f => (f.properties as { role: string }).role === role);

    test('emits legs, one ellipse per clubbed leg, nodes and gate features', () => {
        const plan = buildHolePlan(northInput()); // leg0 has a club, leg1 not
        const g = gate('g1', at(100), 0, 24, 31);
        const fc = buildPlanGeojson({ plan, gates: [g], selectedShotId: null, selectedGateId: null });

        expect(byRole(fc.features, 'leg')).toHaveLength(2);
        expect(byRole(fc.features, 'ellipse')).toHaveLength(1);
        expect(byRole(fc.features, 'node')).toHaveLength(3);
        expect(byRole(fc.features, 'gate-line')).toHaveLength(1);
        expect(byRole(fc.features, 'gate-handle')).toHaveLength(2);
        expect(byRole(fc.features, 'gate-label')).toHaveLength(1);
    });

    test('ellipse polygon is the shared/strategy ring converted to WGS84', () => {
        const plan = buildHolePlan(northInput());
        const fc = buildPlanGeojson({ plan, gates: [], selectedShotId: null, selectedGateId: null });
        const ellipse = byRole(fc.features, 'ellipse')[0].geometry as Polygon;
        const ring = ellipse.coordinates[0];

        const shared = plan.legs[0].ellipse!;
        expect(ring).toHaveLength(shared.polygon.length); // 48 samples + closure
        const first = sweref99tmToWgs84(shared.polygon[0].x, shared.polygon[0].y);
        expect(ring[0][0]).toBeCloseTo(first.lon, 9);
        expect(ring[0][1]).toBeCloseTo(first.lat, 9);
        expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
    });

    test('gate line spans gateEndpoints; label shows both half-widths in metres', () => {
        const g = gate('g1', at(100), 0, 24.4, 31.2);
        const fc = buildPlanGeojson({ plan: null, gates: [g], selectedShotId: null, selectedGateId: null });

        const line = byRole(fc.features, 'gate-line')[0];
        const coords = (line.geometry as LineString).coordinates;
        const station = wgs84ToSweref99tm(g.lat, g.lon);
        const { left, right } = gateEndpoints(station, 0, 24.4, 31.2);
        const leftWgs = sweref99tmToWgs84(left.x, left.y);
        const rightWgs = sweref99tmToWgs84(right.x, right.y);
        expect(coords[0][0]).toBeCloseTo(leftWgs.lon, 9);
        expect(coords[0][1]).toBeCloseTo(leftWgs.lat, 9);
        expect(coords[1][0]).toBeCloseTo(rightWgs.lon, 9);
        expect(coords[1][1]).toBeCloseTo(rightWgs.lat, 9);

        expect(gateLabel(g)).toBe('L 24 m | R 31 m');
        expect((line.properties as { label: string }).label).toBe('L 24 m | R 31 m');
        const handles = byRole(fc.features, 'gate-handle');
        expect(handles.map(h => (h.properties as { side: string }).side).sort()).toEqual(['left', 'right']);
    });

    test('selection flags the shot node and its landing ellipse', () => {
        const plan = buildHolePlan(northInput());
        const fc = buildPlanGeojson({ plan, gates: [], selectedShotId: 's1', selectedGateId: null });

        const ellipse = byRole(fc.features, 'ellipse')[0];
        expect((ellipse.properties as { selected: boolean }).selected).toBe(true);

        const shotNode = byRole(fc.features, 'node')
            .find(f => (f.properties as { kind: string }).kind === 'shot')!;
        expect((shotNode.properties as { selected: boolean }).selected).toBe(true);
        const coords = (shotNode.geometry as Point).coordinates;
        expect(coords[1]).toBeCloseTo(at(200).lat, 9);
    });

    test('leg label carries metres (and plays-like when measured)', () => {
        const plan = buildHolePlan(northInput());
        expect(legLabel(plan.legs[0])).toBe('200 m · plays 195 m');
        const noElev = buildHolePlan(northInput({ tee: { ...at(0), elevation: null } }));
        expect(legLabel(noElev.legs[0])).toBe('200 m');
    });

    test('null plan renders gates only; empty everything renders nothing', () => {
        const fcEmpty = buildPlanGeojson({ plan: null, gates: [], selectedShotId: null, selectedGateId: null });
        expect(fcEmpty.features).toHaveLength(0);
    });
});
