// Union of drawn shapes: the Draw selection panel's "Union" and
// `bun run features:union`. Pure, EPSG:3006 meters in and out.
//
// The outlines are sampled, unioned with polygon-clipping (holes kept), and
// the result is built back from the shapes' OWN control points: each point
// where two outlines cross becomes a corner control, every control whose
// stretch of curve is still on the union's outline stays exactly as it was
// drawn, and the stretch next to a crossing (where a control's neighbour went
// inside the other shape) is fitted to the exact outline by least squares:
// a few new controls plus the kept controls closest to the crossing, which
// may move. So two bunkers drawn with 6 controls each become one bunker with
// about a dozen, not a fresh dense fit.
//
// Plain polygons (every point a corner, no handles) stay polygons: the exact
// union's vertices. A bezier shape with handles has no controls to keep: the
// union is fitted as a new smooth spline (`fitClosedBspline`), which is also
// the fallback when the kept-controls rebuild cannot meet the tolerance.
import polygonClipping from 'polygon-clipping';
import { flattenRing, type AnchorPoint, type FeatureGeometry, type PathRing, type Point } from '../geo/bezier';
import { expandBsplineControls } from '../geo/bspline';
import { fitClosedBspline } from '../geo/spline-fit';
import { MIN_RING_POINTS, rdpSimplifyClosed } from './draw-state';

/** Max distance from the result's curve to the exact union outline (meters). */
const UNION_FIT_TOLERANCE_M = 0.25;
/** Curve samples per spline segment for the union input. */
const SAMPLES_PER_SEGMENT = 16;
/** Flattening tolerance for bezier inputs (meters). */
const UNION_FLATTEN_TOLERANCE_M = 0.05;
/**
 * A smooth control closer than this (curve parameter, ~segments) to a
 * crossing shaped its curve together with a neighbour that is now inside the
 * other shape: it is dropped, and new controls take its place.
 */
const DROP_PARAM = 1;
/** Kept controls within this much further from a crossing are re-solved; the rest stay as drawn. */
const MOVABLE_PARAM = 0.5;
/** A rebuild further than this from the exact outline loses to the fallback fit (meters); the most a union strays. */
export const UNION_MAX_DEVIATION_M = 0.4;
/** New controls tried per crossing side beyond the input's own density. */
const MAX_EXTRA_CONTROLS = 3;
/** Solve-and-reproject rounds per try. */
const FIT_ROUNDS = 5;
/** Pull of a movable kept control toward where it was drawn, per outline sample. */
const MOVABLE_PRIOR = 0.05;
/** Pull of a new control toward its starting point (keeps the system well posed). */
const NEW_PRIOR = 1e-3;
/** Fallback fit: one control per this many metres of outline, clamped. */
const FIT_METERS_PER_CONTROL = 3;
const FIT_MIN_CONTROLS = 8;
const FIT_MAX_CONTROLS = 256;
/** Vertices of a polygon result closer to the line than this go (meters). */
const STRAIGHT_EPSILON_M = 0.02;

export type UnionResult =
    | { geometry: FeatureGeometry; maxDeviation: number }
    | { error: 'too-few' | 'centerline' | 'disjoint' | 'degenerate' };

/** Why a union was refused, as the one-line notice the UI and the CLI show. */
export const UNION_ERRORS: Record<Exclude<UnionResult, { geometry: FeatureGeometry }>['error'], string> = {
    'too-few': 'Select two or more shapes to union.',
    centerline: 'Roads and paths cannot be unioned (they are a centerline).',
    disjoint: 'The shapes do not overlap or touch.',
    degenerate: 'The union has no area.',
};

type XY = [number, number];
/** Where an outline sample came from: input ring `curve` at spline parameter `param`. */
type Tag = { curve: number; param: number };

/** A plain polygon: no curve handles, every spline control a corner. */
function isStraight(geometry: FeatureGeometry): boolean {
    return geometry.rings.every(r => r.points.every(p =>
        geometry.curveType === 'bspline' ? p.corner === true : !p.hIn && !p.hOut));
}

function hasHandles(geometry: FeatureGeometry): boolean {
    return geometry.curveType !== 'bspline' && geometry.rings.some(r => r.points.some(p => p.hIn || p.hOut));
}

/** The ring as spline controls: a bspline as drawn, a polygon as corner controls. */
function splineControls(geometry: FeatureGeometry, ring: PathRing): AnchorPoint[] {
    return geometry.curveType === 'bspline' ? ring.points : ring.points.map(p => ({ x: p.x, y: p.y, corner: true }));
}

/** Uniform cubic B-spline basis at u in [0, 1). */
function basis(u: number): [number, number, number, number] {
    const u2 = u * u;
    const u3 = u2 * u;
    return [(1 - u) ** 3 / 6, (3 * u3 - 6 * u2 + 4) / 6, (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, u3 / 6];
}

/** First and second derivatives of the basis at u. */
function basisDerivatives(u: number): [[number, number, number, number], [number, number, number, number]] {
    return [
        [-((1 - u) ** 2) / 2, (3 * u * u - 4 * u) / 2, (-3 * u * u + 2 * u + 1) / 2, (u * u) / 2],
        [1 - u, 3 * u - 2, 1 - 3 * u, u],
    ];
}

const mod = (i: number, n: number) => ((i % n) + n) % n;

/** Point on the closed spline of expanded controls `e` at parameter t (segment floor(t)). */
function curveAt(e: Point[], t: number): Point {
    const s = Math.floor(t);
    const b = basis(t - s);
    let x = 0;
    let y = 0;
    for (let k = 0; k < 4; k++) {
        const p = e[mod(s + k, e.length)];
        x += b[k] * p.x;
        y += b[k] * p.y;
    }
    return { x, y };
}

/** The parameter in [lo, hi] nearest to q, refined from `t` by Newton steps on the distance. */
function footPoint(e: Point[], t: number, qx: number, qy: number, lo: number, hi: number): number {
    for (let iter = 0; iter < 5; iter++) {
        const s = Math.floor(t);
        const u = t - s;
        const b = basis(u);
        const [d1, d2] = basisDerivatives(u);
        let cx = 0, cy = 0, dx = 0, dy = 0, ex = 0, ey = 0;
        for (let k = 0; k < 4; k++) {
            const p = e[mod(s + k, e.length)];
            cx += b[k] * p.x; cy += b[k] * p.y;
            dx += d1[k] * p.x; dy += d1[k] * p.y;
            ex += d2[k] * p.x; ey += d2[k] * p.y;
        }
        const g = (cx - qx) * dx + (cy - qy) * dy;
        const h = dx * dx + dy * dy + (cx - qx) * ex + (cy - qy) * ey;
        if (h <= 1e-12) break;
        const next = Math.max(lo, Math.min(hi, t - g / h));
        if (Math.abs(next - t) < 1e-7) return next;
        t = next;
    }
    return t;
}

/** One input ring sampled along its spline, with where each original control sits on it. */
interface SampledCurve {
    /** Expanded control count = the curve's parameter range [0, n). */
    n: number;
    samples: XY[];
    params: number[];
    controls: Array<{ point: AnchorPoint; param: number }>;
}

function sampleCurve(points: AnchorPoint[]): SampledCurve {
    const { ctrl } = expandBsplineControls(points);
    const n = ctrl.length;
    const samples: XY[] = [];
    const params: number[] = [];
    for (let s = 0; s < n; s++) {
        for (let j = 0; j < SAMPLES_PER_SEGMENT; j++) {
            const t = s + j / SAMPLES_PER_SEGMENT;
            const p = curveAt(ctrl, t);
            const last = samples[samples.length - 1];
            if (last && Math.hypot(last[0] - p.x, last[1] - p.y) < 1e-9) continue; // a corner's repeated windows
            samples.push([p.x, p.y]);
            params.push(t);
        }
    }
    // Segment s starts next to expanded control s+1, so a control sits at the
    // parameter one before its (middle) expanded copy.
    const controls: SampledCurve['controls'] = [];
    let e = 0;
    for (const point of points) {
        controls.push({ point, param: mod((point.corner ? e + 1 : e) - 1, n) });
        e += point.corner ? 3 : 1;
    }
    return { n, samples, params, controls };
}

const keyOf = (x: number, y: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;

/** Distance from p to a closed polyline. */
function distanceToRing(p: Point, ring: XY[]): number {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy));
    }
    return best;
}

/** Max distance from the spline of `controls` to the exact outline. */
function deviationOf(controls: AnchorPoint[], exact: XY[]): number {
    const flat = flattenRing({ points: controls }, 0.02, 'bspline');
    let max = 0;
    for (const [x, y] of flat) max = Math.max(max, distanceToRing({ x, y }, exact));
    return max;
}

/**
 * Solve the symmetric positive definite system A x = b whose nonzeros lie
 * within `band` of the diagonal (Gaussian elimination inside the band).
 */
function solveBanded(a: Float64Array, b: Float64Array, m: number, band: number): Float64Array | null {
    for (let c = 0; c < m; c++) {
        const pivot = a[c * m + c];
        if (!(Math.abs(pivot) > 1e-12)) return null;
        for (let r = c + 1; r <= Math.min(m - 1, c + band); r++) {
            const f = a[r * m + c] / pivot;
            if (f === 0) continue;
            for (let k = c; k <= Math.min(m - 1, c + band); k++) a[r * m + k] -= f * a[c * m + k];
            b[r] -= f * b[c];
        }
    }
    const x = new Float64Array(m);
    for (let r = m - 1; r >= 0; r--) {
        let sum = b[r];
        for (let k = r + 1; k <= Math.min(m - 1, r + band); k++) sum -= a[r * m + k] * x[k];
        x[r] = sum / a[r * m + r];
    }
    return x;
}

/** One stretch of the union's outline that follows a single input ring, between two crossings. */
interface Run {
    curve: number;
    /** Outline indices and the input's parameter at each, unwrapped, increasing or decreasing. */
    indices: number[];
    taus: number[];
    /** The input's controls on this stretch, by distance from its start (input parameter). */
    kept: Array<{ point: AnchorPoint; tau: number; movable: boolean }>;
    /** Input parameter from the start crossing to the first kept control, and from the last to the end crossing. */
    headSpan: number;
    tailSpan: number;
}

/**
 * One union ring rebuilt from the inputs' own controls (see the file
 * comment), or null when the ring cannot be traced back to them.
 */
function rebuildRing(exact: XY[], curves: SampledCurve[], lookup: Map<string, Tag>):
    { points: AnchorPoint[]; deviation: number } | null {
    const tags = exact.map(([x, y]) => lookup.get(keyOf(x, y)));
    const count = exact.length;
    const start = tags.findIndex((tag, i) => !tag || tags[mod(i - 1, count)]?.curve !== tag.curve);
    if (start < 0) {
        // One input ring is the whole outline (the others lie inside it).
        return { points: curves[tags[0]!.curve].controls.map(c => ({ ...c.point })), deviation: 0 };
    }

    // Walk the outline from a crossing: crossings[i] starts runs[i].
    const crossings: number[] = [];
    const runs: Run[] = [];
    for (let i = 0; i < count; i++) {
        const index = mod(start + i, count);
        const tag = tags[index];
        const last = runs[runs.length - 1];
        // Several unmatched vertices in a row are one crossing.
        if (!tag && last && last.taus.length === 0) continue;
        if (!tag || !last || (last.taus.length > 0 && last.curve !== tag.curve)) {
            crossings.push(index);
            runs.push({ curve: tag?.curve ?? -1, indices: [], taus: [], kept: [], headSpan: 0, tailSpan: 0 });
            if (!tag) continue;
        }
        const run = runs[runs.length - 1];
        const n = curves[tag.curve].n;
        let tau = tag.param;
        if (run.taus.length > 0) {
            const previous = run.taus[run.taus.length - 1];
            let d = mod(tau - previous, n);
            if (d > n / 2) d -= n;
            tau = previous + d;
        }
        run.curve = tag.curve;
        run.indices.push(index);
        run.taus.push(tau);
    }
    for (const run of runs) {
        if (run.taus.length < 2) continue;
        const { n, controls } = curves[run.curve];
        const t0 = run.taus[0];
        const dir = Math.sign(run.taus[run.taus.length - 1] - t0) || 1; // the union may run against the input
        const span = Math.abs(run.taus[run.taus.length - 1] - t0);
        const kept = controls
            .map(c => {
                const offset = mod(dir * (c.param - t0), n);
                return { point: c.point, tau: t0 + dir * offset, offset, near: Math.min(offset, span - offset) };
            })
            .filter(c => c.offset > 0 && c.offset < span && (c.point.corner || c.near >= DROP_PARAM))
            .sort((a, b) => a.offset - b.offset);
        run.kept = kept.map(c => ({ point: c.point, tau: c.tau, movable: !c.point.corner && c.near < DROP_PARAM + MOVABLE_PARAM }));
        run.headSpan = kept.length > 0 ? kept[0].offset : span;
        run.tailSpan = kept.length > 0 ? span - kept[kept.length - 1].offset : 0;
    }

    let best: { points: AnchorPoint[]; deviation: number } | null = null;
    for (let extra = 0; extra <= MAX_EXTRA_CONTROLS; extra++) {
        const points = fitAround(exact, crossings, runs, extra);
        if (!points) break;
        const deviation = deviationOf(points, exact);
        if (!best || deviation < best.deviation) best = { points, deviation };
        if (deviation <= UNION_FIT_TOLERANCE_M) break;
    }
    return best;
}

/** New controls for a stretch of `span` input segments next to a crossing (whose corner spends two). */
const newControlsFor = (span: number, extra: number) => Math.max(1, Math.round(span) - 2) + extra;

/**
 * The ring's controls: crossings as fixed corners, kept controls (fixed, or
 * movable near a crossing), and new controls in each stretch next to a
 * crossing; the movable and new ones solved by least squares against the
 * exact outline, all at once. Every outline sample starts at the spline
 * parameter its input parameter maps to (piecewise linear through the kept
 * controls, which sit at the same place on both curves), then moves to its
 * foot on the fitted curve between solves: a crossing's corner makes the
 * curve linger at it, which the mapping alone cannot know.
 */
function fitAround(exact: XY[], crossings: number[], runs: Run[], extra: number): AnchorPoint[] | null {
    type Slot = { point: AnchorPoint; free: boolean; prior: number; tau?: number };
    const slots: Slot[] = [];
    const runSlots: Array<{ crossing: number; inner: number[]; end: number }> = [];
    runs.forEach((run, r) => {
        const crossing = slots.length;
        const [cx, cy] = exact[crossings[r]];
        slots.push({ point: { x: cx, y: cy, corner: true }, free: false, prior: 0 });
        const inner: number[] = [];
        if (run.taus.length < 2) { runSlots.push({ crossing, inner, end: -1 }); return; }
        // New controls start on the outline, evenly in input parameter.
        const addNew = (fromTau: number, toTau: number, k: number) => {
            for (let j = 1; j <= k; j++) {
                const tau = fromTau + ((toTau - fromTau) * j) / (k + 1);
                const at = run.taus.findIndex(t => (t - tau) * Math.sign(toTau - fromTau) >= 0);
                const [x, y] = exact[run.indices[at < 0 ? run.indices.length - 1 : at]];
                inner.push(slots.length);
                slots.push({ point: { x, y }, free: true, prior: NEW_PRIOR, tau });
            }
        };
        const first = run.taus[0];
        const last = run.taus[run.taus.length - 1];
        if (run.kept.length === 0) {
            addNew(first, last, newControlsFor(run.headSpan, extra));
        } else {
            addNew(first, run.kept[0].tau, newControlsFor(run.headSpan, extra));
            for (const c of run.kept) {
                inner.push(slots.length);
                slots.push({ point: { ...c.point }, free: c.movable, prior: MOVABLE_PRIOR, tau: c.tau });
            }
            addNew(run.kept[run.kept.length - 1].tau, last, newControlsFor(run.tailSpan, extra));
        }
        runSlots.push({ crossing, inner, end: -1 });
    });
    runSlots.forEach((rs, r) => { rs.end = runSlots[(r + 1) % runSlots.length].crossing; });

    // Spline parameter of each slot: one before its middle expanded copy.
    const points = slots.map(s => s.point);
    const { ctrl, origIdx } = expandBsplineControls(points);
    const total = ctrl.length;
    const paramOf: number[] = [];
    for (let e = 0; e < total; e++) {
        const o = origIdx[e];
        if (paramOf[o] === undefined) paramOf[o] = e - 1 + (points[o].corner ? 1 : 0);
    }

    // Outline samples with their starting parameter, per run.
    const data: Array<{ q: XY; t: number; lo: number; hi: number }> = [];
    runs.forEach((run, r) => {
        if (run.taus.length < 2) return;
        const { crossing, inner, end } = runSlots[r];
        const startT = paramOf[crossing];
        let endT = paramOf[end];
        while (endT <= startT) endT += total;
        const knots: Array<[number, number]> = [[run.taus[0], startT]];
        for (const o of inner) {
            const s = slots[o];
            if (s.prior === MOVABLE_PRIOR || !s.free) {
                let t = paramOf[o];
                while (t <= startT) t += total;
                knots.push([s.tau!, t]);
            }
        }
        knots.push([run.taus[run.taus.length - 1], endT]);
        const dir = Math.sign(run.taus[run.taus.length - 1] - run.taus[0]) || 1;
        run.taus.forEach((tau, i) => {
            let k = 1;
            while (k < knots.length - 1 && (tau - knots[k][0]) * dir > 0) k++;
            const [ta, a] = knots[k - 1];
            const [tb, b] = knots[k];
            const t = tb === ta ? a : a + ((tau - ta) / (tb - ta)) * (b - a);
            data.push({ q: exact[run.indices[i]], t: Math.min(endT - 1e-9, Math.max(startT, t)), lo: startT, hi: endT - 1e-9 });
        });
    });

    // Unknowns in ring order. The crossings' triple corners split the ring
    // into independent stretches, so the normal matrix is banded.
    const unknown = new Map<number, number>();
    slots.forEach((s, o) => { if (s.free) unknown.set(o, unknown.size); });
    const m = unknown.size;
    if (m === 0) return points;
    for (let round = 0; round < FIT_ROUNDS; round++) {
        const ata = new Float64Array(m * m);
        const bx = new Float64Array(m);
        const by = new Float64Array(m);
        for (const { q: [qx, qy], t } of data) {
            const s = Math.floor(t);
            const b = basis(t - s);
            const cols: number[] = [];
            const coefs: number[] = [];
            let fx = 0;
            let fy = 0;
            for (let k = 0; k < 4; k++) {
                const e = mod(s + k, total);
                const j = unknown.get(origIdx[e]);
                if (j === undefined) { fx += b[k] * ctrl[e].x; fy += b[k] * ctrl[e].y; continue; }
                const at = cols.indexOf(j);
                if (at >= 0) coefs[at] += b[k];
                else { cols.push(j); coefs.push(b[k]); }
            }
            for (let a = 0; a < cols.length; a++) {
                for (let c = 0; c < cols.length; c++) ata[cols[a] * m + cols[c]] += coefs[a] * coefs[c];
                bx[cols[a]] += coefs[a] * (qx - fx);
                by[cols[a]] += coefs[a] * (qy - fy);
            }
        }
        for (const [o, j] of unknown) {
            const s = slots[o];
            ata[j * m + j] += s.prior;
            bx[j] += s.prior * s.point.x;
            by[j] += s.prior * s.point.y;
        }
        const xs = solveBanded(ata.slice(), bx, m, 3);
        const ys = solveBanded(ata, by, m, 3);
        if (!xs || !ys) return null;
        for (const [o, j] of unknown) points[o] = { x: xs[j], y: ys[j] };
        for (let e = 0; e < total; e++) {
            const j = unknown.get(origIdx[e]);
            if (j !== undefined) ctrl[e] = { x: xs[j], y: ys[j] };
        }
        for (const d of data) d.t = footPoint(ctrl, d.t, d.q[0], d.q[1], Math.max(d.lo, d.t - 1.5), Math.min(d.hi, d.t + 1.5));
    }
    return points;
}

function perimeterOf(points: Array<{ x: number; y: number }>): number {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return sum;
}

/** A fresh smooth spline through the exact outline (bezier inputs, and the fallback). */
function fitRing(exact: XY[]): { points: AnchorPoint[]; deviation: number } | null {
    const pts = exact.map(([x, y]) => ({ x, y }));
    const cap = Math.min(FIT_MAX_CONTROLS,
        Math.max(FIT_MIN_CONTROLS, Math.round(perimeterOf(pts) / FIT_METERS_PER_CONTROL)));
    const fit = fitClosedBspline(pts, UNION_FIT_TOLERANCE_M, cap, { curvatureShare: 0.5 });
    const usable = fit.controls.length >= MIN_RING_POINTS
        && fit.controls.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    return usable ? { points: fit.controls.map(p => ({ x: p.x, y: p.y })), deviation: fit.maxDeviation } : null;
}

/** polygon-clipping ring → open ring (no closing vertex). */
function openRing(ring: XY[]): XY[] {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

/**
 * The union of two or more shape outlines as ONE geometry (holes kept).
 * Refused when a shape is a road/path centerline, when the shapes do not
 * overlap or touch (the union would be several shapes), or when nothing
 * with area is left.
 */
export function unionShapes(geometries: FeatureGeometry[]): UnionResult {
    if (geometries.length < 2) return { error: 'too-few' };
    if (geometries.some(g => g.centerline)) return { error: 'centerline' };
    const straight = geometries.every(isStraight);
    const fitted = geometries.some(hasHandles);

    const curves: SampledCurve[] = [];
    const lookup = new Map<string, Tag>();
    const inputs: XY[][][] = [];
    for (const g of geometries) {
        if (g.rings.length === 0) continue;
        const polygon: XY[][] = [];
        for (const ring of g.rings) {
            let outline: XY[];
            if (straight || fitted) {
                outline = flattenRing(ring, UNION_FLATTEN_TOLERANCE_M, g.curveType) as XY[];
            } else {
                const curve = sampleCurve(splineControls(g, ring));
                const index = curves.length;
                curves.push(curve);
                curve.samples.forEach(([x, y], i) => lookup.set(keyOf(x, y), { curve: index, param: curve.params[i] }));
                outline = curve.samples;
            }
            if (outline.length >= MIN_RING_POINTS) polygon.push(outline);
            else if (polygon.length === 0) break; // a degenerate outline: the shape adds nothing
        }
        if (polygon.length > 0) inputs.push(polygon);
    }
    if (inputs.length === 0) return { error: 'degenerate' };
    const unioned = polygonClipping.union(inputs[0], ...inputs.slice(1));
    if (unioned.length === 0) return { error: 'degenerate' };
    if (unioned.length > 1) return { error: 'disjoint' };

    const rings: PathRing[] = [];
    let maxDeviation = 0;
    for (let i = 0; i < unioned[0].length; i++) {
        const exact = openRing(unioned[0][i] as XY[]);
        let ring: { points: AnchorPoint[]; deviation: number } | null = null;
        if (exact.length >= MIN_RING_POINTS) {
            if (straight) {
                const kept = rdpSimplifyClosed(exact.map(([x, y]) => ({ x, y })), STRAIGHT_EPSILON_M);
                ring = kept.length >= MIN_RING_POINTS ? { points: kept, deviation: 0 } : null;
            } else {
                const rebuilt = fitted ? null : rebuildRing(exact, curves, lookup);
                ring = rebuilt && rebuilt.deviation <= UNION_MAX_DEVIATION_M ? rebuilt : fitRing(exact) ?? rebuilt;
            }
        }
        if (!ring) {
            if (i === 0) return { error: 'degenerate' };
            continue; // a sliver hole
        }
        rings.push({ points: ring.points });
        maxDeviation = Math.max(maxDeviation, ring.deviation);
    }
    const geometry: FeatureGeometry = { crs: geometries[0].crs, rings };
    if (!straight) geometry.curveType = 'bspline';
    return { geometry, maxDeviation };
}
