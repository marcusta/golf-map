import Foundation

/// Club model + selection helpers — faithful Swift port of
/// `shared/strategy/club.ts` (itself the exact port of v1 GolfClub.swift and
/// the v1 club-picking logic). The two MUST stay numerically identical:
/// ported tests + TS-generated golden fixtures (`strategy-goldens.json`) pin
/// the parity.
///
/// Units: all distances in meters. A club carries only nominal carry +
/// lateral dispersion; length dispersion and the ±5%/±4% bands are derived.
///
/// Gotchas preserved from v1 (see club.ts header):
///  - dispersion values are FULL widths (extents), not radii/semi-axes.
///  - the wind multiplier applies to the ±5%-banded value, not the nominal:
///    max = carry × 1.05 × (1 + e), NOT carry × (1.05 + e).
///  - the 100…150 length-dispersion tier is inclusive at BOTH ends.

/// Minimal club shape the strategy math needs — structurally the fields of
/// the stored `ClubRecord` (carry + lateral dispersion), so the cached bag
/// can be passed straight in. Mirror of `club.ts` `ClubSpec`.
public protocol ClubSpec {
    /// Nominal carry, meters.
    var carryM: Double { get }
    /// Lateral dispersion, meters — FULL width, not a semi-axis.
    var dispersionM: Double { get }
}

/// Derived length (depth) dispersion, meters — FULL extent. Tiered
/// percentage of carry, exact v1 rules: carry > 150 → 8%;
/// 100 ≤ carry ≤ 150 (inclusive both ends) → 6%; carry < 100 → 5%.
public func lengthDispersionM(_ carryM: Double) -> Double {
    if carryM > 150 { return carryM * 0.08 }
    if carryM >= 100 { return carryM * 0.06 }
    return carryM * 0.05
}

/// Shortest expected carry under wind: ±5% band FIRST, then the wind
/// multiplier on the banded value.
public func minCarryM(_ carryM: Double, windEffect: Double) -> Double {
    carryM * 0.95 * (1 + windEffect)
}

/// Longest expected carry under wind (band first, wind on banded value).
public func maxCarryM(_ carryM: Double, windEffect: Double) -> Double {
    carryM * 1.05 * (1 + windEffect)
}

/// Narrow lateral dispersion bound under wind (×0.96, then wind).
public func minDispersionM(_ dispersionM: Double, windEffect: Double) -> Double {
    dispersionM * 0.96 * (1 + windEffect)
}

/// Wide lateral dispersion bound under wind (×1.04, then wind).
public func maxDispersionM(_ dispersionM: Double, windEffect: Double) -> Double {
    dispersionM * 1.04 * (1 + windEffect)
}

/// Club whose carry is nearest to `distanceM` (min |carry − d|). Ties keep
/// the earlier club in the list (v1 Swift `min(by:)` semantics). Nil for an
/// empty list.
public func closestClub<T: ClubSpec>(_ clubs: [T], _ distanceM: Double) -> T? {
    var best: T?
    var bestDiff = Double.infinity
    for club in clubs {
        let diff = abs(club.carryM - distanceM)
        if diff < bestDiff {
            bestDiff = diff
            best = club
        }
    }
    return best
}

/// Green-detail club advice. Order of the input list does not matter.
public struct ClubAdvice<T: ClubSpec> {
    /// Shortest club that still reaches: min carry among carry ≥ d.
    public var front: T?
    /// Nearest carry to d (min |carry − d|).
    public var center: T?
    /// Longest club that stays short: max carry among carry ≤ d.
    public var back: T?
}

/// Front/center/back club advice for a target distance. Each slot may be nil
/// at the extremes (e.g. no club reaches → no front). Mirror of `club.ts`
/// `clubAdvice`.
public func clubAdvice<T: ClubSpec>(_ clubs: [T], _ distanceM: Double) -> ClubAdvice<T> {
    var front: T?
    var back: T?
    for club in clubs {
        if club.carryM >= distanceM, front == nil || club.carryM < front!.carryM { front = club }
        if club.carryM <= distanceM, back == nil || club.carryM > back!.carryM { back = club }
    }
    return ClubAdvice(front: front, center: closestClub(clubs, distanceM), back: back)
}

/// Club auto-suggestion for a whole hole: if the hole is longer than the
/// longest club, take the longest club; otherwise the club nearest the total
/// distance. Mirror of `club.ts` `suggestClubForHole`.
public func suggestClubForHole<T: ClubSpec>(_ clubs: [T], _ totalDistanceM: Double) -> T? {
    var longest: T?
    for club in clubs where longest == nil || club.carryM > longest!.carryM { longest = club }
    guard let longest else { return nil }
    if totalDistanceM > longest.carryM { return longest }
    return closestClub(clubs, totalDistanceM)
}
