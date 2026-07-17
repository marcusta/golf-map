import { test, expect, describe } from 'bun:test';
import {
    autoGatesForPlan,
    buildHolePlan,
    buildOptionChips,
    buildPlanGeojson,
    enrichLegStrategy,
    enrichPlanStrategy,
    gateEndpoints,
    gateLabel,
    ghostAimForLeg,
    legDriftLabel,
    legLabel,
    legLight,
    nearestLegFoot,
    optionChipLabel,
    perpendicularFoot,
    planarBearingDeg,
    planLayers,
    scoreRiskTriple,
    type HolePlan,
    type HolePlanInput,
    type LegStrategyContext,
    type OptionChip,
    type PlanLeg,
} from '../src/planner/plan-overlay';
import { buildLieMap } from '../src/planner/lie-map';
import {
    adjustedCarryM,
    dispersionEllipse,
    optimizeAim,
    scoreOptionChain,
    segmentStats,
    windEffect,
    type ChainLeg,
} from '../../shared/strategy';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import type { Club } from '../../shared/api/clubs.gen';
import type { CourseFeature } from '../../shared/api/course-features.gen';
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
    parentShotId?: string | null;
    clubId?: string | null;
    elevation?: number | null;
} = {}): PlanShot {
    return {
        id,
        gamePlanHoleId: 'h1',
        parentShotId: opts.parentShotId ?? null,
        sortOrder: opts.sortOrder ?? 0,
        lat: pos.lat,
        lon: pos.lon,
        elevation: opts.elevation ?? null,
        clubId: opts.clubId ?? null,
        label: null,
        version: 1,
    };
}

/** A rectangular course feature in EPSG:3006 meters (straight edges, no bezier handles). */
function rectFeature(id: string, type: string, minX: number, maxX: number, minY: number, maxY: number): CourseFeature {
    return {
        id,
        courseId: 'course-1',
        holeId: null,
        type,
        geometry: {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: minX, y: minY },
                    { x: maxX, y: minY },
                    { x: maxX, y: maxY },
                    { x: minX, y: maxY },
                ],
            }],
        },
        geojson: null,
        sortOrder: 0,
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

        // buildHolePlan projects the air carry onto the leg's slope (tee elev
        // 10 → shot elev 5), so the expected ellipse gets the same groundSlope.
        const groundSlope = (plan.nodes[1].elevation! - plan.nodes[0].elevation!) / leg.horizontalM;
        const expected = dispersionEllipse({
            origin: { x: plan.nodes[0].x, y: plan.nodes[0].y },
            bearingDeg: leg.bearingDeg,
            club: DRIVER,
            groundSlope,
            windSpeedMps: wind.speedMps,
            windDirectionDeg: wind.directionDeg,
        });
        expect(leg.ellipse?.center.x).toBeCloseTo(expected.center.x, 9);
        expect(leg.ellipse?.center.y).toBeCloseTo(expected.center.y, 9);
        expect(leg.ellipse?.semiLengthM).toBe(expected.semiLengthM);
        expect(leg.ellipse?.semiLateralM).toBe(expected.semiLateralM);
        expect(leg.ellipse?.polygon).toEqual(expected.polygon);

        // Wind-adjusted carry matches the shared wind model exactly. Forward
        // application: the effect is keyed on the assigned club's nominal carry.
        const effect = windEffect(wind.speedMps, wind.directionDeg, leg.bearingDeg, DRIVER.carryM);
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
                shot('s2', at(100), { sortOrder: 0, parentShotId: 's1' }),
            ],
        }));
        expect(plan.nodes.map(n => n.kind)).toEqual(['shot', 'shot']);
        expect(plan.legs).toHaveLength(1);
        expect(plan.legs[0].remainingToGreenM).toBeUndefined();
    });

    test('option tree keeps primary route linear while retaining every branch leg', () => {
        const driver = shot('driver', at(200, -15), { clubId: DRIVER.id, sortOrder: 0 });
        const wedge = shot('wedge', at(320, -5), {
            parentShotId: driver.id, clubId: IRON7.id, sortOrder: 0,
        });
        const iron = shot('iron', at(160, 20), { clubId: IRON7.id, sortOrder: 1 });
        const seven = shot('seven', at(285, 10), {
            parentShotId: iron.id, clubId: IRON7.id, sortOrder: 0,
        });
        const plan = buildHolePlan(northInput({ shots: [driver, wedge, iron, seven] }));

        expect(plan.nodes.filter(n => n.kind === 'shot').map(n => n.shot?.id)).toEqual([
            driver.id, wedge.id,
        ]);
        expect(plan.legs.map(leg => [leg.to.shot?.id ?? 'green', leg.primary])).toEqual([
            [driver.id, true], [wedge.id, true], ['green', true],
        ]);
        expect(plan.allLegs.map(leg => leg.to.shot?.id ?? 'green')).toEqual([
            driver.id, wedge.id, iron.id, seven.id, 'green', 'green',
        ]);
        expect(plan.allLegs.filter(leg => !leg.primary)).toHaveLength(3);
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

    test('leg label carries metres, plays-like, and the club\'s absolute carry', () => {
        // northInput's shot s1 carries DRIVER (200 m nominal) → club part appended.
        const plan = buildHolePlan(northInput());
        expect(legLabel(plan.legs[0])).toBe('200 m · plays 195 m · Driver 200 m');
        const noElev = buildHolePlan(northInput({ tee: { ...at(0), elevation: null } }));
        expect(legLabel(noElev.legs[0])).toBe('200 m · Driver 200 m');
        // A leg without a club shows just distance (+ plays-like when measured).
        const noClub = buildHolePlan(northInput({
            shots: [shot('s1', at(200), { clubId: null, elevation: 5 })],
        }));
        expect(legLabel(noClub.legs[0])).toBe('200 m · plays 195 m');
    });

    test('null plan renders gates only; empty everything renders nothing', () => {
        const fcEmpty = buildPlanGeojson({ plan: null, gates: [], selectedShotId: null, selectedGateId: null });
        expect(fcEmpty.features).toHaveLength(0);
    });

    test('branch features are marked non-primary for dashed/dimmed styling', () => {
        const driver = shot('driver', at(200, -15), { clubId: DRIVER.id, sortOrder: 0 });
        const iron = shot('iron', at(160, 20), { clubId: IRON7.id, sortOrder: 1 });
        const plan = buildHolePlan(northInput({ shots: [driver, iron] }));
        const fc = buildPlanGeojson({ plan, gates: [], selectedShotId: null, selectedGateId: null });
        const legs = byRole(fc.features, 'leg');
        const ellipses = byRole(fc.features, 'ellipse');

        expect(legs.map(feature => (feature.properties as { primary: boolean }).primary))
            .toEqual([true, false, true, false]);
        expect(ellipses.map(feature => (feature.properties as { primary: boolean }).primary))
            .toEqual([true, false]);
        expect(planLayers().some(layer => layer.id === 'plan-leg-option'
            && JSON.stringify(layer.paint).includes('line-dasharray'))).toBe(true);
    });
});

// ── Strategy enrichment (DECADE Phase C) ───────────────────────────────────

describe('enrichLegStrategy / enrichPlanStrategy', () => {
    // A wide fairway spanning the whole corridor so `optimizeAim`'s sweep has
    // somewhere to land; BASE-anchored EPSG:3006 rectangle, like rectFeature.
    const fairway = rectFeature('fw1', 'fairway', BASE.x - 200, BASE.x + 200, BASE.y - 50, BASE.y + 400);

    function ctx(overrides: Partial<LegStrategyContext> = {}): LegStrategyContext {
        return {
            lieMap: buildLieMap([fairway]),
            greenCenter: { x: BASE.x, y: BASE.y + 350 },
            wind: null,
            ...overrides,
        };
    }

    test('leg without a club is returned unchanged (no ellipse, nothing to optimize)', () => {
        const plan = buildHolePlan(northInput({
            shots: [shot('s1', at(200), { clubId: null, elevation: 5 })],
        }));
        const enriched = enrichLegStrategy(plan.legs[1], ctx());
        expect(enriched).toBe(plan.legs[1]); // same reference: no-op passthrough
        expect(enriched.expectedStrokes).toBeUndefined();
        expect(enriched.lieBreakdown).toBeUndefined();
        expect(enriched.recommendedBearingDeg).toBeUndefined();
    });

    test('clubbed leg gets expectedStrokes/lieBreakdown/recommendedBearingDeg matching optimizeAim directly', () => {
        const plan = buildHolePlan(northInput());
        const leg = plan.legs[0];
        const c = ctx();
        const enriched = enrichLegStrategy(leg, c);

        const groundSlope = (leg.playsLikeM! - leg.horizontalM) / leg.horizontalM;
        const expected = optimizeAim({
            origin: { x: leg.from.x, y: leg.from.y },
            club: leg.club!,
            targetBearingDeg: leg.bearingDeg,
            surfaces: c.lieMap.surfaces(),
            greenCenter: c.greenCenter,
            groundSlope,
        });

        expect(enriched.expectedStrokes).toBe(expected.best.expectedStrokes);
        expect(enriched.recommendedBearingDeg).toBe(expected.bestBearingDeg);
        expect(enriched.lieBreakdown).toEqual(expected.breakdown);
        // Pure: original leg object is untouched.
        expect(leg.expectedStrokes).toBeUndefined();
    });

    test('wind is forwarded into optimizeAim only when non-null (calm omits the fields)', () => {
        const plan = buildHolePlan(northInput());
        const leg = plan.legs[0];
        const wind = { speedMps: 4, directionDeg: 180 }; // tailwind on a north shot
        const withWind = enrichLegStrategy(leg, ctx({ wind }));
        const calm = enrichLegStrategy(leg, ctx());
        // Tailwind carries further → generally different (not equal) EV.
        expect(withWind.expectedStrokes).not.toBe(calm.expectedStrokes);
    });

    test('enrichPlanStrategy enriches every leg, preserving leg order and count', () => {
        const plan = buildHolePlan(northInput());
        const enriched = enrichPlanStrategy(plan, ctx());
        expect(enriched.legs).toHaveLength(plan.legs.length);
        expect(enriched.legs[0].expectedStrokes).toBeGreaterThan(0);
        expect(enriched.legs[1].expectedStrokes).toBeUndefined(); // leg 1 has no club
        // Non-leg fields pass through unchanged.
        expect(enriched.nodes).toBe(plan.nodes);
        expect(enriched.totalHorizontalM).toBe(plan.totalHorizontalM);
    });
});

describe('autoGatesForPlan', () => {
    test('one computed gate per clubbed leg, stationed at the leg midpoint', () => {
        const plan = buildHolePlan(northInput());
        const gates = autoGatesForPlan(plan.legs, []);
        expect(gates).toHaveLength(1); // only leg 0 has a club
        expect(gates[0].legIndex).toBe(0);
        expect(gates[0].source).toBe('computed');
        expect(gates[0].directionDeg).toBeCloseTo(plan.legs[0].bearingDeg, 9);

        const mid = { x: (plan.legs[0].from.x + plan.legs[0].to.x) / 2, y: (plan.legs[0].from.y + plan.legs[0].to.y) / 2 };
        const midWgs = sweref99tmToWgs84(mid.x, mid.y);
        expect(gates[0].lat).toBeCloseTo(midWgs.lat, 9);
        expect(gates[0].lon).toBeCloseTo(midWgs.lon, 9);
    });

    test('no hazards nearby: half-widths cap at GATE_DEFAULT_HALF_WIDTH_M, not corridorWidth\'s own default', () => {
        const plan = buildHolePlan(northInput());
        const gates = autoGatesForPlan(plan.legs, []);
        expect(gates[0].halfWidthLeftM).toBeLessThanOrEqual(30);
        expect(gates[0].halfWidthRightM).toBeLessThanOrEqual(30);
    });

    test('a hazard ring narrows the corridor on its side', () => {
        const plan = buildHolePlan(northInput());
        const leg = plan.legs[0];
        const mid = { x: (leg.from.x + leg.to.x) / 2, y: (leg.from.y + leg.to.y) / 2 };
        // Bunker hugging the east (right) side of the corridor at the midpoint.
        const bunker: CourseFeature = {
            id: 'b1', courseId: 'c1', holeId: null, type: 'bunker',
            geometry: {
                crs: 'EPSG:3006',
                rings: [{
                    points: [
                        { x: mid.x + 5, y: mid.y - 20 },
                        { x: mid.x + 40, y: mid.y - 20 },
                        { x: mid.x + 40, y: mid.y + 20 },
                        { x: mid.x + 5, y: mid.y + 20 },
                    ],
                }],
            },
            geojson: null, sortOrder: 0, version: 1,
        };
        const lm = buildLieMap([bunker]);
        const gates = autoGatesForPlan(plan.legs, lm.hazardRings());
        expect(gates[0].halfWidthRightM).toBeLessThan(30);
    });

    test('legs without a club produce no gate', () => {
        const plan = buildHolePlan(northInput({
            shots: [shot('s1', at(200), { clubId: null, elevation: 5 })],
        }));
        const gates = autoGatesForPlan(plan.legs, []);
        expect(gates).toHaveLength(0);
    });
});

// ── Pin lights (DECADE Phase D) ─────────────────────────────────────────────

describe('legLight', () => {
    /** A green-terminating approach leg with a synthetic lie breakdown. */
    function approachLeg(breakdown: Partial<Record<string, number>>): PlanLeg {
        const plan = buildHolePlan(northInput({
            shots: [], green: { ...at(150), elevation: 0 }, preferredClubId: IRON7.id,
        }));
        const leg = plan.legs[0]; // tee → green (an approach)
        expect(leg.to.kind).toBe('green');
        return { ...leg, lieBreakdown: breakdown as PlanLeg['lieBreakdown'] };
    }

    test('null on a non-approach leg (does not land on the green)', () => {
        const plan = buildHolePlan(northInput()); // leg0 tee→shot is NOT an approach
        expect(plan.legs[0].to.kind).toBe('shot');
        expect(legLight({ ...plan.legs[0], lieBreakdown: { green: 1 } })).toBeNull();
    });

    test('null on an un-enriched approach (no lieBreakdown yet)', () => {
        const plan = buildHolePlan(northInput({
            shots: [], green: { ...at(150), elevation: 0 }, preferredClubId: IRON7.id,
        }));
        expect(plan.legs[0].lieBreakdown).toBeUndefined();
        expect(legLight(plan.legs[0])).toBeNull();
    });

    test('green: pattern holds the green, no trouble', () => {
        expect(legLight(approachLeg({ green: 0.95, rough: 0.05 }))).toBe('green');
    });

    test('yellow: a slice of rough (trouble ≥ 10%) but no penalty', () => {
        // 15% sand is trouble ≥ LIGHT_TROUBLE_YELLOW (0.1) but < RED (0.25).
        expect(legLight(approachLeg({ green: 0.85, sand: 0.15 }))).toBe('yellow');
    });

    test('yellow: green rarely held even with little trouble', () => {
        // green 0.5 < LIGHT_GREEN_HELD (0.6), trouble only 5% → yellow, not red.
        expect(legLight(approachLeg({ green: 0.5, rough: 0.45, sand: 0.05 }))).toBe('yellow');
    });

    test('red: any penalty in the pattern', () => {
        expect(legLight(approachLeg({ green: 0.9, penalty: 0.02, rough: 0.08 }))).toBe('red');
    });

    test('red: trouble share at or above the red threshold', () => {
        // 30% sand ≥ LIGHT_TROUBLE_RED (0.25) → red even with no penalty.
        expect(legLight(approachLeg({ green: 0.7, sand: 0.3 }))).toBe('red');
    });
});

// ── Ghost recommended-aim marker (DECADE Phase D) ───────────────────────────

describe('ghostAimForLeg', () => {
    test('null when the leg is not enriched (no recommendedBearingDeg)', () => {
        const plan = buildHolePlan(northInput());
        expect(ghostAimForLeg(plan.legs[0])).toBeNull();
    });

    test('projects along recommendedBearingDeg by the slope-projected adjustedCarryM', () => {
        const plan = buildHolePlan(northInput());
        const leg = plan.legs[0];
        // Recommend aiming 90° (due east); carry projects straight east from the
        // tee, ground-projected by the leg's slope (same rule as the ellipse
        // center, so ghost and pattern share the long axis). northInput's leg 0
        // drops 5 m over 200 m → slope −0.025 → carry / 0.975.
        const enriched: PlanLeg = { ...leg, recommendedBearingDeg: 90 };
        const ghost = ghostAimForLeg(enriched)!;
        expect(ghost).not.toBeNull();
        expect(ghost.legIndex).toBe(0);
        expect(ghost.bearingDeg).toBe(90);
        const slope = (leg.playsLikeM! - leg.horizontalM) / leg.horizontalM;
        expect(ghost.point.x).toBeCloseTo(leg.from.x + leg.adjustedCarryM! / (1 + slope), 6);
        expect(ghost.point.y).toBeCloseTo(leg.from.y, 6);
        const wgs = sweref99tmToWgs84(ghost.point.x, ghost.point.y);
        expect(ghost.lat).toBeCloseTo(wgs.lat, 9);
        expect(ghost.lon).toBeCloseTo(wgs.lon, 9);
    });

    test('calm wind: the ghost aim point IS the recommended pattern center (no drift)', () => {
        const fairway = rectFeature('fw1', 'fairway', BASE.x - 200, BASE.x + 200, BASE.y - 50, BASE.y + 400);
        const enriched = enrichLegStrategy(buildHolePlan(northInput()).legs[0], {
            lieMap: buildLieMap([fairway]),
            greenCenter: { x: BASE.x, y: BASE.y + 350 },
            wind: null,
        });
        const ghost = ghostAimForLeg(enriched)!;
        expect(enriched.recommendedEllipse).toBeDefined();
        expect(enriched.recommendedEllipse!.driftM).toBe(0);
        expect(ghost.point.x).toBeCloseTo(enriched.recommendedEllipse!.center.x, 6);
        expect(ghost.point.y).toBeCloseTo(enriched.recommendedEllipse!.center.y, 6);
    });

    test('null when the leg has no club (no adjustedCarryM to project)', () => {
        const plan = buildHolePlan(northInput({
            shots: [shot('s1', at(200), { clubId: null, elevation: 5 })],
        }));
        // leg1 (shot → green) has no club; even with a recommended bearing it can't project.
        const enriched: PlanLeg = { ...plan.legs[1], recommendedBearingDeg: 0 };
        expect(ghostAimForLeg(enriched)).toBeNull();
    });
});

// ── Overlay renders enriched strategy (lights tint + ghost marker) ──────────

describe('buildPlanGeojson strategy rendering', () => {
    const byRole = (features: Feature[], role: string) =>
        features.filter(f => (f.properties as { role: string }).role === role);

    const fairway = rectFeature('fw1', 'fairway', BASE.x - 200, BASE.x + 200, BASE.y - 50, BASE.y + 400);
    function ctx(): LegStrategyContext {
        return { lieMap: buildLieMap([fairway]), greenCenter: { x: BASE.x, y: BASE.y + 350 }, wind: null };
    }

    test('an enriched plan emits a ghost-aim marker per enriched clubbed leg', () => {
        const enriched = enrichPlanStrategy(buildHolePlan(northInput()), ctx());
        const fc = buildPlanGeojson({ plan: enriched, gates: [], selectedShotId: null, selectedGateId: null });
        // leg0 (tee→shot, has a club) enriches; leg1 (shot→green, no club) does not.
        expect(byRole(fc.features, 'ghost-aim')).toHaveLength(1);
    });

    test('an enriched leg also emits its recommended pattern: dashed ellipse + finish dot', () => {
        const enriched = enrichPlanStrategy(buildHolePlan(northInput()), ctx());
        const fc = buildPlanGeojson({ plan: enriched, gates: [], selectedShotId: null, selectedGateId: null });
        expect(byRole(fc.features, 'ghost-ellipse')).toHaveLength(1);
        expect(byRole(fc.features, 'ghost-center')).toHaveLength(1);
        // Calm wind → no visible drift → no aim→finish connector.
        expect(byRole(fc.features, 'ghost-drift')).toHaveLength(0);
        // The finish dot sits at the recommended pattern's (drifted) center.
        const center = byRole(fc.features, 'ghost-center')[0].geometry as Point;
        const rec = enriched.legs[0].recommendedEllipse!;
        const wgs = sweref99tmToWgs84(rec.center.x, rec.center.y);
        expect(center.coordinates[0]).toBeCloseTo(wgs.lon, 9);
        expect(center.coordinates[1]).toBeCloseTo(wgs.lat, 9);
    });

    test('meaningful crosswind draws the aim→finish connector with a drift label', () => {
        // 5 m/s from due west on a north shot: from shot-left → drifts right
        // well past the 3 m label threshold for a 200 m club.
        const wind = { speedMps: 5, directionDeg: 270 };
        const enriched = enrichPlanStrategy(
            buildHolePlan(northInput({ wind })),
            { ...ctx(), wind },
        );
        const fc = buildPlanGeojson({ plan: enriched, gates: [], selectedShotId: null, selectedGateId: null });
        const drifts = byRole(fc.features, 'ghost-drift');
        expect(drifts).toHaveLength(1);
        const props = drifts[0].properties as { label: string };
        expect(props.label).toMatch(/^drift \d+ m R$/);
        // The connector runs from the ghost aim point to the finish dot.
        const line = drifts[0].geometry as LineString;
        const ghost = ghostAimForLeg(enriched.legs[0])!;
        const rec = enriched.legs[0].recommendedEllipse!;
        const centerWgs = sweref99tmToWgs84(rec.center.x, rec.center.y);
        expect(line.coordinates[0][0]).toBeCloseTo(ghost.lon, 9);
        expect(line.coordinates[0][1]).toBeCloseTo(ghost.lat, 9);
        expect(line.coordinates[1][0]).toBeCloseTo(centerWgs.lon, 9);
        expect(line.coordinates[1][1]).toBeCloseTo(centerWgs.lat, 9);
        // And the leg's own label carries the same hold amount.
        expect(legLabel(enriched.legs[0])).toContain('drift');
        expect(legDriftLabel(enriched.legs[0])).toMatch(/^drift \d+ m R$/);
    });

    test('calm wind: no drift text on the leg label', () => {
        const plain = buildHolePlan(northInput());
        expect(legDriftLabel(plain.legs[0])).toBeNull();
        expect(legLabel(plain.legs[0])).not.toContain('drift');
    });

    test('a plain (un-enriched) plan emits NO ghost markers — the per-frame path stays clean', () => {
        const plain = buildHolePlan(northInput());
        const fc = buildPlanGeojson({ plan: plain, gates: [], selectedShotId: null, selectedGateId: null });
        expect(byRole(fc.features, 'ghost-aim')).toHaveLength(0);
        expect(byRole(fc.features, 'ghost-ellipse')).toHaveLength(0);
        expect(byRole(fc.features, 'ghost-center')).toHaveLength(0);
        expect(byRole(fc.features, 'ghost-drift')).toHaveLength(0);
        // ...and every leg's light property is empty (no tint) until enriched.
        for (const legFeature of byRole(fc.features, 'leg')) {
            expect((legFeature.properties as { light: string }).light).toBe('');
        }
    });

    test('the approach leg carries its confidence light for the tint', () => {
        // Par-3 straight up a fairway into a fairway-bounded green: pattern holds
        // the (fairway) surround, so the approach lights up (non-red).
        const plan = buildHolePlan(northInput({
            shots: [], green: { ...at(150), elevation: 0 }, preferredClubId: IRON7.id,
        }));
        const enriched = enrichPlanStrategy(plan, ctx());
        const fc = buildPlanGeojson({ plan: enriched, gates: [], selectedShotId: null, selectedGateId: null });
        const approach = byRole(fc.features, 'leg')[0];
        const light = (approach.properties as { light: string }).light;
        expect(light).toBe(legLight(enriched.legs[0]) ?? '');
    });
});

// ── Option score chips (feature-plan-shot-options.md O4, T30) ───────────────

describe('option score chips', () => {
    const byRole = (features: Feature[], role: string) =>
        features.filter(f => (f.properties as { role: string }).role === role);

    const fairway = rectFeature('fw1', 'fairway', BASE.x - 200, BASE.x + 200, BASE.y - 50, BASE.y + 400);
    function ctx(): LegStrategyContext {
        return { lieMap: buildLieMap([fairway]), greenCenter: { x: BASE.x, y: BASE.y + 350 }, wind: null };
    }

    /** Driver-vs-iron root options, each with a rank-0 continuation. */
    function optionTree() {
        const driver = shot('driver', at(200, -15), { clubId: DRIVER.id, sortOrder: 0 });
        const wedge = shot('wedge', at(320, -5), {
            parentShotId: driver.id, clubId: IRON7.id, sortOrder: 0,
        });
        const iron = shot('iron', at(160, 20), { clubId: IRON7.id, sortOrder: 1 });
        const seven = shot('seven', at(285, 10), {
            parentShotId: iron.id, clubId: IRON7.id, sortOrder: 0,
        });
        return { driver, wedge, iron, seven, plan: buildHolePlan(northInput({ shots: [driver, wedge, iron, seven] })) };
    }

    /** The ChainLeg buildOptionChips derives for the leg landing on `shotId`. */
    function chainLegFor(plan: HolePlan, shotId: string): ChainLeg {
        const leg = plan.allLegs.find(l => l.to.kind === 'shot' && l.to.shot?.id === shotId)!;
        return {
            origin: { x: leg.from.x, y: leg.from.y },
            landing: { x: leg.to.x, y: leg.to.y },
            club: leg.club,
            groundSlope: leg.playsLikeM !== undefined && leg.horizontalM > 0
                ? (leg.playsLikeM - leg.horizontalM) / leg.horizontalM
                : 0,
        };
    }

    test('a linear plan (no multi-sibling decision point) yields no chips', () => {
        expect(buildOptionChips(buildHolePlan(northInput()), ctx())).toEqual([]);
    });

    test('every option at a decision point gets a chip; chains follow rank-0 continuations', () => {
        const { driver, iron, wedge, seven, plan } = optionTree();
        const c = ctx();
        const chips = buildOptionChips(plan, c);
        expect(chips.map(chip => chip.shotId).sort()).toEqual([driver.id, iron.id].sort());

        const chainCtx = { surfaces: c.lieMap.surfaces(), greenCenter: c.greenCenter };
        const driverChain = scoreOptionChain(
            [chainLegFor(plan, driver.id), chainLegFor(plan, wedge.id)], chainCtx);
        const ironChain = scoreOptionChain(
            [chainLegFor(plan, iron.id), chainLegFor(plan, seven.id)], chainCtx);

        const driverChip = chips.find(chip => chip.shotId === driver.id)!;
        const ironChip = chips.find(chip => chip.shotId === iron.id)!;
        // Root options: no strokes behind the decision — probable score IS the chain EV.
        expect(driverChip.strokesBefore).toBe(0);
        expect(driverChip.probableScore).toBe(driverChain.expectedStrokes);
        expect(driverChip.tailScore).toBe(driverChain.tailStrokes);
        expect(driverChip.penaltyProb).toBe(driverChain.penaltyProb);
        expect(ironChip.probableScore).toBe(ironChain.expectedStrokes);
        // Ranks mirror sibling order; both roots are options of one decision.
        expect(driverChip.rank).toBe(0);
        expect(driverChip.primary).toBe(true);
        expect(ironChip.rank).toBe(1);
        expect(ironChip.primary).toBe(false);
        expect(driverChip.clubName).toBe('Driver');
    });

    test('a deeper decision point counts the strokes already played before it', () => {
        // One tee shot, then TWO options for shot 2 (a depth-1 decision).
        const tee1 = shot('tee1', at(200), { clubId: DRIVER.id, sortOrder: 0 });
        const attack = shot('attack', at(330, -5), {
            parentShotId: tee1.id, clubId: IRON7.id, sortOrder: 0,
        });
        const safe = shot('safe', at(280, 10), {
            parentShotId: tee1.id, clubId: IRON7.id, sortOrder: 1,
        });
        const plan = buildHolePlan(northInput({ shots: [tee1, attack, safe] }));
        const c = ctx();
        const chips = buildOptionChips(plan, c);
        expect(chips.map(chip => chip.shotId).sort()).toEqual([attack.id, safe.id].sort());

        const attackChip = chips.find(chip => chip.shotId === attack.id)!;
        expect(attackChip.strokesBefore).toBe(1); // the tee shot is behind the decision
        const chain = scoreOptionChain(
            [chainLegFor(plan, attack.id)],
            { surfaces: c.lieMap.surfaces(), greenCenter: c.greenCenter },
        );
        expect(attackChip.probableScore).toBe(1 + chain.expectedStrokes);
    });

    test('clubless options still price (point estimate inside the chain scorer)', () => {
        const a = shot('a', at(200, -15), { clubId: null, sortOrder: 0 });
        const b = shot('b', at(160, 20), { clubId: null, sortOrder: 1 });
        const plan = buildHolePlan(northInput({ shots: [a, b] }));
        const chips = buildOptionChips(plan, ctx());
        expect(chips).toHaveLength(2);
        for (const chip of chips) {
            expect(chip.probableScore).toBeGreaterThan(1);
            expect(chip.penaltyProb).toBe(0);
            expect(chip.tailScore).toBe(chip.probableScore); // zero tail spread
        }
    });

    test('scoreRiskTriple / optionChipLabel speak the shared O4 vocabulary', () => {
        expect(scoreRiskTriple(4.23, 0.12)).toBe('prob. 4.2 · 12% pen');
        expect(scoreRiskTriple(3.91, 0.184, 5.62)).toBe('prob. 3.9 · 18% pen, blow-up 5.6');
        const chip: OptionChip = {
            shotId: 's', rank: 0, primary: true, clubName: 'Driver', strokesBefore: 0,
            probableScore: 4.21, penaltyProb: 0.12, tailScore: 5.63, lat: 0, lon: 0,
        };
        expect(optionChipLabel(chip, false)).toBe('Driver · prob. 4.2 · 12% pen');
        expect(optionChipLabel(chip, true)).toBe('Driver · prob. 4.2 · 12% pen, blow-up 5.6');
        expect(optionChipLabel({ ...chip, clubName: null }, false)).toBe('prob. 4.2 · 12% pen');
    });

    test('geojson renders one option-chip feature per chip; selection expands the tail', () => {
        const { driver, iron, plan } = optionTree();
        const chips = buildOptionChips(plan, ctx());
        const fc = buildPlanGeojson({
            plan, gates: [], optionChips: chips, selectedShotId: iron.id, selectedGateId: null,
        });
        const chipFeatures = byRole(fc.features, 'option-chip');
        expect(chipFeatures).toHaveLength(2);

        const labelOf = (shotId: string) => (chipFeatures
            .find(f => (f.properties as { shotId: string }).shotId === shotId)!
            .properties as { label: string }).label;
        expect(labelOf(driver.id)).toContain('prob. ');
        expect(labelOf(driver.id)).not.toContain('blow-up');
        expect(labelOf(iron.id)).toContain('blow-up'); // selected → expanded
        // Chips anchor at the option landing.
        const ironFeature = chipFeatures
            .find(f => (f.properties as { shotId: string }).shotId === iron.id)!;
        const coords = (ironFeature.geometry as Point).coordinates;
        expect(coords[1]).toBeCloseTo(at(160, 20).lat, 9);
        // And the overlay has a symbol layer for the role.
        expect(planLayers().some(layer => layer.id === 'plan-option-chip' && layer.type === 'symbol'))
            .toBe(true);
    });

    test('omitting optionChips renders no chip features (the mid-drag frame)', () => {
        const { plan } = optionTree();
        const fc = buildPlanGeojson({ plan, gates: [], selectedShotId: null, selectedGateId: null });
        expect(byRole(fc.features, 'option-chip')).toHaveLength(0);
    });

    test('chip pricing runs the aim sweep; geojson formatting never does (cadence split)', () => {
        // Same spy proxy as the compute-cadence suite below: reading the lie
        // map's surfaces is how the sweep gets its rings, so counting reads
        // distinguishes "priced" (enrich cadence) from "formatted" (per frame).
        const real = buildLieMap([fairway]);
        let surfaceReads = 0;
        const spy: LegStrategyContext['lieMap'] = {
            classifyLie: p => real.classifyLie(p),
            surfaces: () => { surfaceReads++; return real.surfaces(); },
            hazardRings: () => real.hazardRings(),
        };
        const { plan } = optionTree();
        const chips = buildOptionChips(plan, { ...ctx(), lieMap: spy });
        expect(surfaceReads).toBeGreaterThan(0);

        surfaceReads = 0;
        buildPlanGeojson({ plan, gates: [], optionChips: chips, selectedShotId: null, selectedGateId: null });
        expect(surfaceReads).toBe(0);
    });
});

// ── Compute cadence: the per-frame overlay path never optimises (DECADE §4.5) ─
//
// The planner's per-drag-frame path is patchShotLocal → holePlan recompute →
// buildPlanGeojson (see PlannerToolService.applyDrag / overlayData). NONE of
// those touch optimizeAim: only enrichLegStrategy/enrichPlanStrategy do, and
// those are called on shot-place / drag-RELEASE only. This models a drag: many
// buildHolePlan+buildPlanGeojson passes over moving shot positions must NEVER
// enrich, and the enriched overlay's identity gate (base === live) must fall
// back to plain geometry the moment a fresh plan object appears (a frame).

describe('compute cadence', () => {
    const fairway = rectFeature('fw1', 'fairway', BASE.x - 200, BASE.x + 200, BASE.y - 50, BASE.y + 400);
    function ctx(): LegStrategyContext {
        return { lieMap: buildLieMap([fairway]), greenCenter: { x: BASE.x, y: BASE.y + 350 }, wind: null };
    }

    test('buildHolePlan/buildPlanGeojson (the per-frame path) never produce strategy fields', () => {
        // Simulate 30 drag frames: each moves the shot and rebuilds geometry.
        for (let f = 0; f < 30; f++) {
            const plan = buildHolePlan(northInput({
                shots: [shot('s1', at(150 + f, f), { clubId: DRIVER.id, elevation: 5 })],
            }));
            for (const leg of plan.legs) {
                expect(leg.expectedStrokes).toBeUndefined();
                expect(leg.lieBreakdown).toBeUndefined();
                expect(leg.recommendedBearingDeg).toBeUndefined();
            }
            const fc = buildPlanGeojson({ plan, gates: [], selectedShotId: null, selectedGateId: null });
            // No ghost markers ever appear during the drag.
            expect(fc.features.filter(x => (x.properties as { role: string }).role === 'ghost-aim')).toHaveLength(0);
        }
    });

    test('enrich reads the lie map surfaces (reaches optimizeAim); per-frame build never does', () => {
        // A spying LieMap: optimizeAim (via enrichLegStrategy) MUST read
        // surfaces(); the pure per-frame builders must not touch the lie map at
        // all. Counting surface reads is a direct proxy for "did we optimise?".
        const real = buildLieMap([fairway]);
        let surfaceReads = 0;
        const spy: LegStrategyContext['lieMap'] = {
            classifyLie: p => real.classifyLie(p),
            surfaces: () => { surfaceReads++; return real.surfaces(); },
            hazardRings: () => real.hazardRings(),
        };
        const spyCtx: LegStrategyContext = { ...ctx(), lieMap: spy };

        // Per-frame path: build geometry + overlay across frames — no surface reads.
        for (let f = 0; f < 5; f++) {
            const plan = buildHolePlan(northInput({
                shots: [shot('s1', at(150 + f), { clubId: DRIVER.id, elevation: 5 })],
            }));
            buildPlanGeojson({ plan, gates: [], selectedShotId: null, selectedGateId: null });
        }
        expect(surfaceReads).toBe(0);

        // Enrich (place / release cadence): now surfaces ARE read (per clubbed leg).
        enrichPlanStrategy(buildHolePlan(northInput()), spyCtx);
        expect(surfaceReads).toBeGreaterThan(0);
    });

    test('the overlayPlan identity gate: enriched shown only while base === live', () => {
        // This mirrors PlannerToolService.overlayPlan: render enriched only when
        // its base is still the live holePlan reference; a fresh (drag-frame)
        // plan object breaks the match → plain geometry, no stale lights/ghost.
        const overlayPlan = (live: HolePlan, enriched: { base: HolePlan; enriched: HolePlan } | null): HolePlan =>
            enriched && enriched.base === live ? enriched.enriched : live;

        const live = buildHolePlan(northInput());
        const enriched = { base: live, enriched: enrichPlanStrategy(live, ctx()) };
        // Same live reference → enriched (strategy visible).
        expect(overlayPlan(live, enriched).legs[0].expectedStrokes).toBeGreaterThan(0);
        // A drag frame recomputes holePlan into a NEW object → plain geometry.
        const nextFrame = buildHolePlan(northInput());
        expect(nextFrame).not.toBe(live);
        expect(overlayPlan(nextFrame, enriched).legs[0].expectedStrokes).toBeUndefined();
    });
});
