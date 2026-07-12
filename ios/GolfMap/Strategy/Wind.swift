import Foundation

/// Wind decomposition + carry adjustment — faithful Swift port of
/// `shared/strategy/wind.ts` (itself the exact port of v1
/// GolfWeatherCalculator.swift plus the documented v1.1 crosswind-drift
/// extension). The two MUST stay numerically identical: ported tests +
/// TS-generated golden fixtures (`strategy-goldens.json`) pin the parity.
///
/// Units & conventions:
///  - Canonical input wind speed is m/s; the v1 curve constants are PER MPH,
///    so we convert internally with the exact v1 constant (MPS_TO_MPH). mph
///    never leaves this module.
///  - Bearings/directions in degrees, compass convention: 0 = north,
///    clockwise. `windDirectionDeg` is the direction the wind comes FROM
///    (meteorological). windDirection == shotBearing → dead headwind.
///  - headTailMph: negative = headwind, positive = tailwind.
///  - crosswindMph: positive = wind from the shooter's LEFT (drifts ball
///    shot-RIGHT); negative = from the right, drifting left.
///  - windEffect is a fractional carry multiplier: adjusted = carry × (1+e).

/// Exact v1 conversion constant (GolfWeatherCalculator.swift:12).
public let MPS_TO_MPH = 2.23694

/// Meters per second → miles per hour.
public func mpsToMph(_ mps: Double) -> Double { mps * MPS_TO_MPH }

/// Miles per hour → meters per second.
public func mphToMps(_ mph: Double) -> Double { mph / MPS_TO_MPH }

private let WIND_DEG_TO_RAD = Double.pi / 180

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

/// Fractional carry multiplier for wind — exact v1 curve:
///  - headwind component × 0.01/mph, or × 0.013/mph when the TOTAL wind
///    speed exceeds 18 mph (strict >, total speed — not the component);
///  - tailwind component × 0.005/mph, or × 0.0034/mph above 18 mph.
/// The >18 branch rescales the ENTIRE component, so the curve is
/// intentionally discontinuous at 18 mph — preserved, not smoothed.
public func windEffect(
    _ windSpeedMps: Double,
    _ windDirectionDeg: Double,
    _ shotBearingDeg: Double
) -> Double {
    let windSpeedMph = mpsToMph(windSpeedMps)
    let headTailMph = windComponents(windSpeedMps, windDirectionDeg, shotBearingDeg).headTailMph
    if headTailMph < 0 {
        return windSpeedMph > 18 ? headTailMph * 0.013 : headTailMph * 0.01
    }
    return windSpeedMph > 18 ? headTailMph * 0.0034 : headTailMph * 0.005
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
/// shot-right. v1.1 EXTENSION: drift = carry × crosswind_mph × 0.005.
/// `carryM` is the club's NOMINAL carry (not wind-adjusted).
public func crosswindDriftM(_ carryM: Double, _ crosswindMph: Double) -> Double {
    carryM * crosswindMph * 0.005
}
