// Least-squares fitting of a CLOSED uniform cubic B-spline to a freehand
// stroke (T40) — the pure core of the press-drag trace in the draw tool,
// reused by the SAM click-to-feature assist on raster-mask contours (T45).
//
// EPSG:3006 meters in, EPSG:3006 meters out. No corner detection in v1:
// every returned control point is smooth.
//
// Model: the repo's closed uniform cubic B-spline (geo/bspline.ts) — m
// control points make m curve segments; segment j spans the control window
// (P_j, P_{j+1}, P_{j+2}, P_{j+3}) mod m with the standard 1/6 basis, so
// C_j(0) = (P_j + 4·P_{j+1} + P_{j+2}) / 6. A ring of the returned controls
// with `curveType: 'bspline'` therefore flattens (flattenRing) to exactly
// the curve this module measured its deviation against.
//
// Method: the stroke is deduped and pre-simplified (RDP at toleranceM/2 —
// the solve only needs shape-defining samples), chord-length parameterised
// around the CLOSED ring onto the domain [0, m), densified so every basis
// window has sample support, and solved via the normal equations (one
// small dense Gaussian solve per axis, coordinates centered on the
// centroid for conditioning — EPSG:3006 northings are ~7 digits). The
// control count adapts: 8 → 12 → 16 → 20, stepping up until the max
// distance from the ORIGINAL stroke samples to the fitted curve is within
// tolerance (capped at 20 — the best fit so far is returned regardless).

import { flattenRing, type Point } from './bezier';
import { rdpSimplify } from '../draw/draw-state';

export interface ClosedBsplineFit {
    /**
     * Closed control ring (no duplicate endpoint — the spline wraps modulo
     * n), all smooth. Fewer than 3 controls means the stroke was degenerate
     * (under 3 distinct points) and callers should discard the fit.
     */
    controls: Point[];
    /** Max distance (meters) from the stroke samples to the fitted curve. */
    maxDeviation: number;
}

/** Adaptive control-count ladder (start low, step up until within tolerance). */
const CONTROL_COUNTS = [8, 12, 16, 20] as const;

/** Consecutive stroke samples closer than this (m) collapse into one. */
const DEDUPE_EPS_M = 1e-9;

/**
 * Fit a closed uniform cubic B-spline to a freehand stroke by least
 * squares. The stroke is an OPEN sample sequence of a closed shape: the
 * gap between its last and first samples is closed with a straight chord
 * (a partial trace completes itself smoothly). Degenerate strokes (< 3
 * distinct points) return the points as-is with deviation 0 — callers
 * discard fits with fewer than 3 controls.
 */
export function fitClosedBspline(stroke: Point[], toleranceM: number): ClosedBsplineFit {
    const pts = dedupeClosed(stroke);
    if (pts.length < 3) {
        return { controls: pts.map(p => ({ x: p.x, y: p.y })), maxDeviation: 0 };
    }

    // Pre-simplify for the SOLVE only — deviation is still measured against
    // every original sample. RDP is endpoint-anchored, which is harmless
    // here (it only pins the stroke's own start/end as kept samples).
    const simplified = rdpSimplify(pts, toleranceM / 2);
    const ring = simplified.length >= 3 ? simplified : pts;

    let best: ClosedBsplineFit | null = null;
    for (const m of CONTROL_COUNTS) {
        const controls = solveControls(ring, m);
        const maxDeviation = maxStrokeDeviation(pts, controls, toleranceM);
        if (!best || maxDeviation < best.maxDeviation) best = { controls, maxDeviation };
        if (maxDeviation <= toleranceM) break;
    }
    return best!;
}

/** Drop consecutive (near-)duplicates and an explicit closing duplicate. */
function dedupeClosed(stroke: Point[]): Point[] {
    const out: Point[] = [];
    for (const p of stroke) {
        const last = out[out.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < DEDUPE_EPS_M) continue;
        out.push(p);
    }
    if (out.length >= 2) {
        const first = out[0];
        const last = out[out.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < DEDUPE_EPS_M) out.pop();
    }
    return out;
}

/**
 * Least-squares solve for m closed-B-spline controls approximating the
 * closed polyline `ring`. Samples are chord-length parameterised over
 * [0, m) and long edges (including the closing edge) are densified to at
 * most half a segment's arc length, so every control's basis window has
 * sample support and the normal equations stay well-conditioned.
 */
function solveControls(ring: Point[], m: number): Point[] {
    const n = ring.length;
    const edges: number[] = [];
    let perimeter = 0;
    for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        edges.push(len);
        perimeter += len;
    }

    // Linear samples along the ring: each edge contributes its start point
    // plus enough interpolated points to keep spacing ≤ perimeter / (2m).
    const maxSpacing = perimeter / (2 * m);
    const su: number[] = [];
    const sx: number[] = [];
    const sy: number[] = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const pieces = Math.max(1, Math.ceil(edges[i] / maxSpacing));
        for (let s = 0; s < pieces; s++) {
            const t = s / pieces;
            su.push(((acc + edges[i] * t) / perimeter) * m);
            sx.push(a.x + (b.x - a.x) * t);
            sy.push(a.y + (b.y - a.y) * t);
        }
        acc += edges[i];
    }

    // Center coordinates on the centroid: EPSG:3006 magnitudes (~1e5/1e6 m)
    // would otherwise dominate the normal equations' conditioning.
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < sx.length; i++) {
        cx += sx[i];
        cy += sy[i];
    }
    cx /= sx.length;
    cy /= sy.length;

    // Accumulate the normal equations N·P = r (4 basis nonzeros per sample).
    const N = Array.from({ length: m }, () => new Float64Array(m));
    const rx = new Float64Array(m);
    const ry = new Float64Array(m);
    for (let i = 0; i < su.length; i++) {
        const u = su[i];
        let j = Math.floor(u);
        if (j >= m) j = m - 1; // guard u === m (excluded by construction)
        const w = basis(u - j);
        for (let a = 0; a < 4; a++) {
            const ia = (j + a) % m;
            rx[ia] += w[a] * (sx[i] - cx);
            ry[ia] += w[a] * (sy[i] - cy);
            const row = N[ia];
            for (let b = 0; b < 4; b++) row[(j + b) % m] += w[a] * w[b];
        }
    }
    // Tiny ridge: guards rank deficiency on pathological strokes. Bias pulls
    // toward the centroid by ~1e-9 relative — far below any tolerance.
    for (let d = 0; d < m; d++) N[d][d] += 1e-9;

    const { x, y } = solveNormal(N, rx, ry);
    return Array.from({ length: m }, (_, i) => ({ x: x[i] + cx, y: y[i] + cy }));
}

/** Uniform cubic B-spline basis weights for local parameter t ∈ [0, 1). */
function basis(t: number): [number, number, number, number] {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
        (1 - 3 * t + 3 * t2 - t3) / 6,
        (4 - 6 * t2 + 3 * t3) / 6,
        (1 + 3 * t + 3 * t2 - 3 * t3) / 6,
        t3 / 6,
    ];
}

/**
 * Gaussian elimination with partial pivoting for the (symmetric positive
 * semi-definite + ridge) normal matrix, solving both axes at once. m ≤ 20,
 * so a dense solve is microseconds.
 */
function solveNormal(
    N: Float64Array[],
    rx: Float64Array,
    ry: Float64Array,
): { x: Float64Array; y: Float64Array } {
    const m = N.length;
    const A = N.map((row, i) => {
        const r = new Float64Array(m + 2);
        r.set(row);
        r[m] = rx[i];
        r[m + 1] = ry[i];
        return r;
    });
    for (let col = 0; col < m; col++) {
        let piv = col;
        for (let r = col + 1; r < m; r++) {
            if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        }
        if (piv !== col) {
            const tmp = A[col];
            A[col] = A[piv];
            A[piv] = tmp;
        }
        const d = A[col][col];
        for (let r = col + 1; r < m; r++) {
            const f = A[r][col] / d;
            if (f === 0) continue;
            for (let c = col; c < m + 2; c++) A[r][c] -= f * A[col][c];
        }
    }
    const x = new Float64Array(m);
    const y = new Float64Array(m);
    for (let r = m - 1; r >= 0; r--) {
        let ax = A[r][m];
        let ay = A[r][m + 1];
        for (let c = r + 1; c < m; c++) {
            ax -= A[r][c] * x[c];
            ay -= A[r][c] * y[c];
        }
        x[r] = ax / A[r][r];
        y[r] = ay / A[r][r];
    }
    return { x, y };
}

/**
 * Max distance from the stroke samples to the fitted closed spline,
 * flattened via the shared flattenRing on a `curveType: 'bspline'` ring.
 * Point-to-SEGMENT distances keep the residual chordal error second-order,
 * so the flatten tolerance only needs to be comfortably below toleranceM.
 */
function maxStrokeDeviation(pts: Point[], controls: Point[], toleranceM: number): number {
    const flat = flattenRing(
        { points: controls.map(p => ({ x: p.x, y: p.y })) },
        Math.max(0.02, toleranceM / 8),
        'bspline',
    );
    let worst = 0;
    for (const p of pts) {
        const d = distToClosedPolyline(p, flat);
        if (d > worst) worst = d;
    }
    return worst;
}

/** Min distance from `p` to an implicitly closed polyline (per segment). */
function distToClosedPolyline(p: Point, poly: Array<[number, number]>): number {
    let best = Infinity;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % n];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const d = Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
        if (d < best) best = d;
    }
    return best;
}
