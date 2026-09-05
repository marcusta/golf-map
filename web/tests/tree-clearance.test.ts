import { describe, expect, test } from 'bun:test';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import { buildTreeIndex, type TreeClearanceCrossing, type TreeFeatureInput } from '../../shared/strategy';
import { buildPlanGeojson, planLayers, type PlanLeg, type PlanNode } from '../src/planner/plan-overlay';
import {
    legGroundProfile,
    legTreeClearance,
    treeFeatureInputs,
    treeRowText,
    treeSegmentsForLeg,
    treeStatusClass,
} from '../src/planner/tree-clearance';

function feature(
    id: string,
    type: string,
    box: [number, number, number, number],
    attributes: Record<string, number | string | boolean> | null = null,
): CourseFeature {
    const [x0, x1, y0, y1] = box;
    return {
        id,
        courseId: 'course-1',
        holeId: null,
        type,
        geometry: {
            crs: 'EPSG:3006',
            rings: [{ points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }],
        },
        geojson: null,
        sortOrder: 0,
        source: attributes ? 'lidar-canopy' : null,
        sourceRef: null,
        license: null,
        version: 1,
        attributes,
    } as CourseFeature;
}

function node(kind: PlanNode['kind'], x: number, y: number, elevation: number | null = 0): PlanNode {
    return { kind, depth: 0, primary: true, x, y, lat: 58.4, lon: 15.5, elevation };
}

/** A straight north leg from (0,0) with a club carrying `carryM` (150 m: apex ~23.8 m). */
function leg(carryM: number | null = 150, toY = 150): PlanLeg {
    return {
        index: 0,
        depth: 0,
        primary: true,
        from: node('tee', 0, 0),
        to: node('green', 0, toY),
        bearingDeg: 0,
        club: carryM === null ? null : { id: 'c', name: '7 iron', carryM, dispersionM: 10 } as never,
        horizontalM: toY,
        playsLikeM: toY,
        windEffect: 0,
        adjustedCarryM: carryM ?? undefined,
        ellipse: undefined,
        remainingToGreenM: 0,
    };
}

function trees(minY: number, maxY: number, heightP90M: number | null): TreeFeatureInput {
    return {
        type: 'trees',
        points: [{ x: -20, y: minY }, { x: 20, y: minY }, { x: 20, y: maxY }, { x: -20, y: maxY }],
        attributes: heightP90M === null ? null : { heightP90M },
    };
}

function crossing(status: TreeClearanceCrossing['status'], treeHeightM: number | null, minClearanceM: number | null): TreeClearanceCrossing {
    return {
        feature: trees(0, 1, treeHeightM),
        entryM: 50,
        exitM: 60,
        treeHeightM,
        minClearanceM,
        worstAtM: 50,
        status,
        landsIn: false,
    };
}

describe('treeFeatureInputs', () => {
    test('keeps only trees rings, flattened to planar points with attributes passed through', () => {
        const out = treeFeatureInputs([
            feature('t1', 'trees', [0, 10, 0, 10], { heightP90M: 18, heightMaxM: 22 }),
            feature('t2', 'trees', [20, 30, 0, 10]),
            feature('b1', 'bunker', [40, 50, 0, 10]),
        ]);
        expect(out).toHaveLength(2);
        expect(out[0].type).toBe('trees');
        expect(out[0].points.length).toBeGreaterThanOrEqual(4);
        expect(out[0].points[0]).toEqual({ x: 0, y: 0 });
        expect(out[0].attributes).toEqual({ heightP90M: 18, heightMaxM: 22 });
        expect(out[1].attributes).toBeNull();
    });

    test('skips degenerate rings', () => {
        const degenerate = feature('d', 'trees', [0, 0, 0, 0]);
        degenerate.geometry.rings[0].points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        expect(treeFeatureInputs([degenerate])).toEqual([]);
    });
});

describe('legTreeClearance', () => {
    test('null without a club or without trees', () => {
        expect(legTreeClearance(leg(null), [trees(50, 60, 18)])).toBeNull();
        expect(legTreeClearance(leg(), [])).toBeNull();
        expect(legTreeClearance(leg(), buildTreeIndex([]))).toBeNull();
    });

    test('accepts a prebuilt TreeIndex with the same result as the plain array', () => {
        const forest = [trees(50, 60, 30), trees(300, 320, 18)];
        const viaArray = legTreeClearance(leg(), forest);
        const viaIndex = legTreeClearance(leg(), buildTreeIndex(forest));
        expect(viaIndex).toEqual(viaArray);
        expect(viaIndex?.summary.status).toBe('blocked');
        expect(viaIndex?.beyondCarry).toHaveLength(1);
    });

    test('flat: a 30 m canopy at 50 m blocks a 150 m 7-iron, a 10 m one clears', () => {
        const blocked = legTreeClearance(leg(), [trees(50, 60, 30)]);
        expect(blocked?.summary.status).toBe('blocked');
        expect(blocked?.crossings[0].entryM).toBe(50);
        const clears = legTreeClearance(leg(), [trees(50, 60, 10)]);
        expect(clears?.summary.status).toBe('clears');
    });

    test('hand-drawn trees (no attributes) report unknown', () => {
        expect(legTreeClearance(leg(), [trees(50, 60, null)])?.summary.status).toBe('unknown');
    });

    test('ground rising under the trees turns a clear into a block; a null sample falls back flat', () => {
        // Ball is ~18.7 m up at 50 m (apex 23.8 m at 93 m); a 15 m canopy clears by ~3.7 m.
        const flatOk = legTreeClearance(leg(), [trees(50, 60, 15)], () => 100);
        expect(flatOk?.summary.status).toBe('clears');
        // Ground 10 m higher under the trees than at the tee: canopy top 25 m.
        const lifted = legTreeClearance(leg(), [trees(50, 60, 15)], p => (p.y >= 45 ? 110 : 100));
        expect(lifted?.summary.status).toBe('blocked');
        // Tiles missing everywhere → origin falls back to node elevation (0) and
        // every sample to the origin: the flat answer.
        const missing = legTreeClearance(leg(), [trees(50, 60, 15)], () => null);
        expect(missing?.summary.status).toBe('clears');
    });

    test('legGroundProfile: origin from sampler, node elevation, else 0', () => {
        expect(legGroundProfile(leg(), () => 42).originGroundM).toBe(42);
        const l = leg();
        l.from.elevation = 7;
        expect(legGroundProfile(l, () => null).originGroundM).toBe(7);
        expect(legGroundProfile(l, () => null).groundAt?.(80)).toBe(7);
        l.from.elevation = null;
        expect(legGroundProfile(l).originGroundM).toBe(0);
        expect(legGroundProfile(l).groundAt).toBeUndefined();
    });
});

describe('treeRowText / treeStatusClass', () => {
    test('formats the four statuses', () => {
        expect(treeRowText(crossing('clears', 18, 6.2))).toBe('Trees 18 m · clears by 6 m');
        expect(treeRowText(crossing('blocked', 18, -6.4))).toBe('Trees 18 m · blocked (ball 12 m)');
        expect(treeRowText(crossing('marginal', 18, 1.2))).toBe('Trees 18 m · 1 m to spare');
        expect(treeRowText(crossing('unknown', null, null))).toBe('Trees · height unknown');
    });

    test('ball height never prints negative', () => {
        expect(treeRowText(crossing('blocked', 18, -25))).toBe('Trees 18 m · blocked (ball 0 m)');
    });

    test('status → colour class', () => {
        expect(treeStatusClass('clears')).toBe('good');
        expect(treeStatusClass('marginal')).toBe('risk');
        expect(treeStatusClass('blocked')).toBe('bad');
        expect(treeStatusClass('unknown')).toBe('neutral');
    });
});

describe('treeSegmentsForLeg + plan overlay', () => {
    test('only blocked/marginal crossings become segments, clipped at the carry point', () => {
        const l = leg(150);
        // Blocked canopy straddling the carry point (140–170) and a clear one before it.
        const result = legTreeClearance(l, [trees(140, 170, 40), trees(20, 30, 5)]);
        const segs = treeSegmentsForLeg(l, result);
        expect(segs).toHaveLength(1);
        expect(segs[0].status).toBe('blocked');
        expect(segs[0].from.y).toBeCloseTo(140, 6);
        expect(segs[0].to.y).toBeCloseTo(150, 6);
        expect(segs[0].legIndex).toBe(0);
        expect(treeSegmentsForLeg(l, null)).toEqual([]);
    });

    test('buildPlanGeojson emits leg-trees features with the status and the layer colours them', () => {
        const fc = buildPlanGeojson({
            plan: null,
            gates: [],
            selectedShotId: null,
            selectedGateId: null,
            treeSegments: [
                { legIndex: 0, primary: true, status: 'blocked', from: { x: 500000, y: 6470000 }, to: { x: 500000, y: 6470020 } },
            ],
        });
        const segs = fc.features.filter(f => f.properties?.role === 'leg-trees');
        expect(segs).toHaveLength(1);
        expect(segs[0].properties?.status).toBe('blocked');
        expect(segs[0].geometry.type).toBe('LineString');

        const layer = planLayers().find(l => l.id === 'plan-leg-trees');
        expect(layer?.type).toBe('line');
        const color = JSON.stringify((layer?.paint as Record<string, unknown>)['line-color']);
        expect(color).toContain('"blocked"');
        expect(color).toContain('#B24A32');
        expect(color).toContain('"marginal"');
        expect(color).toContain('#C68A2E');
    });
});
