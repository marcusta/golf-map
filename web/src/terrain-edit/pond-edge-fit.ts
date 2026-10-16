// A proposed pond edge (PondEdgeService: a closed polyline every 0.25 m) as the smooth B-spline a drawn feature
// is, fitted the way the draw tool fits a stroke. Shared by the terrain editor's "Fit edge to water" and
// `bun run water:edge`, so both store the same shape.
import { fitClosedBspline } from '../geo/spline-fit';

/** The fit follows the edge this closely (m): the photo's edge is good to about a pixel or two (0.25 m). */
export const POND_EDGE_FIT_TOLERANCE_M = 0.15;
/** At most one control point per this many metres of edge, and never more than POND_EDGE_MAX_CONTROLS. */
export const POND_EDGE_METERS_PER_CONTROL = 2.5;
export const POND_EDGE_MAX_CONTROLS = 256;

export function fitPondEdge(ring: { x: number; y: number }[]): { controls: { x: number; y: number }[]; maxDeviation: number } {
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const cap = Math.min(POND_EDGE_MAX_CONTROLS, Math.max(8, Math.round(perimeter / POND_EDGE_METERS_PER_CONTROL)));
    const fit = fitClosedBspline(ring.map((p) => ({ x: p.x, y: p.y })), POND_EDGE_FIT_TOLERANCE_M, cap);
    if (fit.controls.length < 3 || !fit.controls.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        throw new Error('the edge could not be fitted as a B-spline');
    }
    return { controls: fit.controls.map((p) => ({ x: p.x, y: p.y })), maxDeviation: fit.maxDeviation };
}
