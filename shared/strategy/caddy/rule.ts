// Smart-caddy rule model — the open–closed extension point that turns the
// engine's NUMBERS into ranked, explained ADVICE (feature-smart-caddy.md §2,
// §4). A rule is a pure, self-gating function; the evaluator (run.ts) is
// fixed and owns all conflict resolution, so no rule ever knows another rule
// exists (§4.1, §4.4). Adding advice = adding a rule file, never editing the
// evaluator or a sibling rule.
//
// Purity contract mirrors corridor.ts / aim.ts: zero-dep, Swift-mirrorable,
// meters + compass-degree conventions. The caller pre-computes every input
// (EV per aim, distances, slope summary, flattened rings) and hands the
// caddy a finished CaddyContext — the rules never read the feature store,
// the DEM, or HTTP (§4.2).
//
// Context inputs from sibling modules: FeatureDistance is imported from the
// distances engine (feature-distances.ts, T4) and re-exported for the caddy
// barrel. GreenSlopeSummary remains FORWARD-DECLARED below — there is no
// shared slope type yet; the web adapter (T9) produces a structurally
// compatible object, and a rule reads only the fields declared here. Retire
// that forward declaration when a canonical shared slope type lands.

import { type AimResult } from '../aim';
import { type ClubSpec } from '../club';
import { type FlatRing } from '../corridor';
import { type Vec2 } from '../ellipse';
import { type FeatureDistance } from '../feature-distances';
import { type StrategyPoint } from '../plays-like';
import { type TreeFeatureInput } from '../tree-clearance';

export { type FeatureDistance };

// ---------------------------------------------------------------------------
// Forward-declared context inputs (retire when the real modules land).
// FeatureDistance is now the canonical type imported from feature-distances.ts
// (T4, re-exported above). GreenSlopeSummary is still forward-declared until
// a shared slope type lands — the web adapter (T9) produces a structurally
// compatible object.
// ---------------------------------------------------------------------------

/**
 * FORWARD-DECL (retire when the web GreenSlopeSummary adapter / T9 lands and
 * exports the canonical type). Compact summary of a green's slope derived
 * from computeSlopeGrid — the dominant fall line plus a front/back split so a
 * rule can say WHICH half to favour (decision D10). The pure rule never
 * touches analysis-math.ts; the platform derives this and passes it in (§4.6).
 */
export interface GreenSlopeSummary {
    /** Dominant downhill (fall-line) bearing, compass degrees. */
    fallLineBearingDeg: number;
    /** Dominant fall-line magnitude, percent (rise/run · 100). */
    fallLinePct: number;
    /** Mean slope of the front half, percent. */
    frontHalfPct: number;
    /** Mean slope of the back half, percent. */
    backHalfPct: number;
}

// ---------------------------------------------------------------------------
// Risk tolerance (decision D16 / D11).
// ---------------------------------------------------------------------------

/**
 * Player risk tolerance — a thin wrapper over the single `riskAversion`
 * number the aim optimiser already understands (decision D16: one number,
 * 0..1). 0 = pure expected value (DECADE orthodoxy); 1 = fully weight the
 * CVaR₈₀ tail. The caddy does NOT invent its own risk math: risk-sensitive
 * rules read `AimResult.perCandidate[].tailStrokes` (already computed under
 * this same knob) and the evaluator risk-weights rule priorities (D12). In
 * v1 this is transient planner state, not persisted (decision D11).
 */
export interface RiskProfile {
    /** 0..1 weight on the tail term. Default 0 = pure EV. */
    riskAversion: number;
}

// ---------------------------------------------------------------------------
// Context, advice, rule.
// ---------------------------------------------------------------------------

/** Which leg of the hole this advice request is for. */
export type CaddyLeg = 'tee' | 'approach' | 'layup' | 'recovery';

/**
 * Everything a rule may read, pre-computed by the platform (§4.2). Never raw
 * domain entities — the caddy is a layer on top of the engine, not a second
 * engine. Adding a new input later is a field here plus the rules that read
 * it, never an evaluator change.
 */
export interface CaddyContext {
    leg: CaddyLeg;
    /** Shot origin, planar meters (elevation optional). */
    origin: StrategyPoint;
    /** The green being played to, with the reference points rules aim at. */
    target: {
        greenPoly: FlatRing;
        center: Vec2;
        front: Vec2;
        back: Vec2;
        pin?: Vec2;
    };
    /** Measured targets along the shot (◄ feature-distances.ts / T4). */
    distances: readonly FeatureDistance[];
    /** EV per candidate aim + lie breakdown (◄ aim.ts). Absent pre-DECADE. */
    aim?: AimResult;
    /** Green slope summary (◄ computeSlopeGrid adapter / T9). */
    greenSlope?: GreenSlopeSummary;
    /** Flattened hazard rings for the hole, caller-filtered. */
    hazards: readonly FlatRing[];
    /** The player's clubs. */
    clubs: readonly ClubSpec[];
    /** Wind: speed m/s, direction FROM in compass degrees. Omit for calm. */
    wind?: { speedMps: number; directionDeg: number };
    hole: { par: number; index: number };
    /** Player risk tolerance (D16). */
    risk: RiskProfile;
    /**
     * Tree rings with their canopy-height attributes (◄ tree-clearance.ts),
     * planar meters. Absent → the over-the-trees rule is silent.
     */
    trees?: readonly TreeFeatureInput[];
    /** Apex of the intended shot above the origin's ground, meters (◄ apex.ts). */
    apexM?: number;
    /**
     * Carry of the intended shot, meters (the planner's assigned club, wind
     * applied). When absent the over-the-trees rule falls back to the club
     * nearest the remaining distance, as can-you-carry-it does.
     */
    shotCarryM?: number;
    /** Ground elevation at distance d along the shot line, meters. Omit for flat ground. */
    groundAt?: (distanceM: number) => number;
}

/** The category of a piece of advice — drives how the UI renders it. */
export type CaddyAdviceKind =
    | 'aim'
    | 'club'
    | 'target-half'
    | 'layup'
    | 'lay-back'
    | 'warning';

/**
 * One ranked, explained recommendation (§4.4). `priority` is the base
 * severity of the concern; `confidence` is the rule's own certainty
 * (low-confidence advice is suppressible). The evaluator ranks by
 * priority × confidence, risk-weighted where the rule opts in (decision D12).
 * `vetoes` lists rule ids whose advice THIS advice demotes/removes — the one
 * place a rule expresses a cross-rule relationship, resolved by the evaluator
 * (not by any rule reaching into another).
 */
export interface CaddyAdvice {
    /** id of the rule that produced this advice. */
    ruleId: string;
    kind: CaddyAdviceKind;
    /** Base severity of the concern, ≥ 0. */
    priority: number;
    /** Rule's own certainty, 0..1. */
    confidence: number;
    /** The recommendation, e.g. 'Favour the front half — green runs away'. */
    headline: string;
    /** The one-sentence "why", optional. */
    detail?: string;
    /** Where to draw it on the overlay, planar meters. */
    anchor?: Vec2;
    /** Rule ids whose advice this one overrides (demote/remove). */
    vetoes?: readonly string[];
    /**
     * Opt-in: scale this advice's priority by the player's riskAversion in
     * ranking (decision D12 — "risk-weighted per rule where the rule
     * declares it"). Safety rules set this so a cautious player surfaces them
     * above aggressive advice; omitted → risk-neutral ranking.
     */
    riskWeighted?: boolean;
}

/**
 * A pure, self-gating advice rule (§4.1). `appliesTo` is a cheap gate (leg
 * type, par, data presence); `evaluate` is pure and returns 0..n advice. A
 * rule never inspects other rules — conflict handling is the evaluator's job.
 */
export interface CaddyRule {
    id: string;
    /** Cheap gate — is this rule relevant to this context at all? */
    appliesTo(ctx: CaddyContext): boolean;
    /** Pure; 0..n advice items. Only called when appliesTo returned true. */
    evaluate(ctx: CaddyContext): CaddyAdvice[];
}
