// Pure draw-tool state + geometry edit operations. No map, no DOM, no
// network — everything here is unit-testable logic. DrawToolService wires
// these to actual map events.

import { Signal, Computed } from '@basics/core/client/core';
import { ringBbox, splitSegment, type AnchorPoint, type Bbox, type FeatureGeometry, type PathRing, type Point } from '../geo/bezier';
import { bsplineRingToBezier } from '../geo/bspline';

/**
 * 'select' — clicks select/deselect features; a selected feature's
 *            vertices are editable.
 * 'draw'   — clicks place anchor points of a new polygon draft.
 */
export type DrawMode = 'select' | 'draw';

/** Minimum anchors for a closeable ring (matches server validation). */
export const MIN_RING_POINTS = 3;

/**
 * The drawing state machine: mode + the in-progress polygon draft (anchor
 * points in EPSG:3006 meters). Selection state lives in FeaturesService.
 */
export class DrawState {
    readonly mode = new Signal<DrawMode>('select');
    readonly draft = new Signal<AnchorPoint[]>([]);

    /**
     * Box-select mode (sticky sub-mode of 'select'). While on, a left-drag
     * rubber-bands features even when it STARTS on top of a shape — which
     * would otherwise move it (or, on the selected feature, edit a vertex).
     * Whole-feature move and vertex editing are suspended for the mode's
     * span; plain clicks still select. Toggled by the panel button / 'B';
     * Space-held is the momentary equivalent (see DrawToolService).
     */
    readonly boxSelect = new Signal(false);

    readonly canClose = new Computed(() => this.draft.get().length >= MIN_RING_POINTS);
    readonly isDrawing = new Computed(() => this.mode.get() === 'draw');

    /**
     * Ephemeral redo stack for mid-draw point undo (Cmd/Ctrl+Z while
     * placing points). Completely separate from the committed-edit history:
     * it only exists while a draft is being drawn.
     */
    private redoPoints: AnchorPoint[] = [];

    /** Arm polygon drawing (clears any previous draft). */
    arm(): void {
        this.draft.set([]);
        this.redoPoints = [];
        this.boxSelect.set(false); // drawing and box-select are exclusive
        this.mode.set('draw');
    }

    /** Toggle sticky box-select mode (leaves draw mode first if drawing). */
    toggleBoxSelect(): void {
        if (this.mode.peek() === 'draw') this.disarm();
        this.boxSelect.update(v => !v);
    }

    /** Leave drawing mode, dropping the draft. */
    disarm(): void {
        this.draft.set([]);
        this.redoPoints = [];
        this.mode.set('select');
    }

    /**
     * Append a draft control point (drawing mode only). New features are
     * b-splines: `corner` (Shift+click) marks the point as a sharp corner.
     */
    addPoint(p: Point, corner = false): void {
        if (this.mode.peek() !== 'draw') return;
        this.redoPoints = [];
        this.draft.update(points => [...points, { x: p.x, y: p.y, ...(corner ? { corner: true } : {}) }]);
    }

    /** Drop the last draft anchor. */
    popPoint(): void {
        this.draft.update(points => points.slice(0, -1));
    }

    /**
     * Double-click is deliberately not a close gesture while drawing: it is
     * too easy to trigger accidentally during rapid point placement. Browser
     * dblclick dispatch includes two click events, though, so discard the
     * duplicate point those clicks leave behind and keep the draft open.
     */
    discardDoubleClickDuplicate(): boolean {
        if (this.mode.peek() !== 'draw') return false;
        const points = this.draft.peek();
        if (points.length <= 1) return false;
        this.redoPoints = [];
        this.draft.set(points.slice(0, -1));
        return true;
    }

    /**
     * Mid-draw point undo (Cmd/Ctrl+Z while drawing): removes the last
     * placed point onto the redo stack. Undoing the FIRST point cancels
     * the draw entirely (returns 'cancelled'). Returns null when not
     * drawing or nothing to undo.
     */
    undoPoint(): 'point' | 'cancelled' | null {
        if (this.mode.peek() !== 'draw') return null;
        const points = this.draft.peek();
        if (points.length === 0) return null;
        if (points.length === 1) {
            this.disarm();
            return 'cancelled';
        }
        this.redoPoints.push(points[points.length - 1]);
        this.draft.set(points.slice(0, -1));
        return 'point';
    }

    /** Mid-draw point redo (Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y while drawing). */
    redoPoint(): boolean {
        if (this.mode.peek() !== 'draw') return false;
        const p = this.redoPoints.pop();
        if (!p) return false;
        this.draft.update(points => [...points, p]);
        return true;
    }

    /**
     * Close the draft into a ring and return it (null when below the
     * 3-anchor minimum). Sticky chain-draw: on success the draft and the
     * mid-draw redo stack are cleared but drawing mode is RETAINED, so the
     * next click starts the next shape of the same type. Exits (Esc / 'B' /
     * deactivate) all route through `disarm`.
     */
    closeDraft(): { points: AnchorPoint[] } | null {
        const points = this.draft.peek();
        if (points.length < MIN_RING_POINTS) return null;
        this.draft.set([]);
        this.redoPoints = [];
        return { points };
    }

    /**
     * ESC while the draw tool is active. Returns true when consumed:
     * a non-empty draft is cancelled (stay armed → false: drop draft AND
     * disarm in one step keeps ESC semantics simple), drawing mode is
     * disarmed, otherwise not consumed (caller may deselect/deactivate).
     */
    handleEscape(): boolean {
        if (this.mode.peek() === 'draw') {
            this.disarm();
            return true;
        }
        return false;
    }
}

// ─── Pure geometry edit operations ────────────────────────────────────────
//
// All operations return a NEW FeatureGeometry (identity change drives the
// flatten caches + signals); inputs are never mutated. Ring/anchor indices
// are trusted to be valid (callers derive them from hit tests).

function cloneGeometry(geometry: FeatureGeometry): FeatureGeometry {
    return {
        crs: geometry.crs,
        ...(geometry.curveType ? { curveType: geometry.curveType } : {}),
        rings: geometry.rings.map(ring => ({
            points: ring.points.map(p => ({
                x: p.x,
                y: p.y,
                ...(p.hIn ? { hIn: { ...p.hIn } } : {}),
                ...(p.hOut ? { hOut: { ...p.hOut } } : {}),
                ...(p.corner ? { corner: true } : {}),
            })),
        })),
    };
}

/** Move an anchor to `to`, translating its handles with it. */
export function moveAnchor(
    geometry: FeatureGeometry,
    ringIdx: number,
    idx: number,
    to: Point,
): FeatureGeometry {
    const next = cloneGeometry(geometry);
    const p = next.rings[ringIdx].points[idx];
    const dx = to.x - p.x;
    const dy = to.y - p.y;
    p.x = to.x;
    p.y = to.y;
    if (p.hIn) p.hIn = { x: p.hIn.x + dx, y: p.hIn.y + dy };
    if (p.hOut) p.hOut = { x: p.hOut.x + dx, y: p.hOut.y + dy };
    return next;
}

/**
 * Move one bezier handle. With `symmetric` (default), the opposite handle
 * mirrors through the anchor (equal length, opposite direction).
 */
export function moveHandle(
    geometry: FeatureGeometry,
    ringIdx: number,
    idx: number,
    which: 'hIn' | 'hOut',
    to: Point,
    symmetric = true,
): FeatureGeometry {
    const next = cloneGeometry(geometry);
    const p = next.rings[ringIdx].points[idx];
    p[which] = { x: to.x, y: to.y };
    if (symmetric) {
        const other = which === 'hIn' ? 'hOut' : 'hIn';
        p[other] = { x: 2 * p.x - to.x, y: 2 * p.y - to.y };
    }
    return next;
}

/**
 * Pull out symmetric handles on an anchor (alt-drag): hOut follows the
 * cursor, hIn mirrors it through the anchor.
 */
export function setSymmetricHandles(
    geometry: FeatureGeometry,
    ringIdx: number,
    idx: number,
    hOut: Point,
): FeatureGeometry {
    const next = cloneGeometry(geometry);
    const p = next.rings[ringIdx].points[idx];
    p.hOut = { x: hOut.x, y: hOut.y };
    p.hIn = { x: 2 * p.x - hOut.x, y: 2 * p.y - hOut.y };
    return next;
}

/** Remove an anchor's bezier handles (its segments become straight). */
export function clearHandles(geometry: FeatureGeometry, ringIdx: number, idx: number): FeatureGeometry {
    const next = cloneGeometry(geometry);
    const p = next.rings[ringIdx].points[idx];
    delete p.hIn;
    delete p.hOut;
    return next;
}

/** True when the anchor has at least one bezier handle. */
export function hasHandles(p: AnchorPoint): boolean {
    return !!(p.hIn || p.hOut);
}

/**
 * Delete an anchor. Returns null when the ring would fall below the
 * 3-anchor minimum (the server rejects such rings).
 */
export function deleteAnchor(
    geometry: FeatureGeometry,
    ringIdx: number,
    idx: number,
): FeatureGeometry | null {
    if (geometry.rings[ringIdx].points.length <= MIN_RING_POINTS) return null;
    const next = cloneGeometry(geometry);
    next.rings[ringIdx].points.splice(idx, 1);
    return next;
}

/**
 * Insert an anchor on segment `segIdx` of ring `ringIdx` at curve
 * parameter `t` without changing the outline (de Casteljau split).
 * Bezier geometries only — spline features use `insertControlPoint`.
 */
export function insertAnchor(
    geometry: FeatureGeometry,
    ringIdx: number,
    segIdx: number,
    t: number,
): FeatureGeometry {
    const next = cloneGeometry(geometry);
    next.rings[ringIdx] = splitSegment(next.rings[ringIdx], segIdx, t);
    return next;
}

/**
 * Insert a smooth b-spline control point at `p` after control `afterIdx`
 * (edge-click insert on spline features: the position comes from
 * nearestOnRing on the FLATTENED curve, the index from the conversion's
 * segment → control map).
 */
export function insertControlPoint(
    geometry: FeatureGeometry,
    ringIdx: number,
    afterIdx: number,
    p: Point,
): FeatureGeometry {
    const next = cloneGeometry(geometry);
    next.rings[ringIdx].points.splice(afterIdx + 1, 0, { x: p.x, y: p.y });
    return next;
}

/**
 * Toggle a vertex between smooth and corner ('C' key / panel button).
 *
 * - bspline: flips the control point's `corner` flag (multiplicity 3 vs 1).
 * - bezier: corner = drop the anchor's handles; smooth = auto-compute
 *   Catmull-Rom-style handles from the neighbors: ±(P[i+1] − P[i−1]) / 6.
 */
export function toggleVertexCorner(
    geometry: FeatureGeometry,
    ringIdx: number,
    idx: number,
): FeatureGeometry {
    const next = cloneGeometry(geometry);
    const points = next.rings[ringIdx].points;
    const p = points[idx];

    if (geometry.curveType === 'bspline') {
        if (p.corner) delete p.corner;
        else p.corner = true;
        return next;
    }

    if (hasHandles(p)) {
        delete p.hIn;
        delete p.hOut;
        return next;
    }
    const n = points.length;
    const prev = points[(idx - 1 + n) % n];
    const nextPt = points[(idx + 1) % n];
    const dx = (nextPt.x - prev.x) / 6;
    const dy = (nextPt.y - prev.y) / 6;
    p.hOut = { x: p.x + dx, y: p.y + dy };
    p.hIn = { x: p.x - dx, y: p.y - dy };
    return next;
}

/** True when the vertex renders/behaves as a corner in its curve model. */
export function isCornerVertex(geometry: FeatureGeometry, ringIdx: number, idx: number): boolean {
    const p = geometry.rings[ringIdx].points[idx];
    return geometry.curveType === 'bspline' ? !!p.corner : !hasHandles(p);
}

/**
 * Bake a b-spline geometry into an exactly equivalent bezier geometry
 * (spline → bezier convert action; the reverse is lossy and not offered).
 * Control points become on-curve anchors with handles; corner flags are
 * consumed by the conversion. Bezier inputs are returned unchanged.
 */
export function bakeBsplineToBezier(geometry: FeatureGeometry): FeatureGeometry {
    if (geometry.curveType !== 'bspline') return geometry;
    return {
        crs: geometry.crs,
        curveType: 'bezier',
        rings: geometry.rings.map(ring => bsplineRingToBezier(ring)),
    };
}

/** Translate every anchor (and its handles) by (dx, dy) meters. */
export function translateGeometry(geometry: FeatureGeometry, dx: number, dy: number): FeatureGeometry {
    const next = cloneGeometry(geometry);
    for (const ring of next.rings) {
        for (const p of ring.points) {
            p.x += dx;
            p.y += dy;
            if (p.hIn) p.hIn = { x: p.hIn.x + dx, y: p.hIn.y + dy };
            if (p.hOut) p.hOut = { x: p.hOut.x + dx, y: p.hOut.y + dy };
        }
    }
    return next;
}

// ─── Vertex bulk operations ────────────────────────────────────────────────

/** Stable key for a vertex of a multi-ring geometry ("ringIdx:idx"). */
export function vertexKey(ringIdx: number, idx: number): string {
    return `${ringIdx}:${idx}`;
}

/** Inverse of `vertexKey`. */
export function parseVertexKey(key: string): { ringIdx: number; idx: number } {
    const [ringIdx, idx] = key.split(':').map(Number);
    return { ringIdx, idx };
}

/**
 * Delete a set of vertices (by vertexKey). Returns null when any affected
 * ring would fall below the 3-point minimum — the operation is
 * all-or-nothing so a bulk delete never partially applies.
 */
export function deleteVertices(geometry: FeatureGeometry, keys: ReadonlySet<string>): FeatureGeometry | null {
    const byRing = new Map<number, Set<number>>();
    for (const key of keys) {
        const { ringIdx, idx } = parseVertexKey(key);
        if (!byRing.has(ringIdx)) byRing.set(ringIdx, new Set());
        byRing.get(ringIdx)!.add(idx);
    }
    for (const [ringIdx, indices] of byRing) {
        const ring = geometry.rings[ringIdx];
        if (!ring || ring.points.length - indices.size < MIN_RING_POINTS) return null;
    }
    const next = cloneGeometry(geometry);
    for (const [ringIdx, indices] of byRing) {
        next.rings[ringIdx].points = next.rings[ringIdx].points.filter((_, i) => !indices.has(i));
    }
    return next;
}

/**
 * 'I' key: insert one vertex between two selected vertices of the same
 * ring and redistribute all in-between vertices EVENLY along the straight
 * chord idx1 → idx2 (ported from the prototype). When the two vertices are
 * the ring's first and last (wrap-around), a plain midpoint is appended.
 * Inserted/redistributed points are plain (no handles — on splines the
 * curve re-smooths itself). Returns the new geometry plus the keys of the
 * two originally selected vertices so the caller can keep them selected.
 */
export function insertBetweenVertices(
    geometry: FeatureGeometry,
    ringIdx: number,
    idxA: number,
    idxB: number,
): { geometry: FeatureGeometry; selection: [string, string] } | null {
    const ring = geometry.rings[ringIdx];
    if (!ring || idxA === idxB) return null;
    const [idx1, idx2] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    const n = ring.points.length;
    const p0 = ring.points[idx1];
    const p1 = ring.points[idx2];
    const next = cloneGeometry(geometry);

    if (idx1 === 0 && idx2 === n - 1) {
        // Wrap-around: insert the midpoint between last and first.
        next.rings[ringIdx].points.push({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 });
        return { geometry: next, selection: [vertexKey(ringIdx, idx1), vertexKey(ringIdx, idx2)] };
    }

    const numBetween = idx2 - idx1 - 1;
    const totalSegments = numBetween + 2; // one more vertex than before
    const between: AnchorPoint[] = [];
    for (let i = 1; i <= numBetween + 1; i++) {
        const t = i / totalSegments;
        between.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
    }
    next.rings[ringIdx].points.splice(idx1 + 1, numBetween, ...between);
    // idx2 shifts by one (one vertex added before it).
    return { geometry: next, selection: [vertexKey(ringIdx, idx1), vertexKey(ringIdx, idx2 + 1)] };
}

// ─── RDP simplification ────────────────────────────────────────────────────

function perpendicularDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer-Douglas-Peucker polyline simplification (ported from the
 * prototype): removes points within `epsilon` meters of the line between
 * the kept endpoints. Operates on any point-like items (anchor points keep
 * their handles/corner flags when they survive).
 */
export function rdpSimplify<T extends Point>(points: T[], epsilon: number): T[] {
    if (points.length < 3) return points;
    let maxDist = 0;
    let maxIndex = 0;
    const first = points[0];
    const last = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
        const dist = perpendicularDistance(points[i], first, last);
        if (dist > maxDist) {
            maxDist = dist;
            maxIndex = i;
        }
    }
    if (maxDist > epsilon) {
        const left = rdpSimplify(points.slice(0, maxIndex + 1), epsilon);
        const right = rdpSimplify(points.slice(maxIndex), epsilon);
        return [...left.slice(0, -1), ...right];
    }
    return [first, last];
}

/**
 * Simplify a geometry's CONTROL/ANCHOR points with RDP (closed-ring
 * variant: the ring is split at its two most distant points so no single
 * "endpoint" is privileged, then each half is simplified). This simplifies
 * the control polygon, not the flattened curve — a mild approximation on
 * curved features, in line with the offset op. Rings that would fall below
 * 3 points keep their 3 extremes. Surviving points keep handles/corner
 * flags.
 */
export function simplifyGeometry(geometry: FeatureGeometry, epsilon: number): FeatureGeometry {
    const next = cloneGeometry(geometry);
    next.rings = next.rings.map(ring => {
        const pts = ring.points;
        if (pts.length <= MIN_RING_POINTS) return ring;
        // Anchor the split at the two mutually farthest of (0, farthest-from-0).
        let split = 1;
        let best = -1;
        for (let i = 1; i < pts.length; i++) {
            const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
            if (d > best) {
                best = d;
                split = i;
            }
        }
        const half1 = rdpSimplify(pts.slice(0, split + 1), epsilon);
        const half2 = rdpSimplify([...pts.slice(split), pts[0]], epsilon);
        const merged = [...half1.slice(0, -1), ...half2.slice(0, -1)];
        if (merged.length < MIN_RING_POINTS) return ring;
        return { points: merged };
    });
    return next;
}

// ─── Path offset (expand / contract) ───────────────────────────────────────

/**
 * Averaged per-vertex normal of the CONTROL polygon with miter clamping
 * (ported from the prototype): the two adjacent edge normals are averaged;
 * at sharp corners the averaged normal is lengthened by the miter factor
 * 1/√((1+dot)/2), clamped to 4, so offset corners keep their distance.
 * Handles are intentionally ignored — the offset operates on control/
 * anchor points (see `offsetGeometry`).
 */
function vertexNormal(points: AnchorPoint[], index: number): Point {
    const n = points.length;
    const curr = points[index];
    const prev = points[(index - 1 + n) % n];
    const next = points[(index + 1) % n];

    const norm = (v: Point): Point => {
        const len = Math.hypot(v.x, v.y);
        return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
    };
    // Perpendicular (90° CCW) of the incoming/outgoing edge directions.
    const normalIn = norm({ x: -(curr.y - prev.y), y: curr.x - prev.x });
    const normalOut = norm({ x: -(next.y - curr.y), y: next.x - curr.x });
    const avg = norm({ x: normalIn.x + normalOut.x, y: normalIn.y + normalOut.y });

    const dot = normalIn.x * normalOut.x + normalIn.y * normalOut.y;
    if (dot < 0.5 && dot > -0.999) {
        const miter = Math.min(1 / Math.sqrt((1 + dot) / 2), 4);
        return { x: avg.x * miter, y: avg.y * miter };
    }
    return avg;
}

function controlSignedArea(points: AnchorPoint[]): number {
    let area = 0;
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return area / 2;
}

/**
 * Offset one ring's control/anchor points outward (distance > 0) or
 * inward (distance < 0), winding-aware via the signed area so "outward"
 * means away from the enclosed region regardless of point order. Handles
 * are translated with their anchor (shape-preserving for gentle offsets).
 */
export function offsetRingPoints(points: AnchorPoint[], distance: number): AnchorPoint[] {
    if (points.length < 3) return points;
    // EPSG:3006 is y-up: a CCW ring (positive area) has its CCW-perpendicular
    // normals pointing INWARD, so expansion needs the negative direction.
    const adjusted = controlSignedArea(points) > 0 ? -distance : distance;
    return points.map((p, i) => {
        const normal = vertexNormal(points, i);
        const dx = normal.x * adjusted;
        const dy = normal.y * adjusted;
        return {
            x: p.x + dx,
            y: p.y + dy,
            ...(p.hIn ? { hIn: { x: p.hIn.x + dx, y: p.hIn.y + dy } } : {}),
            ...(p.hOut ? { hOut: { x: p.hOut.x + dx, y: p.hOut.y + dy } } : {}),
            ...(p.corner ? { corner: true } : {}),
        };
    });
}

/**
 * True when contracting the geometry's outer ring by |distance| cannot
 * collapse it: the flattened bbox's smaller dimension must exceed twice
 * the contraction distance (prototype guard).
 */
export function canOffsetGeometry(geometry: FeatureGeometry, distance: number): boolean {
    if (geometry.rings.length === 0 || geometry.rings[0].points.length < 3) return false;
    if (distance >= 0) return true;
    const bbox: Bbox | null = ringBbox(geometry.rings[0] as PathRing, 0.25, geometry.curveType);
    if (!bbox) return false;
    const minDimension = Math.min(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
    return minDimension > Math.abs(distance) * 2;
}

/**
 * Expand (distance > 0) or contract (distance < 0) a geometry by offsetting
 * its CONTROL/ANCHOR points along per-vertex normals (miter-clamped,
 * winding-aware — see `offsetRingPoints`). Hole rings offset the OPPOSITE
 * direction so expanding a feature also shrinks its holes' cutouts
 * consistently (a hole's "outward" is into the feature).
 *
 * NOTE: offsetting control points is exact for straight segments and a
 * mild approximation for curves (splines especially, where controls are
 * off-curve) — accepted for editor-scale offsets of a few meters.
 *
 * Returns null when the collapse guard rejects the contraction.
 */
export function offsetGeometry(geometry: FeatureGeometry, distance: number): FeatureGeometry | null {
    if (!canOffsetGeometry(geometry, distance)) return null;
    const next = cloneGeometry(geometry);
    next.rings = next.rings.map((ring, i) => ({
        points: offsetRingPoints(ring.points, i === 0 ? distance : -distance),
    }));
    return next;
}

// ─── Marquee-selection hit math ────────────────────────────────────────────

export interface Rect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Normalize two drag corners into a Rect. */
export function rectFromCorners(a: Point, b: Point): Rect {
    return {
        minX: Math.min(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x),
        maxY: Math.max(a.y, b.y),
    };
}

function rectContains(outer: Rect, inner: Rect): boolean {
    return outer.minX <= inner.minX && outer.maxX >= inner.maxX
        && outer.minY <= inner.minY && outer.maxY >= inner.maxY;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
    return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

export type MarqueeMode = 'contain' | 'intersect';

/**
 * Feature ids hit by a marquee rectangle (EPSG:3006 meters), evaluated
 * against each feature's flattened-outline bbox. 'contain' (default):
 * fully inside the rect; 'intersect' (Alt): any overlap.
 */
export function featuresInRect(
    features: ReadonlyArray<{ id: string; geometry: FeatureGeometry }>,
    rect: Rect,
    mode: MarqueeMode,
): string[] {
    const hits: string[] = [];
    for (const feature of features) {
        if (feature.geometry.rings.length === 0) continue;
        const bbox = ringBbox(feature.geometry.rings[0] as PathRing, 0.25, feature.geometry.curveType);
        if (!bbox) continue;
        const matches = mode === 'contain' ? rectContains(rect, bbox) : rectsIntersect(rect, bbox);
        if (matches) hits.push(feature.id);
    }
    return hits;
}

/**
 * Vertex keys of a geometry's control/anchor points inside a marquee
 * rectangle (vertex marquee on the single selected feature).
 */
export function verticesInRect(geometry: FeatureGeometry, rect: Rect): string[] {
    const hits: string[] = [];
    geometry.rings.forEach((ring, ringIdx) => {
        ring.points.forEach((p, idx) => {
            if (p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY) {
                hits.push(vertexKey(ringIdx, idx));
            }
        });
    });
    return hits;
}
