import { describe, expect, test } from 'bun:test';
import {
    flowBearingDeg, fitWaterPiece, planWaterSteps,
    type WaterStepsFeatureInput, type WaterStepsProposalInput,
} from '../src/terrain-edit/water-steps-apply';
import { flattenRing } from '../src/geo/bezier';

// The Find falls planner (water-steps-apply.ts): a proposal -> the feature edits Accept and `water:steps` store.

const rect = (x0: number, x1: number, y0: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const E = 500000, N = 6500000;

/** Distance from p to the closed polyline. */
function distToRing(p: { x: number; y: number }, ring: { x: number; y: number }[]): number {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    }
    return best;
}

const creek: WaterStepsFeatureInput = {
    id: 'c1', type: 'water_creek', holeId: 'h3', layer: null, version: 4,
    geometry: { crs: 'EPSG:3006', rings: [{ points: rect(E, E + 120, N - 3, N + 3) }] },
    attributes: { digPreset: 'meadow_brook', digDepthM: 0.3, bankVegPalette: 'reeds' },
};
const pond: WaterStepsFeatureInput = {
    id: 'p1', type: 'water', holeId: null, layer: null, version: 2,
    geometry: { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points: rect(E + 125, E + 138, N - 6, N + 6) }] },
    attributes: { digPreset: 'deep_water', digLevelOffsetM: -0.2 },
};

function proposal(): WaterStepsProposalInput {
    return {
        bodies: [{ featureId: 'c1', shape: 'hole_3_23e', version: 4 }, { featureId: 'p1', shape: 'others_23c', version: 2 }],
        pieces: [
            { bodyId: 'c1', shape: 'hole_3_23e', index: 0, kind: 'pond', ring: rect(E, E + 39.5, N - 3, N + 3), levelM: 10, topM: 10, bottomM: 10, areaM2: 237, digLevelOffsetM: 0.04 },
            { bodyId: 'c1', shape: 'hole_3_23e', index: 1, kind: 'pond', ring: rect(E + 40.5, E + 79.5, N - 3, N + 3), levelM: 9, topM: 9, bottomM: 9, areaM2: 234, digLevelOffsetM: 4.2 },
            { bodyId: 'c1', shape: 'hole_3_23e', index: 2, kind: 'creek', ring: rect(E + 80.5, E + 120, N - 3, N + 3), levelM: null, topM: 8, bottomM: 7, areaM2: 237.1, digLevelOffsetM: null },
            { bodyId: 'p1', shape: 'others_23c', index: 0, kind: 'pond', ring: rect(E + 125, E + 138, N - 6, N + 6), levelM: 6, topM: 6, bottomM: 6, areaM2: 156, digLevelOffsetM: -0.31 },
        ],
        falls: [
            { style: 'sill', fromBodyId: 'c1', toBodyId: 'c1', fromPiece: 0, toPiece: 1, line: [{ x: E + 40.5, y: N - 3 }, { x: E + 40.5, y: N + 3 }], at: { x: E + 40.5, y: N }, flow: { x: 1, y: 0 }, topM: 10, bottomM: 9, dropM: 1, sillM: 1, forced: false },
            { style: 'sill', fromBodyId: 'c1', toBodyId: 'c1', fromPiece: 1, toPiece: 2, line: [{ x: E + 80.5, y: N - 3 }, { x: E + 80.5, y: N + 3 }], at: { x: E + 80.5, y: N }, flow: { x: 1, y: 0 }, topM: 9, bottomM: 9, dropM: 0, sillM: 1, forced: true },
            { style: 'outlet', fromBodyId: 'c1', toBodyId: 'p1', fromPiece: 2, toPiece: 0, line: [{ x: E + 125, y: N - 0.75 }, { x: E + 125, y: N + 0.75 }], at: { x: E + 125, y: N }, flow: { x: 1, y: 0 }, topM: 7, bottomM: 6, dropM: 1, sillM: null, forced: false },
        ],
    };
}

describe('planWaterSteps', () => {
    test('the largest piece keeps the feature; the others are new features in its hole; a lone piece keeps its outline', () => {
        const plan = planWaterSteps(proposal(), [creek, pond], { split: true });
        expect(plan.updates.map((u) => [u.featureId, u.version, u.patch.type])).toEqual([['c1', 4, 'water_creek'], ['p1', 2, 'water']]);
        // The creek run (237.1 m2) is the biggest of hole_3_23e's pieces.
        expect(plan.updates[0]!.patch.geometry.curveType).toBe('bspline');
        expect(plan.updates[1]!.patch.geometry).toBe(pond.geometry);
        const pieces = plan.creates.filter((c) => c.type !== 'waterfall');
        expect(pieces.map((c) => [c.label, c.type, c.holeId, c.layer])).toEqual([
            ['hole_3_23e·0', 'water', 'h3', null], ['hole_3_23e·1', 'water', 'h3', null],
        ]);
    });

    test('a pond piece gets the dig settings that hold its level; a creek piece keeps the creek and drops pond keys', () => {
        const plan = planWaterSteps(proposal(), [creek, pond], { split: true });
        const [first, second] = plan.creates;
        // From a creek: its bed profile goes, the pond preset is the default one.
        expect(first!.attributes).toEqual({ bankVegPalette: 'reeds', digPreset: 'natural_pond', digBankAboveDeg: 45, digLevelOffsetM: 0.04 });
        expect(second!.attributes.digLevelOffsetM).toBe(3);                         // clamped to the generator's range
        expect(plan.updates[0]!.patch.attributes).toEqual({ digPreset: 'meadow_brook', digDepthM: 0.3, bankVegPalette: 'reeds' });
        // A pond stays a pond with its own preset and the new offset.
        expect(plan.updates[1]!.patch.attributes).toEqual({ digPreset: 'deep_water', digLevelOffsetM: -0.31, digBankAboveDeg: 45 });
    });

    test('a pond piece becoming a creek loses the pond dig settings', () => {
        const p = proposal();
        p.bodies = [p.bodies[1]!];
        p.pieces = [{ ...p.pieces[3]!, kind: 'creek', levelM: null, digLevelOffsetM: null }];
        p.falls = [];
        const plan = planWaterSteps(p, [pond], { split: true });
        expect(plan.updates[0]!.patch).toMatchObject({ type: 'water_creek', attributes: {} });
    });

    test('each fall is a waterfall along its lip: style, levels, flow bearing, the sill only on sills', () => {
        const plan = planWaterSteps(proposal(), [creek, pond], { split: true });
        const falls = plan.creates.filter((c) => c.type === 'waterfall');
        expect(falls.map((f) => f.label)).toEqual(['fall hole_3_23e·0→1', 'fall hole_3_23e·1→2', 'fall hole_3_23e·2→others_23c·0']);
        expect(falls[0]!.attributes).toEqual({ style: 'sill', flowBearingDeg: 90, topM: 10, bottomM: 9, sillM: 1 });
        expect(falls[0]!.geometry.centerline!.points).toEqual([{ x: E + 40.5, y: N - 3 }, { x: E + 40.5, y: N + 3 }]);
        expect(falls[0]!.geometry.centerline!.widthM).toBe(2);
        expect(falls[0]!.geometry.rings[0]!.points.length).toBeGreaterThan(3);   // the corridor, derived
        expect(falls[0]!.holeId).toBe('h3');
        // A forced cut with no drop on the lidar keeps no levels (the server wants top above bottom).
        expect(falls[1]!.attributes).toEqual({ style: 'sill', flowBearingDeg: 90, sillM: 1 });
        expect(plan.warnings.some((w) => w.includes('no drop'))).toBe(true);
        expect(falls[2]!.attributes).toEqual({ style: 'outlet', flowBearingDeg: 90, topM: 7, bottomM: 6 });
        expect(falls[2]!.holeId).toBe('h3');                                       // the upstream body's hole
    });

    test('a cascade is a waterfall along its path down, upstream first, with its stream width; an existing fall gets none', () => {
        const p = proposal();
        const path = [{ x: E + 120, y: N }, { x: E + 121.5, y: N + 0.4 }, { x: E + 123.2, y: N + 0.2 }, { x: E + 125, y: N }];
        p.falls = [
            { ...p.falls[0]!, exists: true },
            p.falls[1]!,
            { ...p.falls[2]!, style: 'cascade', line: path, at: path[1]!, widthM: 1.2, exists: false },
        ];
        const plan = planWaterSteps(p, [creek, pond]);
        expect(plan.existing).toBe(1);
        const falls = plan.creates.filter((c) => c.type === 'waterfall');
        expect(falls.map((f) => f.label)).toEqual(['fall hole_3_23e·1→2', 'cascade hole_3_23e·2→others_23c·0']);
        expect(falls[1]!.attributes).toEqual({ style: 'cascade', flowBearingDeg: 90, topM: 7, bottomM: 6, widthM: 1.2 });
        expect(falls[1]!.geometry.centerline!.points.map((q) => [q.x, q.y])).toEqual(path.map((q) => [q.x, q.y]));
        // A width out of range is clamped; none given is the default stream.
        p.falls = [{ ...p.falls[2]!, widthM: 9 }];
        expect(planWaterSteps(p, [creek, pond]).creates[0]!.attributes.widthM).toBe(5);
        p.falls = [{ ...p.falls[0]!, widthM: undefined }];
        expect(planWaterSteps(p, [creek, pond]).creates[0]!.attributes.widthM).toBe(1.2);
    });

    test('a body that is not given is an error', () => {
        expect(() => planWaterSteps(proposal(), [creek], { split: true })).toThrow(/others_23c is not loaded/);
    });
});

describe('fitWaterPiece', () => {
    test("a piece's straight cut edges stay within a few decimetres of the B-spline, the rest within the tolerance", () => {
        const ring = rect(0, 39.5, 0, 6);
        const fit = fitWaterPiece(ring);
        expect(fit.maxDeviation).toBeLessThan(0.25);
        const curve = flattenRing({ points: fit.controls }, 0.02, 'bspline').map(([x, y]) => ({ x, y }));
        // Away from the corners the curve hugs the edges.
        const mids = curve.filter((p) => p.x > 2 && p.x < 37.5);
        expect(Math.max(...mids.map((p) => distToRing(p, ring)))).toBeLessThan(0.15);
    });

    test('a curved outline is fitted to the tolerance', () => {
        const ring = Array.from({ length: 120 }, (_, i) => {
            const a = (i / 120) * 2 * Math.PI;
            return { x: 12 * Math.cos(a), y: 7 * Math.sin(a) };
        });
        expect(fitWaterPiece(ring).maxDeviation).toBeLessThanOrEqual(0.15);
    });
});

test('flowBearingDeg: compass degrees clockwise from north', () => {
    expect(flowBearingDeg({ x: 0, y: 1 })).toBe(0);
    expect(flowBearingDeg({ x: 1, y: 0 })).toBe(90);
    expect(flowBearingDeg({ x: 0, y: -1 })).toBe(180);
    expect(flowBearingDeg({ x: -1, y: 0 })).toBe(270);
    expect(flowBearingDeg({ x: -0.7071, y: 0.7071 })).toBe(315);
});
