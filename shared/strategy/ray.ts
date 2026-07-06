// Shared ray/ring intersection primitives for strategy geometry.
//
// Pure planar geometry in projected meters (EPSG:3006-style {x, y}).
// Ray directions are expected to be unit vectors; returned `t` values are
// therefore distances in meters along the ray. Rings are implicitly closed.

import type { Vec2 } from './ellipse';

const EPS = 1e-12;
const DEDUPE_EPS_M = 1e-9;

/**
 * All unique boundary-intersection distances (t >= 0) between a ray and a
 * ring's segments, sorted ascending. Parallel/coincident edges are ignored;
 * callers decide whether the resulting contacts represent a crossing,
 * tangent, or nearest boundary hit for their use case.
 */
export function rayRingIntersections(
    origin: Vec2,
    dir: Vec2,
    points: readonly Vec2[],
    maxDistanceM = Infinity,
): number[] {
    const hits: number[] = [];
    const n = points.length;

    for (let i = 0; i < n; i++) {
        const a = points[i];
        const b = points[(i + 1) % n];
        const sx = b.x - a.x;
        const sy = b.y - a.y;
        const denom = dir.x * sy - dir.y * sx; // dir x s
        if (Math.abs(denom) < EPS) continue; // parallel (or degenerate edge)

        const qx = a.x - origin.x;
        const qy = a.y - origin.y;
        const t = (qx * sy - qy * sx) / denom; // distance along the ray
        const u = (qx * dir.y - qy * dir.x) / denom; // position along the edge

        if (t >= -EPS && t <= maxDistanceM + EPS && u >= -EPS && u <= 1 + EPS) {
            hits.push(Math.abs(t) < EPS ? 0 : t);
        }
    }

    hits.sort((a, b) => a - b);

    const unique: number[] = [];
    for (const hit of hits) {
        if (unique.length === 0 || Math.abs(hit - unique[unique.length - 1]) > DEDUPE_EPS_M) {
            unique.push(hit);
        }
    }
    return unique;
}
