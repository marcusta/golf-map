// Corridor-width math for the plan-gate ruler: how far offline (left/right
// of the aim line) before the ball is in a hazard. New for Phase 5 (no v1
// equivalent — v1 only had the dispersion arc to eyeball against the hole);
// shape per ROADMAP "Decided 2026-07-05" (plan_gates / corridor ruler).
//
// Pure planar geometry in projected meters (EPSG:3006-style {x, y}).
// Bearings are compass degrees (0 = north, clockwise). "Left"/"right" are
// relative to FACING ALONG the corridor axis: left = axis − 90°, right =
// axis + 90°. The ruler itself is the perpendicular to `axisBearingDeg`.
//
// Hazard classification is the CALLER's job: this module receives only the
// rings that count as obstacles (pre-flattened, e.g. via web flattenRing /
// server geo.ts). DEFAULT_HAZARD_TYPES is the ROADMAP default set for that
// filtering — fairway/green/tee/semi_rough/rough/path are in play.

import { bearingToUnitVector, type Vec2 } from './ellipse';
import { rayRingIntersections } from './ray';

/** A flattened obstacle ring (implicitly closed) with its feature type. */
export interface FlatRing {
    points: Vec2[];
    /** Course-feature type, e.g. 'bunker' — informational passthrough. */
    kind: string;
}

/**
 * Default feature types treated as corridor obstacles. This includes physical
 * obstacles/surfaces (bunker, water, deep_rough, trees) and rules overlays
 * that should bound strategy corridors (penalty areas, OOB, outside). The
 * set is a parameter of the CALLER's ring filtering, not enforced here.
 */
export const DEFAULT_HAZARD_TYPES: readonly string[] = [
    'bunker',
    'water',
    'water_creek',
    'outside',
    'deep_rough',
    'trees',
    'penalty_yellow',
    'penalty_red',
    'oob',
];

export interface CorridorWidthOptions {
    /** Ruler station on (or near) the aim line, planar meters. */
    station: Vec2;
    /** Corridor-axis bearing (aim-line direction), compass degrees. */
    axisBearingDeg: number;
    /** Obstacle rings only — pre-filtered by the caller. */
    obstacles: readonly FlatRing[];
    /** Cap for each half-width, meters. Default 100. */
    maxHalfWidthM?: number;
}

export interface CorridorWidth {
    /** In-play half-width to the left of the axis, meters (≤ cap). */
    leftM: number;
    /** In-play half-width to the right of the axis, meters (≤ cap). */
    rightM: number;
    /** The ring that bounds the left side; undefined when capped. */
    leftHit?: FlatRing;
    /** The ring that bounds the right side; undefined when capped. */
    rightHit?: FlatRing;
}

/**
 * In-play half-widths at a station: cast the perpendicular ray left and
 * right of the axis and find the nearest obstacle-ring boundary each way.
 * A station INSIDE an obstacle yields 0/0 (you are already in the hazard).
 * No hit within `maxHalfWidthM` → that side reports the cap with no hit.
 */
export function corridorWidth(options: CorridorWidthOptions): CorridorWidth {
    const { station, axisBearingDeg, obstacles } = options;
    const maxHalfWidthM = options.maxHalfWidthM ?? 100;

    for (const ring of obstacles) {
        if (ring.points.length >= 3 && pointInRing(station, ring.points)) {
            return { leftM: 0, rightM: 0, leftHit: ring, rightHit: ring };
        }
    }

    const left = castRay(station, bearingToUnitVector(axisBearingDeg - 90), obstacles, maxHalfWidthM);
    const right = castRay(station, bearingToUnitVector(axisBearingDeg + 90), obstacles, maxHalfWidthM);

    return { leftM: left.distanceM, rightM: right.distanceM, leftHit: left.hit, rightHit: right.hit };
}

/** Nearest ring-boundary hit along a ray, capped. */
function castRay(
    origin: Vec2,
    dir: Vec2,
    obstacles: readonly FlatRing[],
    maxDistanceM: number,
): { distanceM: number; hit?: FlatRing } {
    let best = Infinity;
    let hit: FlatRing | undefined;
    for (const ring of obstacles) {
        const d = rayRingDistance(origin, dir, ring.points);
        if (d < best) {
            best = d;
            hit = ring;
        }
    }
    if (best > maxDistanceM) return { distanceM: maxDistanceM };
    return { distanceM: best, hit };
}

/**
 * Nearest intersection distance (t ≥ 0 along unit `dir`) between a ray and
 * a ring's segments (ring implicitly closed). Infinity when the ray misses.
 */
function rayRingDistance(origin: Vec2, dir: Vec2, points: readonly Vec2[]): number {
    return rayRingIntersections(origin, dir, points)[0] ?? Infinity;
}

/**
 * Point-in-polygon (ray casting) against an implicitly closed ring. Points
 * exactly on an edge may land on either side — acceptable for corridor
 * queries (same caveat as web pointInRing). Exported (decision D22) as the
 * shared primitive for aim.ts lie classification and the future carry.ts.
 */
export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = ring[i];
        const b = ring[j];
        const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
        if (intersects) inside = !inside;
    }
    return inside;
}
