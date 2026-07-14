// Feature-distances engine — the yardage-list assembly layer
// (feature-distances-yardages.md §5.3). Pure composition, ZERO new math:
// bearing from origin→target, segmentStats (plays-like.ts) for line +
// elevation, hazardsAlongLine (carry.ts) to expand a hazard target into
// front/carry rows, windEffect/playsAsM (wind.ts) for the wind delta, and
// clubAdvice (club.ts) for the suggested club. This module owns no domain
// entities (Green / CourseFeature / AimPoint) — callers adapt those into
// DistanceTarget (decision: feature owns a generic target, doc §4.2).
//
// Units & conventions: points are projected planar meters (EPSG:3006-style
// {x, y}); bearings are compass degrees (0 = north, clockwise), matching
// bearingToUnitVector's convention in ellipse.ts. Wind speed m/s, direction
// = where the wind comes FROM (wind.ts).
//
// Null-propagation contract (doc §5.3, exact):
//  - `lineM` is ALWAYS present — a straight-line distance never depends on
//    elevation or wind.
//  - `elevationDeltaM` is null when either endpoint lacks a DEM elevation
//    sample (segmentStats returns it undefined in that case).
//  - `playsLikeM` is null whenever `elevationDeltaM` is null — plays-like is
//    defined as line + elevationΔ (segmentStats.playsLikeSimpleM), so it
//    cannot exist without a resolved elevation delta.
//  - `windDeltaM` is null when wind is absent from the input. It is computed
//    as `playsAsM(playsLikeM, effect) − playsLikeM`, so it ALSO requires a
//    non-null playsLikeM; wind-with-missing-elevation still yields null
//    (there is no elevation-free plays-like number to adjust).
// The engine NEVER collapses these three deltas into one number — the UI
// (T5) renders them separably (doc §4.4).
//
// Hazard bearing: a 'hazard' target is a ring, not a point, so there is no
// origin→target bearing to derive the way there is for a 'point' target.
// The caller supplies one reference `bearingDeg` in FeatureDistancesInput —
// the shot line hazard rays are cast along (decision D6: default is
// origin→green-centre, overridden by a selected aim point; that policy
// lives in the web adapter, T5 — this engine just takes the resolved
// bearing). The same reference bearing is reused as the wind-projection
// bearing for hazard rows (there is no other bearing to project onto).

import { hazardsAlongLine, type CarryOverHazard } from './carry';
import { type ClubSpec, clubAdvice } from './club';
import { type FlatRing } from './corridor';
import { segmentStats, type StrategyPoint } from './plays-like';
import { playsAsM, windEffect } from './wind';

/** Which reference point on the green (or elsewhere) a 'point' target is. */
export type PointRole = 'green_front' | 'green_center' | 'green_back' | 'layup' | 'aim' | 'pin';

/**
 * A target the engine can measure to. 'point' is any single point with a
 * role tag (green reference points, layups, aim points, pin). 'hazard' is a
 * ring (bunker/water/…); the engine expands it into up to two rows (front
 * and carry) via hazardsAlongLine, cast along the input's shared
 * `bearingDeg` (see module header).
 */
export type DistanceTarget =
    | { kind: 'point'; label: string; role: PointRole; at: StrategyPoint }
    | { kind: 'hazard'; label: string; ring: FlatRing };

/**
 * One row of the yardage list. `kind` is the target's PointRole for 'point'
 * targets, or 'hazard_front' / 'hazard_carry' for the two rows a crossed
 * hazard ring expands into. See module header for the null-propagation
 * contract on the three delta fields.
 */
export interface FeatureDistance {
    kind: PointRole | 'hazard_front' | 'hazard_carry';
    label: string;
    /** Bearing from origin to this row's point, compass degrees. */
    bearingDeg: number;
    /** Straight-line ground distance, meters. Always present. */
    lineM: number;
    /** Signed elevation delta, meters (uphill positive). Null: no DEM at an endpoint. */
    elevationDeltaM: number | null;
    /** lineM + elevationDeltaM (segmentStats.playsLikeSimpleM). Null when elevationDeltaM is null. */
    playsLikeM: number | null;
    /** playsAsM(playsLikeM, windEffect(...)) − playsLikeM. Null when wind is absent or playsLikeM is null. */
    windDeltaM: number | null;
    /** Club whose carry is nearest the wind-adjusted plays-like distance, if clubs were supplied. */
    club?: ClubSpec;
}

export interface FeatureDistancesInput {
    /** Shot origin, planar meters. Elevation must already be filled by the caller's provider. */
    origin: StrategyPoint;
    /** Targets to measure to — adapters produce these from domain entities. */
    targets: readonly DistanceTarget[];
    /**
     * Reference shot bearing, compass degrees, used to cast hazard rays
     * (hazard targets have no point of their own — see module header) and
     * as the wind-projection bearing for the resulting hazard rows.
     */
    bearingDeg: number;
    /** Wind speed m/s + direction FROM, compass degrees. Omit for calm / unknown. */
    wind?: { speedMps: number; directionDeg: number };
    /** Player's clubs, for the per-row club suggestion. Omit to skip club advice. */
    clubs?: readonly ClubSpec[];
}

/**
 * Assemble the sorted yardage list for one origin. Pure composition over
 * segmentStats / hazardsAlongLine / windEffect / playsAsM / clubAdvice — see
 * module header for the exact null-propagation rules. Rows are sorted
 * ascending by `lineM`.
 */
export function featureDistances(input: FeatureDistancesInput): FeatureDistance[] {
    const { origin, targets, bearingDeg, wind, clubs } = input;
    const rows: FeatureDistance[] = [];

    for (const target of targets) {
        if (target.kind === 'point') {
            rows.push(buildRow(target.role, target.label, origin, target.at, wind, clubs));
            continue;
        }

        const hazards = hazardsAlongLine(origin, bearingDeg, [target.ring]);
        for (const hazard of hazards) {
            rows.push(buildHazardRow('hazard_front', `${target.label} front`, origin, bearingDeg, hazard.frontM, wind, clubs));
            rows.push(buildHazardRow('hazard_carry', `${target.label} carry`, origin, bearingDeg, hazard.carryM, wind, clubs));
        }
    }

    rows.sort((a, b) => a.lineM - b.lineM);
    return rows;
}

/** Bearing from `from` to `to`, compass degrees [0, 360) — inverse of bearingToUnitVector. */
function bearingBetween(from: StrategyPoint, to: StrategyPoint): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
}

/** Build one row for a 'point' target: its own origin→target bearing and line. */
function buildRow(
    kind: FeatureDistance['kind'],
    label: string,
    origin: StrategyPoint,
    at: StrategyPoint,
    wind: FeatureDistancesInput['wind'],
    clubs: FeatureDistancesInput['clubs'],
): FeatureDistance {
    const stats = segmentStats(origin, at);
    const rowBearingDeg = bearingBetween(origin, at);
    return finishRow(kind, label, rowBearingDeg, stats.horizontalM, stats.playsLikeSimpleM, wind, clubs);
}

/**
 * Build one row for a hazard-expanded distance (front or carry): the point
 * is `distanceM` along the shared reference bearing from origin, so line +
 * elevation come from segmentStats against that projected point.
 */
function buildHazardRow(
    kind: FeatureDistance['kind'],
    label: string,
    origin: StrategyPoint,
    bearingDeg: number,
    distanceM: number,
    wind: FeatureDistancesInput['wind'],
    clubs: FeatureDistancesInput['clubs'],
): FeatureDistance {
    // Hazard rows have no elevation-sampled point of their own (the ring's
    // edges aren't sampled here) — segmentStats against a same-elevation
    // point degrades exactly like any other missing-elevation endpoint: use
    // origin's own elevation only if we had a matching point, but we don't,
    // so elevation is unresolved for hazard rows (undefined at, not implied
    // flat). We model the projected point as {x, y} with no elevation field,
    // which segmentStats treats as "no DEM sample" → null propagation.
    const projected: StrategyPoint = projectAlong(origin, bearingDeg, distanceM);
    const stats = segmentStats(origin, projected);
    return finishRow(kind, label, bearingDeg, stats.horizontalM, stats.playsLikeSimpleM, wind, clubs);
}

function projectAlong(origin: StrategyPoint, bearingDeg: number, distanceM: number): StrategyPoint {
    const rad = (bearingDeg * Math.PI) / 180;
    return { x: origin.x + distanceM * Math.sin(rad), y: origin.y + distanceM * Math.cos(rad) };
}

function finishRow(
    kind: FeatureDistance['kind'],
    label: string,
    bearingDeg: number,
    lineM: number,
    playsLikeSimpleM: number | undefined,
    wind: FeatureDistancesInput['wind'],
    clubs: FeatureDistancesInput['clubs'],
): FeatureDistance {
    const elevationDeltaM = playsLikeSimpleM === undefined ? null : playsLikeSimpleM - lineM;
    const playsLikeM = playsLikeSimpleM === undefined ? null : playsLikeSimpleM;

    let windDeltaM: number | null = null;
    if (wind && playsLikeM !== null) {
        const effect = windEffect(wind.speedMps, wind.directionDeg, bearingDeg, playsLikeM);
        windDeltaM = playsAsM(playsLikeM, effect) - playsLikeM;
    }

    const row: FeatureDistance = { kind, label, bearingDeg, lineM, elevationDeltaM, playsLikeM, windDeltaM };

    if (clubs && clubs.length > 0) {
        const targetForClub = (playsLikeM ?? lineM) + (windDeltaM ?? 0);
        const advice = clubAdvice(clubs, targetForClub);
        if (advice.center) row.club = advice.center;
    }

    return row;
}
