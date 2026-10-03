import { describe, expect, test } from 'bun:test';
import {
    cubicBezierPoint,
    flattenRing,
    nearestOnRing,
    pointInGeometry,
    pointInRing,
    ringBbox,
    segmentControls,
    type FeatureGeometry,
    type NearestOnRing,
    type PathRing,
    type Point,
} from '../src/geo/bezier';
import { bsplineBezierCached, flatCacheStats, flatGeometry, resetFlatCacheStats } from '../src/geo/flat-cache';
import { bsplineRingToBezierWithMap } from '../src/geo/bspline';

// Identity-keyed flatten cache (review item 5): hit-testing reuses the
// flattened rings of an unchanged geometry object and bbox-rejects before
// the ray cast. These pin cache identity and that the fast paths return
// exactly what the uncached math returns.

function lcg(seed: number): () => number {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** A curved bezier ring with a hole: kidney-ish outer, square hole. */
function bezierGeometry(): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [
            {
                points: [
                    { x: 0, y: 0, hOut: { x: 20, y: -10 } },
                    { x: 60, y: 0, hIn: { x: 45, y: -12 }, hOut: { x: 75, y: 12 } },
                    { x: 70, y: 40 },
                    { x: 30, y: 25, hIn: { x: 45, y: 20 }, hOut: { x: 15, y: 30 } },
                    { x: 0, y: 45 },
                ],
            },
            { points: [{ x: 20, y: 5 }, { x: 35, y: 5 }, { x: 35, y: 15 }, { x: 20, y: 15 }] },
        ],
    };
}

function splineGeometry(): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        curveType: 'bspline',
        rings: [{
            points: [
                { x: 0, y: 0 }, { x: 40, y: -5 }, { x: 55, y: 20, corner: true },
                { x: 40, y: 50 }, { x: 5, y: 45 }, { x: -10, y: 20 },
            ],
        }],
    };
}

/** The pre-cache pointInGeometry, verbatim. */
function uncachedPointInGeometry(p: Point, geometry: FeatureGeometry, tol = 0.25): boolean {
    if (geometry.rings.length === 0) return false;
    const outer = flattenRing(geometry.rings[0], tol, geometry.curveType);
    if (outer.length < 3 || !pointInRing(p, outer)) return false;
    for (let i = 1; i < geometry.rings.length; i++) {
        const hole = flattenRing(geometry.rings[i], tol, geometry.curveType);
        if (hole.length >= 3 && pointInRing(p, hole)) return false;
    }
    return true;
}

/** The pre-change nearestOnRing, verbatim. */
function oldNearestOnRing(ring: PathRing, p: Point): NearestOnRing | null {
    const n = ring.points.length;
    if (n < 2) return null;
    let best: NearestOnRing | null = null;
    for (let i = 0; i < n; i++) {
        const [p0, p1, p2, p3] = segmentControls(ring, i);
        const STEPS = 32;
        let bestT = 0;
        let bestD = Infinity;
        for (let s = 0; s <= STEPS; s++) {
            const t = s / STEPS;
            const [x, y] = cubicBezierPoint(p0, p1, p2, p3, t);
            const d = Math.hypot(x - p.x, y - p.y);
            if (d < bestD) { bestD = d; bestT = t; }
        }
        let lo = Math.max(0, bestT - 1 / STEPS);
        let hi = Math.min(1, bestT + 1 / STEPS);
        for (let iter = 0; iter < 24; iter++) {
            const m1 = lo + (hi - lo) / 3;
            const m2 = hi - (hi - lo) / 3;
            const [x1, y1] = cubicBezierPoint(p0, p1, p2, p3, m1);
            const [x2, y2] = cubicBezierPoint(p0, p1, p2, p3, m2);
            if (Math.hypot(x1 - p.x, y1 - p.y) <= Math.hypot(x2 - p.x, y2 - p.y)) hi = m2;
            else lo = m1;
        }
        const t = (lo + hi) / 2;
        const [x, y] = cubicBezierPoint(p0, p1, p2, p3, t);
        const d = Math.hypot(x - p.x, y - p.y);
        if (!best || d < best.dist) best = { segIdx: i, t, point: { x, y }, dist: d };
    }
    return best;
}

describe('flat cache identity', () => {
    test('the same geometry object hits; a new object (an edit) misses', () => {
        const g = bezierGeometry();
        resetFlatCacheStats();
        const first = flatGeometry(g, 0.25);
        const second = flatGeometry(g, 0.25);
        expect(second).toBe(first);
        expect(flatCacheStats()).toEqual({ hits: 1, misses: 1 });

        const edited = structuredClone(g);
        const third = flatGeometry(edited, 0.25);
        expect(third).not.toBe(first);
        expect(flatCacheStats()).toEqual({ hits: 1, misses: 2 });
    });

    test('a different tolerance rebuilds instead of returning the wrong flattening', () => {
        const g = bezierGeometry();
        const fine = flatGeometry(g, 0.25);
        const coarse = flatGeometry(g, 5);
        expect(coarse.tol).toBe(5);
        expect(coarse.rings[0].pts.length).toBeLessThan(fine.rings[0].pts.length);
        expect(coarse.rings[0].pts).toEqual(flattenRing(g.rings[0], 5));
    });

    test('cached rings and bboxes equal the uncached flattening', () => {
        for (const g of [bezierGeometry(), splineGeometry()]) {
            const flat = flatGeometry(g, 0.25);
            g.rings.forEach((ring, i) => {
                expect(flat.rings[i].pts).toEqual(flattenRing(ring, 0.25, g.curveType));
            });
            const pts = flattenRing(g.rings[0], 0.25, g.curveType);
            expect(ringBbox(g.rings[0], 0.25, g.curveType)).toEqual({
                minX: Math.min(...pts.map(q => q[0])),
                minY: Math.min(...pts.map(q => q[1])),
                maxX: Math.max(...pts.map(q => q[0])),
                maxY: Math.max(...pts.map(q => q[1])),
            });
        }
    });

    test('bspline conversion is cached per control ring', () => {
        const g = splineGeometry();
        const a = bsplineBezierCached(g.rings[0]);
        expect(bsplineBezierCached(g.rings[0])).toBe(a);
        expect(a).toEqual(bsplineRingToBezierWithMap(g.rings[0]));
        expect(bsplineBezierCached(structuredClone(g.rings[0]))).not.toBe(a);
    });
});

describe('pointInGeometry with bbox reject', () => {
    test('matches the uncached result on 4000 random points', () => {
        const rnd = lcg(42);
        for (const g of [bezierGeometry(), splineGeometry()]) {
            let inside = 0;
            for (let i = 0; i < 2000; i++) {
                const p = { x: -30 + rnd() * 130, y: -30 + rnd() * 100 };
                const expected = uncachedPointInGeometry(p, g);
                expect(pointInGeometry(p, g)).toBe(expected);
                if (expected) inside++;
            }
            // Both outcomes are exercised, including the hole.
            expect(inside).toBeGreaterThan(100);
            expect(inside).toBeLessThan(1900);
        }
        expect(pointInGeometry({ x: 27, y: 10 }, bezierGeometry())).toBe(false); // in the hole
    });
});

describe('nearestOnRing', () => {
    test('without maxDist the result is unchanged from the old implementation', () => {
        const rnd = lcg(7);
        const rings = [bezierGeometry().rings[0], bsplineRingToBezierWithMap(splineGeometry().rings[0]).ring];
        for (const ring of rings) {
            for (let i = 0; i < 300; i++) {
                const p = { x: -20 + rnd() * 110, y: -20 + rnd() * 80 };
                expect(nearestOnRing(ring, p)).toEqual(oldNearestOnRing(ring, p));
            }
        }
    });

    test('with maxDist: same hit when within reach, null otherwise', () => {
        const rnd = lcg(99);
        const ring = bezierGeometry().rings[0];
        let within = 0;
        for (let i = 0; i < 1000; i++) {
            const p = { x: -20 + rnd() * 110, y: -20 + rnd() * 80 };
            const old = oldNearestOnRing(ring, p)!;
            const tol = 3;
            const hit = nearestOnRing(ring, p, tol);
            if (old.dist <= tol) {
                within++;
                expect(hit).toEqual(old);
            } else {
                expect(hit).toBeNull();
            }
        }
        expect(within).toBeGreaterThan(20);
    });
});
