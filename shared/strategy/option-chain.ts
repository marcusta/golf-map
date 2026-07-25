// Option-chain scoring (feature-plan-shot-options.md, decision O4) — the
// price of ONE authored branch of a plan's option tree, from its decision
// point to hole-out. Generalises the par-5 attack rule's locked two-shot EV
// chain (smart-caddy §5 / par5-attack.ts) to depth n: each authored leg with
// a club is priced dispersion-aware by `optimizeAim` (whose samples already
// carry the expected-strokes table continuation to hole-out), and each leg
// WITHOUT a club is the point estimate `1 + shotsToHoleOut(remaining,
// lie(landing))` with zero tail spread and zero penalty. No nested sampling,
// no Monte Carlo whole-hole distribution (explicitly out of scope, O4).
//
// CHAIN COMPOSITION (the subtle part — read before changing):
//
// Every per-leg figure is an "EV to hole out from this leg's origin"
// assuming TABLE continuation after its landing: for a clubbed leg that is
// `1 + aim.best.expectedStrokes` (one stroke to play it, plus the sampled
// table pricing of everything after), for a clubless leg
// `1 + shotsToHoleOut(landing)`. When the author has planned a NEXT leg,
// that leg re-prices the continuation the table just estimated — so the
// chain telescopes: each leg contributes its hole-out EV MINUS the table
// baseline at its planned landing (the part the next leg replaces), and the
// last leg's baseline stays (the terminal expected strokes from the chain's
// final landing).
//
//     expectedStrokes = Σᵢ (legEVᵢ − baselineᵢ) + baselineₙ
//
// A clubless leg contributes exactly 1 (its EV and baseline cancel); a
// clubbed leg contributes 1 + its dispersion surcharge over the point
// estimate. The one-leg chain degenerates to `1 + aim.best.expectedStrokes`
// — exactly the par-5 attack rule's chain (its `ev` omits the constant +1
// because it only ranks strategies; the agreement fixture pins the offset).
//
// TAIL (CVaR₈₀, D16 semantics): per-leg tail spreads (tailStrokes −
// expectedStrokes over the same samples) compose in QUADRATURE:
//
//     tailStrokes = expectedStrokes + √(Σᵢ spreadᵢ²)
//
// Rationale: leg outcomes are independent, and for sums of independent
// (approximately normal) leg costs the CVaR₈₀ excess is proportional to the
// total σ, which adds root-sum-square — NOT linearly (that would price the
// "every leg blows up at once" comonotone bound, a ~0.2ⁿ event far beyond
// the worst-20% mean). One-leg chains reduce to `1 + aim.best.tailStrokes`,
// preserving par-5 agreement exactly. Known approximation: an intermediate
// leg's spread already includes table-continuation variance that the next
// authored leg partially re-prices — accepted, consistent with the same
// approximation in the EV surcharge.
//
// PENALTY: chain aggregate `1 − Π(1 − legPenaltyProbᵢ)` (locked, O4); leg
// probabilities are `optimizeAim`'s breakdown penalty fractions, 0 for
// clubless legs.
//
// Conventions match the rest of shared/strategy: pure/zero-dep, projected
// meters, compass bearings (0 = north, clockwise), surfaces topmost-first
// (D23). Compute cadence is the CALLER's contract (DECADE §4.5): run on
// shot-place / drag-release, never per drag frame. No Swift mirror (O4 —
// deferred until an on-course consumer needs live re-pricing).

import { optimizeAim } from './aim';
import { type ClubSpec } from './club';
import { pointInRing, type FlatRing } from './corridor';
import { type Vec2 } from './ellipse';
import { shotsToHoleOut } from './expected-strokes';
import { lieFromFeatureType, type Lie } from './lie';

/** One authored leg of an option branch: planned origin → planned landing. */
export interface ChainLeg {
    /** Where the leg is played from, planar meters. */
    origin: Vec2;
    /** The authored landing point, planar meters. */
    landing: Vec2;
    /** Assigned club — set ⇒ dispersion-aware pricing; absent ⇒ point estimate. */
    club?: ClubSpec | null;
    /** Ground slope along the shot line (see ellipse.ts groundSlope). */
    groundSlope?: number;
    /**
     * Enriched aim bearing for this leg (optimizeAim's bestBearingDeg), set by
     * the plan-overlay enrich pass. Ignored by scoreOptionChain (it re-derives
     * the aim from origin→landing); consumed by simulateChain (§V1 step 1) so
     * a rollout samples around the SAME aim the branch was priced at. Absent ⇒
     * the sim aims naively at origin→landing.
     */
    recommendedBearingDeg?: number;
}

/** Shared pricing context for every leg of the chain. */
export interface ChainScoreContext {
    /** ALL classified surface rings, pre-flattened, TOPMOST-FIRST (D23). */
    surfaces: readonly FlatRing[];
    /** Terminal target — remaining distances are measured to this point. */
    greenCenter: Vec2;
    /** Wind: speed m/s, direction FROM in compass degrees. Omit for calm. */
    wind?: { speedMps: number; directionDeg: number };
    /** Lie for points contained by no surface ring. Default 'rough'. */
    fallbackLie?: Lie;
}

/** One leg's contribution to the chain score. */
export interface ChainLegScore {
    /**
     * EV to hole out from THIS leg's origin under table continuation:
     * `1 + aim.best.expectedStrokes` (clubbed) or `1 + baselineStrokes`
     * (point estimate).
     */
    expectedStrokes: number;
    /** CVaR₈₀ analogue of the same; equals expectedStrokes when clubless. */
    tailStrokes: number;
    /** This leg's penalty probability (breakdown fraction; 0 clubless). */
    penaltyProb: number;
    /**
     * Expected strokes from the PLANNED landing to hole-out (table lookup at
     * the landing's classified lie) — the continuation estimate the next
     * authored leg replaces; the last leg's baseline is the chain terminal.
     */
    baselineStrokes: number;
    /** Dispersion-sample lie fractions at the priced aim (clubbed legs only). */
    breakdown?: Partial<Record<Lie, number>>;
}

/** The O4 triple for one option branch, plus its per-leg build-up. */
export interface ChainScore {
    /** EV to hole out from the decision point (includes the legs' strokes). */
    expectedStrokes: number;
    /** CVaR₈₀ carried through the chain (D16) — the blow-up number. */
    tailStrokes: number;
    /** Chain-aggregate penalty probability: 1 − Π(1 − legPenaltyProb). */
    penaltyProb: number;
    perLeg: ChainLegScore[];
}

/** Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters. */
function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

/** First containing ring wins (caller order is topmost-first, D23). */
function lieAt(p: Vec2, surfaces: readonly FlatRing[], fallback: Lie): Lie {
    for (const ring of surfaces) {
        if (ring.points.length < 3) continue;
        if (pointInRing(p, ring.points)) return lieFromFeatureType(ring.kind);
    }
    return fallback;
}

/**
 * Score one authored option branch from its decision point to hole-out.
 * Pure and deterministic (D14 via `optimizeAim`). `legs` run root-first from
 * the decision point; an empty chain scores as all zeros (nothing to play).
 * The result is derived, never persisted (O4).
 */
export function scoreOptionChain(
    legs: readonly ChainLeg[],
    ctx: ChainScoreContext,
): ChainScore {
    const fallbackLie = ctx.fallbackLie ?? 'rough';
    const perLeg: ChainLegScore[] = [];

    for (const leg of legs) {
        const remainingM = Math.hypot(
            ctx.greenCenter.x - leg.landing.x,
            ctx.greenCenter.y - leg.landing.y,
        );
        const baselineStrokes = shotsToHoleOut(remainingM, lieAt(leg.landing, ctx.surfaces, fallbackLie));

        if (leg.club) {
            // The exact optimizeAim path enrichLegStrategy runs per leg
            // (plan-overlay.ts): full sweep, best candidate, riskAversion 0.
            const aim = optimizeAim({
                origin: leg.origin,
                club: leg.club,
                targetBearingDeg: bearingDeg(leg.origin, leg.landing),
                surfaces: ctx.surfaces,
                greenCenter: ctx.greenCenter,
                fallbackLie,
                ...(leg.groundSlope !== undefined ? { groundSlope: leg.groundSlope } : {}),
                ...(ctx.wind !== undefined
                    ? { windSpeedMps: ctx.wind.speedMps, windDirectionDeg: ctx.wind.directionDeg }
                    : {}),
            });
            perLeg.push({
                expectedStrokes: 1 + aim.best.expectedStrokes,
                tailStrokes: 1 + aim.best.tailStrokes,
                penaltyProb: aim.breakdown.penalty ?? 0,
                baselineStrokes,
                breakdown: aim.breakdown,
            });
        } else {
            perLeg.push({
                expectedStrokes: 1 + baselineStrokes,
                tailStrokes: 1 + baselineStrokes,
                penaltyProb: 0,
                baselineStrokes,
            });
        }
    }

    if (perLeg.length === 0) return { expectedStrokes: 0, tailStrokes: 0, penaltyProb: 0, perLeg };

    let expectedStrokes = perLeg[perLeg.length - 1].baselineStrokes;
    let spreadSq = 0;
    let cleanProb = 1;
    for (const leg of perLeg) {
        expectedStrokes += leg.expectedStrokes - leg.baselineStrokes;
        const spread = leg.tailStrokes - leg.expectedStrokes;
        spreadSq += spread * spread;
        cleanProb *= 1 - leg.penaltyProb;
    }

    return {
        expectedStrokes,
        tailStrokes: expectedStrokes + Math.sqrt(spreadSq),
        penaltyProb: 1 - cleanProb,
        perLeg,
    };
}
