// Default apex (peak ball height) by carry distance — the flight-height
// input tree-clearance.ts needs when there is no trajectory sampler.
//
// Pure, zero-dep, Swift-mirrorable. Meters throughout.
//
// Source of the table: TrackMan PGA Tour averages (trackman.com "PGA Tour
// averages", carry in yards / apex in feet, converted to meters and rounded):
//   Driver  275 yd carry / 102 ft apex  → ~250 m / 31 m
//   3-wood  243 yd / 92 ft              → ~222 m / 28 m
//   5-iron  194 yd / 102 ft             → ~177 m / 31 m
//   7-iron  172 yd / 90 ft              → ~157 m / 27 m
//   9-iron  148 yd / 87 ft              → ~135 m / 27 m
//   PW      136 yd / 80 ft              → ~124 m / 24 m
// Tour irons peak around 30 m across the bag; only the short game drops
// sharply. The table below rounds those into carry anchors that bracket the
// distances a planner sees (driver 230 m down to a 50 m pitch) and linearly
// interpolates between them. Beyond the ends the apex is clamped.
//
// Amateurs launch slower and spin less, so their apex sits lower for the
// same carry. `apexScale` (default AMATEUR_APEX_SCALE = 0.85, i.e. a 27 m
// tour apex becomes ~23 m) scales the whole table; pass 1 for tour numbers.

/** Carry → apex anchors, meters, ascending carry. */
export const APEX_TABLE: readonly { carryM: number; apexM: number }[] = [
    { carryM: 50, apexM: 12 },
    { carryM: 90, apexM: 22 },
    { carryM: 120, apexM: 26 },
    { carryM: 150, apexM: 28 },
    { carryM: 200, apexM: 30 },
    { carryM: 230, apexM: 30 },
];

/** Amateur apex as a fraction of the tour table (see header). */
export const AMATEUR_APEX_SCALE = 0.85;

/** Optional club hints; `apexM` on the club (a measured apex) wins over the table. */
export interface ApexClubHint {
    category?: string;
    loftDeg?: number;
    /** Measured/known apex for this club, meters — used verbatim when finite and > 0. */
    apexM?: number | null;
}

export interface ApexOptions {
    /** Multiplier on the table apex (not on a club's measured apexM). Default AMATEUR_APEX_SCALE. */
    apexScale?: number;
}

/** Tour-table apex for `carryM` (meters), linearly interpolated, clamped at the ends. */
export function tableApexM(carryM: number): number {
    if (!(carryM > 0)) return 0;
    const first = APEX_TABLE[0];
    const last = APEX_TABLE[APEX_TABLE.length - 1];
    if (carryM <= first.carryM) return first.apexM;
    if (carryM >= last.carryM) return last.apexM;
    for (let i = 0; i < APEX_TABLE.length - 1; i++) {
        const a = APEX_TABLE[i];
        const b = APEX_TABLE[i + 1];
        if (carryM >= a.carryM && carryM <= b.carryM) {
            const t = (carryM - a.carryM) / (b.carryM - a.carryM);
            return a.apexM + (b.apexM - a.apexM) * t;
        }
    }
    return last.apexM;
}

/**
 * Apex height above the origin's ground for a shot carrying `carryM`, meters.
 * A club with a measured `apexM` is used as-is; otherwise the tour table
 * scaled by `apexScale` (default AMATEUR_APEX_SCALE). `category`/`loftDeg`
 * are accepted for future refinement (a low-lofted punch flies flatter) and
 * currently do not change the result. 0 for a non-positive carry.
 */
export function apexHeightM(carryM: number, club?: ApexClubHint, opts: ApexOptions = {}): number {
    const measured = club?.apexM;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) return measured;
    const scale = opts.apexScale ?? AMATEUR_APEX_SCALE;
    return tableApexM(carryM) * scale;
}
