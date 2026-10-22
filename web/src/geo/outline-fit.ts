// A traced outline (a SAM mask contour, a bunker's sand edge) as an editable closed B-spline feature geometry:
// simplified (the raster staircase stripped), then fitted with a control floor scaled to its perimeter and
// controls weighted to its bends. One fit for the SAM tool, the Draw mode's bunker proposals and `bun run bunkers`.
// Pure, EPSG:3006 metres in and out.

import { rdpSimplifyClosed, MIN_RING_POINTS } from '../draw/draw-state';
import { fitClosedBspline } from './spline-fit';
import type { FeatureGeometry, Point } from './bezier';

/** RDP epsilon (meters) applied to the outline before fitting. Ortho pixels are ~0.16 m, so 0.2 strips the
 * staircase and keeps real detail. */
export const OUTLINE_SIMPLIFY_EPS_M = 0.2;
/** B-spline fit tolerance (meters): outlines are raster-quantized, so tighter than the freehand trace's 0.75. */
export const OUTLINE_FIT_TOLERANCE_M = 0.3;
/** Vertex-density floor: the fit starts at one control per this many metres of perimeter (a 34 m bunker outline
 * → 14 controls, where the tolerance alone settled at 8) and still climbs until it meets the tolerance. */
export const OUTLINE_METERS_PER_CONTROL = 2.5;
/** Adaptive-ladder cap: 48 covers a ~75 m green at ~3 m spacing. */
export const OUTLINE_MAX_CONTROLS = 48;
/** Share of the controls placed by turning angle rather than arc length (spline-fit FitOptions.curvatureShare):
 * straight stretches thin out, bends pick up the difference. */
export const OUTLINE_CURVATURE_SHARE = 0.5;

/** Closed-ring perimeter (meters) of a point list. */
export function ringPerimeter(pts: Array<{ x: number; y: number }>): number {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        sum += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return sum;
}

/** The perimeter-scaled ladder floor, clamped to the cap. */
export function outlineMinControls(perimeterM: number): number {
    return Math.min(OUTLINE_MAX_CONTROLS, Math.round(perimeterM / OUTLINE_METERS_PER_CONTROL));
}

/**
 * The outline (EPSG:3006, closed, the first point not repeated) as a one-ring B-spline geometry, or null when
 * it is too small to keep (fewer controls than a ring needs).
 */
export function outlineToBspline(ring: Point[]): FeatureGeometry | null {
    const simplified = rdpSimplifyClosed(ring, OUTLINE_SIMPLIFY_EPS_M);
    const { controls } = fitClosedBspline(simplified, OUTLINE_FIT_TOLERANCE_M, OUTLINE_MAX_CONTROLS, {
        minControls: outlineMinControls(ringPerimeter(simplified)),
        curvatureShare: OUTLINE_CURVATURE_SHARE,
    });
    if (controls.length < MIN_RING_POINTS) return null;
    return { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points: controls.map(p => ({ x: p.x, y: p.y })) }] };
}
