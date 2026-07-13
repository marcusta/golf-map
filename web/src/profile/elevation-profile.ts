import { wgs84ToSweref99tm } from '../geo/transform';

// ─── Elevation profile math ────────────────────────────────────────────────
//
// Side-view (cross-section) elevation series along a polyline path — the
// tee→shots→green hole route in the planner, or any measure-style path.
//
// Round-trip port of the iOS `ElevationProfile` (ios/GolfMap/Profile/
// ElevationProfile.swift), which itself started as a port of the measure
// tool's `refreshProfile` — this brings the iOS improvements back:
// distance-interval sampling (one sample every 2 m, clamped per leg) instead
// of a fixed 50 samples per segment, plus presentation smoothing. Cumulative
// distance is measured in EPSG:3006 projected meters — the same length math
// as the measure tool and plays-like — so the x-axis agrees with every other
// number in the app. Lat/lon are interpolated linearly within a leg
// (sub-centimeter error at golf-hole scale).

/** A WGS84 path vertex (field order matches PlanNodePoint / iOS LatLon). */
export interface LatLon {
    lat: number;
    lon: number;
}

/** One resolved sample along the path. */
export interface ProfileSample {
    /** Cumulative horizontal distance from the path start (m, EPSG:3006). */
    distance: number;
    /** Terrain elevation (m), or null where coverage is missing (gap). */
    elevation: number | null;
}

/** Async terrain sampler (ElevationService in prod, stubs in tests). */
export type ProfileElevationSampler = (p: LatLon) => Promise<number | null>;

/** Default sampling interval along the path (m). */
export const PROFILE_INTERVAL_M = 2;
/** Hard per-leg sample cap (keeps a mis-tagged kilometer leg cheap). */
export const MAX_SAMPLES_PER_LEG = 200;

/** EPSG:3006 planar length of one leg (same math as the measure tool). */
function legLengthMeters(a: LatLon, b: LatLon): number {
    const pa = wgs84ToSweref99tm(a.lat, a.lon);
    const pb = wgs84ToSweref99tm(b.lat, b.lon);
    return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

/**
 * Cumulative EPSG:3006 distance (m) of every path vertex, starting at 0.
 * Empty for an empty path. These are the marker positions (Tee / shots /
 * Green) on the profile x-axis.
 */
export function vertexDistances(path: readonly LatLon[]): number[] {
    if (path.length === 0) return [];
    const distances = [0];
    let cumulative = 0;
    for (let i = 1; i < path.length; i++) {
        cumulative += legLengthMeters(path[i - 1], path[i]);
        distances.push(cumulative);
    }
    return distances;
}

/**
 * Sample the terrain along the whole path: `intervalM` spacing per leg
 * (min 2, max `maxSamplesPerLeg` samples per leg), shared vertices
 * deduplicated (each leg after the first skips its start sample). Fewer
 * than two path points → empty.
 */
export async function profileSeries(
    path: readonly LatLon[],
    sampler: ProfileElevationSampler,
    intervalM = PROFILE_INTERVAL_M,
    maxSamplesPerLeg = MAX_SAMPLES_PER_LEG,
): Promise<ProfileSample[]> {
    if (path.length < 2) return [];
    const interval = Math.max(intervalM, 0.1);

    const samples: ProfileSample[] = [];
    let cumulative = 0;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const legLength = legLengthMeters(a, b);
        const count = Math.max(2, Math.min(maxSamplesPerLeg, Math.ceil(legLength / interval) + 1));
        // Skip the first sample of every leg after the first: it is the
        // previous leg's end vertex (dedupe the shared vertex).
        const start = i === 1 ? 0 : 1;
        const legSamples = await Promise.all(
            Array.from({ length: count - start }, (_, j) => {
                const k = start + j;
                const t = k / (count - 1);
                const point: LatLon = {
                    lat: a.lat + (b.lat - a.lat) * t,
                    lon: a.lon + (b.lon - a.lon) * t,
                };
                return sampler(point).then(elevation => ({
                    distance: cumulative + legLength * t,
                    elevation,
                }));
            }),
        );
        samples.push(...legSamples);
        cumulative += legLength;
    }
    return samples;
}

/**
 * Moving-average smoothing for the DRAWN curve only (kills the 0.1 m
 * terrain-quantization stair-steps). Gaps (null elevation) stay gaps; the
 * window shrinks near run edges so endpoints barely move. All printed
 * NUMBERS (Δs, marker elevations) stay raw — smoothing is presentation only.
 */
export function smoothProfile(samples: readonly ProfileSample[], window = 5): ProfileSample[] {
    if (window <= 1 || samples.length <= 2) return [...samples];
    const half = Math.floor(window / 2);
    return samples.map((sample, index) => {
        if (sample.elevation === null) return sample;
        let sum = 0;
        let count = 0;
        const from = Math.max(0, index - half);
        const to = Math.min(samples.length - 1, index + half);
        for (let j = from; j <= to; j++) {
            const e = samples[j].elevation;
            if (e === null) continue;
            sum += e;
            count++;
        }
        return { distance: sample.distance, elevation: count > 0 ? sum / count : null };
    });
}
