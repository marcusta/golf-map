// Dispersion ellipse + distance rings, in projected planar meters
// (EPSG:3006-style {x, y}; +x = east, +y = north — callers convert to
// WGS84 at render time).
//
// The ellipse implements v1's INTENDED visualization (ROADMAP decision:
// "Dispersion visual = ellipse" — v1's DispersionEllipse class was dead
// code and four arcs shipped instead; we build the ellipse the kickoff
// mandates): center = origin + wind-adjusted carry along bearing (+
// crosswind drift perpendicular, the v1.1 extension), full extents =
// derived length dispersion × lateral dispersion, rotated by bearing.
//
// Units & conventions: meters throughout; bearings compass degrees
// (0 = north, clockwise); wind speed m/s, direction = where the wind
// comes FROM (see wind.ts). Club dispersion values are FULL extents
// (v1 gotcha #1), so semi-axes are half of them.
//
// Sources: v1 GolfClub.swift (dispersion tiers/bands),
// GolfWeatherCalculator.swift (wind), DispersionEllipseRenderer.swift
// (full-extent axes, rotation by bearing), MapCoordinator.swift:314–358
// (distance-ring radii).

import { lengthDispersionM, type ClubSpec } from './club';
import { adjustedCarryM, crosswindDriftM, windComponents, windEffect } from './wind';

/** A point/vector in projected planar meters (+x east, +y north). */
export interface Vec2 {
    x: number;
    y: number;
}

/**
 * Unit vector pointing along a compass bearing (0° = +y/north, 90° =
 * +x/east): (sin b, cos b).
 */
export function bearingToUnitVector(bearingDeg: number): Vec2 {
    const rad = (bearingDeg * Math.PI) / 180;
    return { x: Math.sin(rad), y: Math.cos(rad) };
}

export interface DispersionEllipseOptions {
    /** Shot origin (tee / aim point / plan shot), planar meters. */
    origin: Vec2;
    /** Shot bearing, compass degrees. */
    bearingDeg: number;
    club: ClubSpec;
    /** Wind speed in m/s. Omit both wind fields for a no-wind ellipse. */
    windSpeedMps?: number;
    /** Direction the wind comes FROM, compass degrees. */
    windDirectionDeg?: number;
    /** Polygon sample count (points on the ellipse). Default 48. */
    samples?: number;
}

export interface DispersionEllipse {
    /** Expected landing point: origin + adjusted carry + crosswind drift. */
    center: Vec2;
    /** Semi-axis along the shot line (length dispersion / 2), meters. */
    semiLengthM: number;
    /** Semi-axis across the shot line (lateral dispersion / 2), meters. */
    semiLateralM: number;
    /** The shot bearing the ellipse is rotated by, degrees. */
    bearingDeg: number;
    /**
     * CLOSED ring: `samples` points around the ellipse plus the first
     * point repeated as the last (length = samples + 1), counter-clockwise
     * in ellipse-local parameter starting at the far (down-range) tip.
     */
    polygon: Vec2[];
}

/**
 * The dispersion ellipse for one shot. With wind, the center moves by the
 * v1 wind effect along the bearing and by the v1.1 crosswind drift
 * perpendicular to it (positive drift = shot-right); the axes themselves
 * are wind-independent (derived from the club alone).
 */
export function dispersionEllipse(options: DispersionEllipseOptions): DispersionEllipse {
    const { origin, bearingDeg, club } = options;
    const samples = options.samples ?? 48;

    const hasWind = options.windSpeedMps !== undefined && options.windDirectionDeg !== undefined;
    const effect = hasWind
        ? windEffect(options.windSpeedMps!, options.windDirectionDeg!, bearingDeg)
        : 0;
    const driftM = hasWind
        ? crosswindDriftM(
              club.carryM,
              windComponents(options.windSpeedMps!, options.windDirectionDeg!, bearingDeg).crosswindMph,
          )
        : 0;

    const along = bearingToUnitVector(bearingDeg);
    // Perpendicular pointing shot-RIGHT (bearing + 90°) = (cos b, −sin b).
    const right: Vec2 = { x: along.y, y: -along.x };

    const carry = adjustedCarryM(club.carryM, effect);
    const center: Vec2 = {
        x: origin.x + carry * along.x + driftM * right.x,
        y: origin.y + carry * along.y + driftM * right.y,
    };

    // v1 dispersion values are FULL extents → semi-axes are halves.
    const semiLengthM = lengthDispersionM(club.carryM) / 2;
    const semiLateralM = club.dispersionM / 2;

    const polygon: Vec2[] = [];
    for (let i = 0; i < samples; i++) {
        const t = (i / samples) * 2 * Math.PI;
        const u = semiLengthM * Math.cos(t); // along the shot line
        const v = semiLateralM * Math.sin(t); // across, toward shot-right
        polygon.push({
            x: center.x + u * along.x + v * right.x,
            y: center.y + u * along.y + v * right.y,
        });
    }
    polygon.push({ ...polygon[0] }); // explicit closure

    return { center, semiLengthM, semiLateralM, bearingDeg, polygon };
}

// ---------------------------------------------------------------------------
// Distance rings (v1 MapCoordinator.swift addDistanceArcs, lines 314–358)
// ---------------------------------------------------------------------------

/** Green-centered ring radii, meters (75 blue / 100 red / 150 yellow in v1). */
export const GREEN_RING_RADII_M: readonly number[] = [75, 100, 150];

/** Extra green-centered radius added on par 5s (v1: exactly 2 aim points). */
export const GREEN_RING_PAR5_EXTRA_M = 200;

/** Tee-centered full-circle radii, meters. */
export const TEE_RING_RADII_M: readonly number[] = [200, 250];

/** Green-centered radii for a hole: [75, 100, 150], plus 200 on a par 5. */
export function greenRingRadiiM(par: number): number[] {
    return par === 5 ? [...GREEN_RING_RADII_M, GREEN_RING_PAR5_EXTRA_M] : [...GREEN_RING_RADII_M];
}

/**
 * Planar circle as a CLOSED ring (first point repeated last, length
 * samples + 1), starting due north, clockwise (compass order).
 */
export function ringPolygon(center: Vec2, radiusM: number, samples = 64): Vec2[] {
    const out: Vec2[] = [];
    for (let i = 0; i < samples; i++) {
        const bearing = (i / samples) * 360;
        const dir = bearingToUnitVector(bearing);
        out.push({ x: center.x + radiusM * dir.x, y: center.y + radiusM * dir.y });
    }
    out.push({ ...out[0] });
    return out;
}
