// Plays-like distance (simple caddie rule) — the shared reference port of
// web/src/measure/measure-state.ts segmentStats/pathTotals (canonical) and
// iOS GolfMap/Geo/PlaysLike.swift. Semantics must stay identical in all
// three places; this file is the reference the others mirror.
//
// Units & conventions: points are projected planar meters (EPSG:3006-style
// {x, y}); elevation is meters (RH2000 in practice). playsLikeSimple =
// horizontal + elevationΔ (uphill adds, downhill subtracts) — deliberately
// a placeholder rule kept behind this one function so a full ballistics
// model can swap in on both platforms later (Phase 7).
//
// Degradation: a missing elevation on either endpoint (undefined or null)
// makes ALL elevation-dependent fields undefined; horizontal is always
// computed. slopePct has a zero-run guard (horizontal 0 → 0, not NaN).

/** A path point in planar meters, with optional elevation (meters). */
export interface StrategyPoint {
    x: number;
    y: number;
    /** Meters; undefined/null = no terrain sample at this point. */
    elevation?: number | null;
}

/**
 * Stats for one A→B segment. `horizontalM` is always defined; the
 * elevation-dependent fields are undefined when either endpoint lacks an
 * elevation sample.
 */
export interface SegmentStats {
    /** Planar ground distance, meters. */
    horizontalM: number;
    /** Signed elevation delta B − A, meters. */
    elevationDeltaM?: number;
    /** 3D line-of-sight chord, meters. */
    straightLineM?: number;
    /** Slope angle, degrees (of |Δelev| over run). */
    slopeDeg?: number;
    /** Slope percentage (|rise|/run × 100; 0 when run is 0). */
    slopePct?: number;
    /** Plays-like (simple): horizontal + elevationΔ, meters. */
    playsLikeSimpleM?: number;
}

/** Totals across a whole path. Elevation totals sum only measured segments. */
export interface PathTotals extends SegmentStats {
    /** Segments where both endpoints had elevation. */
    measuredSegments: number;
    /** Total segment count (points.length − 1). */
    totalSegments: number;
}

/** Segment stats between two points (see module header for semantics). */
export function segmentStats(a: StrategyPoint, b: StrategyPoint): SegmentStats {
    const horizontalM = Math.hypot(b.x - a.x, b.y - a.y);

    if (a.elevation === undefined || a.elevation === null || b.elevation === undefined || b.elevation === null) {
        return { horizontalM };
    }

    const elevationDeltaM = b.elevation - a.elevation;
    const straightLineM = Math.hypot(horizontalM, elevationDeltaM);
    const slopeDeg = (Math.atan2(Math.abs(elevationDeltaM), horizontalM) * 180) / Math.PI;
    const slopePct = horizontalM > 0 ? (Math.abs(elevationDeltaM) / horizontalM) * 100 : 0;
    const playsLikeSimpleM = horizontalM + elevationDeltaM;

    return { horizontalM, elevationDeltaM, straightLineM, slopeDeg, slopePct, playsLikeSimpleM };
}

/** Per-segment stats for a whole path (points.length − 1 entries). */
export function pathSegmentStats(points: readonly StrategyPoint[]): SegmentStats[] {
    const out: SegmentStats[] = [];
    for (let i = 1; i < points.length; i++) out.push(segmentStats(points[i - 1], points[i]));
    return out;
}

/**
 * Cumulative totals across a path (iOS/web semantics, identical to
 * measure-state.ts pathTotals): horizontal sums EVERY segment; the
 * elevation-dependent totals sum only segments where both endpoints have
 * elevation. straightLine is the sum of per-segment 3D chords (a
 * draped-path length, NOT the end-to-end chord). Aggregate slope is the
 * secant slope of the summed rise over the MEASURED run only.
 */
export function pathTotals(points: readonly StrategyPoint[]): PathTotals {
    const segments = pathSegmentStats(points);

    let horizontalM = 0;
    let elevationDeltaM = 0;
    let straightLineM = 0;
    let playsLikeSimpleM = 0;
    let measuredRun = 0;
    let measuredSegments = 0;

    for (const seg of segments) {
        horizontalM += seg.horizontalM;
        if (seg.elevationDeltaM !== undefined) {
            elevationDeltaM += seg.elevationDeltaM;
            straightLineM += seg.straightLineM!;
            playsLikeSimpleM += seg.playsLikeSimpleM!;
            measuredRun += seg.horizontalM;
            measuredSegments++;
        }
    }

    if (measuredSegments === 0) {
        return { horizontalM, measuredSegments, totalSegments: segments.length };
    }

    const slopeDeg = (Math.atan2(Math.abs(elevationDeltaM), measuredRun || 1) * 180) / Math.PI;
    const slopePct = measuredRun > 0 ? (Math.abs(elevationDeltaM) / measuredRun) * 100 : 0;

    return {
        horizontalM,
        elevationDeltaM,
        straightLineM,
        slopeDeg,
        slopePct,
        playsLikeSimpleM,
        measuredSegments,
        totalSegments: segments.length,
    };
}
