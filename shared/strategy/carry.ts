// Along-line hazard front/carry distances for the yardage-list engine.
//
// Pure planar geometry in projected meters (EPSG:3006-style {x, y}).
// Bearings are compass degrees (0 = north, clockwise). Callers pre-flatten
// and pre-filter obstacle rings; this module only answers which rings the
// shot line crosses and where their near/far boundaries are.

import { pointInRing, type FlatRing } from './corridor';
import { bearingToUnitVector, type Vec2 } from './ellipse';
import { rayRingIntersections } from './ray';

export interface CarryOverHazard {
    ring: FlatRing;
    /** Near-edge distance along the shot line, meters. */
    frontM: number;
    /** Far-edge distance along the shot line, meters. */
    carryM: number;
}

export function hazardsAlongLine(
    origin: Vec2,
    bearingDeg: number,
    obstacles: readonly FlatRing[],
    maxM = Infinity,
): CarryOverHazard[] {
    const dir = bearingToUnitVector(bearingDeg);
    const out: CarryOverHazard[] = [];

    for (const ring of obstacles) {
        const hits = rayRingIntersections(origin, dir, ring.points, maxM);
        const originInside = ring.points.length >= 3 && pointInRing(origin, ring.points);

        if (originInside) {
            if (hits.length >= 1) {
                out.push({ ring, frontM: 0, carryM: hits[hits.length - 1] });
            }
            continue;
        }

        if (hits.length >= 2 && hasInteriorInterval(origin, dir, ring.points, hits)) {
            out.push({ ring, frontM: hits[0], carryM: hits[hits.length - 1] });
        }
    }

    return out;
}

function hasInteriorInterval(origin: Vec2, dir: Vec2, points: readonly Vec2[], hits: readonly number[]): boolean {
    if (points.length < 3) return false;

    for (let i = 0; i < hits.length - 1; i++) {
        const mid = (hits[i] + hits[i + 1]) / 2;
        const p = {
            x: origin.x + dir.x * mid,
            y: origin.y + dir.y * mid,
        };
        if (pointInRing(p, points)) return true;
    }

    return false;
}
