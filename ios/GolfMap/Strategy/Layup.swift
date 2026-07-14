import Foundation

/// Layup / shot-outcome engine — faithful Swift port of `shared/strategy/layup.ts`.
/// For each club in the bag, what a shot from the origin toward a target leaves.
/// The two MUST stay numerically identical: ported tests + TS-generated golden
/// fixtures (`strategy-goldens.json`) pin the parity.
///
/// One pure computation behind three surfaces: the on-course card's honest
/// outcome line ("Driver 243 → 65 m in") that replaces the misleading "reaches
/// the green" club advice when the target is beyond the longest club; the
/// distance-ladder "Layups" rows (one per useful club); and any "lay up to
/// leave a full club" prompt the caddy wants to build.
///
/// Units: meters. `targetM` is the straight-line distance origin → target (green
/// center, pin, whatever the caller measures against). Distances are RAW: the
/// caller applies plays-like / wind before calling if it wants them folded in,
/// and rounds for display. Input order is preserved (bag sortOrder), so no
/// cross-language sort-stability guarantees are needed.

/// One club played from the origin toward the target, with what it leaves.
public struct LayupOption<T: ClubSpec> {
    /// The club played from the origin.
    public var club: T
    /// Its nominal carry, meters (`club.carryM`, unrounded).
    public var carryM: Double
    /// Distance from where this club lands to the target, meters
    /// (`targetM − carryM`). Negative when the club carries past the target.
    public var remainingM: Double
    /// Club whose carry best matches `remainingM` (`closestClub` over the same
    /// bag) — the approach you'd have left. Nil when the club reaches the
    /// target or the bag is empty.
    public var approachClub: T?
    /// `carryM ≥ targetM` — the club reaches, so this is not a layup.
    public var reaches: Bool
}

/// For each club, what a shot from the origin toward a target `targetM` meters
/// away leaves. Returned in input (bag) order — the caller filters/sorts for
/// display. `approachClub` is the closest-carry club to the remaining distance;
/// nil once the club reaches (`remainingM ≤ 0`) or the bag is empty.
public func layupOptions<T: ClubSpec>(_ clubs: [T], _ targetM: Double) -> [LayupOption<T>] {
    clubs.map { club in
        let remainingM = targetM - club.carryM
        let reaches = club.carryM >= targetM
        return LayupOption(
            club: club,
            carryM: club.carryM,
            remainingM: remainingM,
            approachClub: reaches ? nil : closestClub(clubs, remainingM),
            reaches: reaches
        )
    }
}

/// The layup that advances the most: the longest-carry club that still falls
/// short of the target — the "bomb it, here's what's left" line. Ties keep the
/// earlier club in the bag (v1 `min/max(by:)` semantics). Nil when every club
/// reaches the target (nothing to lay up with) or the bag is empty.
public func longestLayup<T: ClubSpec>(_ clubs: [T], _ targetM: Double) -> LayupOption<T>? {
    var best: LayupOption<T>?
    for opt in layupOptions(clubs, targetM) where !opt.reaches {
        if best == nil || opt.carryM > best!.carryM { best = opt }
    }
    return best
}
