// Bezier / b-spline ring flattening, shared by server and web.
//
// Data model (server/services/geo.ts FeatureGeometry): a ring is an ordered
// list of anchors in projected EPSG:3006 meters with optional ABSOLUTE
// cubic handles. Segment i runs anchor[i] -> anchor[(i+1) % n] as the
// cubic (a, a.hOut ?? a, b.hIn ?? b, b). A 'bspline' ring holds the CONTROL
// points of a closed uniform cubic B-spline; corner points are triplicated.
//
// The server (toGeoJson, analysis) and the web editor (render, hit-testing)
// both flatten through flattenSegment, so identical input gives identical
// polygons, and server-side area and length stats match what the editor
// draws.
//
// Subdivision is adaptive by chord error. A curved segment is split at
// t = 0.5 by de Casteljau until each piece passes the flatness test below,
// to a depth of at most MAX_DEPTH (256 pieces, the old per-segment cap).
//
// Flatness test (R. Willcocks): with u = 3·p1 - 2·p0 - p3 and
// v = 3·p2 - p0 - 2·p3, the curve stays within E of the uniformly
// parametrised chord when max(ux², vx²) + max(uy², vy²) <= 16·E². The
// bound covers the perpendicular distance to the chord, so it also catches
// loops whose chord is degenerate (p0 == p3).
//
// `toleranceMeters` keeps its old meaning for callers: the spacing the
// legacy fixed subdivision used. The chord-error bound is derived from it
// as E = tol² / (8·REFERENCE_RADIUS_M), the sagitta of a chord of length
// tol on a circle of radius REFERENCE_RADIUS_M. On curves of that radius
// the vertex spacing is at most tol, as before. Spacing grows as
// tol·sqrt(R / REFERENCE_RADIUS_M) for gentler curves, so long near-straight
// segments get far fewer vertices.

export interface FlatPoint {
    x: number;
    y: number;
}

export interface FlattenAnchor {
    x: number;
    y: number;
    hIn?: FlatPoint;
    hOut?: FlatPoint;
    corner?: boolean;
}

export interface FlattenRingInput {
    points: FlattenAnchor[];
}

export type FlattenCurveType = 'bezier' | 'bspline';

/** Curve radius (m) at which the adaptive spacing equals the tolerance. */
export const REFERENCE_RADIUS_M = 3;

/** De Casteljau split depth cap: at most 2^8 = 256 pieces per segment. */
export const MAX_DEPTH = 8;

/** Chord-error bound (m) used for a flatten tolerance (see the header). */
export function chordErrorForTolerance(toleranceMeters: number): number {
    return (toleranceMeters * toleranceMeters) / (8 * REFERENCE_RADIUS_M);
}

export function cubicBezierPoint(
    p0: FlatPoint, p1: FlatPoint, p2: FlatPoint, p3: FlatPoint, t: number,
): [number, number] {
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

/**
 * Flattened points of one cubic segment a -> b, start anchor first, end
 * anchor excluded. A straight segment yields only its start anchor.
 */
export function flattenSegment(
    straight: boolean,
    ax: number, ay: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    bx: number, by: number,
    toleranceMeters: number,
): Array<[number, number]> {
    const out: Array<[number, number]> = [[ax, ay]];
    if (straight) return out;
    const e = chordErrorForTolerance(toleranceMeters);
    subdivide(out, ax, ay, p1x, p1y, p2x, p2y, bx, by, 16 * e * e, 0);
    return out;
}

/** Appends the interior split points of one cubic, in curve order. */
function subdivide(
    out: Array<[number, number]>,
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    limit: number,
    depth: number,
): void {
    if (depth >= MAX_DEPTH) return;
    const ux = 3 * x1 - 2 * x0 - x3;
    const uy = 3 * y1 - 2 * y0 - y3;
    const vx = 3 * x2 - x0 - 2 * x3;
    const vy = 3 * y2 - y0 - 2 * y3;
    if (Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy) <= limit) return;

    const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
    const bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
    const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
    const dx = (ax + bx) / 2, dy = (ay + by) / 2;
    const ex = (bx + cx) / 2, ey = (by + cy) / 2;
    const mx = (dx + ex) / 2, my = (dy + ey) / 2;

    subdivide(out, x0, y0, ax, ay, dx, dy, mx, my, limit, depth + 1);
    out.push([mx, my]);
    subdivide(out, mx, my, ex, ey, cx, cy, x3, y3, limit, depth + 1);
}

/**
 * The pre-adaptive subdivision: ceil(controlPolygonLength / tol) uniform
 * pieces, clamped to [1, 256]. Kept as a reference for vertex-count
 * comparisons and for any parity fixture still pinned to it. No production
 * code path calls it.
 */
export function flattenSegmentUniform(
    straight: boolean,
    ax: number, ay: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    bx: number, by: number,
    toleranceMeters: number,
): Array<[number, number]> {
    const out: Array<[number, number]> = [[ax, ay]];
    if (straight) return out;
    const p0 = { x: ax, y: ay };
    const p1 = { x: p1x, y: p1y };
    const p2 = { x: p2x, y: p2y };
    const p3 = { x: bx, y: by };
    const controlLength =
        Math.hypot(p1x - ax, p1y - ay) + Math.hypot(p2x - p1x, p2y - p1y) + Math.hypot(bx - p2x, by - p2y);
    const segments = Math.max(1, Math.min(256, Math.ceil(controlLength / toleranceMeters)));
    for (let s = 1; s < segments; s++) out.push(cubicBezierPoint(p0, p1, p2, p3, s / segments));
    return out;
}

export type SegmentFlattener = typeof flattenSegment;

/**
 * Flattens a closed ring into a polyline of [x, y] points in the ring's own
 * coordinate space. The polyline is NOT explicitly closed. Straight
 * segments (no handle on either end) contribute only their start anchor.
 *
 * For 'bspline' rings each bezier segment of the exact conversion is
 * computed from the control window (c0, c1, c2, c3):
 *   start = (c0 + 4·c1 + c2) / 6   h1 = (2·c1 + c2) / 3
 *   end   = (c1 + 4·c2 + c3) / 6   h2 = (c1 + 2·c2) / 3
 * with corner controls triplicated and the window wrapped modulo n.
 *
 * `segment` selects the per-segment flattener (default: adaptive).
 */
export function flattenRing(
    ring: FlattenRingInput,
    toleranceMeters: number,
    curveType?: FlattenCurveType,
    segment: SegmentFlattener = flattenSegment,
): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    if (curveType === 'bspline') {
        const ctrl: FlatPoint[] = [];
        for (const p of ring.points) {
            ctrl.push(p);
            if (p.corner) ctrl.push(p, p);
        }
        const n = ctrl.length;
        if (n < 3) return ctrl.map(p => [p.x, p.y]);
        for (let i = 0; i < n; i++) {
            const c0 = ctrl[i];
            const c1 = ctrl[(i + 1) % n];
            const c2 = ctrl[(i + 2) % n];
            const c3 = ctrl[(i + 3) % n];
            appendAll(out, segment(
                false,
                (c0.x + 4 * c1.x + c2.x) / 6, (c0.y + 4 * c1.y + c2.y) / 6,
                (2 * c1.x + c2.x) / 3, (2 * c1.y + c2.y) / 3,
                (c1.x + 2 * c2.x) / 3, (c1.y + 2 * c2.y) / 3,
                (c1.x + 4 * c2.x + c3.x) / 6, (c1.y + 4 * c2.y + c3.y) / 6,
                toleranceMeters,
            ));
        }
        return out;
    }
    const pts = ring.points;
    if (pts.length === 0) return out;
    if (pts.length === 1) return [[pts[0].x, pts[0].y]];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const h1 = a.hOut ?? a;
        const h2 = b.hIn ?? b;
        appendAll(out, segment(!a.hOut && !b.hIn, a.x, a.y, h1.x, h1.y, h2.x, h2.y, b.x, b.y, toleranceMeters));
    }
    return out;
}

/**
 * Flattens an OPEN path: the same per-segment subdivision as flattenRing,
 * without the closing segment, and with the final anchor included.
 */
export function flattenOpenPath(points: FlattenAnchor[], toleranceMeters: number): Array<[number, number]> {
    if (points.length === 0) return [];
    const out: Array<[number, number]> = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const h1 = a.hOut ?? a;
        const h2 = b.hIn ?? b;
        appendAll(out, flattenSegment(!a.hOut && !b.hIn, a.x, a.y, h1.x, h1.y, h2.x, h2.y, b.x, b.y, toleranceMeters));
    }
    const last = points[points.length - 1];
    out.push([last.x, last.y]);
    return out;
}

function appendAll(out: Array<[number, number]>, seg: Array<[number, number]>): void {
    for (let k = 0; k < seg.length; k++) out.push(seg[k]);
}
