import { test, expect, describe } from 'bun:test';
import {
    expandBsplineControls,
    bsplineRingToBezier,
    bsplineRingToBezierWithMap,
} from '../src/geo/bspline';
import {
    flattenRing,
    pointInGeometry,
    outerRingArea,
    ringBbox,
    nearestOnRing,
    type PathRing,
    type FeatureGeometry,
} from '../src/geo/bezier';
// Direct parity check against the server implementation (same repo — the
// strongest possible evidence that client preview === server-derived
// GeoJSON for spline features).
import {
    flattenRing as serverFlattenRing,
    bsplineRingToBezier as serverBsplineRingToBezier,
} from '../../server/services/geo';

// Reference fixture shared with server/services/geo.test.ts: a 10x10
// square of 4 smooth controls.
const square: PathRing = {
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
};

describe('expandBsplineControls', () => {
    test('corner points triplicate; origIdx maps expanded → original', () => {
        const { ctrl, origIdx } = expandBsplineControls([
            { x: 0, y: 0 },
            { x: 10, y: 0, corner: true },
            { x: 10, y: 10 },
        ]);
        expect(ctrl).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
        expect(origIdx).toEqual([0, 1, 1, 1, 2]);
    });
});

describe('bsplineRingToBezier', () => {
    test('exact conversion values for the 4-control square (server-shared fixture)', () => {
        const bez = bsplineRingToBezier(square);
        expect(bez.points).toHaveLength(4);
        const [a0, a1] = bez.points;
        // start_0 = (p0 + 4·p1 + p2)/6 = (50/6, 10/6)
        expect(a0.x).toBeCloseTo(50 / 6, 12);
        expect(a0.y).toBeCloseTo(10 / 6, 12);
        // cp1_0 = (2·p1 + p2)/3 = (10, 10/3); cp2_0 = (p1 + 2·p2)/3 = (10, 20/3)
        expect(a0.hOut!.x).toBeCloseTo(10, 12);
        expect(a0.hOut!.y).toBeCloseTo(10 / 3, 12);
        expect(a1.hIn!.x).toBeCloseTo(10, 12);
        expect(a1.hIn!.y).toBeCloseTo(20 / 3, 12);
    });

    test('segInsertAfter maps curve segments to bracketing ORIGINAL controls', () => {
        // Smooth square: expanded == original, segment i lies between
        // controls i+1 and i+2 → insert after original index (i+1) % 4.
        const { segInsertAfter } = bsplineRingToBezierWithMap(square);
        expect(segInsertAfter).toEqual([1, 2, 3, 0]);

        // With a corner (triplicated), the map still returns ORIGINAL
        // indices, never expanded ones.
        const withCorner: PathRing = {
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0, corner: true },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        const conv = bsplineRingToBezierWithMap(withCorner);
        expect(conv.ring.points).toHaveLength(6); // 4 + 2 extra corner copies
        for (const idx of conv.segInsertAfter) {
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(4);
        }
    });
});

describe('client ↔ server parity', () => {
    const fixtures: Array<{ name: string; ring: PathRing }> = [
        { name: 'smooth square', ring: square },
        {
            name: 'square with one corner',
            ring: {
                points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0, corner: true },
                    { x: 10, y: 10 },
                    { x: 0, y: 10 },
                ],
            },
        },
        {
            name: 'irregular 6-control bunker-ish blob with two corners',
            ring: {
                points: [
                    { x: 541800.2, y: 6468250.7 },
                    { x: 541812.9, y: 6468248.1, corner: true },
                    { x: 541820.4, y: 6468259.3 },
                    { x: 541815.0, y: 6468270.8 },
                    { x: 541803.3, y: 6468272.2, corner: true },
                    { x: 541795.6, y: 6468261.0 },
                ],
            },
        },
    ];

    for (const { name, ring } of fixtures) {
        test(`bspline conversion is bit-identical to the server: ${name}`, () => {
            expect(bsplineRingToBezier(ring)).toEqual(serverBsplineRingToBezier(ring));
        });

        test(`bspline flattening is bit-identical to the server: ${name}`, () => {
            const client = flattenRing(ring, 0.25, 'bspline');
            const server = serverFlattenRing(ring, 0.25, 'bspline');
            expect(client).toEqual(server);
        });
    }

    test('bezier flattening parity is unchanged (regression)', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        expect(flattenRing(ring, 0.25)).toEqual(serverFlattenRing(ring, 0.25));
    });
});

describe('bspline geometry routing in bezier helpers', () => {
    const splineGeometry: FeatureGeometry = {
        crs: 'EPSG:3006',
        curveType: 'bspline',
        rings: [square],
    };

    test('flattened spline square is a near-circle', () => {
        const flat = flattenRing(square, 0.05, 'bspline');
        const radii = flat.map(([x, y]) => Math.hypot(x - 5, y - 5));
        expect(Math.max(...radii) / Math.min(...radii)).toBeLessThan(1.05);
    });

    test('pointInGeometry hit-tests the CURVE, not the control polygon', () => {
        // Center: inside both.
        expect(pointInGeometry({ x: 5, y: 5 }, splineGeometry)).toBe(true);
        // Near a control corner: inside the control polygon but OUTSIDE
        // the inscribed spline curve (r ≈ 4.58–4.71 from center).
        expect(pointInGeometry({ x: 9.5, y: 9.5 }, splineGeometry)).toBe(false);
        // Just inside the curve along an axis (dist 4.4 < rMin 4.58).
        expect(pointInGeometry({ x: 9.4, y: 5 }, splineGeometry)).toBe(true);
        expect(pointInGeometry({ x: 30, y: 5 }, splineGeometry)).toBe(false);
    });

    test('outerRingArea uses the flattened curve (smaller than control square)', () => {
        const area = outerRingArea(splineGeometry);
        expect(area).toBeGreaterThan(50); // ~π·4.65² ≈ 68
        expect(area).toBeLessThan(80); // well under the 100 control square
    });

    test('ringBbox with bspline reflects the inscribed curve', () => {
        const bbox = ringBbox(square, 0.05, 'bspline')!;
        expect(bbox.minX).toBeGreaterThan(0.2); // curve pulled inside controls
        expect(bbox.maxX).toBeLessThan(9.8);
    });

    test('nearestOnRing on the converted ring finds points on the actual curve', () => {
        const { ring } = bsplineRingToBezierWithMap(square);
        const hit = nearestOnRing(ring, { x: 12, y: 5 })!;
        // Rightmost curve extent is x = 11s/12 + 5 ≈ 9.58 at y = 5.
        expect(hit.point.x).toBeCloseTo(5 + (11 * 5) / 12, 1);
        expect(hit.point.y).toBeCloseTo(5, 1);
    });
});
