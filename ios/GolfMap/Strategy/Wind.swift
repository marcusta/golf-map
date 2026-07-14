import Foundation

/// Wind decomposition + carry adjustment — faithful Swift port of
/// `shared/strategy/wind.ts`. The two MUST stay numerically identical: ported
/// tests + TS-generated golden fixtures (`strategy-goldens.json`) pin the
/// parity.
///
/// Units & conventions:
///  - Canonical input wind speed is m/s; the calibration table is keyed in
///    mph, so we convert internally with the exact constant (MPS_TO_MPH). mph
///    never leaves this module.
///  - Bearings/directions in degrees, compass convention: 0 = north,
///    clockwise. `windDirectionDeg` is the direction the wind comes FROM
///    (meteorological). windDirection == shotBearing → dead headwind.
///  - headTailMph: negative = headwind, positive = tailwind.
///  - crosswindMph: positive = wind from the shooter's LEFT (drifts ball
///    shot-RIGHT); negative = from the right, drifting left.
///  - windEffect is a fractional carry multiplier: adjusted = carry × (1+e).
///
/// WIND MODEL (calibrated 2026-07 — supersedes the v1 linear-per-mph curve):
/// the plays-as effect is NOT a fixed percentage per mph. The percentage
/// effect varies ~3× with shot distance — long clubs punch through wind far
/// better than short ones. We interpolate a calibration grid instead.

/// Exact v1 conversion constant (GolfWeatherCalculator.swift:12).
public let MPS_TO_MPH = 2.23694

/// Meters per second → miles per hour.
public func mpsToMph(_ mps: Double) -> Double { mps * MPS_TO_MPH }

/// Miles per hour → meters per second.
public func mphToMps(_ mph: Double) -> Double { mph / MPS_TO_MPH }

private let WIND_DEG_TO_RAD = Double.pi / 180
private let YARDS_PER_METER = 1 / 0.9144

// MARK: - Ballnamic plays-as wind table (PGA competition, calibrated 2026-07)
//
// Adjustments in YARDS added to (hurting / head wind) or subtracted from
// (helping / tail wind) the shot's playing distance, per PURE head/tail wind
// speed in mph. Rows are shot-distance bands, keyed by a representative
// distance in yards. This raw table IS the calibration record — keep it
// legible; the fraction grids below are derived from it at load.

/// Shot-distance nodes for the wind grid, yards (ascending).
public let WIND_DISTANCE_NODES_YD = [115.0, 140.0, 162.5, 187.5, 225.0, 285.0]
/// Head/tail component nodes for the wind grid, mph (ascending).
public let WIND_SPEED_NODES_MPH = [5.0, 10.0, 15.0, 20.0, 25.0]

// Hurting (head wind) — yards ADDED to the playing distance, per row/speed.
private let HURT_YD: [[Double]] = [
    [5, 11, 18, 26, 35], // 115
    [6, 12, 20, 28, 38], // 140
    [6, 14, 23, 32, 43], // 162.5
    [7, 15, 24, 35, 47], // 187.5
    [5, 11, 19, 28, 38], // 225
    [4, 9, 15, 21, 28], // 285
]

// Helping (tail wind) — yards SUBTRACTED from the playing distance (listed
// positive here). Note helping saturates and the 225 row even reverses.
//
// OPEN CALIBRATION QUESTION (2026-07): an independent TrackMan-style source
// (golfwrx.com/318416, 140 yd shot) matches this table's hurting column to
// within 0.5 yd at every speed, but shows tail wind saturating much harder
// above 15 mph (+12.5 yd at 25 mph vs this table's +17). Ballnamic may be
// ~30% optimistic on strong tail winds; revisit with better data.
private let HELP_YD: [[Double]] = [
    [4, 8, 11, 14, 16], // 115
    [5, 9, 12, 15, 17], // 140
    [5, 10, 13, 16, 18], // 162.5
    [6, 10, 14, 17, 18], // 187.5
    [4, 6, 8, 8, 7], // 225
    [4, 7, 9, 11, 12], // 285
]

// Convert each table cell to a plays-as FRACTION a = adjustmentYd / distanceYd
// (precomputed at load). `a` is the fraction of the shot distance the wind
// adds (hurting) or removes (helping).
private let HURT_A: [[Double]] = HURT_YD.enumerated().map { i, row in
    row.map { $0 / WIND_DISTANCE_NODES_YD[i] }
}
private let HELP_A: [[Double]] = HELP_YD.enumerated().map { i, row in
    row.map { $0 / WIND_DISTANCE_NODES_YD[i] }
}

public struct WindComponents: Equatable, Sendable {
    /// Along-shot component, mph. Negative = headwind, positive = tailwind.
    public var headTailMph: Double
    /// Cross-shot component, mph. Positive = drifts the ball shot-right.
    public var crosswindMph: Double
}

/// Decompose wind into head/tail and cross components relative to a shot
/// bearing — exact v1 decomposition: rel = (windDirection − shotBearing +
/// 180) mod 360, normalized [0, 360); headTail = cos(rel)·mph;
/// crosswind = sin(rel)·mph.
public func windComponents(
    _ windSpeedMps: Double,
    _ windDirectionDeg: Double,
    _ shotBearingDeg: Double
) -> WindComponents {
    let windSpeedMph = mpsToMph(windSpeedMps)
    let rel = (windDirectionDeg - shotBearingDeg + 180).truncatingRemainder(dividingBy: 360)
    let normalized = rel < 0 ? rel + 360 : rel
    return WindComponents(
        headTailMph: cos(normalized * WIND_DEG_TO_RAD) * windSpeedMph,
        crosswindMph: sin(normalized * WIND_DEG_TO_RAD) * windSpeedMph
    )
}

/// Fraction `a` for ONE distance row at the given |head/tail| component,
/// applying the speed-axis interpolation/extrapolation policy:
///  - 0 mph → 0; 0–5 mph → linear from a=0 at 0 to the 5-mph column;
///  - 5–25 mph → linear interpolation between the bracketing columns;
///  - > 25 mph, hurting → linear extrapolation of the 20→25 segment, but
///    evaluated at min(speed, 35) so the fraction caps at its 35-mph value;
///  - > 25 mph, helping → clamp to the 25-mph column (helping saturates).
private func rowFraction(_ row: [Double], _ speedMph: Double, _ hurting: Bool) -> Double {
    let nodes = WIND_SPEED_NODES_MPH
    let last = nodes.count - 1
    if speedMph <= 0 { return 0 }
    if speedMph <= nodes[0] { return row[0] * (speedMph / nodes[0]) }
    if speedMph >= nodes[last] {
        if hurting {
            let capped = min(speedMph, 35)
            let slope = (row[last] - row[last - 1]) / (nodes[last] - nodes[last - 1])
            return row[last] + slope * (capped - nodes[last])
        }
        return row[last]
    }
    var hi = 1
    while nodes[hi] < speedMph { hi += 1 }
    let lo = hi - 1
    let t = (speedMph - nodes[lo]) / (nodes[hi] - nodes[lo])
    return row[lo] + (row[hi] - row[lo]) * t
}

/// Bilinear-interpolated plays-as fraction from the calibration grid. Distance
/// is clamped to [115, 285] yd (below 115 → 115 row, above 285 → 285 row); the
/// speed axis follows `rowFraction`'s policy.
private func gridFraction(_ distanceYd: Double, _ speedMph: Double, _ hurting: Bool) -> Double {
    let grid = hurting ? HURT_A : HELP_A
    let nodes = WIND_DISTANCE_NODES_YD
    let d = min(max(distanceYd, nodes[0]), nodes[nodes.count - 1])
    var hi = 1
    while hi < nodes.count - 1 && nodes[hi] < d { hi += 1 }
    let lo = hi - 1
    let t = (d - nodes[lo]) / (nodes[hi] - nodes[lo])
    let aLo = rowFraction(grid[lo], speedMph, hurting)
    let aHi = rowFraction(grid[hi], speedMph, hurting)
    return aLo + (aHi - aLo) * t
}

/// Fractional carry multiplier for wind, from the Ballnamic calibration grid.
/// `shotDistanceM` is the distance of the shot being evaluated (the club's
/// NOMINAL carry for forward application; the target's straight-line distance
/// for plays-as). Bilinear-interpolate the plays-as fraction `a` from the
/// hurting grid (head wind, headTail < 0) or helping grid (tail wind), keyed on
/// the head/tail COMPONENT magnitude and the shot distance, then convert to the
/// effect `e` the application forms expect so playsAsM(D, e) reproduces the
/// table:
///  - Hurting: plays-as = D×(1+a) → e = −a/(1+a) (negative, lengthens).
///  - Helping: plays-as = D×(1−a) → e = a/(1−a) (positive, shortens).
/// Returns 0 for calm wind, non-positive distance, or a dead crosswind.
public func windEffect(
    _ windSpeedMps: Double,
    _ windDirectionDeg: Double,
    _ shotBearingDeg: Double,
    _ shotDistanceM: Double
) -> Double {
    if shotDistanceM <= 0 || windSpeedMps <= 0 { return 0 }
    let headTailMph = windComponents(windSpeedMps, windDirectionDeg, shotBearingDeg).headTailMph
    if headTailMph == 0 { return 0 }
    let hurting = headTailMph < 0
    let a = gridFraction(shotDistanceM * YARDS_PER_METER, abs(headTailMph), hurting)
    return hurting ? -a / (1 + a) : a / (1 - a)
}

/// Forward application: how far the club actually flies. carry × (1 + e).
public func adjustedCarryM(_ carryM: Double, _ effect: Double) -> Double {
    carryM * (1 + effect)
}

/// Inverse application ("plays as", v1 GreenDetailView): the effective
/// distance a target plays to under wind. distance / (1 + e). Deliberately
/// NOT the algebraic inverse of adjustedCarryM (v1 uses the division form).
public func playsAsM(_ distanceM: Double, _ effect: Double) -> Double {
    distanceM / (1 + effect)
}

/// Lateral drift of the landing point from crosswind, meters. Positive =
/// shot-right. v1.1 EXTENSION: drift = carry × crosswind_mph × 0.005. Out of
/// scope for the 2026-07 head/tail recalibration (no crosswind data in the
/// table). `carryM` is the club's NOMINAL carry (not wind-adjusted).
public func crosswindDriftM(_ carryM: Double, _ crosswindMph: Double) -> Double {
    carryM * crosswindMph * 0.005
}
