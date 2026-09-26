// Centerline features: a road or cart path stored as the line down its middle
// plus a width, the way it is laid out on the ground. The line is the feature's
// editable shape; the corridor polygon (`rings`) is derived from it, so every
// consumer that reads rings — render, lie, the surface stack, the GSPro SVG,
// iOS — keeps working unchanged, and moving a road is moving one line.
//
// The server re-derives the rings on every create/update (a centerline
// geometry's rings are never trusted from the client); the web derives the
// same rings locally for instant feedback. Both call `centerlineGeometry`.
//
// The curve through the control points is a Catmull-Rom spline with
// chord-scaled tangents (evenly spaced clicks on an arc hug the arc; unevenly
// spaced ones — a long straight into a tight bend — do not overshoot). A
// `corner` point breaks the curve: straight in, straight out. The corridor is
// that curve buffered by half the width with round joins and round caps: two
// roads meeting end to end, or a branch ending on another road, join without
// a notch.

import polygonClipping, { type Geom, type MultiPolygon, type Pair, type Ring } from 'polygon-clipping';

export interface CenterlinePoint {
    x: number;
    y: number;
    /** Break the curve here (a real corner): straight in, straight out. */
    corner?: boolean;
}

export interface FeatureCenterline {
    points: CenterlinePoint[];
    /** Total corridor width in metres. */
    widthM: number;
}

export interface CorridorRing {
    points: Array<{ x: number; y: number }>;
}

/** What a centerline feature's geometry looks like once its rings are derived. */
export interface CenterlineGeometry {
    crs: string;
    curveType: 'bezier';
    rings: CorridorRing[];
    centerline: FeatureCenterline;
}

export const MIN_CENTERLINE_WIDTH_M = 0.2;
export const MAX_CENTERLINE_WIDTH_M = 60;
/** How closely the flattened curve follows the true spline (m). */
export const CENTERLINE_FLATTEN_TOLERANCE_M = 0.05;
/**
 * Clicked paths: a bend turning at least this much becomes a corner (a real
 * corner, not a curve the user clicked round in a few steps).
 */
export const DRAWN_CORNER_TURN_DEG = 45;
/** Imported roads: the pipeline's fetch-roads CORNER_TURN_DEG. */
export const IMPORTED_CORNER_TURN_DEG = 70;

/** Round joins/caps: arc step in radians (8 per quarter circle). */
const ARC_STEP_RAD = Math.PI / 16;
/** Drops the collinear vertices the union leaves where pieces meet (m). */
const RING_SIMPLIFY_M = 0.002;
/** A hole smaller than this is a clipping sliver, not a ring road's inside (m²). */
const MIN_HOLE_AREA_M2 = 0.01;

type XY = { x: number; y: number };

/** The control points with consecutive duplicates removed. */
export function distinctControls(points: readonly CenterlinePoint[]): CenterlinePoint[] {
    const out: CenterlinePoint[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
    }
    return out;
}

/** Why a centerline is unusable, or null when it is fine. */
export function centerlineError(centerline: unknown): string | null {
    if (!centerline || typeof centerline !== 'object') return 'Centerline must be an object';
    const c = centerline as { points?: unknown; widthM?: unknown };
    if (typeof c.widthM !== 'number' || !Number.isFinite(c.widthM)) return 'Centerline widthM must be a number';
    if (c.widthM < MIN_CENTERLINE_WIDTH_M || c.widthM > MAX_CENTERLINE_WIDTH_M) {
        return `Centerline widthM must be ${MIN_CENTERLINE_WIDTH_M}..${MAX_CENTERLINE_WIDTH_M} m`;
    }
    if (!Array.isArray(c.points)) return 'Centerline must have a points array';
    for (const p of c.points as Array<Partial<CenterlinePoint>>) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return 'Centerline points must have finite x/y coordinates';
    }
    if (distinctControls(c.points as CenterlinePoint[]).length < 2) return 'Centerline needs at least 2 distinct points';
    return null;
}

/** Turn at b between a→b and b→c, degrees (0 = straight on). */
function turnDeg(a: XY, b: XY, c: XY): number {
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    const t2 = Math.atan2(c.y - b.y, c.x - b.x);
    let turn = Math.abs(t2 - t1) * (180 / Math.PI);
    if (turn > 180) turn = 360 - turn;
    return turn;
}

/** Mark every interior point turning at least `turnDegMin` as a corner (keeps existing corners). */
export function autoCorners(points: readonly XY[], turnDegMin: number): CenterlinePoint[] {
    const pts = distinctControls(points);
    return pts.map((p, i) => {
        const corner = (p as CenterlinePoint).corner === true
            || (i > 0 && i < pts.length - 1 && turnDeg(pts[i - 1], p, pts[i + 1]) >= turnDegMin);
        return corner ? { x: p.x, y: p.y, corner: true } : { x: p.x, y: p.y };
    });
}

/** Cubic bezier controls of each span between consecutive control points. */
export function centerlineBeziers(points: readonly CenterlinePoint[]): Array<[XY, XY, XY, XY]> {
    const pts = distinctControls(points);
    const n = pts.length;
    if (n < 2) return [];
    const len = (i: number) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    // Unit tangent at a smooth interior point: the direction from the previous
    // to the next point. Ends and corners have none (null): each span then
    // leaves/enters them along its own chord.
    const tangent = (i: number): XY | null => {
        if (i === 0 || i === n - 1 || pts[i].corner) return null;
        const dx = pts[i + 1].x - pts[i - 1].x, dy = pts[i + 1].y - pts[i - 1].y;
        const d = Math.hypot(dx, dy);
        return d < 1e-9 ? null : { x: dx / d, y: dy / d };
    };
    // Handle length at a smooth point: a third of the SHORTER neighbouring
    // chord on both sides. A long straight into a tight bend would otherwise
    // swing its long handle by the bend's tangent and bow the straight out.
    const reach = (i: number) => Math.min(len(i - 1), len(i)) / 3;
    const out: Array<[XY, XY, XY, XY]> = [];
    for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = len(i);
        const chord = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
        const ta = tangent(i), tb = tangent(i + 1);
        const ha = ta ? { x: ta.x * reach(i), y: ta.y * reach(i) } : { x: (chord.x * d) / 3, y: (chord.y * d) / 3 };
        const hb = tb ? { x: tb.x * reach(i + 1), y: tb.y * reach(i + 1) } : { x: (chord.x * d) / 3, y: (chord.y * d) / 3 };
        out.push([
            { x: a.x, y: a.y },
            { x: a.x + ha.x, y: a.y + ha.y },
            { x: b.x - hb.x, y: b.y - hb.y },
            { x: b.x, y: b.y },
        ]);
    }
    return out;
}

function flattenCubic(c: [XY, XY, XY, XY], tol: number, out: XY[], depth = 0): void {
    const [p0, p1, p2, p3] = c;
    const dx = p3.x - p0.x, dy = p3.y - p0.y;
    const chord = Math.hypot(dx, dy);
    const off = (q: XY) => chord < 1e-9
        ? Math.hypot(q.x - p0.x, q.y - p0.y)
        : Math.abs((q.x - p0.x) * dy - (q.y - p0.y) * dx) / chord;
    if (depth >= 12 || Math.max(off(p1), off(p2)) <= tol) {
        out.push({ x: p3.x, y: p3.y });
        return;
    }
    const mid = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
    const p012 = mid(p01, p12), p123 = mid(p12, p23);
    const m = mid(p012, p123);
    flattenCubic([p0, p01, p012, m], tol, out, depth + 1);
    flattenCubic([m, p123, p23, p3], tol, out, depth + 1);
}

/**
 * The curve as a polyline, one list per span (span i runs control i → i+1,
 * both ends included) — what hit tests map back to control indices.
 */
export function flattenCenterlineSpans(points: readonly CenterlinePoint[], tol = CENTERLINE_FLATTEN_TOLERANCE_M): XY[][] {
    return centerlineBeziers(points).map(c => {
        const span: XY[] = [{ x: c[0].x, y: c[0].y }];
        flattenCubic(c, tol, span);
        return span;
    });
}

/** The curve through the control points as one polyline (EPSG:3006). */
export function flattenCenterline(points: readonly CenterlinePoint[], tol = CENTERLINE_FLATTEN_TOLERANCE_M): XY[] {
    const spans = flattenCenterlineSpans(points, tol);
    if (spans.length === 0) return distinctControls(points).map(p => ({ x: p.x, y: p.y }));
    const out: XY[] = [spans[0][0]];
    for (const span of spans) out.push(...span.slice(1));
    return out;
}

/** Nearest point on the curve: the span it lies on (control `span` → `span + 1`) and the distance. */
export function nearestOnCenterline(points: readonly CenterlinePoint[], q: XY): { span: number; point: XY; dist: number } | null {
    let best: { span: number; point: XY; dist: number } | null = null;
    flattenCenterlineSpans(points).forEach((line, span) => {
        for (let i = 0; i < line.length - 1; i++) {
            const a = line[i], b = line[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const l2 = dx * dx + dy * dy;
            const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
            const point = { x: a.x + t * dx, y: a.y + t * dy };
            const dist = Math.hypot(q.x - point.x, q.y - point.y);
            if (!best || dist < best.dist) best = { span, point, dist };
        }
    });
    return best;
}

/** Arc points around `c` at radius `r` from angle a0 sweeping `sweep` (signed), ends included. */
function arc(c: Pair, r: number, a0: number, sweep: number): Pair[] {
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD));
    const out: Pair[] = [];
    for (let k = 0; k <= steps; k++) {
        const a = a0 + (sweep * k) / steps;
        out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return out;
}

function simplifyClosed(ring: Pair[], eps: number): Pair[] {
    // Douglas-Peucker on the open ring (closing point dropped), anchored at
    // the ring's first vertex and its farthest vertex.
    const pts = ring.slice(0, -1);
    if (pts.length <= 4) return pts;
    let far = 0, farD = -1;
    for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
        if (d > farD) { farD = d; far = i; }
    }
    const dp = (seq: Pair[]): Pair[] => {
        if (seq.length <= 2) return seq;
        const a = seq[0], b = seq[seq.length - 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l = Math.hypot(dx, dy);
        let idx = -1, max = -1;
        for (let i = 1; i < seq.length - 1; i++) {
            const d = l < 1e-12 ? Math.hypot(seq[i][0] - a[0], seq[i][1] - a[1]) : Math.abs((seq[i][0] - a[0]) * dy - (seq[i][1] - a[1]) * dx) / l;
            if (d > max) { max = d; idx = i; }
        }
        if (max <= eps) return [a, b];
        return [...dp(seq.slice(0, idx + 1)).slice(0, -1), ...dp(seq.slice(idx))];
    };
    const first = dp(pts.slice(0, far + 1));
    const second = dp([...pts.slice(far), pts[0]]);
    return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/**
 * Grids the pieces are snapped to before the union (m). polygon-clipping
 * throws ("Unable to complete output ring") on vertices that nearly but not
 * quite coincide — kerb corners of neighbouring pieces a few ulps apart.
 * Snapping makes them coincide; a coarser grid is the retry.
 */
const UNION_GRIDS_M = [1e-6, 1e-4, 1e-3];

export function unionRobust(pieces: Pair[][]): MultiPolygon {
    let failure: unknown = null;
    for (const grid of UNION_GRIDS_M) {
        const snapped: Geom[] = [];
        for (const ring of pieces) {
            const out: Pair[] = [];
            for (const [x, y] of ring) {
                const q: Pair = [Math.round(x / grid) * grid, Math.round(y / grid) * grid];
                const last = out[out.length - 1];
                if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
            }
            // Closed ring of at least a triangle, with some area.
            if (out.length >= 4 && Math.abs(ringArea(out)) > grid * grid) snapped.push([out]);
        }
        if (snapped.length === 0) return [];
        try {
            return polygonClipping.union(snapped[0], ...snapped.slice(1));
        } catch (e) {
            failure = e;
        }
    }
    throw failure;
}

function ringArea(ring: Pair[]): number {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

/**
 * A polyline buffered by `halfWidth` with round joins and caps: the union of
 * one rectangle per segment, one pie per join and a half disc per end (always
 * right, however tight the bend or wherever the line crosses itself). Rings in
 * the polyline's own coordinates, exterior first, then holes; closing point
 * dropped. Null when the line has no length.
 */
export function bufferCenterlinePolyline(line: readonly XY[], halfWidth: number): Pair[][] | null {
    const pts = distinctControls(line);
    if (pts.length < 2 || !(halfWidth > 0)) return null;
    // Work near the origin: EPSG:3006 northings (~6.4e6) cost the clipper
    // precision it needs for centimetre slivers.
    const ox = pts[0].x, oy = pts[0].y;
    const local: Pair[] = pts.map(p => [p.x - ox, p.y - oy]);
    const r = halfWidth;
    const pieces: Pair[][] = [];
    const dirs: Pair[] = [];
    // Per segment: its left/right kerb corners at the start (0) and end (1).
    // Joins and caps reuse these exact coordinates — a corner recomputed from
    // the normal differs by 1e-16, and the clipper drops such a piece.
    const left0: Pair[] = [], left1: Pair[] = [], right0: Pair[] = [], right1: Pair[] = [];
    for (let i = 0; i < local.length - 1; i++) {
        const [ax, ay] = local[i], [bx, by] = local[i + 1];
        const l = Math.hypot(bx - ax, by - ay);
        dirs.push([(bx - ax) / l, (by - ay) / l]);
        const nx = (-(by - ay) / l) * r, ny = ((bx - ax) / l) * r;
        left0.push([ax + nx, ay + ny]);
        left1.push([bx + nx, by + ny]);
        right1.push([bx - nx, by - ny]);
        right0.push([ax - nx, ay - ny]);
        // The centerline ends are vertices too: the joins and caps meet the
        // rectangle there, and a vertex landing mid-edge (a T-junction) is
        // where the clipper leaves a hairline slit down to the centerline.
        pieces.push([left0[i], left1[i], local[i + 1], right1[i], right0[i], local[i], left0[i]]);
    }
    // An arc from kerb corner `from` to `to` about `c`, its ends exactly those corners.
    const fan = (c: Pair, from: Pair, to: Pair, sweep: number): Pair[] => {
        const pts = arc(c, r, Math.atan2(from[1] - c[1], from[0] - c[0]), sweep);
        pts[0] = from;
        pts[pts.length - 1] = to;
        return pts;
    };
    for (let i = 1; i < local.length - 1; i++) {
        const u0 = dirs[i - 1], u1 = dirs[i];
        const turn = Math.atan2(u0[0] * u1[1] - u0[1] * u1[0], u0[0] * u1[0] + u0[1] * u1[1]);
        if (Math.abs(turn) < 1e-9) continue;
        // The gap opens on the outside of the bend: right of a left turn.
        const c = local[i];
        const outer = turn > 0 ? fan(c, right1[i - 1], right0[i], turn) : fan(c, left1[i - 1], left0[i], turn);
        pieces.push([c, ...outer, c]);
    }
    const last = dirs.length - 1;
    const startCap = fan(local[0], left0[0], right0[0], Math.PI);
    pieces.push([...startCap, startCap[0]]);
    const endCap = fan(local[local.length - 1], right1[last], left1[last], Math.PI);
    pieces.push([...endCap, endCap[0]]);

    const union = unionRobust(pieces);
    if (union.length === 0) return null;
    // One connected line buffers to one polygon; keep the largest should
    // floating-point dust ever split one off.
    const polygon = union.reduce((best, p) => (Math.abs(ringArea(p[0])) > Math.abs(ringArea(best[0])) ? p : best));
    return polygon
        .map((ring: Ring) => simplifyClosed(ring, RING_SIMPLIFY_M))
        // Holes the clipper leaves where pieces barely fail to meet: slivers.
        .filter((ring, i) => ring.length >= 3 && (i === 0 || Math.abs(ringArea(ring)) > MIN_HOLE_AREA_M2))
        .map(ring => ring.map(([x, y]) => [x + ox, y + oy] as Pair));
}

/** The corridor rings of a centerline (straight-edged anchors), or null when degenerate. */
export function corridorRings(centerline: FeatureCenterline): CorridorRing[] | null {
    if (centerlineError(centerline) !== null) return null;
    const rings = bufferCenterlinePolyline(flattenCenterline(centerline.points), centerline.widthM / 2);
    if (!rings || rings.length === 0) return null;
    return rings.map(ring => ({ points: ring.map(([x, y]) => ({ x, y })) }));
}

/**
 * A centerline feature's full geometry: the cleaned centerline (distinct
 * points, `corner` only where set) and its derived corridor rings. Null when
 * the centerline is unusable.
 */
export function centerlineGeometry(crs: string, centerline: FeatureCenterline): CenterlineGeometry | null {
    const clean: FeatureCenterline = {
        points: distinctControls(centerline.points).map(p => (p.corner ? { x: p.x, y: p.y, corner: true } : { x: p.x, y: p.y })),
        widthM: centerline.widthM,
    };
    const rings = corridorRings(clean);
    if (!rings) return null;
    return { crs, curveType: 'bezier', rings, centerline: clean };
}
