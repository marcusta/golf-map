import { describe, expect, test } from 'bun:test';
import {
    clearHandles,
    deleteAnchor,
    insertAnchor,
    insertControlPoint,
    moveAnchor,
    moveHandle,
    setSymmetricHandles,
    toggleVertexCorner,
} from '../src/draw/draw-state';
import { cubicBezierPoint, flattenRing, type AnchorPoint, type FeatureGeometry, type PathRing, type Point } from '../src/geo/bezier';
import { bsplineRingToBezier } from '../src/geo/bspline';
import { flatRing, resetFlatCacheStats, segmentCacheStats } from '../src/geo/flat-cache';

// Review item 8: drag edits share untouched rings and points with their
// input, and flattenRing reuses the flattened points of every segment whose
// controls are unchanged. These pin the identity contract and that cached
// flattening returns exactly the uncached math.

/** The pre-cache flattenRing, verbatim (server parity reference). */
function referenceFlatten(ring: PathRing, tol: number, curveType?: 'bezier' | 'bspline'): Array<[number, number]> {
    if (curveType === 'bspline') ring = bsplineRingToBezier(ring);
    const pts = ring.points;
    if (pts.length === 0) return [];
    if (pts.length === 1) return [[pts[0].x, pts[0].y]];
    const out: Array<[number, number]> = [];
    const n = pts.length;
    const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        out.push([a.x, a.y]);
        const p0 = { x: a.x, y: a.y };
        const p1 = a.hOut ?? { x: a.x, y: a.y };
        const p2 = b.hIn ?? { x: b.x, y: b.y };
        const p3 = { x: b.x, y: b.y };
        if (!a.hOut && !b.hIn) continue;
        const len = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
        const segs = Math.max(1, Math.min(256, Math.ceil(len / tol)));
        for (let s = 1; s < segs; s++) out.push(cubicBezierPoint(p0, p1, p2, p3, s / segs));
    }
    return out;
}

/** n-anchor circle with tangent handles. */
function circle(n: number, r = 100): AnchorPoint[] {
    const k = (4 / 3) * Math.tan(Math.PI / (2 * n)) * r;
    return Array.from({ length: n }, (_, i) => {
        const a = (2 * Math.PI * i) / n;
        const x = r * Math.cos(a), y = r * Math.sin(a);
        const tx = -Math.sin(a), ty = Math.cos(a);
        return { x, y, hIn: { x: x - k * tx, y: y - k * ty }, hOut: { x: x + k * tx, y: y + k * ty } };
    });
}

function twoRings(curveType?: 'bspline'): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        ...(curveType ? { curveType } : {}),
        rings: [
            { points: curveType ? circle(12).map(p => ({ x: p.x, y: p.y })) : circle(12) },
            { points: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] },
        ],
    };
}

function snapshot(g: FeatureGeometry): string {
    return JSON.stringify(g);
}

describe('single-vertex edits share structure', () => {
    const ops: Array<[string, (g: FeatureGeometry) => FeatureGeometry | null]> = [
        ['moveAnchor', g => moveAnchor(g, 0, 3, { x: 5, y: 7 })],
        ['moveHandle', g => moveHandle(g, 0, 3, 'hOut', { x: 5, y: 7 })],
        ['moveHandle asymmetric', g => moveHandle(g, 0, 3, 'hIn', { x: 5, y: 7 }, false)],
        ['setSymmetricHandles', g => setSymmetricHandles(g, 0, 3, { x: 5, y: 7 })],
        ['clearHandles', g => clearHandles(g, 0, 3)],
        ['toggleVertexCorner', g => toggleVertexCorner(g, 0, 3)],
    ];
    for (const [name, op] of ops) {
        test(`${name}: new geometry, new touched ring, one new point, input untouched`, () => {
            const g = twoRings();
            const before = snapshot(g);
            const next = op(g)!;
            expect(snapshot(g)).toBe(before);
            expect(next).not.toBe(g);
            expect(next.rings).not.toBe(g.rings);
            expect(next.rings[0]).not.toBe(g.rings[0]);
            expect(next.rings[0].points).not.toBe(g.rings[0].points);
            expect(next.rings[1]).toBe(g.rings[1]);
            const changed = next.rings[0].points.filter((p, i) => p !== g.rings[0].points[i]);
            expect(changed).toEqual([next.rings[0].points[3]]);
        });
    }

    test('moveAnchor translates handles and keeps the corner flag', () => {
        const g = twoRings('bspline');
        g.rings[0].points[2] = { ...g.rings[0].points[2], corner: true };
        const next = moveAnchor(g, 0, 2, { x: 1, y: 2 });
        expect(next.rings[0].points[2]).toEqual({ x: 1, y: 2, corner: true });
        expect(next.curveType).toBe('bspline');
        const h = twoRings();
        const p = h.rings[0].points[3];
        const moved = moveAnchor(h, 0, 3, { x: p.x + 4, y: p.y - 2 }).rings[0].points[3];
        expect(moved.hIn).toEqual({ x: p.hIn!.x + 4, y: p.hIn!.y - 2 });
        expect(moved.hOut).toEqual({ x: p.hOut!.x + 4, y: p.hOut!.y - 2 });
    });

    test('insert and delete keep every other point object', () => {
        const g = twoRings();
        const before = snapshot(g);
        const del = deleteAnchor(g, 0, 5)!;
        expect(del.rings[0].points).toEqual([...g.rings[0].points.slice(0, 5), ...g.rings[0].points.slice(6)]);
        del.rings[0].points.forEach((p, i) => expect(p).toBe(g.rings[0].points[i < 5 ? i : i + 1]));
        const ins = insertControlPoint(g, 0, 4, { x: 0, y: 0 });
        expect(ins.rings[0].points.length).toBe(13);
        expect(ins.rings[0].points[4]).toBe(g.rings[0].points[4]);
        expect(ins.rings[0].points[6]).toBe(g.rings[0].points[5]);
        const split = insertAnchor(g, 0, 4, 0.5);
        // The split segment's ends get new handles; the rest are shared.
        expect(split.rings[0].points[3]).toBe(g.rings[0].points[3]);
        expect(split.rings[0].points[4]).not.toBe(g.rings[0].points[4]);
        expect(split.rings[0].points[6]).not.toBe(g.rings[0].points[5]);
        expect(split.rings[0].points[7]).toBe(g.rings[0].points[6]);
        expect(split.rings[1]).toBe(g.rings[1]);
        expect(snapshot(g)).toBe(before);
    });
});

describe('per-segment flatten cache', () => {
    test('a drag frame re-flattens only the segments touching the moved anchor (bezier)', () => {
        const g = twoRings();
        flatRing(g.rings[0], 0.25);
        let frame = g;
        for (let i = 0; i < 5; i++) {
            resetFlatCacheStats();
            frame = moveAnchor(g, 0, 3, { x: 60 + i, y: 60 - i });
            const flat = flatRing(frame.rings[0], 0.25);
            // Segment 2 (anchor 2 -> 3) and segment 3 (anchor 3 -> 4).
            expect(segmentCacheStats()).toEqual({ hits: 10, misses: 2 });
            expect(flat.pts).toEqual(referenceFlatten(frame.rings[0], 0.25));
        }
    });

    test('a drag frame re-flattens only the four segments a control influences (bspline)', () => {
        const g = twoRings('bspline');
        flattenRing(g.rings[0], 0.25, 'bspline');
        for (let i = 0; i < 5; i++) {
            resetFlatCacheStats();
            const frame = moveAnchor(g, 0, 6, { x: -80 + i, y: 3 * i });
            const flat = flattenRing(frame.rings[0], 0.25, 'bspline');
            expect(segmentCacheStats()).toEqual({ hits: 8, misses: 4 });
            expect(flat).toEqual(referenceFlatten(frame.rings[0], 0.25, 'bspline'));
        }
    });

    test('bspline corner copies key separate segments and match the reference', () => {
        const g = twoRings('bspline');
        const corner = toggleVertexCorner(g, 0, 4);
        expect(flattenRing(corner.rings[0], 0.25, 'bspline')).toEqual(referenceFlatten(corner.rings[0], 0.25, 'bspline'));
        const back = toggleVertexCorner(corner, 0, 4);
        expect(flattenRing(back.rings[0], 0.25, 'bspline')).toEqual(referenceFlatten(back.rings[0], 0.25, 'bspline'));
    });

    test('tolerances are cached side by side', () => {
        const ring = { points: circle(8) };
        for (const tol of [0.25, 1, 0.25, 0.05, 1]) {
            expect(flattenRing(ring, tol)).toEqual(referenceFlatten(ring, tol));
        }
        resetFlatCacheStats();
        flattenRing(ring, 0.25);
        flattenRing(ring, 1);
        expect(segmentCacheStats()).toEqual({ hits: 16, misses: 0 });
    });

    test('a point mutated in place misses instead of returning a stale outline', () => {
        const ring: PathRing = { points: circle(6) };
        flattenRing(ring, 0.25);
        const p = ring.points[2];
        p.x += 3;
        p.hOut = { x: p.hOut!.x + 3, y: p.hOut!.y };
        expect(flattenRing({ points: ring.points.slice() }, 0.25)).toEqual(referenceFlatten(ring, 0.25));
        delete ring.points[2].hIn;
        delete ring.points[1].hOut;
        expect(flattenRing({ points: ring.points.slice() }, 0.25)).toEqual(referenceFlatten(ring, 0.25));
    });

    test('randomized rings match the uncached reference across repeated edits', () => {
        let s = 7;
        const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
        for (let k = 0; k < 60; k++) {
            const n = 1 + Math.floor(rnd() * 10);
            const points: AnchorPoint[] = Array.from({ length: n }, () => {
                const p: AnchorPoint = { x: rnd() * 50, y: rnd() * 50 };
                if (rnd() < 0.5) p.hIn = { x: p.x + rnd() * 6 - 3, y: p.y + rnd() * 6 - 3 };
                if (rnd() < 0.5) p.hOut = { x: p.x + rnd() * 6 - 3, y: p.y + rnd() * 6 - 3 };
                if (rnd() < 0.2) p.corner = true;
                return p;
            });
            for (const curveType of [undefined, 'bspline'] as const) {
                let g: FeatureGeometry = { crs: 'EPSG:3006', ...(curveType ? { curveType } : {}), rings: [{ points }] };
                for (let e = 0; e < 4; e++) {
                    expect(flattenRing(g.rings[0], 0.25, curveType)).toEqual(referenceFlatten(g.rings[0], 0.25, curveType));
                    g = moveAnchor(g, 0, Math.floor(rnd() * n), { x: rnd() * 50, y: rnd() * 50 });
                }
            }
        }
    });
});
