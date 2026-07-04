// Bezier path-ring geometry for the course-feature editor.
//
// The data model matches the server's FeatureGeometry (server/services/
// geo.ts): a feature is a set of closed rings; each ring is an ordered list
// of anchor points in projected EPSG:3006 meters, with optional cubic
// bezier handles (hIn = incoming control point, hOut = outgoing control
// point, both ABSOLUTE coordinates). Segment i runs anchor[i] → anchor
// [(i+1) % n] as the cubic (a, a.hOut ?? a, b.hIn ?? b, b).
//
// `flattenRing` is a verbatim port of the server's flattening (same
// tolerance heuristic, same subdivision caps) so client-rendered shapes
// match the server-materialized GeoJSON exactly. The rest is editor math:
// hit-testing, bboxes, nearest-point queries for vertex insertion, and a
// de Casteljau split that inserts an anchor WITHOUT changing the curve.
//
// B-spline geometries (curveType: 'bspline') route through geo/bspline.ts:
// flattenRing / pointInGeometry / ringBbox / outerRingArea convert the
// control ring to its exact bezier equivalent first, so hit-testing,
// selection and analysis work identically on spline features.

import { bsplineRingToBezier } from './bspline';

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

function dist(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

export function cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): [number, number] {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return [
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    ];
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
 * Flattens a closed PathRing into a polyline of [x, y] points — port of the
 * server's flattenRing (identical output for identical input). The polyline
 * is NOT explicitly closed. Straight segments (no handles on either end)
 * contribute only their start anchor; curved segments are subdivided into
 * ceil(controlPolygonLength / tolerance) pieces (clamped to [1, 256]).
 *
 * When `curveType` is 'bspline' the ring's points are B-spline CONTROL
 * points: the ring is first converted to its exact bezier equivalent
 * (corner triplication + closed wrap), then flattened identically —
 * matching the server's flattenRing.
 */
export function flattenRing(
    ring: PathRing,
    toleranceMeters: number,
    curveType?: CurveType,
): Array<[number, number]> {
    if (curveType === 'bspline') ring = bsplineRingToBezier(ring);
    const pts = ring.points;
    if (pts.length === 0) return [];
    if (pts.length === 1) return [[pts[0].x, pts[0].y]];

    const out: Array<[number, number]> = [];
    const n = pts.length;

    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];

        out.push([a.x, a.y]);

        const p0: Point = { x: a.x, y: a.y };
        const p1: Point = a.hOut ?? { x: a.x, y: a.y };
        const p2: Point = b.hIn ?? { x: b.x, y: b.y };
        const p3: Point = { x: b.x, y: b.y };

        const isStraight = !a.hOut && !b.hIn;
        if (isStraight) continue;

        const controlLength = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
        const segments = Math.max(1, Math.min(256, Math.ceil(controlLength / toleranceMeters)));

        for (let s = 1; s < segments; s++) {
            const t = s / segments;
            out.push(cubicBezierPoint(p0, p1, p2, p3, t));
        }
    }

    return out;
}

/**
 * Flattens an OPEN path (a drawing draft): same subdivision as flattenRing
 * but without the closing segment from last anchor back to the first, and
 * the final anchor is included.
 */
export function flattenOpenPath(points: AnchorPoint[], toleranceMeters: number): Array<[number, number]> {
    if (points.length === 0) return [];
    const out: Array<[number, number]> = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        out.push([a.x, a.y]);

        const p0: Point = { x: a.x, y: a.y };
        const p1: Point = a.hOut ?? p0;
        const p2: Point = b.hIn ?? { x: b.x, y: b.y };
        const p3: Point = { x: b.x, y: b.y };
        if (!a.hOut && !b.hIn) continue;

        const controlLength = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
        const segments = Math.max(1, Math.min(256, Math.ceil(controlLength / toleranceMeters)));
        for (let s = 1; s < segments; s++) {
            out.push(cubicBezierPoint(p0, p1, p2, p3, s / segments));
        }
    }
    const last = points[points.length - 1];
    out.push([last.x, last.y]);
    return out;
}

/**
 * Point-in-polygon (ray casting) against a flattened ring. The ring is
 * treated as implicitly closed. Points exactly on an edge may land on
 * either side — fine for click hit-testing.
 */
export function pointInRing(p: Point, ring: Array<[number, number]>): boolean {
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

/** Bbox of a ring's flattened outline (tolerance 0.25 m). Null for empty rings. */
export function ringBbox(ring: PathRing, toleranceMeters = 0.25, curveType?: CurveType): Bbox | null {
    const flat = flattenRing(ring, toleranceMeters, curveType);
    if (flat.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of flat) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
}

/** Signed area (shoelace) of a flattened ring. Positive = CCW. */
export function signedArea(poly: Array<[number, number]>): number {
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
 */
export function nearestOnRing(ring: PathRing, p: Point): NearestOnRing | null {
    const n = ring.points.length;
    if (n < 2) return null;

    let best: NearestOnRing | null = null;

    for (let i = 0; i < n; i++) {
        const [p0, p1, p2, p3] = segmentControls(ring, i);
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

    return best;
}

/**
 * Insert an anchor on segment `segIdx` at parameter `t` WITHOUT changing
 * the curve (de Casteljau split). For a straight segment the new anchor is
 * a plain point on the line; for a curved segment the neighbors' handles
 * are re-derived and the new anchor gets hIn/hOut from the split.
 * Returns a NEW ring (input is not mutated).
 */
export function splitSegment(ring: PathRing, segIdx: number, t: number): PathRing {
    const n = ring.points.length;
    const points = ring.points.map(pt => ({ ...pt }));
    const a = points[segIdx];
    const b = points[(segIdx + 1) % n];

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
 * (rings[0]) and NOT inside any hole ring (rings[1..]).
 */
export function pointInGeometry(p: Point, geometry: FeatureGeometry, toleranceMeters = 0.25): boolean {
    if (geometry.rings.length === 0) return false;
    const outer = flattenRing(geometry.rings[0], toleranceMeters, geometry.curveType);
    if (outer.length < 3 || !pointInRing(p, outer)) return false;
    for (let i = 1; i < geometry.rings.length; i++) {
        const hole = flattenRing(geometry.rings[i], toleranceMeters, geometry.curveType);
        if (hole.length >= 3 && pointInRing(p, hole)) return false;
    }
    return true;
}

/** |Area| of a geometry's outer ring — used to pick the topmost (smallest) hit. */
export function outerRingArea(geometry: FeatureGeometry, toleranceMeters = 0.25): number {
    if (geometry.rings.length === 0) return 0;
    return Math.abs(signedArea(flattenRing(geometry.rings[0], toleranceMeters, geometry.curveType)));
}
