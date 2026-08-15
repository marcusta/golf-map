import { playsAsM, windEffect } from '../../../shared/strategy';
import { wgs84ToSweref99tm } from '../geo/transform';
import { vertexDistances, type LatLon, type ProfileSample } from './elevation-profile';

// ─── Drag-measure math for the elevation-profile chart ─────────────────────
//
// A dragged x-range [d0, d1] on the profile measures the stretch of the hole
// between two along-path distances: the actual (horizontal) distance, the
// raw elevation delta, and the plays-like distance with the elevation and
// wind contributions broken out. Composition matches the iOS on-course card
// (OnCourseDistances.compute): plays-like simple = horizontal + elevationΔ
// (shared segmentStats rule), then wind applies over the elevation-adjusted
// figure as playsAsM(simple, windEffect(..., simple)).

export interface ProfileWind {
    speedMps: number;
    directionDeg: number;
}

/** One measured x-range of the profile. Null fields = not resolvable. */
export interface RangeMeasure {
    /** Along-path horizontal distance of the range (m). */
    distanceM: number;
    /** Raw elevation delta end − start (m); null when either end lacks coverage. */
    elevationDeltaM: number | null;
    /** Plays-like incl. elevation + wind (m). */
    playsLikeM: number;
    /** Wind contribution to plays-like (m, signed); null when no wind given. */
    windAdjM: number | null;
    /** Chord compass bearing start → end (deg); null for a degenerate range. */
    bearingDeg: number | null;
}

/** Nearest raw sample elevation to `d`, or null beyond `tolerance` / in a gap. */
function elevationAt(
    samples: readonly ProfileSample[],
    d: number,
    tolerance = 5,
): number | null {
    let best: ProfileSample | null = null;
    for (const sample of samples) {
        if (sample.elevation === null) continue;
        if (!best || Math.abs(sample.distance - d) < Math.abs(best.distance - d)) {
            best = sample;
        }
    }
    if (!best || Math.abs(best.distance - d) > tolerance) return null;
    return best.elevation;
}

/** WGS84 position at along-path distance `d` (clamped to the path ends). */
export function pointAtDistance(path: readonly LatLon[], d: number): LatLon | null {
    if (path.length === 0) return null;
    if (path.length === 1) return path[0];
    const dists = vertexDistances(path);
    const total = dists[dists.length - 1];
    const clamped = Math.min(Math.max(d, 0), total);
    for (let i = 1; i < path.length; i++) {
        if (clamped > dists[i] && i < path.length - 1) continue;
        const legLength = dists[i] - dists[i - 1];
        const t = legLength > 0 ? (clamped - dists[i - 1]) / legLength : 0;
        const a = path[i - 1];
        const b = path[i];
        return {
            lat: a.lat + (b.lat - a.lat) * Math.min(Math.max(t, 0), 1),
            lon: a.lon + (b.lon - a.lon) * Math.min(Math.max(t, 0), 1),
        };
    }
    return path[path.length - 1];
}

/** Planar (EPSG:3006) compass bearing a → b, deg — same as the iOS card. */
function planarBearingDeg(a: LatLon, b: LatLon): number | null {
    const pa = wgs84ToSweref99tm(a.lat, a.lon);
    const pb = wgs84ToSweref99tm(b.lat, b.lon);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    if (dx === 0 && dy === 0) return null;
    const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
}

/**
 * Measure the dragged x-range [d0, d1] (order-agnostic; the chord bearing
 * and wind always evaluate in the start → end drag direction along the
 * path, i.e. lower → higher distance).
 */
export function measureRange(
    samples: readonly ProfileSample[],
    path: readonly LatLon[],
    wind: ProfileWind | null,
    d0: number,
    d1: number,
): RangeMeasure {
    const lo = Math.min(d0, d1);
    const hi = Math.max(d0, d1);
    const distanceM = hi - lo;

    const eLo = elevationAt(samples, lo);
    const eHi = elevationAt(samples, hi);
    const elevationDeltaM = eLo !== null && eHi !== null ? eHi - eLo : null;

    // Elevation-adjusted base (shared segmentStats plays-like rule); plain
    // horizontal when coverage is missing.
    const base = distanceM + (elevationDeltaM ?? 0);

    const a = pointAtDistance(path, lo);
    const b = pointAtDistance(path, hi);
    const bearingDeg = a && b ? planarBearingDeg(a, b) : null;

    let playsLikeM = base;
    let windAdjM: number | null = null;
    if (wind && bearingDeg !== null && distanceM > 0) {
        const effect = windEffect(wind.speedMps, wind.directionDeg, bearingDeg, base);
        playsLikeM = playsAsM(base, effect);
        windAdjM = playsLikeM - base;
    }

    return { distanceM, elevationDeltaM, playsLikeM, windAdjM, bearingDeg };
}
