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
// that curve buffered by half the width with round joins. Each end has a shape
// of its own (`startCap` / `endCap`, CenterlineCap): a straight cut whose
// corners are rounded by `rounding` (0 straight .. 1 half circle, reaching that
// radius beyond the end like a round line cap), a turning circle (vändplan) or
// a taper. A road without one keeps the half circle it always had: two roads
// meeting end to end, or a branch ending on another road, join without a notch.

import polygonClipping, { type Geom, type MultiPolygon, type Pair, type Ring } from 'polygon-clipping';

export interface CenterlinePoint {
    x: number;
    y: number;
    /** Break the curve here (a real corner): straight in, straight out. */
    corner?: boolean;
}

export type CenterlineCapShape = 'rounded' | 'turning' | 'taper';

/**
 * The shape of one end. Sizes left out follow the road's width, so a wider
 * road keeps its proportions.
 */
export interface CenterlineCap {
    shape: CenterlineCapShape;
    /** rounded: corner radius as a fraction of half the width (0 straight cut .. 1 half circle). */
    rounding?: number;
    /** turning: the circle's diameter (m); default TURNING_DIAMETER_FACTOR × width. */
    diameterM?: number;
    /** taper: how long the narrowing is (m); default TAPER_LENGTH_FACTOR × width. */
    lengthM?: number;
    /** taper: the width at the tip (m); default TAPER_END_WIDTH_FACTOR × width. */
    endWidthM?: number;
}

export interface FeatureCenterline {
    points: CenterlinePoint[];
    /** Total corridor width in metres. */
    widthM: number;
    /** The shape at the first point; absent = half circle. */
    startCap?: CenterlineCap;
    /** The shape at the last point; absent = half circle. */
    endCap?: CenterlineCap;
}

/** The end every road had before cap shapes: a half circle. */
export const ROUND_CAP: CenterlineCap = { shape: 'rounded', rounding: 1 };
/** Newly drawn roads: a straight end with soft corners. */
export const DEFAULT_DRAWN_CAP: CenterlineCap = { shape: 'rounded', rounding: 0.4 };
export const TURNING_DIAMETER_FACTOR = 2.5;
export const TAPER_LENGTH_FACTOR = 2;
export const TAPER_END_WIDTH_FACTOR = 0.4;
export const MAX_TURNING_DIAMETER_M = 120;
export const MAX_TAPER_LENGTH_M = 200;

/** The named end shapes the editor offers, in order. */
export const CAP_PRESETS = [
    { id: 'straight', label: 'Straight', cap: { shape: 'rounded', rounding: 0 } },
    { id: 'soft', label: 'Soft corners', cap: DEFAULT_DRAWN_CAP },
    { id: 'rounded', label: 'Rounded', cap: { shape: 'rounded', rounding: 0.7 } },
    { id: 'round', label: 'Round', cap: ROUND_CAP },
    { id: 'turning', label: 'Turning circle', cap: { shape: 'turning' } },
    { id: 'taper', label: 'Taper', cap: { shape: 'taper' } },
] as const satisfies ReadonlyArray<{ id: string; label: string; cap: CenterlineCap }>;

export type CapPresetId = (typeof CAP_PRESETS)[number]['id'];

/** The preset a cap is (absent = round), or null for one with its own sizes. */
export function capPresetOf(cap: CenterlineCap | undefined): CapPresetId | null {
    const c = cap ?? ROUND_CAP;
    for (const preset of CAP_PRESETS) {
        const p: CenterlineCap = preset.cap;
        if (p.shape !== c.shape) continue;
        if (c.shape === 'rounded' ? p.rounding === c.rounding : c.diameterM === undefined && c.lengthM === undefined && c.endWidthM === undefined) return preset.id;
    }
    return null;
}

/** A cap's sizes with the width-following defaults filled in. */
export function resolveCap(cap: CenterlineCap | undefined, widthM: number): Required<CenterlineCap> {
    const c = cap ?? ROUND_CAP;
    return {
        shape: c.shape,
        rounding: c.rounding ?? 1,
        diameterM: c.diameterM ?? TURNING_DIAMETER_FACTOR * widthM,
        lengthM: c.lengthM ?? TAPER_LENGTH_FACTOR * widthM,
        endWidthM: c.endWidthM ?? TAPER_END_WIDTH_FACTOR * widthM,
    };
}

/** Why a cap is unusable, or null when it is fine. */
export function capError(cap: unknown, widthM: number): string | null {
    if (!cap || typeof cap !== 'object') return 'Cap must be an object';
    const c = cap as Partial<Record<keyof CenterlineCap, unknown>>;
    const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
    if (!num(c.rounding) || !num(c.diameterM) || !num(c.lengthM) || !num(c.endWidthM)) return 'Cap sizes must be numbers';
    if (c.shape === 'rounded') {
        if (c.rounding === undefined || (c.rounding as number) < 0 || (c.rounding as number) > 1) return 'Cap rounding must be 0..1';
    } else if (c.shape === 'turning') {
        const d = c.diameterM as number | undefined;
        if (d !== undefined && (d < widthM || d > MAX_TURNING_DIAMETER_M)) return `Turning circle diameter must be the road width..${MAX_TURNING_DIAMETER_M} m`;
    } else if (c.shape === 'taper') {
        const l = c.lengthM as number | undefined, w = c.endWidthM as number | undefined;
        if (l !== undefined && (l <= 0 || l > MAX_TAPER_LENGTH_M)) return `Taper length must be 0..${MAX_TAPER_LENGTH_M} m`;
        if (w !== undefined && (w < 0 || w >= widthM)) return 'Taper end width must be at least 0 and under the road width';
    } else {
        return 'Cap shape must be rounded, turning or taper';
    }
    return null;
}

/** Only the cap's known fields (what is stored). */
function cleanCap(cap: CenterlineCap): CenterlineCap {
    const out: CenterlineCap = { shape: cap.shape };
    if (cap.shape === 'rounded') out.rounding = cap.rounding;
    if (cap.shape === 'turning' && cap.diameterM !== undefined) out.diameterM = cap.diameterM;
    if (cap.shape === 'taper' && cap.lengthM !== undefined) out.lengthM = cap.lengthM;
    if (cap.shape === 'taper' && cap.endWidthM !== undefined) out.endWidthM = cap.endWidthM;
    return out;
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
 * And how far one flattened segment may turn (radians, 3°): closely spaced
 * controls bow less than the distance tolerance, so on that alone the curve
 * came out as its control polygon - a kink at every point, plain to see on a
 * narrow band (Omberg's 0.7 m creek, controls 1.4 m apart turning ~15°).
 */
const FLATTEN_MAX_TURN_RAD = (3 * Math.PI) / 180;
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
    for (const key of ['startCap', 'endCap'] as const) {
        const cap = (centerline as Partial<FeatureCenterline>)[key];
        const error = cap === undefined ? null : capError(cap, c.widthM);
        if (error) return `Centerline ${key}: ${error}`;
    }
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

/** How far a cubic's direction turns from its start to its end (radians; 0 when a handle is degenerate). */
function turn(c: [XY, XY, XY, XY]): number {
    const [p0, , , p3] = c;
    const apart = (a: XY, b: XY) => Math.hypot(b.x - a.x, b.y - a.y) > 1e-9;
    const s = c.slice(1).find(q => apart(p0, q));            // where it heads from p0
    const e = c.slice(0, 3).reverse().find(q => apart(q, p3)); // where it comes into p3 from
    if (!s || !e) return 0;
    const h1 = Math.atan2(s.y - p0.y, s.x - p0.x), h2 = Math.atan2(p3.y - e.y, p3.x - e.x);
    return Math.abs(((h2 - h1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
}

function flattenCubic(c: [XY, XY, XY, XY], tol: number, out: XY[], depth = 0): void {
    const [p0, p1, p2, p3] = c;
    const dx = p3.x - p0.x, dy = p3.y - p0.y;
    const chord = Math.hypot(dx, dy);
    const off = (q: XY) => chord < 1e-9
        ? Math.hypot(q.x - p0.x, q.y - p0.y)
        : Math.abs((q.x - p0.x) * dy - (q.y - p0.y) * dx) / chord;
    if (depth >= 12 || (Math.max(off(p1), off(p2)) <= tol && turn(c) <= FLATTEN_MAX_TURN_RAD)) {
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

/** The ends' shapes for `bufferCenterlinePolyline` (absent = half circle). */
export interface CenterlineCaps {
    start?: CenterlineCap;
    end?: CenterlineCap;
}

/** A point `d` m along `line` (0 = its start), splitting that segment: the line gets a vertex there. */
function withVertexAt(line: Pair[], d: number): Pair[] {
    let run = 0;
    for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1];
        const l = Math.hypot(bx - ax, by - ay);
        if (d <= run + l) {
            const t = (d - run) / l;
            if (t < 1e-6 || t > 1 - 1e-6) return line; // on a vertex already
            return [...line.slice(0, i + 1), [ax + t * (bx - ax), ay + t * (by - ay)], ...line.slice(i + 1)];
        }
        run += l;
    }
    return line;
}

/** Signed sweep from angle a0 to a1, the short way round (-π..π). */
function shortSweep(a0: number, a1: number): number {
    let s = a1 - a0;
    while (s > Math.PI) s -= 2 * Math.PI;
    while (s < -Math.PI) s += 2 * Math.PI;
    return s;
}

/**
 * A polyline buffered by `halfWidth` with round joins and the ends' shapes
 * (`caps`, a half circle each by default): the union of one quad per segment,
 * one pie per join and a piece per end (always right, however tight the bend
 * or wherever the line crosses itself). A taper narrows the segments near its
 * end, so the half width varies along the line. Rings in the polyline's own
 * coordinates, exterior first, then holes; closing point dropped. Null when
 * the line has no length.
 */
export function bufferCenterlinePolyline(line: readonly XY[], halfWidth: number, caps: CenterlineCaps = {}): Pair[][] | null {
    const pts = distinctControls(line);
    if (pts.length < 2 || !(halfWidth > 0)) return null;
    // Work near the origin: EPSG:3006 northings (~6.4e6) cost the clipper
    // precision it needs for centimetre slivers.
    const ox = pts[0].x, oy = pts[0].y;
    let local: Pair[] = pts.map(p => [p.x - ox, p.y - oy]);
    const r = halfWidth;
    const widthM = 2 * r;
    const start = resolveCap(caps.start, widthM), end = resolveCap(caps.end, widthM);

    // Tapers: a vertex where each narrowing begins, then the half width per vertex.
    const lengthOf = (l: Pair[]) => l.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);
    const total = lengthOf(local);
    const share = start.shape === 'taper' && end.shape === 'taper' ? total / 2 : total;
    const startTaper = start.shape === 'taper' ? Math.min(start.lengthM, share) : 0;
    const endTaper = end.shape === 'taper' ? Math.min(end.lengthM, share) : 0;
    if (startTaper > 0) local = withVertexAt(local, startTaper);
    if (endTaper > 0) local = withVertexAt(local, total - endTaper);
    const along: number[] = [0];
    for (let i = 1; i < local.length; i++) along.push(along[i - 1] + Math.hypot(local[i][0] - local[i - 1][0], local[i][1] - local[i - 1][1]));
    const radius = along.map(d => {
        let h = r;
        if (startTaper > 0 && d < startTaper) h = Math.min(h, start.endWidthM / 2 + (r - start.endWidthM / 2) * (d / startTaper));
        const back = total - d;
        if (endTaper > 0 && back < endTaper) h = Math.min(h, end.endWidthM / 2 + (r - end.endWidthM / 2) * (back / endTaper));
        return h;
    });

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
        const nx = -(by - ay) / l, ny = (bx - ax) / l;
        const ra = radius[i], rb = radius[i + 1];
        left0.push([ax + nx * ra, ay + ny * ra]);
        left1.push([bx + nx * rb, by + ny * rb]);
        right1.push([bx - nx * rb, by - ny * rb]);
        right0.push([ax - nx * ra, ay - ny * ra]);
        // The centerline ends are vertices too: the joins and caps meet the
        // rectangle there, and a vertex landing mid-edge (a T-junction) is
        // where the clipper leaves a hairline slit down to the centerline.
        pieces.push([left0[i], left1[i], local[i + 1], right1[i], right0[i], local[i], left0[i]]);
    }
    // An arc from kerb corner `from` to `to` about `c`, its ends exactly those corners.
    const fan = (c: Pair, from: Pair, to: Pair, sweep: number, rad: number): Pair[] => {
        const pts = arc(c, rad, Math.atan2(from[1] - c[1], from[0] - c[0]), sweep);
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
        const outer = turn > 0 ? fan(c, right1[i - 1], right0[i], turn, radius[i]) : fan(c, left1[i - 1], left0[i], turn, radius[i]);
        pieces.push([c, ...outer, c]);
    }

    // One end: E the end point, A and B its kerb corners (B = E - (A - E)),
    // u pointing out of the road. Arcs run anticlockwise from A over u to B.
    const capPieces = (cap: Required<CenterlineCap>, E: Pair, A: Pair, B: Pair, u: Pair, inward: Pair[]): Pair[][] => {
        const rE = Math.hypot(A[0] - E[0], A[1] - E[1]);
        const a: Pair = rE > 0 ? [(A[0] - E[0]) / rE, (A[1] - E[1]) / rE] : [-u[1], u[0]];
        const angle = (v: Pair) => Math.atan2(v[1], v[0]);
        const rounded = (rho: number): Pair[][] => {
            if (rho >= 1) {
                // The half circle exactly as before cap shapes (byte-identical rings).
                const half = fan(E, A, B, Math.PI, rE);
                return [[...half, half[0]]];
            }
            const c = rho * rE;
            if (c < 1e-4) return [];
            const c1: Pair = [E[0] + a[0] * (rE - c), E[1] + a[1] * (rE - c)];
            const c2: Pair = [E[0] - a[0] * (rE - c), E[1] - a[1] * (rE - c)];
            const arc1 = arc(c1, c, angle(a), Math.PI / 2);
            const arc2 = arc(c2, c, angle(u), Math.PI / 2);
            arc1[0] = A;
            arc2[arc2.length - 1] = B;
            return [[...arc1, ...arc2, E, A]];
        };
        if (cap.shape === 'rounded') return rounded(Math.max(0, Math.min(1, cap.rounding)));
        if (cap.shape === 'taper') return rounded(1);
        // Turning circle about the end point, with kerb fillets where it meets the road.
        const R = cap.diameterM / 2;
        if (!(R > rE + 1e-3)) return rounded(1);
        const circle = arc(E, R, 0, 2 * Math.PI);
        circle[circle.length - 1] = circle[0];
        const out: Pair[][] = [circle];
        const f = rE;
        const s = Math.sqrt((R + f) ** 2 - (rE + f) ** 2);
        // Fillets need the road to run (near enough) straight back from E for
        // `s` m: P is where it is `s` from E, and the fillets sit square to EP.
        let P: Pair | null = null;
        let prev = E;
        const between: Pair[] = [];
        for (const p of inward) {
            const dp = Math.hypot(p[0] - E[0], p[1] - E[1]);
            if (dp >= s) {
                const d0 = Math.hypot(prev[0] - E[0], prev[1] - E[1]);
                const t = (s - d0) / (dp - d0);
                P = [prev[0] + t * (p[0] - prev[0]), prev[1] + t * (p[1] - prev[1])];
                break;
            }
            between.push(p);
            prev = p;
        }
        if (!P) return out;
        const uf: Pair = [(E[0] - P[0]) / s, (E[1] - P[1]) / s];
        const af: Pair = -uf[1] * a[0] + uf[0] * a[1] >= 0 ? [-uf[1], uf[0]] : [uf[1], -uf[0]];
        const tolerance = 0.05 * rE + 0.02;
        if (between.some(p => Math.abs((p[0] - E[0]) * af[0] + (p[1] - E[1]) * af[1]) > tolerance)) return out;
        for (const side of [1, -1]) {
            const n: Pair = [af[0] * side, af[1] * side];
            const F: Pair = [P[0] + n[0] * (rE + f), P[1] + n[1] * (rE + f)];
            const T1: Pair = [P[0] + n[0] * rE, P[1] + n[1] * rE];
            const toE: Pair = [(E[0] - F[0]) / (R + f), (E[1] - F[1]) / (R + f)];
            const T2: Pair = [F[0] + toE[0] * f, F[1] + toE[1] * f];
            const a0 = angle([-n[0], -n[1]]);
            const fillet = arc(F, f, a0, shortSweep(a0, angle(toE)));
            fillet[0] = T1;
            fillet[fillet.length - 1] = T2;
            out.push([P, ...fillet, E, P]);
        }
        return out;
    };
    const last = dirs.length - 1;
    const n = local.length - 1;
    const startU: Pair = [-dirs[0][0], -dirs[0][1]];
    pieces.push(...capPieces(start, local[0], left0[0], right0[0], startU, local.slice(1)));
    pieces.push(...capPieces(end, local[n], right1[last], left1[last], dirs[last], local.slice(0, n).reverse()));

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
    const rings = bufferCenterlinePolyline(flattenCenterline(centerline.points), centerline.widthM / 2, { start: centerline.startCap, end: centerline.endCap });
    if (!rings || rings.length === 0) return null;
    return rings.map(ring => ({ points: ring.map(([x, y]) => ({ x, y })) }));
}

/**
 * A centerline feature's full geometry: the cleaned centerline (distinct
 * points, `corner` only where set, the caps' known fields) and its derived
 * corridor rings. Null when the centerline is unusable.
 */
export function centerlineGeometry(crs: string, centerline: FeatureCenterline): CenterlineGeometry | null {
    const clean: FeatureCenterline = {
        points: distinctControls(centerline.points).map(p => (p.corner ? { x: p.x, y: p.y, corner: true } : { x: p.x, y: p.y })),
        widthM: centerline.widthM,
    };
    if (centerline.startCap) clean.startCap = cleanCap(centerline.startCap);
    if (centerline.endCap) clean.endCap = cleanCap(centerline.endCap);
    const rings = corridorRings(clean);
    if (!rings) return null;
    return { crs, curveType: 'bezier', rings, centerline: clean };
}
