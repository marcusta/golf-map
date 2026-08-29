import Foundation

/// Closed-form Tour Read — the Tier-3 putting read and the verbal takeaway.
/// Faithful Swift port of `shared/strategy/putting/tour-read.ts` — the two
/// MUST stay numerically identical (same constants, same formulas, same
/// clamps and sign conventions); ported tests + TS-generated goldens
/// (`putting-goldens.json`) pin the parity. Constant names keep the TS
/// SCREAMING_SNAKE spelling (house pattern, see AnalysisMath.swift).
///
/// This is the manual arithmetic tier: the player paces the putt and
/// eyeballs a slope %, and this module produces aim + pace with no surface
/// data at all. It is also shown alongside the exact integrator
/// (Putt.swift) as a sanity cross-check (doc §5.1).
///
/// Provenance: the aim formula is Ralph Bauer's Tour Read system —
/// `aim inches = (paces × 2 − 1) × slope%`, calibrated at ~stimp 10 with a
/// pace that finishes ~1 ft past the hole (doc §3.2).
///
/// Units & conventions (house style — canonical everywhere is METERS):
///  - The public entry points take and return meters. Tour Read's native
///    arithmetic is paces (aim distance) and inches (aim offset); those
///    imperial units are confined to this module and converted at the edges
///    with the named constants below. Imperial never leaks past the formatter.
///  - `slopePct` is the CROSS-slope percentage along the putt line (rise/run
///    × 100), unsigned magnitude; `breakSide` carries which way it breaks.
///  - `stimpFt` is the stimpmeter reading in feet (the number greens are
///    quoted in). μ (friction) is derived from it via §3.1.
///  - Sign convention for aimOffsetMeters: POSITIVE = aim to the RIGHT of
///    the hole, NEGATIVE = aim to the LEFT, both from the ball's point of
///    view looking down the line. A putt that breaks left-to-right needs a
///    left-of-hole aim → negative offset. `breakSide` (.left | .right) names
///    the side the ball breaks TOWARD. The aim side is the opposite and is
///    derived from the signed offset by the formatter.
///  - grade (Δh along the line) is signed: positive = uphill (hole above
///    ball), negative = downhill. Used for the break multiplier and pace.

// MARK: - §3.1 Friction from stimp

/// Stimpmeter release speed, m/s (doc §3.1).
public let STIMP_RELEASE_V0_MPS = 1.83

/// Gravitational acceleration, m/s² (the value behind the 0.56 constant).
public let GRAVITY_MPS2 = 9.8

/// Feet → meters (exact). Also the ft→m factor folded into FRICTION_CONSTANT.
public let FEET_TO_METERS = 0.3048

/// μ = v₀² / (2·g·S_m) with S in feet gives μ = FRICTION_CONSTANT / S_ft.
/// FRICTION_CONSTANT = v₀² / (2·g·FEET_TO_METERS) ≈ 0.56 (doc §3.1). Kept as
/// a derived expression, not a magic 0.56, so the physics stays legible.
public let FRICTION_CONSTANT =
    (STIMP_RELEASE_V0_MPS * STIMP_RELEASE_V0_MPS) / (2 * GRAVITY_MPS2 * FEET_TO_METERS)

/// Rolling-resistance coefficient μ from a stimp reading (feet).
/// μ ≈ 0.56 / S_ft; stimp 10 → μ ≈ 0.056 (doc §3.1).
public func stimpToFriction(_ stimpFt: Double) -> Double {
    FRICTION_CONSTANT / stimpFt
}

/// Effective friction constant for the PLAYS-LIKE length — empirical, not the
/// stimpmeter physics above. Pure Coulomb (Δh/μ with μ = 0.56/S) overstates
/// the elevation surcharge of a struck putt: a real putt burns extra energy
/// in the launch skid phase and in speed-dependent rolling losses, so the
/// effective friction over the roll is higher than the stimpmeter's slow lag
/// release. Fit to GSPro readings at stimp 11 (8 cm rise → +1.0 m plays-like;
/// 29 cm over 8 m → +3.6–3.7 m): both anchors sit on Δh · S/0.88 (factors
/// 12.5 and ~12.6). The fit's regime is ≤ ~12 m and ≤ ~32 cm of rise; beyond
/// that the linear form extrapolates (the true response is sub-linear in
/// distance and slope).
///
/// canStop/breakMultiplier stay on FRICTION_CONSTANT — whether the ball can
/// physically stop is lag-speed stimpmeter physics, exactly what 0.56 encodes.
public let PLAYS_LIKE_FRICTION_CONSTANT = 0.88

/// Effective friction for the plays-like length (calibrated; see above).
public func stimpToPlaysLikeFriction(_ stimpFt: Double) -> Double {
    PLAYS_LIKE_FRICTION_CONSTANT / stimpFt
}

// MARK: - Unit bridge (Tour Read is paces & inches)

/// One Tour Read pace ≈ 3 ft (a full walking stride). 0.9144 m.
public let PACE_METERS = 3 * FEET_TO_METERS
/// Inches → meters (exact).
public let INCHES_TO_METERS = 0.0254

/// Meters → Tour Read paces.
public func metersToPaces(_ m: Double) -> Double {
    m / PACE_METERS
}

/// Tour Read inches → meters.
public func inchesToMeters(_ inches: Double) -> Double {
    inches * INCHES_TO_METERS
}

// MARK: - §3.2 Tour Read aim + stimp scaling

/// Reference stimp the raw Tour Read aim formula is calibrated at (doc §3.2).
public let TOUR_READ_REFERENCE_STIMP_FT = 10.0
/// Break scales ~±10% per stimp foot from the reference, linear (doc §3.2).
public let STIMP_BREAK_SCALE_PER_FT = 0.10

/// Raw Tour Read aim in inches at the reference stimp (doc §3.2):
///   aimInches = max(paces × 2 − 1, 0) × slopePct
/// The `−1` captures short putts spending proportionally less time in the
/// slow high-curvature phase; clamped at 0 so sub-1-pace putts never produce
/// a negative aim.
public func tourReadAimInchesAtReference(_ paces: Double, _ slopePct: Double) -> Double {
    let paceTerm = max(paces * 2 - 1, 0)
    return paceTerm * slopePct
}

/// Linear stimp scaling factor for break: 1 at the reference stimp, ±10% per
/// foot away from it (doc §3.2). Faster green (higher stimp) → more break.
/// Floored at 0 (a nonsensically slow green can't invert the break direction).
public func stimpBreakScale(_ stimpFt: Double) -> Double {
    let factor = 1 + STIMP_BREAK_SCALE_PER_FT * (stimpFt - TOUR_READ_REFERENCE_STIMP_FT)
    return max(factor, 0)
}

/// Aim inches for a given pace count, slope %, and stimp (reference × scale).
public func tourReadAimInches(_ paces: Double, _ slopePct: Double, _ stimpFt: Double) -> Double {
    tourReadAimInchesAtReference(paces, slopePct) * stimpBreakScale(stimpFt)
}

// MARK: - §3.3 Uphill/downhill break multiplier

/// Break multiplier from the grade m along the line (doc §3.3):
///   downhill (−m): μ / (μ − |m|)  → more break
///   uphill   (+m): μ / (μ + |m|)  → less break
/// At stimp 10: 2% downhill → ×~1.55, 2% uphill → ×~0.74.
///
/// `gradeFraction` is the signed grade rise/run (positive = uphill). As the
/// downhill grade approaches μ the denominator → 0 and the multiplier
/// diverges (the ball never stops — see plays-like's canStop flag); guarded
/// to +infinity there, exactly like the TS source.
public func breakMultiplier(mu: Double, gradeFraction: Double) -> Double {
    let denom = mu + gradeFraction // uphill adds, downhill (negative) subtracts
    if denom <= 0 { return .infinity }
    return mu / denom
}

// MARK: - §3.4 Plays-like putt length (pace)

/// Plays-like putt length and stop feasibility (doc §3.4):
///   playsLike = D + Δh / μ = D + Δh · S_ft / 0.56
/// Uphill (Δh > 0) plays longer; downhill (Δh < 0) plays shorter. When
/// Δh/μ ≤ −D the ball can't be stopped near the hole: `canStop` is false and
/// the (now ≤ 0 or tiny) number is still returned so the caller can surface
/// "can't stop this one — lag to the low side" (doc §3.4).
public func playsLikeLength(
    distanceM: Double,
    gradeDeltaM: Double,
    mu: Double
) -> (playsLikeMeters: Double, canStop: Bool) {
    let playsLikeMeters = distanceM + gradeDeltaM / mu
    return (playsLikeMeters: playsLikeMeters, canStop: playsLikeMeters > 0)
}

// MARK: - Assembled read

/// Which side of the hole the putt breaks toward.
public enum BreakSide: String, Sendable {
    case left
    case right
    case straight
}

public struct TourRead: Equatable, Sendable {
    /// Signed aim offset in meters. Positive = aim RIGHT of the hole,
    /// negative = aim LEFT, from the ball's view down the line (see header).
    public var aimOffsetMeters: Double
    /// Raw Tour Read aim magnitude in inches (native unit, pre-conversion).
    public var aimInches: Double
    /// Side the ball breaks toward. The player aims on the opposite side.
    public var breakSide: BreakSide
    /// Slope-and-stimp-adjusted plays-like putt length, meters (§3.4).
    public var playsLikeMeters: Double
    /// Break multiplier applied for the grade along the line (§3.3).
    public var breakMultiplier: Double
    /// False when Δh/μ ≤ −D — the putt can't be stopped near the hole.
    public var canStop: Bool
}

/// Main entry — canonical METERS in (house convention).
///
/// - Parameters:
///   - distanceM: putt length (ball→hole), meters
///   - gradeDeltaM: signed elevation change along the line, meters
///     (positive = uphill, negative = downhill)
///   - slopePct: cross-slope magnitude along the line, % (unsigned)
///   - stimpFt: green speed, stimpmeter feet
///   - breakToRight: true if the ball breaks left→right (aim LEFT), false
///     if right→left (aim RIGHT). Ignored when slopePct is 0.
public func tourRead(
    distanceM: Double,
    gradeDeltaM: Double,
    slopePct: Double,
    stimpFt: Double,
    breakToRight: Bool
) -> TourRead {
    let mu = stimpToFriction(stimpFt)
    let paces = metersToPaces(distanceM)

    let baseInches = tourReadAimInches(paces, slopePct, stimpFt)
    // breakMultiplier expects the dimensionless along-line grade (rise/run),
    // not the raw elevation delta in meters.
    let gradeFraction = distanceM > 0 ? gradeDeltaM / distanceM : 0
    let mult = breakMultiplier(mu: mu, gradeFraction: gradeFraction)
    // Diverging multiplier (can't-stop downhill) shouldn't blow the aim up to
    // infinity — the aim is meaningless when the ball won't stop; cap the
    // multiplier's contribution to a finite value there.
    let finiteMult = mult.isFinite ? mult : 0
    let aimInches = baseInches * finiteMult

    let breakSide: BreakSide = slopePct == 0 || aimInches == 0
        ? .straight
        : breakToRight
            ? .right
            : .left
    // Aim opposite the break side. Break-right → aim LEFT → negative offset.
    let sign: Double = breakSide == .right ? -1 : breakSide == .left ? 1 : 0
    let aimOffsetMeters = sign * inchesToMeters(aimInches)

    // Plays-like uses the CALIBRATED effective friction; canStop keeps the
    // physical μ (see PLAYS_LIKE_FRICTION_CONSTANT).
    let (playsLikeMeters, _) = playsLikeLength(
        distanceM: distanceM, gradeDeltaM: gradeDeltaM,
        mu: stimpToPlaysLikeFriction(stimpFt)
    )
    let (_, canStop) = playsLikeLength(
        distanceM: distanceM, gradeDeltaM: gradeDeltaM, mu: mu
    )

    return TourRead(
        aimOffsetMeters: aimOffsetMeters,
        aimInches: aimInches,
        breakSide: breakSide,
        playsLikeMeters: playsLikeMeters,
        breakMultiplier: mult,
        canStop: canStop
    )
}

/// Convenience for the on-course Tier-3 flow, where the player counts PACES
/// rather than measuring meters. Same read, paces in.
public func tourReadFromPaces(
    _ paces: Double,
    gradeDeltaM: Double,
    slopePct: Double,
    stimpFt: Double,
    breakToRight: Bool
) -> TourRead {
    tourRead(
        distanceM: paces * PACE_METERS,
        gradeDeltaM: gradeDeltaM,
        slopePct: slopePct,
        stimpFt: stimpFt,
        breakToRight: breakToRight
    )
}

// MARK: - Verbal formatter

public enum UnitSystem: String, Sendable {
    case metric
    case imperial
}

/// The on-course takeaway string, e.g.
///   imperial: "14 in left" · "plays like 41 ft"
///   metric:   "aim 35 cm left" · "plays like 12.5 m"
/// and the can't-stop case: "can't stop this one — lag to the low side".
///
/// `aim` and `pace` come separately so callers can render/place them;
/// `combined` joins them with " · " for a one-line takeaway.
public struct TourReadVerbal: Equatable, Sendable {
    public var aim: String
    public var pace: String
    public var combined: String
}

private let CANT_STOP_MESSAGE = "can't stop this one — lag to the low side"

/// JS `Math.round` semantics: half-values round toward +∞ (floor(x + 0.5)) —
/// NOT Swift's `.rounded()` (half away from zero). Kept exact for parity.
private func jsRound(_ value: Double) -> Double {
    floor(value + 0.5)
}

private func roundTo(_ value: Double, _ step: Double) -> Double {
    jsRound(value / step) * step
}

public func formatTourRead(_ read: TourRead, units: UnitSystem = .metric) -> TourReadVerbal {
    let aim = formatAim(read, units)
    let pace = read.canStop
        ? "plays like \(formatLength(read.playsLikeMeters, units))"
        : CANT_STOP_MESSAGE
    return TourReadVerbal(aim: aim, pace: pace, combined: "\(aim) · \(pace)")
}

private func formatAim(_ read: TourRead, _ units: UnitSystem) -> String {
    if read.breakSide == .straight || read.aimInches == 0 { return "straight" }
    let aimSide = read.aimOffsetMeters > 0 ? BreakSide.right : BreakSide.left
    if units == .imperial {
        let inches = Int(jsRound(read.aimInches))
        return "\(inches) in \(aimSide.rawValue)"
    }
    // Metric: centimeters, rounded to 5 cm (a read is never that precise).
    let cm = roundTo(abs(read.aimOffsetMeters) * 100, 5)
    return "aim \(Int(cm)) cm \(aimSide.rawValue)"
}

private func formatLength(_ meters: Double, _ units: UnitSystem) -> String {
    if units == .imperial {
        let feet = meters / FEET_TO_METERS
        return "\(Int(jsRound(feet))) ft"
    }
    // Metric: meters to one decimal.
    return String(format: "%.1f m", jsRound(meters * 10) / 10)
}
