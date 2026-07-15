// Closed-form Tour Read — the Tier-3 putting read and the verbal takeaway
// (docs/feature-putting-green-reading.md §3.1–3.4, §4 Tier 3, §6).
//
// Pure, zero-dep, deterministic — Swift-mirrorable (T17) plain math. This is
// the manual arithmetic tier: the player paces the putt and eyeballs a slope
// %, and this module produces aim + pace with no surface data at all. It is
// also shown alongside the exact integrator (putt.ts) as a sanity cross-check
// (doc §5.1).
//
// Provenance: the aim formula is Ralph Bauer's Tour Read system —
//   https://www.golfdigest.com/story/tour-read-putting-app-ralph-bauer-how-it-works-green-reading
//   https://tourreadgolf.com/
// `aim inches = (paces × 2 − 1) × slope%`, calibrated at ~stimp 10 with a
// pace that finishes ~1 ft past the hole (doc §3.2).
//
// Units & conventions (house style — canonical everywhere is METERS):
//  - The public entry points take and return meters. Tour Read's native
//    arithmetic is paces (aim distance) and inches (aim offset); those
//    imperial units are confined to this module and converted at the edges
//    with the named constants below. Imperial never leaks past the formatter.
//  - `slopePct` is the CROSS-slope percentage along the putt line (rise/run ×
//    100), unsigned magnitude; `breakSide` carries which way it breaks.
//  - `stimpFt` is the stimpmeter reading in feet (the number greens are
//    quoted in). μ (friction) is derived from it via §3.1.
//  - Sign convention for aimOffsetMeters: POSITIVE = aim to the RIGHT of the
//    hole, NEGATIVE = aim to the LEFT, both from the ball's point of view
//    looking down the line. A putt that breaks left-to-right needs a
//    left-of-hole aim → negative offset. `breakSide` ('left' | 'right') names
//    the side the ball breaks TOWARD. The aim side is the opposite and is
//    derived from the signed offset by the formatter.
//  - grade (Δh along the line) is signed: positive = uphill (hole above
//    ball), negative = downhill. Used for the break multiplier and pace.

// ── §3.1 Friction from stimp ────────────────────────────────────────────────

/** Stimpmeter release speed, m/s (doc §3.1). */
export const STIMP_RELEASE_V0_MPS = 1.83;

/** Gravitational acceleration, m/s² (the value behind the 0.56 constant). */
export const GRAVITY_MPS2 = 9.8;

/** Feet → meters (exact). Also the ft→m factor folded into FRICTION_CONSTANT. */
export const FEET_TO_METERS = 0.3048;

/**
 * μ = v₀² / (2·g·S_m) with S in feet gives μ = FRICTION_CONSTANT / S_ft.
 * FRICTION_CONSTANT = v₀² / (2·g·FEET_TO_METERS) ≈ 0.56 (doc §3.1). Kept as a
 * derived expression, not a magic 0.56, so the physics stays legible.
 */
export const FRICTION_CONSTANT =
    (STIMP_RELEASE_V0_MPS * STIMP_RELEASE_V0_MPS) / (2 * GRAVITY_MPS2 * FEET_TO_METERS);

/**
 * Rolling-resistance coefficient μ from a stimp reading (feet).
 * μ ≈ 0.56 / S_ft; stimp 10 → μ ≈ 0.056 (doc §3.1).
 */
export function stimpToFriction(stimpFt: number): number {
    return FRICTION_CONSTANT / stimpFt;
}

// ── Unit bridge (Tour Read is paces & inches) ───────────────────────────────

/** One Tour Read pace ≈ 3 ft (a full walking stride). */
export const PACE_METERS = 3 * FEET_TO_METERS; // 0.9144 m
/** Inches → meters (exact). */
export const INCHES_TO_METERS = 0.0254;

/** Meters → Tour Read paces. */
export function metersToPaces(m: number): number {
    return m / PACE_METERS;
}
/** Tour Read inches → meters. */
export function inchesToMeters(inches: number): number {
    return inches * INCHES_TO_METERS;
}

// ── §3.2 Tour Read aim + stimp scaling ──────────────────────────────────────

/** Reference stimp the raw Tour Read aim formula is calibrated at (doc §3.2). */
export const TOUR_READ_REFERENCE_STIMP_FT = 10;
/** Break scales ~±10% per stimp foot from the reference, linear (doc §3.2). */
export const STIMP_BREAK_SCALE_PER_FT = 0.10;

/**
 * Raw Tour Read aim in inches at the reference stimp (doc §3.2):
 *   aimInches = max(paces × 2 − 1, 0) × slopePct
 * The `−1` captures short putts spending proportionally less time in the slow
 * high-curvature phase; clamped at 0 so sub-1-pace putts never produce a
 * negative aim.
 */
export function tourReadAimInchesAtReference(paces: number, slopePct: number): number {
    const paceTerm = Math.max(paces * 2 - 1, 0);
    return paceTerm * slopePct;
}

/**
 * Linear stimp scaling factor for break: 1 at the reference stimp, ±10% per
 * foot away from it (doc §3.2). Faster green (higher stimp) → more break.
 * Floored at 0 (a nonsensically slow green can't invert the break direction).
 */
export function stimpBreakScale(stimpFt: number): number {
    const factor = 1 + STIMP_BREAK_SCALE_PER_FT * (stimpFt - TOUR_READ_REFERENCE_STIMP_FT);
    return Math.max(factor, 0);
}

/** Aim inches for a given pace count, slope %, and stimp (reference × scale). */
export function tourReadAimInches(paces: number, slopePct: number, stimpFt: number): number {
    return tourReadAimInchesAtReference(paces, slopePct) * stimpBreakScale(stimpFt);
}

// ── §3.3 Uphill/downhill break multiplier ───────────────────────────────────

/**
 * Break multiplier from the grade m along the line (doc §3.3):
 *   downhill (−m): μ / (μ − |m|)  → more break
 *   uphill   (+m): μ / (μ + |m|)  → less break
 * At stimp 10: 2% downhill → ×~1.55, 2% uphill → ×~0.74.
 *
 * `gradeFraction` is the signed grade rise/run (positive = uphill). As the
 * downhill grade approaches μ the denominator → 0 and the multiplier diverges
 * (the ball never stops — see plays-like's canStop flag); guarded to a large
 * finite value and floored at 0 so callers get a usable number.
 */
export function breakMultiplier(mu: number, gradeFraction: number): number {
    const denom = mu + gradeFraction; // uphill adds, downhill (negative) subtracts
    if (denom <= 0) return Number.POSITIVE_INFINITY;
    return mu / denom;
}

// ── §3.4 Plays-like putt length (pace) ──────────────────────────────────────

/**
 * Plays-like putt length and stop feasibility (doc §3.4):
 *   playsLike = D + Δh / μ = D + Δh · S_ft / 0.56
 * Uphill (Δh > 0) plays longer; downhill (Δh < 0) plays shorter. When
 * Δh/μ ≤ −D the ball can't be stopped near the hole: `canStop` is false and
 * the (now ≤ 0 or tiny) number is still returned so the caller can surface
 * "can't stop this one — lag to the low side" (doc §3.4).
 */
export function playsLikeLength(
    distanceM: number,
    gradeDeltaM: number,
    mu: number,
): { playsLikeMeters: number; canStop: boolean } {
    const playsLikeMeters = distanceM + gradeDeltaM / mu;
    return { playsLikeMeters, canStop: playsLikeMeters > 0 };
}

// ── Assembled read ──────────────────────────────────────────────────────────

/** Which side of the hole the putt breaks toward. */
export type BreakSide = 'left' | 'right' | 'straight';

export interface TourRead {
    /**
     * Signed aim offset in meters. Positive = aim RIGHT of the hole, negative
     * = aim LEFT, from the ball's view down the line (see module header).
     */
    aimOffsetMeters: number;
    /** Raw Tour Read aim magnitude in inches (native unit, pre-conversion). */
    aimInches: number;
    /** Side the ball breaks toward. The player aims on the opposite side. */
    breakSide: BreakSide;
    /** Slope-and-stimp-adjusted plays-like putt length, meters (§3.4). */
    playsLikeMeters: number;
    /** Break multiplier applied for the grade along the line (§3.3). */
    breakMultiplier: number;
    /** False when Δh/μ ≤ −D — the putt can't be stopped near the hole. */
    canStop: boolean;
}

/**
 * Main entry — canonical METERS in (house convention).
 *
 * @param distanceM      putt length (ball→hole), meters
 * @param gradeDeltaM    signed elevation change along the line, meters
 *                       (positive = uphill, negative = downhill)
 * @param slopePct       cross-slope magnitude along the line, % (unsigned)
 * @param stimpFt        green speed, stimpmeter feet
 * @param breakToRight   true if the ball breaks left→right (aim LEFT), false
 *                       if right→left (aim RIGHT). Ignored when slopePct is 0.
 */
export function tourRead(
    distanceM: number,
    gradeDeltaM: number,
    slopePct: number,
    stimpFt: number,
    breakToRight: boolean,
): TourRead {
    const mu = stimpToFriction(stimpFt);
    const paces = metersToPaces(distanceM);

    const baseInches = tourReadAimInches(paces, slopePct, stimpFt);
    // breakMultiplier expects the dimensionless along-line grade (rise/run),
    // not the raw elevation delta in meters.
    const gradeFraction = distanceM > 0 ? gradeDeltaM / distanceM : 0;
    const mult = breakMultiplier(mu, gradeFraction);
    // Diverging multiplier (can't-stop downhill) shouldn't blow the aim up to
    // Infinity — the aim is meaningless when the ball won't stop; cap the
    // multiplier's contribution to a finite value there.
    const finiteMult = Number.isFinite(mult) ? mult : 0;
    const aimInches = baseInches * finiteMult;

    const breakSide: BreakSide = slopePct === 0 || aimInches === 0
        ? 'straight'
        : breakToRight
            ? 'right'
            : 'left';
    // Aim opposite the break side. Break-right → aim LEFT → negative offset.
    const sign = breakSide === 'right' ? -1 : breakSide === 'left' ? 1 : 0;
    const aimOffsetMeters = sign * inchesToMeters(aimInches);

    const { playsLikeMeters, canStop } = playsLikeLength(distanceM, gradeDeltaM, mu);

    return {
        aimOffsetMeters,
        aimInches,
        breakSide,
        playsLikeMeters,
        breakMultiplier: mult,
        canStop,
    };
}

/**
 * Convenience for the on-course Tier-3 flow, where the player counts PACES
 * rather than measuring meters. Same read, paces in.
 */
export function tourReadFromPaces(
    paces: number,
    gradeDeltaM: number,
    slopePct: number,
    stimpFt: number,
    breakToRight: boolean,
): TourRead {
    return tourRead(paces * PACE_METERS, gradeDeltaM, slopePct, stimpFt, breakToRight);
}

// ── Verbal formatter ────────────────────────────────────────────────────────

export type UnitSystem = 'metric' | 'imperial';

/**
 * The on-course takeaway string, e.g.
 *   imperial: "14 in left" · "plays like 41 ft"
 *   metric:   "aim 35 cm left" · "plays like 12.5 m"
 * and the can't-stop case: "can't stop this one — lag to the low side".
 *
 * Returns the two lines separately so callers can render/place them; `combined`
 * joins them with " · " for a one-line takeaway.
 */
export interface TourReadVerbal {
    aim: string;
    pace: string;
    combined: string;
}

const CANT_STOP_MESSAGE = "can't stop this one — lag to the low side";

function roundTo(value: number, step: number): number {
    return Math.round(value / step) * step;
}

export function formatTourRead(read: TourRead, units: UnitSystem = 'metric'): TourReadVerbal {
    const aim = formatAim(read, units);
    const pace = read.canStop
        ? `plays like ${formatLength(read.playsLikeMeters, units)}`
        : CANT_STOP_MESSAGE;
    return { aim, pace, combined: `${aim} · ${pace}` };
}

function formatAim(read: TourRead, units: UnitSystem): string {
    if (read.breakSide === 'straight' || read.aimInches === 0) return 'straight';
    const aimSide = read.aimOffsetMeters > 0 ? 'right' : 'left';
    if (units === 'imperial') {
        const inches = Math.round(read.aimInches);
        return `${inches} in ${aimSide}`;
    }
    // Metric: centimeters, rounded to 5 cm (a read is never that precise).
    const cm = roundTo(Math.abs(read.aimOffsetMeters) * 100, 5);
    return `aim ${cm} cm ${aimSide}`;
}

function formatLength(meters: number, units: UnitSystem): string {
    if (units === 'imperial') {
        const feet = meters / FEET_TO_METERS;
        return `${Math.round(feet)} ft`;
    }
    // Metric: meters to one decimal.
    return `${(Math.round(meters * 10) / 10).toFixed(1)} m`;
}
