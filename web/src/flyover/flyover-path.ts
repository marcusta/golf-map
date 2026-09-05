/**
 * Pure geometry for the hole flyover: waypoint smoothing (Catmull-Rom),
 * arc-length lookup along the smoothed path, the low-flight camera pose for
 * a given path position, and the speed profile (constant 225 km/h with an
 * eased start and stop). No MapLibre, no DI — everything here is unit-tested
 * in `tests/flyover-path.test.ts`.
 *
 * Distances are metres on a local equirectangular plane anchored at the
 * path's first waypoint; a hole is < 1 km so the projection error is
 * negligible for camera placement.
 */

export interface LngLat {
    lng: number;
    lat: number;
}

/** A point on the resampled path with its cumulative arc length `s` (m). */
export interface PathPoint extends LngLat {
    s: number;
}

export interface FlyoverPath {
    points: PathPoint[];
    /** Total arc length in metres. */
    length: number;
}

/** Camera placement expressed as "from here, look at there" in WGS84 + metres. */
export interface CameraPose {
    from: LngLat;
    /** Camera altitude, metres (already multiplied by terrain exaggeration). */
    altFrom: number;
    to: LngLat;
    /** Target altitude, metres (already multiplied by terrain exaggeration). */
    altTo: number;
    /** Compass bearing from camera to target, degrees [0, 360). */
    bearing: number;
    /** MapLibre pitch: 0 = straight down, 90 = horizon. */
    pitch: number;
}

export interface PoseOptions {
    /** Eye height above local ground, metres (before exaggeration). */
    eyeHeightM: number;
    /** The eye looks at the path point this far ahead (clamped to the path end). */
    lookAheadM: number;
    /** The look point sits this high above the ground there, metres. */
    lookHeightM: number;
    /** Terrain vertical exaggeration; scales ground + heights. */
    exaggeration: number;
}

/** Eye height above local ground while flying, metres. */
export const FLYOVER_EYE_HEIGHT_M = 5;
/** Look target: this far ahead along the path, clamped to the green. */
export const FLYOVER_LOOK_AHEAD_M = 120;
/** Look target height above the ground at that point, metres. */
export const FLYOVER_LOOK_HEIGHT_M = 2;
/**
 * The eye stops this short of the green centre. Without it the final frame
 * would have the eye above the green looking straight down at its own look
 * point (from == to); 15 m back at 5 m up gives an approach view of the green.
 */
export const FLYOVER_END_STANDOFF_M = 15;
/** Cruise speed along the path: 225 km/h. */
export const FLYOVER_SPEED_M_S = 225 / 3.6;
/** Ease-in at the tee and ease-out at the green, each this long, ms. */
export const FLYOVER_EASE_MS = 1500;
/** Shortest flight (very short holes), ms. The only duration clamp. */
export const FLYOVER_MIN_FLIGHT_MS = 3000;
/** Overhead camera → start pose transition, ms (same as walk mode's enter). */
export const FLYOVER_ENTER_MS = 1500;
/** Hold at the final pose before restoring the overhead camera, ms. */
export const FLYOVER_HOLD_MS = 2000;
/** Resampling step for the smoothed path, metres. */
export const PATH_STEP_M = 5;

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Metres per degree of longitude / latitude at a reference latitude. */
export function metersPerDegree(latDeg: number): { x: number; y: number } {
    const perDegLat = EARTH_RADIUS_M * DEG;
    return { x: perDegLat * Math.cos(latDeg * DEG), y: perDegLat };
}

/** Planar distance in metres (equirectangular, fine for sub-km spans). */
export function distanceM(a: LngLat, b: LngLat): number {
    const m = metersPerDegree((a.lat + b.lat) / 2);
    const dx = (b.lng - a.lng) * m.x;
    const dy = (b.lat - a.lat) * m.y;
    return Math.hypot(dx, dy);
}

/** Compass bearing a→b in degrees [0, 360). */
export function bearingDeg(a: LngLat, b: LngLat): number {
    const m = metersPerDegree((a.lat + b.lat) / 2);
    const dx = (b.lng - a.lng) * m.x;
    const dy = (b.lat - a.lat) * m.y;
    const deg = Math.atan2(dx, dy) / DEG;
    return ((deg % 360) + 360) % 360;
}

/**
 * Pick the back tee: the tee farthest from the green centre. Null for an
 * empty list. Ties resolve to the first in list order.
 */
export function backTee<T extends { lat: number; lon: number }>(
    tees: readonly T[],
    green: { lat: number; lon: number },
): T | null {
    let best: T | null = null;
    let bestD = -1;
    const g = { lng: green.lon, lat: green.lat };
    for (const tee of tees) {
        const d = distanceM({ lng: tee.lon, lat: tee.lat }, g);
        if (d > bestD) {
            best = tee;
            bestD = d;
        }
    }
    return best;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

/**
 * Smooth the waypoints with a Catmull-Rom spline (end tangents from
 * duplicated endpoints) and resample it at roughly `stepM` metres. Two
 * waypoints give a straight line. Consecutive duplicates (< 0.5 m apart)
 * collapse. Returns null when fewer than two distinct waypoints remain.
 */
export function buildFlyoverPath(waypoints: readonly LngLat[], stepM = PATH_STEP_M): FlyoverPath | null {
    const distinct: LngLat[] = [];
    for (const w of waypoints) {
        const prev = distinct[distinct.length - 1];
        if (!prev || distanceM(prev, w) >= 0.5) distinct.push({ lng: w.lng, lat: w.lat });
    }
    if (distinct.length < 2) return null;

    const origin = distinct[0];
    const m = metersPerDegree(origin.lat);
    const toPlane = (p: LngLat) => ({ x: (p.lng - origin.lng) * m.x, y: (p.lat - origin.lat) * m.y });
    const toLngLat = (x: number, y: number): LngLat => ({ lng: origin.lng + x / m.x, lat: origin.lat + y / m.y });
    const plane = distinct.map(toPlane);

    // Sample the spline densely (chord-proportional), then accumulate s.
    const samples: Array<{ x: number; y: number }> = [plane[0]];
    for (let i = 0; i < plane.length - 1; i++) {
        const p0 = plane[Math.max(0, i - 1)];
        const p1 = plane[i];
        const p2 = plane[i + 1];
        const p3 = plane[Math.min(plane.length - 1, i + 2)];
        const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const n = Math.max(1, Math.ceil(chord / stepM));
        for (let k = 1; k <= n; k++) {
            const t = k / n;
            if (plane.length === 2) {
                samples.push({ x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t });
            } else {
                samples.push({
                    x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
                    y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
                });
            }
        }
    }

    const points: PathPoint[] = [];
    let s = 0;
    for (let i = 0; i < samples.length; i++) {
        if (i > 0) s += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
        points.push({ ...toLngLat(samples[i].x, samples[i].y), s });
    }
    return { points, length: s };
}

/**
 * Position at arc length `s`. Values outside [0, length] extrapolate
 * linearly along the first / last segment so a camera trailing the tee or a
 * look-at point past the green still lies on the hole's line.
 */
export function pointAlong(path: FlyoverPath, s: number): LngLat {
    const pts = path.points;
    if (pts.length === 1) return { lng: pts[0].lng, lat: pts[0].lat };

    let a: PathPoint;
    let b: PathPoint;
    if (s <= 0) {
        a = pts[0];
        b = pts[1];
    } else if (s >= path.length) {
        a = pts[pts.length - 2];
        b = pts[pts.length - 1];
    } else {
        // Binary search for the segment containing s.
        let lo = 0;
        let hi = pts.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (pts[mid].s <= s) lo = mid;
            else hi = mid;
        }
        a = pts[lo];
        b = pts[hi];
    }
    const span = b.s - a.s;
    const t = span > 0 ? (s - a.s) / span : 0;
    return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
}

/**
 * Ground elevation along the path, sampled at fixed arc-length steps
 * starting at `s0` (which may be negative to cover the camera's trailing
 * position). `values` are unexaggerated metres above sea level.
 */
export interface GroundProfile {
    s0: number;
    stepM: number;
    values: number[];
}

/** Arc-length positions a ground profile should be sampled at. */
export function groundSampleStations(path: FlyoverPath, behindM: number, aheadM: number, stepM = PATH_STEP_M): { s0: number; stations: number[] } {
    const s0 = -behindM - stepM;
    const end = path.length + aheadM + stepM;
    const stations: number[] = [];
    for (let s = s0; s <= end + 1e-9; s += stepM) stations.push(s);
    return { s0, stations };
}

/**
 * Build a profile from raw samples, filling gaps (null = outside tile
 * coverage) from the nearest known neighbour. All-null → flat zero.
 */
export function fillGroundProfile(s0: number, stepM: number, raw: ReadonlyArray<number | null>): GroundProfile {
    const values = new Array<number>(raw.length);
    let last: number | null = null;
    for (let i = 0; i < raw.length; i++) {
        const v = raw[i];
        if (v !== null && Number.isFinite(v)) last = v;
        values[i] = last ?? Number.NaN;
    }
    // Leading gap: back-fill from the first known value.
    let first: number | null = null;
    for (const v of values) if (!Number.isNaN(v)) { first = v; break; }
    for (let i = 0; i < values.length; i++) values[i] = Number.isNaN(values[i]) ? (first ?? 0) : values[i];
    return { s0, stepM, values };
}

/** Linearly interpolated ground height at arc length `s`, clamped at the ends. */
export function groundAt(profile: GroundProfile, s: number): number {
    const { s0, stepM, values } = profile;
    if (values.length === 0) return 0;
    const f = (s - s0) / stepM;
    if (f <= 0) return values[0];
    if (f >= values.length - 1) return values[values.length - 1];
    const i = Math.floor(f);
    const t = f - i;
    return values[i] + (values[i + 1] - values[i]) * t;
}

/** Pitch (MapLibre convention) for a camera `dAlt` above its target at `horizontalM`. */
export function pitchFor(horizontalM: number, dAlt: number): number {
    return 90 - Math.atan2(dAlt, horizontalM) / DEG;
}

/** Compose a pose from camera + target positions and altitudes. */
export function poseFromTo(from: LngLat, altFrom: number, to: LngLat, altTo: number): CameraPose {
    return {
        from,
        altFrom,
        to,
        altTo,
        bearing: bearingDeg(from, to),
        pitch: pitchFor(distanceM(from, to), altFrom - altTo),
    };
}

/** Arc length where the eye stops: `standoffM` short of the green, never below 0. */
export function eyePathLength(path: FlyoverPath, standoffM = FLYOVER_END_STANDOFF_M): number {
    return Math.max(0, path.length - standoffM);
}

/**
 * Camera pose while flying: the eye is on the path at arc length `s`,
 * `eyeHeightM` above the ground there, and looks at the path point
 * `lookAheadM` ahead (clamped to the green) at `lookHeightM` above ground.
 * Ground and heights scale by `exaggeration` to match MapLibre's exaggerated
 * terrain mesh.
 *
 * The geometric pitch is 90 - atan((eyeH - lookH) / lookAhead): with the
 * defaults 5 m / 2 m / 120 m that is 88.6°, past MapLibre's 85° maximum. The
 * pose reports the geometric value; the service raises `maxPitch` to 85 and
 * MapLibre clamps on `jumpTo` (the eye then sits ~12.5 m above ground, i.e.
 * lookAhead * tan(5°) + lookH, with the look point fixed). As the eye nears the green the look distance shrinks
 * to `FLYOVER_END_STANDOFF_M` and the pitch drops to ~79°, under the cap.
 *
 * Heading is the bearing eye → look point. Because the look point is 120 m
 * ahead on a Catmull-Rom spline, the heading is a running chord over 120 m of
 * path: corner turns spread over the approach rather than stepping at the
 * aim point (`tests/flyover-path.test.ts` bounds the per-step change).
 */
export function cameraPose(
    path: FlyoverPath,
    s: number,
    ground: (s: number) => number,
    opts: PoseOptions,
): CameraPose {
    const sTo = Math.min(path.length, s + opts.lookAheadM);
    const from = pointAlong(path, s);
    const to = pointAlong(path, sTo);
    const altFrom = (ground(s) + opts.eyeHeightM) * opts.exaggeration;
    const altTo = (ground(sTo) + opts.lookHeightM) * opts.exaggeration;
    return poseFromTo(from, altFrom, to, altTo);
}

/** Linear blend between two poses (positions + altitudes; angles recomputed). */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
    const mix = (x: number, y: number) => x + (y - x) * t;
    return poseFromTo(
        { lng: mix(a.from.lng, b.from.lng), lat: mix(a.from.lat, b.from.lat) },
        mix(a.altFrom, b.altFrom),
        { lng: mix(a.to.lng, b.to.lng), lat: mix(a.to.lat, b.to.lat) },
        mix(a.altTo, b.altTo),
    );
}

/** Symmetric ease in/out (cubic). */
export function easeInOutCubic(t: number): number {
    const x = Math.min(1, Math.max(0, t));
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Flight duration for `lengthM` of eye path at constant `speedMs`, with a
 * speed ramp of `easeMs` at each end. A symmetric ramp covers half the
 * distance a constant-speed segment would, so the two ramps together cost
 * exactly one `easeMs` over the pure `length / speed` time. Floor: `minMs`.
 */
export function flyoverDurationMs(
    lengthM: number,
    speedMs = FLYOVER_SPEED_M_S,
    easeMs = FLYOVER_EASE_MS,
    minMs = FLYOVER_MIN_FLIGHT_MS,
): number {
    return Math.max(minMs, (lengthM / speedMs) * 1000 + easeMs);
}

/** Integral of smoothstep(x) = 3x² − 2x³ from 0 to x. */
function smoothstepIntegral(x: number): number {
    return x * x * x - x * x * x * x / 2;
}

/**
 * Fraction of the path covered at normalised time `u` ∈ [0, 1] when the
 * speed ramps up with a smoothstep over the first `ramp` of the time, holds
 * constant, and ramps down over the last `ramp` (ramp ≤ 0.5). Speed is
 * continuous and so is acceleration at the ramp ends. With
 * `ramp = easeMs / durationMs` the cruise speed equals `FLYOVER_SPEED_M_S`
 * for any duration `flyoverDurationMs` returns above the floor.
 */
export function flightProgress(u: number, ramp: number): number {
    const x = Math.min(1, Math.max(0, u));
    const r = Math.min(0.5, Math.max(0, ramp));
    // Normalising area: r/2 per ramp + (1 − 2r) cruise = 1 − r.
    const area = 1 - r;
    if (r === 0) return x;
    let d: number;
    if (x < r) d = r * smoothstepIntegral(x / r);
    else if (x <= 1 - r) d = r / 2 + (x - r);
    else d = area - r * smoothstepIntegral((1 - x) / r);
    return d / area;
}
