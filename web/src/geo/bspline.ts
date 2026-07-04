// Uniform cubic B-spline support for course features — the client twin of
// the server's b-spline machinery in server/services/geo.ts (identical
// math, verified by parity tests in web/tests/bspline.test.ts).
//
// A 'bspline' ring's points are CONTROL points of a CLOSED uniform cubic
// B-spline: they pull the curve but don't lie on it. Each window of 4
// consecutive (expanded) controls p0..p3 yields one cubic bezier segment:
//
//   start = (p0 + 4·p1 + p2) / 6      cp1 = (2·p1 + p2) / 3
//   end   = (p1 + 4·p2 + p3) / 6      cp2 = (p1 + 2·p2) / 3
//
// The loop closes by wrapping the window modulo n — n segments for n
// expanded controls. A point marked `corner` is triplicated in the control
// array (knot multiplicity 3), forcing the curve through it as a sharp
// corner. Smooth (default) points appear once.

import type { AnchorPoint, PathRing, Point } from './bezier';

/**
 * Expand control points: corner points are triplicated (multiplicity 3).
 * `origIdx[i]` maps expanded control i back to its index in `points`.
 */
export function expandBsplineControls(points: AnchorPoint[]): { ctrl: Point[]; origIdx: number[] } {
    const ctrl: Point[] = [];
    const origIdx: number[] = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const copies = p.corner ? 3 : 1;
        for (let c = 0; c < copies; c++) {
            ctrl.push({ x: p.x, y: p.y });
            origIdx.push(i);
        }
    }
    return { ctrl, origIdx };
}

export interface BsplineBezier {
    /** The exactly equivalent bezier ring (n anchors with hIn/hOut). */
    ring: PathRing;
    /**
     * For bezier segment i (anchor i → anchor i+1): the ORIGINAL control
     * index after which a control inserted on that segment belongs. Curve
     * segment i lies "between" expanded controls i+1 and i+2, so this is
     * origIdx[(i + 1) % n].
     */
    segInsertAfter: number[];
}

/**
 * Convert a closed b-spline control ring into its exact bezier equivalent,
 * plus the segment → control-index map used for edge-click insertion.
 */
export function bsplineRingToBezierWithMap(ring: PathRing): BsplineBezier {
    const { ctrl, origIdx } = expandBsplineControls(ring.points);
    const n = ctrl.length;
    if (n < 3) {
        return {
            ring: { points: ctrl.map(p => ({ x: p.x, y: p.y })) },
            segInsertAfter: ctrl.map((_, i) => origIdx[i]),
        };
    }

    const anchors: AnchorPoint[] = [];
    const segInsertAfter: number[] = [];
    for (let i = 0; i < n; i++) {
        const p0 = ctrl[i];
        const p1 = ctrl[(i + 1) % n];
        const p2 = ctrl[(i + 2) % n];
        anchors.push({
            x: (p0.x + 4 * p1.x + p2.x) / 6,
            y: (p0.y + 4 * p1.y + p2.y) / 6,
            hOut: { x: (2 * p1.x + p2.x) / 3, y: (2 * p1.y + p2.y) / 3 },
        });
        segInsertAfter.push(origIdx[(i + 1) % n]);
    }
    // Segment i ends at anchor (i+1): its second control point is that
    // anchor's incoming handle.
    for (let i = 0; i < n; i++) {
        const p1 = ctrl[(i + 1) % n];
        const p2 = ctrl[(i + 2) % n];
        anchors[(i + 1) % n].hIn = { x: (p1.x + 2 * p2.x) / 3, y: (p1.y + 2 * p2.y) / 3 };
    }
    return { ring: { points: anchors }, segInsertAfter };
}

/** Convert a closed b-spline control ring to its exact bezier PathRing. */
export function bsplineRingToBezier(ring: PathRing): PathRing {
    return bsplineRingToBezierWithMap(ring).ring;
}
