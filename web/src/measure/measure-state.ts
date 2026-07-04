// Pure measurement state machine + stats math. No map, no DOM, no network —
// everything here is unit-testable logic. MeasureToolService wires these to
// map events + the ElevationService.
//
// Distances are computed in projected SWEREF 99 TM meters (EPSG:3006):
// callers transform each WGS84 click to easting/northing and hand us plain
// { e, n } pairs, so horizontal distance is straight Euclidean math — correct
// at course scale and consistent with the rest of the app (draw/analysis all
// work in EPSG:3006).

import { Signal, Computed } from '@basics/core/client/core';

/**
 * One placed measurement point. `e`/`n` are EPSG:3006 easting/northing
 * (meters); `lng`/`lat` are kept for overlay rendering + re-sampling.
 * `elevation` is meters RH2000, or null when terrain coverage is missing
 * (excluded from elevation-dependent stats).
 */
export interface MeasurePoint {
    lng: number;
    lat: number;
    e: number;
    n: number;
    elevation: number | null;
}

/**
 * Stats for one A→B segment. Horizontal/straight-line are always defined
 * (pure planar geometry). Elevation-dependent fields are null when either
 * endpoint lacks an elevation sample.
 */
export interface SegmentStats {
    /** Planar ground distance in meters (EPSG:3006 Euclidean). */
    horizontal: number;
    /** Signed elevation delta B−A in meters (null if either sample missing). */
    elevationDelta: number | null;
    /** True 3D line-of-sight distance in meters (null if elevation missing). */
    straightLine: number | null;
    /** Slope angle in degrees (null if elevation missing). */
    slopeDeg: number | null;
    /** Slope as a percentage (rise/run × 100; null if elevation missing). */
    slopePct: number | null;
    /**
     * "Plays-like (simple)" caddie rule: horizontal + elevationΔ. Uphill adds
     * distance, downhill subtracts. Null if elevation missing. This is the
     * preliminary Phase-3 rule; the full model lands in Phase 5.
     */
    playsLikeSimple: number | null;
}

/** Totals across the whole path. Elevation totals sum only measurable segments. */
export interface PathTotals extends SegmentStats {
    /** Number of segments contributing to the elevation-dependent totals. */
    measuredSegments: number;
    /** Total segment count (path.length − 1). */
    totalSegments: number;
}

/**
 * Segment stats between two points in EPSG:3006 meters. Elevation-dependent
 * fields degrade to null when either endpoint has no elevation.
 */
export function segmentStats(a: MeasurePoint, b: MeasurePoint): SegmentStats {
    const de = b.e - a.e;
    const dn = b.n - a.n;
    const horizontal = Math.hypot(de, dn);

    if (a.elevation === null || b.elevation === null) {
        return {
            horizontal,
            elevationDelta: null,
            straightLine: null,
            slopeDeg: null,
            slopePct: null,
            playsLikeSimple: null,
        };
    }

    const elevationDelta = b.elevation - a.elevation;
    const straightLine = Math.hypot(horizontal, elevationDelta);
    const slopeDeg = (Math.atan2(Math.abs(elevationDelta), horizontal) * 180) / Math.PI;
    const slopePct = horizontal > 0 ? (Math.abs(elevationDelta) / horizontal) * 100 : 0;
    const playsLikeSimple = horizontal + elevationDelta;

    return { horizontal, elevationDelta, straightLine, slopeDeg, slopePct, playsLikeSimple };
}

/** Per-segment stats for a whole path (path.length − 1 entries). */
export function pathSegmentStats(path: MeasurePoint[]): SegmentStats[] {
    const out: SegmentStats[] = [];
    for (let i = 1; i < path.length; i++) out.push(segmentStats(path[i - 1], path[i]));
    return out;
}

/**
 * Cumulative totals across the path. Horizontal sums every segment;
 * elevation-dependent totals sum only segments where both endpoints have
 * elevation. Straight-line total is the sum of per-segment 3D chords (a
 * draped-path length), NOT the 3D chord end-to-end. Slope is the aggregate
 * secant slope of the summed run/rise over measured segments.
 */
export function pathTotals(segments: SegmentStats[]): PathTotals {
    let horizontal = 0;
    let elevationDelta = 0;
    let straightLine = 0;
    let playsLikeSimple = 0;
    let measuredSegments = 0;

    for (const seg of segments) {
        horizontal += seg.horizontal;
        if (seg.elevationDelta !== null) {
            elevationDelta += seg.elevationDelta;
            straightLine += seg.straightLine!;
            playsLikeSimple += seg.playsLikeSimple!;
            measuredSegments++;
        }
    }

    const hasElevation = measuredSegments > 0;
    // Aggregate slope over the measured run (horizontal of measured segments only).
    let measuredRun = 0;
    for (const seg of segments) {
        if (seg.elevationDelta !== null) measuredRun += seg.horizontal;
    }
    const slopeDeg = hasElevation ? (Math.atan2(Math.abs(elevationDelta), measuredRun || 1) * 180) / Math.PI : null;
    const slopePct = hasElevation && measuredRun > 0 ? (Math.abs(elevationDelta) / measuredRun) * 100 : hasElevation ? 0 : null;

    return {
        horizontal,
        elevationDelta: hasElevation ? elevationDelta : null,
        straightLine: hasElevation ? straightLine : null,
        slopeDeg,
        slopePct,
        playsLikeSimple: hasElevation ? playsLikeSimple : null,
        measuredSegments,
        totalSegments: segments.length,
    };
}

/**
 * The measurement path state machine. Points are placed by clicking; after
 * the path is "ended" the next placement starts fresh.
 *
 * Lifecycle:
 *  - empty → place A → place B → extend (C, D, …)
 *  - end() (double-click / click near start) marks the path complete but keeps
 *    it visible; the next place() starts a brand-new path.
 *  - clear() wipes everything (Escape).
 *
 * All coordinate/elevation handling lives in MeasureToolService; this class
 * only owns the point list + ended flag.
 */
export class MeasureState {
    readonly points = new Signal<MeasurePoint[]>([]);
    /** True once the current path has been ended (next place restarts). */
    readonly ended = new Signal(false);

    readonly hasPath = new Computed(() => this.points.get().length >= 2);
    readonly count = new Computed(() => this.points.get().length);

    /** Per-segment stats, recomputed when points change. */
    readonly segments = new Computed<SegmentStats[]>(() => pathSegmentStats(this.points.get()));
    /** Cumulative totals, recomputed when points change. */
    readonly totals = new Computed<PathTotals>(() => pathTotals(this.segments.get()));

    /**
     * Place a point. If the path was ended (or is empty), this begins a new
     * path with `p` as its first point; otherwise it extends the path.
     */
    place(p: MeasurePoint): void {
        if (this.ended.peek()) {
            this.points.set([p]);
            this.ended.set(false);
            return;
        }
        this.points.update(pts => [...pts, p]);
    }

    /**
     * End the current path (double-click / click-near-start). No-op unless
     * there are at least two points. Keeps the path visible.
     */
    end(): void {
        if (this.points.peek().length < 2) return;
        this.ended.set(true);
    }

    /** Wipe the whole path (Escape / clear button). */
    clear(): void {
        this.points.set([]);
        this.ended.set(false);
    }

    /** Patch a single point's elevation in place (async sample resolved). */
    setElevation(index: number, elevation: number | null): void {
        this.points.update(pts => {
            if (index < 0 || index >= pts.length) return pts;
            const next = pts.slice();
            next[index] = { ...next[index], elevation };
            return next;
        });
    }
}
