// Club model + selection helpers — exact port of v1 GolfClub.swift and the
// v1 club-picking logic (GamePlannerViewModel.swift:163–170,
// GreenDetailView.swift:183–196).
//
// Units: all distances in meters. A club carries only nominal carry +
// lateral dispersion (matches the server `clubs` table: carry_m,
// dispersion_m — ROADMAP decision "Club model unchanged"); length
// dispersion and the ±5%/±4% bands are derived.
//
// Gotchas preserved from v1 (see recon spec §1):
//  - dispersion values are FULL widths (extents), not radii/semi-axes.
//  - the wind multiplier applies to the ±5%-banded value, not the nominal:
//    max = carry × 1.05 × (1 + e), NOT carry × (1.05 + e).
//  - the 100…150 length-dispersion tier is inclusive at BOTH ends.

/**
 * Minimal club shape the strategy math needs. Structurally compatible with
 * the generated `Club` API type (shared/api/clubs.gen.ts), so API clubs can
 * be passed straight in.
 */
export interface ClubSpec {
    name?: string;
    /** Nominal carry, meters. */
    carryM: number;
    /** Lateral dispersion, meters — FULL width, not a semi-axis. */
    dispersionM: number;
}

/**
 * Derived length (depth) dispersion, meters — FULL extent. Tiered
 * percentage of carry, exact v1 rules (GolfClub.swift:9–18):
 * carry > 150 → 8%; 100 ≤ carry ≤ 150 (inclusive both ends) → 6%;
 * carry < 100 → 5%.
 */
export function lengthDispersionM(carryM: number): number {
    if (carryM > 150) return carryM * 0.08;
    if (carryM >= 100) return carryM * 0.06;
    return carryM * 0.05;
}

/**
 * Shortest expected carry under wind: ±5% band FIRST, then the wind
 * multiplier on the banded value (GolfClub.swift:27–49).
 */
export function minCarryM(carryM: number, windEffect: number): number {
    return carryM * 0.95 * (1 + windEffect);
}

/** Longest expected carry under wind (band first, wind on banded value). */
export function maxCarryM(carryM: number, windEffect: number): number {
    return carryM * 1.05 * (1 + windEffect);
}

/** Narrow lateral dispersion bound under wind (×0.96, then wind). */
export function minDispersionM(dispersionM: number, windEffect: number): number {
    return dispersionM * 0.96 * (1 + windEffect);
}

/** Wide lateral dispersion bound under wind (×1.04, then wind). */
export function maxDispersionM(dispersionM: number, windEffect: number): number {
    return dispersionM * 1.04 * (1 + windEffect);
}

/**
 * Club whose carry is nearest to `distanceM` (min |carry − d|). Ties keep
 * the earlier club in the list (v1 Swift `min(by:)` semantics). Undefined
 * for an empty list.
 */
export function closestClub<T extends ClubSpec>(clubs: readonly T[], distanceM: number): T | undefined {
    let best: T | undefined;
    let bestDiff = Infinity;
    for (const club of clubs) {
        const diff = Math.abs(club.carryM - distanceM);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = club;
        }
    }
    return best;
}

/**
 * Green-detail club advice (GreenDetailView.swift:183–196). Order of the
 * input list does not matter (v1 pre-sorted descending; this scans).
 */
export interface ClubAdvice<T extends ClubSpec> {
    /** Shortest club that still reaches: min carry among carry ≥ d. */
    front?: T;
    /** Nearest carry to d (min |carry − d|). */
    center?: T;
    /** Longest club that stays short: max carry among carry ≤ d. */
    back?: T;
}

/**
 * Front/center/back club advice for a target distance. Each slot may be
 * undefined at the extremes (e.g. no club reaches → no front).
 */
export function clubAdvice<T extends ClubSpec>(clubs: readonly T[], distanceM: number): ClubAdvice<T> {
    let front: T | undefined;
    let back: T | undefined;
    for (const club of clubs) {
        if (club.carryM >= distanceM && (!front || club.carryM < front.carryM)) front = club;
        if (club.carryM <= distanceM && (!back || club.carryM > back.carryM)) back = club;
    }
    return { front, center: closestClub(clubs, distanceM), back };
}

/**
 * Club auto-suggestion for a whole hole (GamePlannerViewModel.swift:163–170):
 * if the hole is longer than the longest club, take the longest club;
 * otherwise the club nearest the total distance.
 */
export function suggestClubForHole<T extends ClubSpec>(clubs: readonly T[], totalDistanceM: number): T | undefined {
    let longest: T | undefined;
    for (const club of clubs) {
        if (!longest || club.carryM > longest.carryM) longest = club;
    }
    if (!longest) return undefined;
    if (totalDistanceM > longest.carryM) return longest;
    return closestClub(clubs, totalDistanceM);
}
