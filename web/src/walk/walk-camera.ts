/**
 * Pure maths for the ground-level "walk" camera: look-direction to a
 * look-at target, WASD move vectors, clamping, the enter/exit transition
 * blend and the initial look direction (next aim point > 100 m away, else
 * the green). No MapLibre, no DI — unit-tested in `tests/walk-camera.test.ts`.
 *
 * Distances are metres on a local equirectangular plane (same convention as
 * `flyover-path.ts`); a hole is < 1 km so the error is negligible.
 */

import { bearingDeg, distanceM, metersPerDegree, type LngLat } from '../flyover/flyover-path';

export type { LngLat };

/** Where the eye is and where it looks. Angles in degrees. */
export interface WalkPose {
    eye: LngLat;
    /** Eye altitude, metres above sea level (unexaggerated). */
    eyeAlt: number;
    /** Compass heading the eye looks along, [0, 360). */
    heading: number;
    /**
     * Elevation angle of the view direction: 0 = horizon, negative = down.
     * MapLibre caps pitch at 85°, and pitch = 90° + tilt for a camera looking
     * down at its target, so the usable tilt range is [-60°, -5°]: -5° is as
     * close to horizon-level as the engine allows, -60° is a steep look at
     * the ground a few metres ahead.
     */
    tilt: number;
}

/** "From here, look at there" — the MapLibre camera input. Altitudes unexaggerated. */
export interface WalkFromTo {
    from: LngLat;
    altFrom: number;
    to: LngLat;
    altTo: number;
    /** Heading carried along so a straight-down transition start keeps its bearing. */
    heading: number;
}

/** Default eye height above ground, metres. */
export const WALK_EYE_HEIGHT_M = 2.0;
/** Q/E height range, metres. */
export const WALK_MIN_EYE_HEIGHT_M = 1.0;
export const WALK_MAX_EYE_HEIGHT_M = 60.0;
/** Eye height change rate for Q/E, metres per second. */
export const WALK_HEIGHT_RATE_M_S = 12.0;
/** Tilt limits (see WalkPose.tilt). */
export const WALK_TILT_MIN = -60;
export const WALK_TILT_MAX = -5;
/** Distance from eye to the synthetic look-at target, metres. */
export const WALK_LOOK_DISTANCE_M = 50;
/** Walking speed: 60 km/h; Shift multiplies it (180 km/h). */
export const WALK_SPEED_M_S = 60 / 3.6;
export const WALK_FAST_MULTIPLIER = 3;
/** Mouse-look sensitivity, degrees per pixel (yaw and tilt). */
export const WALK_YAW_DEG_PER_PX = 0.25;
/** Arrow-key look rates, degrees per second. */
export const WALK_ARROW_YAW_DEG_S = 90;
export const WALK_ARROW_TILT_DEG_S = 45;
/** Enter/exit camera transition, ms. */
export const WALK_TRANSITION_MS = 1500;
/** An aim point closer than this is skipped when picking the initial look target. */
export const WALK_NEXT_AIM_MIN_M = 100;

const DEG = Math.PI / 180;

export function clampTilt(tilt: number): number {
    return Math.min(WALK_TILT_MAX, Math.max(WALK_TILT_MIN, tilt));
}

export function clampEyeHeight(h: number): number {
    return Math.min(WALK_MAX_EYE_HEIGHT_M, Math.max(WALK_MIN_EYE_HEIGHT_M, h));
}

/** Normalise a heading into [0, 360). */
export function wrapHeading(deg: number): number {
    return ((deg % 360) + 360) % 360;
}

/** MapLibre pitch (0 = straight down) for a view tilt (0 = horizon). */
export function pitchFromTilt(tilt: number): number {
    return 90 + tilt;
}

/** View tilt for a MapLibre pitch. */
export function tiltFromPitch(pitch: number): number {
    return pitch - 90;
}

/** Offset a point by metres east / north. */
export function offsetM(p: LngLat, eastM: number, northM: number): LngLat {
    const m = metersPerDegree(p.lat);
    return { lng: p.lng + eastM / m.x, lat: p.lat + northM / m.y };
}

/**
 * Look-at target `distM` along the view direction: horizontal reach
 * distM·cos(tilt) along the heading, vertical drop distM·sin(tilt).
 */
export function lookTarget(pose: WalkPose, distM = WALK_LOOK_DISTANCE_M): { to: LngLat; altTo: number } {
    const tilt = pose.tilt * DEG;
    const horizontal = distM * Math.cos(tilt);
    const h = pose.heading * DEG;
    return {
        to: offsetM(pose.eye, horizontal * Math.sin(h), horizontal * Math.cos(h)),
        altTo: pose.eyeAlt + distM * Math.sin(tilt),
    };
}

/** Expand a pose into the from/to pair MapLibre consumes. */
export function fromTo(pose: WalkPose, distM = WALK_LOOK_DISTANCE_M): WalkFromTo {
    const { to, altTo } = lookTarget(pose, distM);
    return { from: pose.eye, altFrom: pose.eyeAlt, to, altTo, heading: pose.heading };
}

export interface MoveKeys {
    forward: boolean;
    back: boolean;
    left: boolean;
    right: boolean;
}

/**
 * Ground-plane displacement (metres east, north) for the held movement keys
 * over `dtSec`. Forward/back run along the heading, strafe is perpendicular;
 * diagonals are normalised so W+D is not faster than W. Tilt does not affect
 * movement: walking is on the ground plane.
 */
export function moveVector(heading: number, keys: MoveKeys, speedMs: number, dtSec: number): { east: number; north: number } {
    let fwd = 0;
    let side = 0;
    if (keys.forward) fwd += 1;
    if (keys.back) fwd -= 1;
    if (keys.right) side += 1;
    if (keys.left) side -= 1;
    const len = Math.hypot(fwd, side);
    if (len === 0) return { east: 0, north: 0 };
    fwd /= len;
    side /= len;
    const h = heading * DEG;
    const step = speedMs * dtSec;
    // Forward unit = (sin h, cos h); right unit = (cos h, -sin h).
    return {
        east: step * (fwd * Math.sin(h) + side * Math.cos(h)),
        north: step * (fwd * Math.cos(h) - side * Math.sin(h)),
    };
}

/** Walking speed for the modifier state. */
export function walkSpeed(fast: boolean): number {
    return WALK_SPEED_M_S * (fast ? WALK_FAST_MULTIPLIER : 1);
}

/** Apply a mouse-look delta: yaw with dx, tilt inverted so dragging up looks up. */
export function applyLook(pose: WalkPose, dxPx: number, dyPx: number, degPerPx = WALK_YAW_DEG_PER_PX): WalkPose {
    return {
        ...pose,
        heading: wrapHeading(pose.heading + dxPx * degPerPx),
        tilt: clampTilt(pose.tilt - dyPx * degPerPx),
    };
}

/** Shortest-arc blend between two headings. */
export function lerpHeading(a: number, b: number, t: number): number {
    let d = wrapHeading(b - a);
    if (d > 180) d -= 360;
    return wrapHeading(a + d * t);
}

/** Blend two poses: positions and altitude linearly, heading along the shortest arc. */
export function lerpWalkPose(a: WalkPose, b: WalkPose, t: number): WalkPose {
    const mix = (x: number, y: number) => x + (y - x) * t;
    return {
        eye: { lng: mix(a.eye.lng, b.eye.lng), lat: mix(a.eye.lat, b.eye.lat) },
        eyeAlt: mix(a.eyeAlt, b.eyeAlt),
        heading: lerpHeading(a.heading, b.heading, t),
        tilt: mix(a.tilt, b.tilt),
    };
}

/**
 * Initial look target from `from`: the first aim point in hole order that
 * lies more than `minM` away, otherwise the green centre. Null when the hole
 * has neither (caller keeps the map's current bearing).
 */
export function initialLookTarget(from: LngLat, aims: readonly LngLat[], green: LngLat | null, minM = WALK_NEXT_AIM_MIN_M): LngLat | null {
    for (const aim of aims) if (distanceM(from, aim) > minM) return aim;
    return green;
}

/** Heading toward `target`, or `fallback` when there is none / it coincides with `from`. */
export function initialHeading(from: LngLat, target: LngLat | null, fallback: number): number {
    if (!target || distanceM(from, target) < 0.5) return wrapHeading(fallback);
    return bearingDeg(from, target);
}

/** The pose walk mode enters at: standing at `at`, horizon-level, looking along `heading`. */
export function entryPose(at: LngLat, groundAlt: number, heading: number, eyeHeightM = WALK_EYE_HEIGHT_M): WalkPose {
    return { eye: at, eyeAlt: groundAlt + eyeHeightM, heading: wrapHeading(heading), tilt: WALK_TILT_MAX };
}
