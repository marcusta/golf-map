// Wind decomposition + carry adjustment — exact port of v1
// GolfWeatherCalculator.swift (lines 10–57) plus the documented v1.1
// crosswind-drift extension (ROADMAP "Decided 2026-07-05, Phase 5 kickoff").
//
// Units & conventions:
//  - Canonical input wind speed is m/s (m/s end-to-end per ROADMAP); the
//    v1 curve constants are PER MPH, so we convert internally with the
//    exact v1 constant (units.ts MPS_TO_MPH). mph never leaves this module.
//  - Bearings/directions in degrees, compass convention: 0 = north,
//    clockwise. `windDirectionDeg` is the direction the wind comes FROM
//    (meteorological). windDirection == shotBearing → dead headwind.
//  - headTailMph: negative = headwind, positive = tailwind.
//  - crosswindMph: positive = wind from the shooter's LEFT, pushing the
//    ball toward shot-RIGHT; negative = from the right, drifting left.
//    (Derivation: wind from bearing−90 → rel = 90 → sin = +1; wind coming
//    from the left blows toward the right of the shot line.)
//  - windEffect is a fractional carry multiplier: adjusted = carry × (1+e).

import { mpsToMph } from './units';

const DEG_TO_RAD = Math.PI / 180;

export interface WindComponents {
    /** Along-shot component, mph. Negative = headwind, positive = tailwind. */
    headTailMph: number;
    /** Cross-shot component, mph. Positive = drifts the ball shot-right. */
    crosswindMph: number;
}

/**
 * Decompose wind into head/tail and cross components relative to a shot
 * bearing — exact v1 decomposition (GolfWeatherCalculator.swift:40–51):
 * rel = (windDirection − shotBearing + 180) mod 360, normalized [0, 360);
 * headTail = cos(rel)·mph; crosswind = sin(rel)·mph.
 */
export function windComponents(
    windSpeedMps: number,
    windDirectionDeg: number,
    shotBearingDeg: number,
): WindComponents {
    const windSpeedMph = mpsToMph(windSpeedMps);
    const rel = (windDirectionDeg - shotBearingDeg + 180) % 360;
    const normalized = rel < 0 ? rel + 360 : rel;
    return {
        headTailMph: Math.cos(normalized * DEG_TO_RAD) * windSpeedMph,
        crosswindMph: Math.sin(normalized * DEG_TO_RAD) * windSpeedMph,
    };
}

/**
 * Fractional carry multiplier for wind — exact v1 curve
 * (GolfWeatherCalculator.swift:20–38):
 *  - headwind component × 0.01/mph, or × 0.013/mph when the TOTAL wind
 *    speed exceeds 18 mph (strict >, total speed — not the component);
 *  - tailwind component × 0.005/mph, or × 0.0034/mph above 18 mph.
 * The >18 branch rescales the ENTIRE component, so the curve is
 * intentionally discontinuous at 18 mph (recon spec fixture F) — preserve,
 * do not smooth.
 */
export function windEffect(
    windSpeedMps: number,
    windDirectionDeg: number,
    shotBearingDeg: number,
): number {
    const windSpeedMph = mpsToMph(windSpeedMps);
    const { headTailMph } = windComponents(windSpeedMps, windDirectionDeg, shotBearingDeg);
    if (headTailMph < 0) {
        return windSpeedMph > 18 ? headTailMph * 0.013 : headTailMph * 0.01;
    }
    return windSpeedMph > 18 ? headTailMph * 0.0034 : headTailMph * 0.005;
}

/** Forward application: how far the club actually flies. carry × (1 + e). */
export function adjustedCarryM(carryM: number, effect: number): number {
    return carryM * (1 + effect);
}

/**
 * Inverse application ("plays as", v1 GreenDetailView.swift:172–181): the
 * effective distance a target plays to under wind. distance / (1 + e).
 * NOTE: deliberately NOT the algebraic inverse of adjustedCarryM applied
 * as ×(1−e) — v1 uses the division form; keep both directions distinct.
 */
export function playsAsM(distanceM: number, effect: number): number {
    return distanceM / (1 + effect);
}

/**
 * Lateral drift of the landing point from crosswind, meters. Positive =
 * shot-right (matches crosswindMph sign convention above).
 *
 * v1.1 EXTENSION (not v1 behavior): v1 computed the crosswind component
 * but never consumed it (recon spec §3). ROADMAP Phase-5 decision:
 * drift = carry × crosswind_mph × 0.005, applied to the dispersion-ellipse
 * center perpendicular to the bearing. Flagged for Phase 7 calibration.
 * `carryM` is the club's NOMINAL carry (not wind-adjusted).
 */
export function crosswindDriftM(carryM: number, crosswindMph: number): number {
    return carryM * crosswindMph * 0.005;
}
