// Unit conversions for the strategy math.
//
// Canonical storage/API unit for wind speed is m/s (ROADMAP, Phase 5
// kickoff decision). The v1 wind curve is stated per-mph, so the strategy
// modules convert internally with the EXACT v1 constant below (v1
// GolfWeatherCalculator.swift:12 — `mpsToMph(mps) = mps * 2.23694`).
// mph must never leak past display/input boundaries.

/** Exact v1 conversion constant (GolfWeatherCalculator.swift:12). */
export const MPS_TO_MPH = 2.23694;

/** Meters per second → miles per hour. */
export function mpsToMph(mps: number): number {
    return mps * MPS_TO_MPH;
}

/** Miles per hour → meters per second. */
export function mphToMps(mph: number): number {
    return mph / MPS_TO_MPH;
}
