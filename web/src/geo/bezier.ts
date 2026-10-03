// Bezier path-ring geometry for the course-feature editor.
//
// The data model matches the server's FeatureGeometry (server/services/
// geo.ts): a feature is a set of closed rings; each ring is an ordered list
// of anchor points in projected EPSG:3006 meters, with optional cubic
// bezier handles (hIn = incoming control point, hOut = outgoing control
// point, both ABSOLUTE coordinates). Segment i runs anchor[i] → anchor
// [(i+1) % n] as the cubic (a, a.hOut ?? a, b.hIn ?? b, b).
//
// Segment flattening lives in shared/geo/bezier.ts and is the same code the
// server runs, so client-rendered shapes match the server-materialized
// GeoJSON exactly. `flattenRing` here adds the per-segment cache
// (geo/flat-cache.ts) on top of it. The rest is editor math:
// hit-testing, bboxes, nearest-point queries for vertex insertion, and a
// de Casteljau split that inserts an anchor WITHOUT changing the curve.
//
// B-spline geometries (curveType: 'bspline') route through geo/bspline.ts:
// flattenRing / pointInGeometry / ringBbox / outerRingArea convert the
// control ring to its exact bezier equivalent first, so hit-testing,
// selection and analysis work identically on spline features.

import { bsplineRingToBezier } from './bspline';
import { cachedSegment, flatGeometry, flatRing } from './flat-cache';
import { cubicBezierPoint, flattenOpenPath, flattenSegment } from '../../../shared/geo/bezier';

export { cubicBezierPoint, flattenOpenPath, flattenSegment };

export interface Point {
    x: number;
    y: number;
}

export interface AnchorPoint {
    x: number;
    y: number;
    hIn?: Point;
    hOut?: Point;
    /**
     * B-spline corner flag (meaningful when the geometry's curveType is
     * 'bspline'): the control point is triplicated during expansion,
     * forcing the curve through it as a sharp corner. Ignored for bezier.
     */
    corner?: boolean;
}

export interface PathRing {
    points: AnchorPoint[];
}

/** Curve interpretation of a geometry's rings. Absent = 'bezier' (legacy). */
export type CurveType = 'bezier' | 'bspline';

export interface FeatureGeometry {
    crs: string;
    /**
     * 'bezier' (default when absent): ring points are anchors ON the curve
     * with optional cubic handles. 'bspline': ring points are CONTROL
     * points of a closed uniform cubic B-spline (see geo/bspline.ts).
     */
    curveType?: CurveType;
    rings: PathRing[];
}

/** The cubic control points for segment `i` (anchor i → anchor (i+1) % n). */
export function segmentControls(ring: PathRing, i: number): [Point, Point, Point, Point] {
    const a = ring.points[i];
    const b = ring.points[(i + 1) % ring.points.length];
    return [
        { x: a.x, y: a.y },
        a.hOut ?? { x: a.x, y: a.y },
        b.hIn ?? { x: b.x, y: b.y },
        { x: b.x, y: b.y },
    ];
}

/**
 * Flattens a closed PathRing into a polyline of [x, y] points. Identical
 * output to the shared (server) flattenRing for identical input. The
 * polyline is NOT explicitly closed. Straight segments (no handles on
 * either end) contribute only their start anchor; curved segments are
 * subdivided adaptively by chord error (shared/geo/bezier.ts).
 *
 * When `curveType` is 'bspline' the ring's points are B-spline CONTROL
 * points: the ring is first converted to its exact bezier equivalent
 * (corner triplication + closed wrap), then flattened identically.
 *
 * Each segment's points come from the per-segment cache in
 * geo/flat-cache.ts (keyed on the segment's AnchorPoint, verified against
 * its control values). The returned array is fresh, but its [x, y] tuples
 * are shared with other calls: callers must not mutate the tuples.
 */
export function flattenRing(
    ring: PathRing,
    toleranceMeters: number,
    curveType?: CurveType,
): Array<[number, number]> {
    if (curveType === 'bspline') return flattenBsplineRing(ring, toleranceMeters);
    const pts = ring.points;
    if (pts.length === 0) return [];
    if (pts.length === 1) return [[pts[0].x, pts[0].y]];

    const n = pts.length;
    const segs: Array<Array<[number, number]>> = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const h1 = a.hOut ?? a;
        const h2 = b.hIn ?? b;
        const seg = cachedSegment(
            false, a, 0, toleranceMeters, !a.hOut && !b.hIn,
            a.x, a.y, h1.x, h1.y, h2.x, h2.y, b.x, b.y,
        );
        segs[i] = seg;
        total += seg.length;
    }
    return concatSegments(segs, total);
}

/** Concatenate per-segment slices into one fresh array. */
function concatSegments(segs: Array<Array<[number, number]>>, total: number): Array<[number, number]> {
    const out: Array<[number, number]> = new Array(total);
    let o = 0;
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        for (let k = 0; k < seg.length; k++) out[o++] = seg[k];
    }
    return out;
}

/**
 * flattenRing for a b-spline control ring. Computes each bezier segment of
 * the exact conversion (geo/bspline.ts, same arithmetic) without building
 * the converted ring, so the segment cache can key on the ORIGINAL control
 * point: segment i is keyed on the control at expanded index i + 1, with
 * its triplicate copy number as the slot for corner points.
 */
function flattenBsplineRing(ring: PathRing, toleranceMeters: number): Array<[number, number]> {
    const points = ring.points;
    const origIdx: number[] = [];
    const copy: number[] = [];
    for (let i = 0; i < points.length; i++) {
        const copies = points[i].corner ? 3 : 1;
        for (let c = 0; c < copies; c++) {
            origIdx.push(i);
            copy.push(c);
        }
    }
    const n = origIdx.length;
    if (n < 3) return flattenRing(bsplineRingToBezier(ring), toleranceMeters);

    const segs: Array<Array<[number, number]>> = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
        const c0 = points[origIdx[i]];
        const c1 = points[origIdx[(i + 1) % n]];
        const c2 = points[origIdx[(i + 2) % n]];
        const c3 = points[origIdx[(i + 3) % n]];
        const seg = cachedSegment(
            true, c1, copy[(i + 1) % n], toleranceMeters, false,
            (c0.x + 4 * c1.x + c2.x) / 6, (c0.y + 4 * c1.y + c2.y) / 6,
            (2 * c1.x + c2.x) / 3, (2 * c1.y + c2.y) / 3,
            (c1.x + 2 * c2.x) / 3, (c1.y + 2 * c2.y) / 3,
            (c1.x + 4 * c2.x + c3.x) / 6, (c1.y + 4 * c2.y + c3.y) / 6,
        );
        segs[i] = seg;
        total += seg.length;
    }
    return concatSegments(segs, total);
}

/**
 * Point-in-polygon (ray casting) against a flattened ring. The ring is
 * treated as implicitly closed. Points exactly on an edge may land on
 * either side — fine for click hit-testing.
 */
export function pointInRing(p: Point, ring: ReadonlyArray<readonly [number, number]>): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

export interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Bbox of a ring's flattened outline (tolerance 0.25 m). Null for empty rings.
 * Cached on the ring object (geo/flat-cache.ts); the result is shared, so
 * callers must not mutate it.
 */
export function ringBbox(ring: PathRing, toleranceMeters = 0.25, curveType?: CurveType): Bbox | null {
    return flatRing(ring, toleranceMeters, curveType).bbox;
}

function bboxContains(b: Bbox | null, p: Point): boolean {
    return !!b && p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** Signed area (shoelace) of a flattened ring. Positive = CCW. */
export function signedArea(poly: ReadonlyArray<readonly [number, number]>): number {
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
}

export interface NearestOnRing {
    /** Anchor-segment index: the hit lies on segment anchor[i] → anchor[i+1 % n]. */
    segIdx: number;
    /** Curve parameter within that cubic segment, in [0, 1]. */
    t: number;
    /** The nearest point itself. */
    point: Point;
    /** Distance from the query point, in ring units (meters). */
    dist: number;
}

/**
 * Nearest point on a ring's outline to `p` — used for click-on-edge vertex
 * insertion. Coarse-samples each cubic segment, then refines the best
 * parameter by local ternary search. Accuracy is well under editor click
 * tolerance (sub-centimeter for golf-feature-sized segments).
 *
 * With `maxDist`, a segment whose control-point bbox expanded by `maxDist`
 * does not contain `p` is skipped without sampling: a cubic lies inside the
 * convex hull of its controls, so every point on it is farther than
 * `maxDist`. The result then equals the unbounded result whenever that
 * result is within `maxDist`, and is null otherwise.
 */
export function nearestOnRing(ring: PathRing, p: Point, maxDist?: number): NearestOnRing | null {
    const n = ring.points.length;
    if (n < 2) return null;

    let best: NearestOnRing | null = null;

    for (let i = 0; i < n; i++) {
        const [p0, p1, p2, p3] = segmentControls(ring, i);
        if (maxDist !== undefined) {
            const minX = Math.min(p0.x, p1.x, p2.x, p3.x) - maxDist;
            const maxX = Math.max(p0.x, p1.x, p2.x, p3.x) + maxDist;
            const minY = Math.min(p0.y, p1.y, p2.y, p3.y) - maxDist;
            const maxY = Math.max(p0.y, p1.y, p2.y, p3.y) + maxDist;
            if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
        }
        // Coarse scan
        const STEPS = 32;
        let bestT = 0;
        let bestD = Infinity;
        for (let s = 0; s <= STEPS; s++) {
            const t = s / STEPS;
            const [x, y] = cubicBezierPoint(p0, p1, p2, p3, t);
            const d = Math.hypot(x - p.x, y - p.y);
            if (d < bestD) {
                bestD = d;
                bestT = t;
            }
        }
        // Local ternary refine around the coarse winner
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
        if (!best || d < best.dist) {
            best = { segIdx: i, t, point: { x, y }, dist: d };
        }
    }

    if (best && maxDist !== undefined && best.dist > maxDist) return null;
    return best;
}

/**
 * Insert an anchor on segment `segIdx` at parameter `t` WITHOUT changing
 * the curve (de Casteljau split). For a straight segment the new anchor is
 * a plain point on the line; for a curved segment the neighbors' handles
 * are re-derived and the new anchor gets hIn/hOut from the split.
 * Returns a NEW ring (input is not mutated). Points other than the two
 * segment ends keep their object identity (see draw-state structural
 * sharing).
 */
export function splitSegment(ring: PathRing, segIdx: number, t: number): PathRing {
    const n = ring.points.length;
    const points = ring.points.slice();
    const a = (points[segIdx] = { ...points[segIdx] });
    const b = (points[(segIdx + 1) % n] = { ...points[(segIdx + 1) % n] });

    const straight = !a.hOut && !b.hIn;
    if (straight) {
        const mid: AnchorPoint = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        points.splice(segIdx + 1, 0, mid);
        return { points };
    }

    const [p0, p1, p2, p3] = segmentControls(ring, segIdx);
    const lerp = (u: Point, v: Point): Point => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
    const q0 = lerp(p0, p1);
    const q1 = lerp(p1, p2);
    const q2 = lerp(p2, p3);
    const r0 = lerp(q0, q1);
    const r1 = lerp(q1, q2);
    const s = lerp(r0, r1);

    a.hOut = q0;
    b.hIn = q2;
    const mid: AnchorPoint = { x: s.x, y: s.y, hIn: r0, hOut: r1 };
    points.splice(segIdx + 1, 0, mid);
    return { points };
}

/**
 * Feature hit-test in ring space: true when `p` is inside the outer ring
 * (rings[0]) and NOT inside any hole ring (rings[1..]). Flattened rings and
 * bboxes come from the identity-keyed cache (geo/flat-cache.ts); a point
 * outside a ring's bbox skips that ring's ray cast.
 */
export function pointInGeometry(p: Point, geometry: FeatureGeometry, toleranceMeters = 0.25): boolean {
    if (geometry.rings.length === 0) return false;
    const flat = flatGeometry(geometry, toleranceMeters);
    const outer = flat.rings[0];
    if (!bboxContains(outer.bbox, p)) return false;
    if (outer.pts.length < 3 || !pointInRing(p, outer.pts)) return false;
    for (let i = 1; i < flat.rings.length; i++) {
        const hole = flat.rings[i];
        if (hole.pts.length >= 3 && bboxContains(hole.bbox, p) && pointInRing(p, hole.pts)) return false;
    }
    return true;
}

/** |Area| of a geometry's outer ring — used to pick the topmost (smallest) hit. */
export function outerRingArea(geometry: FeatureGeometry, toleranceMeters = 0.25): number {
    if (geometry.rings.length === 0) return 0;
    return Math.abs(signedArea(flatGeometry(geometry, toleranceMeters).rings[0].pts));
}
