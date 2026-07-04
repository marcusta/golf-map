// Pure draw-tool state + geometry edit operations. No map, no DOM, no
// network — everything here is unit-testable logic. DrawToolService wires
// these to actual map events.

import { Signal, Computed } from '@basics/core/client/core';
import { splitSegment, type AnchorPoint, type FeatureGeometry, type Point } from '../geo/bezier';

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

    readonly canClose = new Computed(() => this.draft.get().length >= MIN_RING_POINTS);
    readonly isDrawing = new Computed(() => this.mode.get() === 'draw');

    /** Arm polygon drawing (clears any previous draft). */
    arm(): void {
        this.draft.set([]);
        this.mode.set('draw');
    }

    /** Leave drawing mode, dropping the draft. */
    disarm(): void {
        this.draft.set([]);
        this.mode.set('select');
    }

    /** Append a draft anchor (drawing mode only). */
    addPoint(p: Point): void {
        if (this.mode.peek() !== 'draw') return;
        this.draft.update(points => [...points, { x: p.x, y: p.y }]);
    }

    /** Drop the last draft anchor (used to swallow the dblclick duplicate). */
    popPoint(): void {
        this.draft.update(points => points.slice(0, -1));
    }

    /**
     * Close the draft into a ring and return it (null when below the
     * 3-anchor minimum). Resets to select mode on success.
     */
    closeDraft(): { points: AnchorPoint[] } | null {
        const points = this.draft.peek();
        if (points.length < MIN_RING_POINTS) return null;
        this.disarm();
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
        rings: geometry.rings.map(ring => ({
            points: ring.points.map(p => ({
                x: p.x,
                y: p.y,
                ...(p.hIn ? { hIn: { ...p.hIn } } : {}),
                ...(p.hOut ? { hOut: { ...p.hOut } } : {}),
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
