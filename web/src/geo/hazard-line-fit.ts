// A GKD hazard line (GsproExportService.gkdLines: a closed ring in EPSG:3006 with nodes every 3 m at most, staked
// 1 m outside the water and out over its bank) as the smooth closed B-spline every drawn shape is: densified to
// HAZARD_LINE_SAMPLE_M, then least-squares fitted the way the draw tool fits a traced stroke (spline-fit.ts), with
// the control count raised in proportion to the line's length so a long creek line still follows its water.
// Shared by Furniture's "Edit line" and `bun run gkd:lines -- adopt`, so both store the same shape.
import { fitClosedBspline } from './spline-fit';
import type { FeatureGeometry, Point } from './bezier';

/** The line is sampled this densely before the fit, so its straight 3 m runs are measured along their length (m). */
export const HAZARD_LINE_SAMPLE_M = 0.5;
/** The fitted curve stays this close to the staked line (m). */
export const HAZARD_LINE_FIT_TOLERANCE_M = 0.25;
/** The fit tries up to one control point per this many metres of line (and never fewer than 8)… */
export const HAZARD_LINE_METERS_PER_CONTROL = 1.5;
/** …starting from one per this many metres, so a 2 km creek line does not climb the whole ladder from 8. */
export const HAZARD_LINE_START_METERS_PER_CONTROL = 4;
export const HAZARD_LINE_MAX_CONTROLS = 2048;

export interface HazardLineFit {
    /** The closed control ring, all smooth (no corners). */
    controls: Point[];
    /** Furthest the fitted curve lies from the staked line (m). */
    maxDeviation: number;
    perimeterM: number;
}

/** Length of a closed ring (m), the closing edge included. */
export function ringPerimeterM(points: ReadonlyArray<readonly [number, number]>): number {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!;
        sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return sum;
}

/** The closed ring with points added so no edge (the closing one included) is longer than `stepM`. */
function densifyClosed(points: ReadonlyArray<readonly [number, number]>, stepM: number): Point[] {
    const out: Point[] = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!;
        const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepM));
        for (let s = 0; s < pieces; s++) {
            const t = s / pieces;
            out.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t });
        }
    }
    return out;
}

/** Fit a hazard line's ring (first point not repeated). Throws when it cannot be fitted (fewer than 3 distinct points). */
export function fitHazardLine(points: ReadonlyArray<readonly [number, number]>): HazardLineFit {
    const ring = points.length > 1 && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1]
        ? points.slice(0, -1) : points;
    // Shoelace about the first point: EPSG:3006 magnitudes would drown a small ring's area in rounding.
    let twiceArea = 0;
    const [ox, oy] = ring[0] ?? [0, 0];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        twiceArea += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
    }
    if (ring.length < 3 || Math.abs(twiceArea) < 1e-3) throw new Error('the line could not be fitted as a B-spline (it encloses nothing)');
    const perimeterM = ringPerimeterM(ring);
    const cap = Math.min(HAZARD_LINE_MAX_CONTROLS, Math.max(8, Math.round(perimeterM / HAZARD_LINE_METERS_PER_CONTROL)));
    const start = Math.min(cap, Math.max(8, Math.round(perimeterM / HAZARD_LINE_START_METERS_PER_CONTROL)));
    const fit = fitClosedBspline(densifyClosed(ring, HAZARD_LINE_SAMPLE_M), HAZARD_LINE_FIT_TOLERANCE_M, cap, { minControls: start, curvatureShare: 0.5 });
    if (fit.controls.length < 3 || !fit.controls.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        throw new Error('the line could not be fitted as a B-spline');
    }
    return { controls: fit.controls.map(p => ({ x: p.x, y: p.y })), maxDeviation: fit.maxDeviation, perimeterM };
}

/** The line as a drawn feature's geometry: one closed smooth B-spline ring in EPSG:3006. */
export function hazardLineGeometry(points: ReadonlyArray<readonly [number, number]>): FeatureGeometry {
    return { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points: fitHazardLine(points).controls }] };
}
