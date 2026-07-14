// Wind decomposition + carry adjustment.
//
// Units & conventions:
//  - Canonical input wind speed is m/s (m/s end-to-end per ROADMAP); the
//    calibration table is keyed in mph, so we convert internally with the
//    exact constant (units.ts MPS_TO_MPH). mph never leaves this module.
//  - Bearings/directions in degrees, compass convention: 0 = north,
//    clockwise. `windDirectionDeg` is the direction the wind comes FROM
//    (meteorological). windDirection == shotBearing → dead headwind.
//  - headTailMph: negative = headwind, positive = tailwind.
//  - crosswindMph: positive = wind from the shooter's LEFT, pushing the
//    ball toward shot-RIGHT; negative = from the right, drifting left.
//    (Derivation: wind from bearing−90 → rel = 90 → sin = +1; wind coming
//    from the left blows toward the right of the shot line.)
//  - windEffect is a fractional carry multiplier: adjusted = carry × (1+e).
//
// WIND MODEL (calibrated 2026-07 — supersedes the v1 linear-per-mph curve):
// the plays-as effect is NOT a fixed percentage per mph. Real data shows the
// percentage effect varies ~3× with shot distance — long clubs punch through
// wind far better than short ones. We interpolate a calibration grid instead.

import { mpsToMph } from './units';

const DEG_TO_RAD = Math.PI / 180;
const YARDS_PER_METER = 1 / 0.9144;

// ---------------------------------------------------------------------------
// Ballnamic plays-as wind table (PGA competition, calibrated 2026-07).
//
// Adjustments in YARDS added to (hurting / head wind) or subtracted from
// (helping / tail wind) the shot's playing distance, per PURE head/tail wind
// speed in mph. Rows are shot-distance bands, keyed by a representative
// distance in yards. This raw table IS the calibration record — keep it
// legible; the fraction grids below are derived from it at module load.
//
// Distance nodes ascending; speed nodes ascending (mph).
// ---------------------------------------------------------------------------

/** Shot-distance nodes for the wind grid, yards (ascending). */
export const WIND_DISTANCE_NODES_YD = [115, 140, 162.5, 187.5, 225, 285];
/** Head/tail component nodes for the wind grid, mph (ascending). */
export const WIND_SPEED_NODES_MPH = [5, 10, 15, 20, 25];

// Hurting (head wind) — yards ADDED to the playing distance, per row/speed.
const HURT_YD = [
    [5, 11, 18, 26, 35], // 115
    [6, 12, 20, 28, 38], // 140
    [6, 14, 23, 32, 43], // 162.5
    [7, 15, 24, 35, 47], // 187.5
    [5, 11, 19, 28, 38], // 225
    [4, 9, 15, 21, 28], // 285
];

// Helping (tail wind) — yards SUBTRACTED from the playing distance (listed
// positive here). Note helping saturates and the 225 row even reverses.
//
// OPEN CALIBRATION QUESTION (2026-07): an independent TrackMan-style source
// (golfwrx.com/318416, 140 yd shot) matches this table's hurting column to
// within 0.5 yd at every speed, but shows tail wind saturating much harder
// above 15 mph (+12.5 yd at 25 mph vs this table's +17). Ballnamic may be
// ~30% optimistic on strong tail winds; revisit with better data.
const HELP_YD = [
    [4, 8, 11, 14, 16], // 115
    [5, 9, 12, 15, 17], // 140
    [5, 10, 13, 16, 18], // 162.5
    [6, 10, 14, 17, 18], // 187.5
    [4, 6, 8, 8, 7], // 225
    [4, 7, 9, 11, 12], // 285
];

// Convert each table cell to a plays-as FRACTION a = adjustmentYd / distanceYd
// (precomputed at module init). `a` is the fraction of the shot distance the
// wind adds (hurting) or removes (helping).
const HURT_A = HURT_YD.map((row, i) => row.map((yd) => yd / WIND_DISTANCE_NODES_YD[i]));
const HELP_A = HELP_YD.map((row, i) => row.map((yd) => yd / WIND_DISTANCE_NODES_YD[i]));

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
 * Fraction `a` for ONE distance row at the given |head/tail| component,
 * applying the speed-axis interpolation/extrapolation policy:
 *  - 0 mph → 0; 0–5 mph → linear from a=0 at 0 to the 5-mph column;
 *  - 5–25 mph → linear interpolation between the bracketing columns;
 *  - > 25 mph, hurting → linear extrapolation of the 20→25 segment, but
 *    evaluated at min(speed, 35) so the fraction caps at its 35-mph value;
 *  - > 25 mph, helping → clamp to the 25-mph column (helping saturates).
 */
function rowFraction(row: number[], speedMph: number, hurting: boolean): number {
    const nodes = WIND_SPEED_NODES_MPH;
    const last = nodes.length - 1;
    if (speedMph <= 0) return 0;
    if (speedMph <= nodes[0]) return row[0] * (speedMph / nodes[0]);
    if (speedMph >= nodes[last]) {
        if (hurting) {
            const capped = Math.min(speedMph, 35);
            const slope = (row[last] - row[last - 1]) / (nodes[last] - nodes[last - 1]);
            return row[last] + slope * (capped - nodes[last]);
        }
        return row[last];
    }
    let hi = 1;
    while (nodes[hi] < speedMph) hi++;
    const lo = hi - 1;
    const t = (speedMph - nodes[lo]) / (nodes[hi] - nodes[lo]);
    return row[lo] + (row[hi] - row[lo]) * t;
}

/**
 * Bilinear-interpolated plays-as fraction from the calibration grid. Distance
 * is clamped to [115, 285] yd (below 115 → 115 row, above 285 → 285 row); the
 * speed axis follows `rowFraction`'s policy.
 */
function gridFraction(distanceYd: number, speedMph: number, hurting: boolean): number {
    const grid = hurting ? HURT_A : HELP_A;
    const nodes = WIND_DISTANCE_NODES_YD;
    const d = Math.min(Math.max(distanceYd, nodes[0]), nodes[nodes.length - 1]);
    let hi = 1;
    while (hi < nodes.length - 1 && nodes[hi] < d) hi++;
    const lo = hi - 1;
    const t = (d - nodes[lo]) / (nodes[hi] - nodes[lo]);
    const aLo = rowFraction(grid[lo], speedMph, hurting);
    const aHi = rowFraction(grid[hi], speedMph, hurting);
    return aLo + (aHi - aLo) * t;
}

/**
 * Fractional carry multiplier for wind, from the Ballnamic calibration grid.
 * `shotDistanceM` is the distance of the shot being evaluated (the club's
 * NOMINAL carry for forward application; the target's straight-line distance
 * for plays-as). Bilinear-interpolate the plays-as fraction `a` from the
 * hurting grid (head wind, headTail < 0) or helping grid (tail wind), keyed on
 * the head/tail COMPONENT magnitude and the shot distance, then convert to the
 * effect `e` the application forms expect so playsAsM(D, e) reproduces the
 * table:
 *  - Hurting: plays-as = D×(1+a) → e = −a/(1+a) (negative, lengthens).
 *  - Helping: plays-as = D×(1−a) → e = a/(1−a) (positive, shortens).
 * Returns 0 for calm wind, non-positive distance, or a dead crosswind.
 */
export function windEffect(
    windSpeedMps: number,
    windDirectionDeg: number,
    shotBearingDeg: number,
    shotDistanceM: number,
): number {
    if (shotDistanceM <= 0 || windSpeedMps <= 0) return 0;
    const { headTailMph } = windComponents(windSpeedMps, windDirectionDeg, shotBearingDeg);
    if (headTailMph === 0) return 0;
    const hurting = headTailMph < 0;
    const a = gridFraction(shotDistanceM * YARDS_PER_METER, Math.abs(headTailMph), hurting);
    return hurting ? -a / (1 + a) : a / (1 - a);
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
 * Out of scope for the 2026-07 head/tail recalibration (no crosswind data
 * in the table). `carryM` is the club's NOMINAL carry (not wind-adjusted).
 */
export function crosswindDriftM(carryM: number, crosswindMph: number): number {
    return carryM * crosswindMph * 0.005;
}
