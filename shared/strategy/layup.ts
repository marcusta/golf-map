// Layup / shot-outcome engine — for each club in the bag, what a shot from the
// origin toward a target leaves. One pure computation behind three surfaces:
//  - the on-course card's honest outcome line ("Driver 243 → 65 m in") that
//    replaces the misleading "reaches the green" club advice when the target is
//    beyond the longest club;
//  - the distance-ladder "Layups" rows (one per useful club);
//  - any "lay up to leave a full club" prompt the caddy wants to build.
//
// Units: meters. `targetM` is the straight-line distance origin → target (green
// center, pin, whatever the caller measures against). Distances are RAW: the
// caller applies plays-like / wind before calling if it wants them folded in,
// and rounds for display. Input order is preserved (bag sortOrder) so the
// Swift mirror needs no cross-language sort-stability guarantees.

import { type ClubSpec, closestClub } from './club';

/**
 * One club played from the origin toward the target, with what it leaves.
 */
export interface LayupOption<T extends ClubSpec> {
    /** The club played from the origin. */
    club: T;
    /** Its nominal carry, meters (`club.carryM`, unrounded). */
    carryM: number;
    /**
     * Distance from where this club lands to the target, meters
     * (`targetM − carryM`). Negative when the club carries past the target.
     */
    remainingM: number;
    /**
     * Club whose carry best matches `remainingM` (`closestClub` over the same
     * bag) — the approach you'd have left. Undefined when the club reaches the
     * target or the bag is empty.
     */
    approachClub?: T;
    /** `carryM ≥ targetM` — the club reaches, so this is not a layup. */
    reaches: boolean;
}

/**
 * For each club, what a shot from the origin toward a target `targetM` meters
 * away leaves. Returned in input (bag) order — the caller filters/sorts for
 * display. `approachClub` is the closest-carry club to the remaining distance;
 * undefined once the club reaches (`remainingM ≤ 0`) or the bag is empty.
 */
export function layupOptions<T extends ClubSpec>(
    clubs: readonly T[],
    targetM: number,
): LayupOption<T>[] {
    return clubs.map((club) => {
        const remainingM = targetM - club.carryM;
        const reaches = club.carryM >= targetM;
        return {
            club,
            carryM: club.carryM,
            remainingM,
            reaches,
            approachClub: reaches ? undefined : closestClub(clubs, remainingM),
        };
    });
}

/**
 * The layup that advances the most: the longest-carry club that still falls
 * short of the target — the "bomb it, here's what's left" line. Ties keep the
 * earlier club in the bag (v1 `min/max(by:)` semantics). Undefined when every
 * club reaches the target (nothing to lay up with) or the bag is empty.
 */
export function longestLayup<T extends ClubSpec>(
    clubs: readonly T[],
    targetM: number,
): LayupOption<T> | undefined {
    let best: LayupOption<T> | undefined;
    for (const opt of layupOptions(clubs, targetM)) {
        if (opt.reaches) continue;
        if (!best || opt.carryM > best.carryM) best = opt;
    }
    return best;
}
