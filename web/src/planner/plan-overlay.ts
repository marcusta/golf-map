// Pure planning-model + overlay-geojson builders for the game-plan editor.
// No MapLibre, no DOM, no services — unit-testable under happy-dom (same
// split as analysis-tool.service vs analysis-overlay). All strategy math
// comes from shared/strategy (single reference implementation); this module
// only assembles nodes/legs and converts geometry for rendering.
//
// Planning model (Phase 5 contract):
//  - The primary node sequence follows rank-0 children from the rank-0 root.
//    All option nodes/legs are retained separately for the map overlay.
//  - Leg N = node N → node N+1; leg bearing = planar initial bearing in
//    EPSG:3006 (atan2(Δx, Δy), fine at course scale — consistent everywhere).
//  - The ellipse for a leg anchors at its ORIGIN node and projects forward
//    along the leg bearing; club = the landing shot's clubId, with the TEE
//    leg falling back to the hole's preferredClubId. Legs without a club
//    (e.g. later legs into the green) get no ellipse.
//  - Plays-like per leg via shared/strategy segmentStats on the node
//    elevations (tee/shot/green rows carry sampled elevations).
//
// Coordinates: math in EPSG:3006 planar meters; WGS84 conversion happens
// only when building the GeoJSON FeatureCollection for the map overlay.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { OverlayLayerSpec } from '../map/map.service';
import type { Club } from '../../../shared/api/clubs.gen';
import type { PlanShot, PlanGate } from '../../../shared/api/game-plans.gen';
import {
    adjustedCarryM,
    bearingToUnitVector,
    corridorWidth,
    dispersionEllipse,
    gatedForwardRoutePoints,
    optimizeAim,
    scoreOptionChain,
    segmentStats,
    windEffect,
    type ChainLeg,
    type ChainScoreContext,
    type DispersionEllipse,
    type FlatRing,
    type Lie,
    type Vec2,
} from '../../../shared/strategy';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../geo/transform';
import {
    ACCENT_COLOR,
    CAT,
    MAP_GREEN_FILL,
    MARKER_FILL,
    MARKER_RING,
    MARKER_RING_WIDTH,
    OVERLAY_TEXT,
    OVERLAY_TEXT_HALO,
    SHOT_LINE_COLOR,
    SHOT_LINE_WIDTH,
    STATUS_BAD,
    STATUS_GOOD,
    STATUS_NEUTRAL,
    STATUS_RISK,
} from '../map/map-palette';
import type { LieMap } from './lie-map';

/** Overlay/source id for the plan rendering. */
export const PLAN_OVERLAY_ID = 'plan';

/** Default half-widths for a freshly placed corridor gate, meters. */
export const GATE_DEFAULT_HALF_WIDTH_M = 30;

/** Selection highlight colour (matches the builder tools). */
export const PLAN_SELECTION_COLOR = ACCENT_COLOR; // '#BF6A3E' — --data-cat-1 / accent

// ── Planning model ─────────────────────────────────────────────────────────

/** A WGS84 anchor point with its sampled elevation (tee/shot/green rows). */
export interface PlanNodePoint {
    lat: number;
    lon: number;
    elevation: number | null;
}

/** One node of the hole's planning sequence, with projected coordinates. */
export interface PlanNode extends PlanNodePoint {
    kind: 'tee' | 'shot' | 'green';
    /** The backing shot row when kind === 'shot'. */
    shot?: PlanShot;
    /** Depth in the option tree (tee = -1, first shot = 0, green = terminal). */
    depth: number;
    /** True when this node belongs to the rank-0 primary line. */
    primary: boolean;
    /** EPSG:3006 easting/northing, meters. */
    x: number;
    y: number;
}

/** Effective wind for a hole (hole override ?? plan wind; null = calm). */
export interface EffectiveWind {
    speedMps: number;
    directionDeg: number;
}

export interface HolePlanInput {
    /** Resolved origin tee (GamePlanHole.teeId, fallback first by sortOrder). */
    tee: PlanNodePoint | null;
    /** The hole's plan shots, sorted by sortOrder. */
    shots: readonly PlanShot[];
    /** Rank-0 traversal supplied by PlanService's primary-line selector. */
    primaryShots?: readonly PlanShot[];
    /** Green center (terminal target). */
    green: PlanNodePoint | null;
    /** All clubs (for clubId lookups). */
    clubs: readonly Club[];
    /** Hole preferredClubId — the tee leg's club fallback. */
    preferredClubId: string | null;
    wind: EffectiveWind | null;
}

/** One leg of the plan with its full readout. */
export interface PlanLeg {
    index: number;
    /** Leg depth in the tree (0 = tee shot). */
    depth: number;
    /** Primary-line legs render solid; other option legs render dashed/dimmed. */
    primary: boolean;
    from: PlanNode;
    to: PlanNode;
    /** Planar initial bearing from → to, compass degrees. */
    bearingDeg: number;
    /** Assigned club (landing shot's club; tee-leg fallback preferredClubId). */
    club: Club | null;
    /** Planar ground distance, meters. */
    horizontalM: number;
    /** horizontal + elevationΔ; undefined when an endpoint lacks elevation. */
    playsLikeM: number | undefined;
    /** Fractional wind carry multiplier for this leg's bearing (0 when calm). */
    windEffect: number;
    /** The assigned club's wind-adjusted carry, meters (undefined: no club). */
    adjustedCarryM: number | undefined;
    /** Dispersion ellipse anchored at `from` (undefined: no club). */
    ellipse: DispersionEllipse | undefined;
    /** Straight-line distance from `to` to the green center, meters. */
    remainingToGreenM: number | undefined;
    /**
     * Expected strokes to hole out from this leg's approach aim, from
     * `optimizeAim` (undefined until `enrichLegStrategy` fills it — see
     * COMPUTE CADENCE below). Only meaningful for legs with a club (the
     * ones that get a dispersion ellipse); undefined otherwise.
     */
    expectedStrokes?: number;
    /**
     * Fraction of dispersion samples per lie at the recommended aim (the
     * `optimizeAim` result's `breakdown`) — drives the lights UI (T7).
     * Undefined until enriched, same as `expectedStrokes`.
     */
    lieBreakdown?: Partial<Record<Lie, number>>;
    /** The recommended aim bearing from `optimizeAim`, when enriched. */
    recommendedBearingDeg?: number;
    /**
     * The dispersion pattern the RECOMMENDED aim would produce (same club/
     * wind/slope, `recommendedBearingDeg`), filled in by `enrichLegStrategy`
     * alongside the other strategy fields. This is what the ghost marker's
     * "aim here" actually lands: its (drift-shifted) `center` is the
     * predicted finish. Undefined until enriched — so, like the ghost, it
     * never renders mid-drag.
     */
    recommendedEllipse?: DispersionEllipse;
}

// ── Strategy enrichment (DECADE Phase C) ────────────────────────────────────
//
// COMPUTE CADENCE (decision DECADE §4.5): `optimizeAim`/`shotsToHoleOut` are
// NOT run inside `buildHolePlan` above — that function is called on every
// reactive tick, INCLUDING per-drag-frame local patches (see
// PlannerToolService.applyDrag → patchShotLocal, which is deliberately a
// synchronous per-frame local mutation with no network I/O). Sweeping ~13
// aim candidates × ~128 samples × point-in-ring per frame would turn every
// mouse-move into a full re-optimization.
//
// Instead, `enrichLegStrategy` is a SEPARATE, opt-in step: callers invoke it
// only on shot-place and drag-RELEASE (see PlannerToolService.persistDrag /
// placeShot), passing the already-built `HolePlan`'s legs. It returns new
// leg objects with `expectedStrokes`/`lieBreakdown`/`recommendedBearingDeg`
// filled in; `buildHolePlan`'s own output is never mutated in place, so a
// caller that skips enrichment (e.g. the per-frame drag path) keeps getting
// plain geometry with those fields undefined, by construction — there is no
// per-frame code path that can accidentally reach `optimizeAim`.

/** Inputs `enrichLegStrategy` needs beyond what's already on the leg. */
export interface LegStrategyContext {
    /** The hole's pre-flattened lie map (see planner/lie-map.ts). */
    lieMap: LieMap;
    /** Terminal target for remaining-distance scoring (the green center). */
    greenCenter: Vec2;
    wind: EffectiveWind | null;
}

/**
 * Enrich ONE leg with `expectedStrokes`/`lieBreakdown`/`recommendedBearingDeg`
 * via `optimizeAim`, when the leg has a club (no club → no ellipse → nothing
 * to optimize, the leg is returned unchanged). Pure: does not mutate `leg`.
 */
export function enrichLegStrategy(leg: PlanLeg, ctx: LegStrategyContext): PlanLeg {
    if (!leg.club) return leg;
    const wind = ctx.wind;
    // Same groundSlope derivation buildHolePlan uses for the ellipse (elevationΔ
    // recovered from playsLikeM = horizontal + elevationΔ), so the aim sweep's
    // ellipses land consistently with the leg's own drawn ellipse.
    const groundSlope = leg.playsLikeM !== undefined && leg.horizontalM > 0
        ? (leg.playsLikeM - leg.horizontalM) / leg.horizontalM
        : 0;

    const result = optimizeAim({
        origin: { x: leg.from.x, y: leg.from.y },
        club: leg.club,
        targetBearingDeg: leg.bearingDeg,
        surfaces: ctx.lieMap.surfaces(),
        greenCenter: ctx.greenCenter,
        groundSlope,
        ...(wind !== null ? { windSpeedMps: wind.speedMps, windDirectionDeg: wind.directionDeg } : {}),
    });

    return {
        ...leg,
        expectedStrokes: result.best.expectedStrokes,
        lieBreakdown: result.breakdown,
        recommendedBearingDeg: result.bestBearingDeg,
        // The pattern the winning aim produces — one extra ellipse per
        // enrichment pass (trivial next to the sweep itself). Rendered as the
        // dashed "you'd finish here" companion to the ghost aim marker.
        recommendedEllipse: dispersionEllipse({
            origin: { x: leg.from.x, y: leg.from.y },
            bearingDeg: result.bestBearingDeg,
            club: leg.club,
            groundSlope,
            ...(wind !== null
                ? { windSpeedMps: wind.speedMps, windDirectionDeg: wind.directionDeg }
                : {}),
        }),
    };
}

/** Enrich every leg of a plan (shot-place / drag-release cadence — see above). */
export function enrichPlanStrategy(plan: HolePlan, ctx: LegStrategyContext): HolePlan {
    const allLegs = plan.allLegs.map(leg => enrichLegStrategy(leg, ctx));
    const byIndex = new Map(allLegs.map(leg => [leg.index, leg]));
    return {
        ...plan,
        allLegs,
        legs: plan.legs.map(leg => byIndex.get(leg.index)!),
    };
}

// ── Pin lights (DECADE Phase D) ─────────────────────────────────────────────
//
// Generic green/yellow/red confidence chip per APPROACH leg (a leg landing
// on the green). Derived purely from the enriched `lieBreakdown` (the fraction
// of dispersion samples per lie at the recommended aim) — NO DECADE branding,
// no trademarked "light" naming (DECADE doc §9), just a three-level attack
// confidence. The published DECADE principle is: attack (green) when the
// pattern almost never leaves the green and never finds trouble; be cautious
// (yellow) when a meaningful slice misses into rough/sand; bail to the fat
// side (red) when penalty/recovery trouble is in play or the green is rarely
// held. "Short side" here means the trouble lies (sand + penalty + recovery) —
// the ones that leave a hard up-and-down — crossing a threshold; the plan
// model carries only the green centre, not pin-relative geometry, so we use
// the trouble-share of the pattern as the short-side proxy (calibratable).

export type LegLight = 'green' | 'yellow' | 'red';

/** Trouble share above this → at best yellow (a slice misses the short side). */
export const LIGHT_TROUBLE_YELLOW = 0.1;
/** Trouble share above this (or any penalty) → red (bail to the fat side). */
export const LIGHT_TROUBLE_RED = 0.25;
/** Green-hit share below this → at best yellow (green rarely held). */
export const LIGHT_GREEN_HELD = 0.6;

/**
 * The confidence light for an enriched APPROACH leg, or null when the leg is
 * not an approach (does not land on the green) or is not yet enriched (no
 * `lieBreakdown`). Pure — reads only the leg's own breakdown.
 *
 * red   — any penalty in the pattern, OR trouble (sand+penalty+recovery) share
 *         ≥ LIGHT_TROUBLE_RED: take your medicine, aim at the fat side.
 * yellow— trouble share ≥ LIGHT_TROUBLE_YELLOW, OR green held <
 *         LIGHT_GREEN_HELD: playable but don't fire at a tucked pin.
 * green — pattern holds the green and stays out of trouble: attack.
 */
export function legLight(leg: PlanLeg): LegLight | null {
    if (leg.to.kind !== 'green' || !leg.lieBreakdown) return null;
    const b = leg.lieBreakdown;
    const penalty = b.penalty ?? 0;
    const trouble = penalty + (b.sand ?? 0) + (b.recovery ?? 0);
    const green = b.green ?? 0;
    if (penalty > 0 || trouble >= LIGHT_TROUBLE_RED) return 'red';
    if (trouble >= LIGHT_TROUBLE_YELLOW || green < LIGHT_GREEN_HELD) return 'yellow';
    return 'green';
}

// ── Ghost recommended-aim marker (DECADE Phase D) ───────────────────────────

/**
 * The recommended-aim landing point for an enriched leg, projected forward
 * from the leg's origin along `recommendedBearingDeg` by the leg's own
 * adjusted carry — a "ghost" marker showing where DECADE would aim this shot.
 * Null when the leg is not enriched or has no club/carry to project.
 */
export interface GhostAim {
    legIndex: number;
    bearingDeg: number;
    /** Landing point, EPSG:3006 meters. */
    point: Vec2;
    lat: number;
    lon: number;
}

export function ghostAimForLeg(leg: PlanLeg): GhostAim | null {
    if (leg.recommendedBearingDeg === undefined || leg.adjustedCarryM === undefined) return null;
    const unit = bearingToUnitVector(leg.recommendedBearingDeg);
    // Same ground-slope projection the ellipse applies to its center, so the
    // ghost sits on the recommended pattern's long axis and the ghost →
    // pattern-center offset is PURE crosswind drift (an honest "hold" arrow).
    const slope = leg.playsLikeM !== undefined && leg.horizontalM > 0
        ? (leg.playsLikeM - leg.horizontalM) / leg.horizontalM
        : 0;
    const carry = 1 + slope > 0 ? leg.adjustedCarryM / (1 + slope) : leg.adjustedCarryM;
    const point: Vec2 = {
        x: leg.from.x + unit.x * carry,
        y: leg.from.y + unit.y * carry,
    };
    const { lat, lon } = sweref99tmToWgs84(point.x, point.y);
    return { legIndex: leg.index, bearingDeg: leg.recommendedBearingDeg, point, lat, lon };
}

export interface HolePlan {
    /** Primary route only: tee → rank-0 chain → green. */
    nodes: PlanNode[];
    /** Primary route legs only (preserves existing panel/profile semantics). */
    legs: PlanLeg[];
    /** Every unique tee/shot/green node, including option branches. */
    allNodes: PlanNode[];
    /** Every tree edge plus one terminal edge from each leaf to the green. */
    allLegs: PlanLeg[];
    /** Sum of leg horizontals, meters. */
    totalHorizontalM: number;
    /** Sum of plays-like over legs that have it; undefined when none do. */
    totalPlaysLikeM: number | undefined;
}

/** Planar initial bearing a → b in EPSG:3006, compass degrees [0, 360). */
export function planarBearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

function orderedChildren(shots: readonly PlanShot[]): Map<string | null, PlanShot[]> {
    const index = new Map<string | null, PlanShot[]>();
    for (const shot of shots) {
        const siblings = index.get(shot.parentShotId) ?? [];
        siblings.push(shot);
        index.set(shot.parentShotId, siblings);
    }
    for (const siblings of index.values()) {
        siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    }
    return index;
}

function derivePrimaryShots(shots: readonly PlanShot[]): PlanShot[] {
    const children = orderedChildren(shots);
    const primary: PlanShot[] = [];
    let parentShotId: string | null = null;
    while (true) {
        const shot: PlanShot | undefined = children.get(parentShotId)?.[0];
        if (!shot) return primary;
        primary.push(shot);
        parentShotId = shot.id;
    }
}

/** Build the primary route plus all option-tree overlay geometry. */
export function buildHolePlan(input: HolePlanInput): HolePlan {
    const clubById = new Map(input.clubs.map(c => [c.id, c]));
    const children = orderedChildren(input.shots);
    const primaryShots = input.primaryShots ?? derivePrimaryShots(input.shots);
    const primaryIds = new Set(primaryShots.map(shot => shot.id));

    const makeNode = (
        kind: PlanNode['kind'],
        p: PlanNodePoint,
        depth: number,
        primary: boolean,
        shot?: PlanShot,
    ): PlanNode => {
        const { x, y } = wgs84ToSweref99tm(p.lat, p.lon);
        return { kind, lat: p.lat, lon: p.lon, elevation: p.elevation, x, y, shot, depth, primary };
    };
    const tee = input.tee ? makeNode('tee', input.tee, -1, true) : null;
    const green = input.green ? makeNode('green', input.green, primaryShots.length, true) : null;
    const nodeByShotId = new Map<string, PlanNode>();
    const depthByShotId = new Map<string, number>();
    const depthFor = (shot: PlanShot): number => {
        const cached = depthByShotId.get(shot.id);
        if (cached !== undefined) return cached;
        const parent = shot.parentShotId === null
            ? null
            : input.shots.find(candidate => candidate.id === shot.parentShotId) ?? null;
        const depth = parent ? depthFor(parent) + 1 : 0;
        depthByShotId.set(shot.id, depth);
        return depth;
    };
    for (const shot of input.shots) {
        nodeByShotId.set(shot.id, makeNode(
            'shot',
            { lat: shot.lat, lon: shot.lon, elevation: shot.elevation },
            depthFor(shot),
            primaryIds.has(shot.id),
            shot,
        ));
    }

    const allLegs: PlanLeg[] = [];
    const addLeg = (from: PlanNode, to: PlanNode, depth: number, primary: boolean): void => {
        const index = allLegs.length;
        const bearingDeg = planarBearingDeg(from, to);
        const stats = segmentStats(from, to);

        // Club: the landing shot's club; the tee leg (index 0) falls back to
        // the hole's preferred club (also covers the par-3 zero-shot leg).
        const clubId = (to.kind === 'shot' ? to.shot?.clubId : null)
            ?? (depth === 0 ? input.preferredClubId : null);
        const club = (clubId && clubById.get(clubId)) || null;

        // Forward application (paired with adjustedCarryM below): key the
        // effect on the club's nominal carry when a club is assigned; fall
        // back to the leg's plays-like/horizontal distance otherwise.
        const effect = input.wind
            ? windEffect(
                  input.wind.speedMps,
                  input.wind.directionDeg,
                  bearingDeg,
                  club?.carryM ?? stats.playsLikeSimpleM ?? stats.horizontalM,
              )
            : 0;
        // Leg slope (signed elevationΔ / horizontal) so the ellipse projects
        // the club's air carry onto the ground — keeps the dispersion circle
        // consistent with plays-like club selection (downhill reaches further).
        const groundSlope = stats.elevationDeltaM !== undefined && stats.horizontalM > 0
            ? stats.elevationDeltaM / stats.horizontalM
            : 0;
        const ellipse = club
            ? dispersionEllipse({
                origin: { x: from.x, y: from.y },
                bearingDeg,
                club,
                groundSlope,
                ...(input.wind !== null
                    ? { windSpeedMps: input.wind.speedMps, windDirectionDeg: input.wind.directionDeg }
                    : {}),
            })
            : undefined;

        allLegs.push({
            index,
            depth,
            primary,
            from,
            to,
            bearingDeg,
            club,
            horizontalM: stats.horizontalM,
            playsLikeM: stats.playsLikeSimpleM,
            windEffect: effect,
            adjustedCarryM: club ? adjustedCarryM(club.carryM, effect) : undefined,
            ellipse,
            remainingToGreenM: green ? Math.hypot(green.x - to.x, green.y - to.y) : undefined,
        });
    };

    for (const shot of input.shots) {
        const to = nodeByShotId.get(shot.id)!;
        const from = shot.parentShotId === null ? tee : nodeByShotId.get(shot.parentShotId) ?? null;
        if (from) addLeg(from, to, to.depth, primaryIds.has(shot.id));
    }
    if (green) {
        if (input.shots.length === 0) {
            if (tee) addLeg(tee, green, 0, true);
        } else {
            const primaryTailId = primaryShots.at(-1)?.id ?? null;
            for (const shot of input.shots) {
                if ((children.get(shot.id)?.length ?? 0) > 0) continue;
                const from = nodeByShotId.get(shot.id)!;
                addLeg(from, green, from.depth + 1, shot.id === primaryTailId);
            }
        }
    }

    const primaryNodeRows = primaryShots
        .map(shot => nodeByShotId.get(shot.id))
        .filter((node): node is PlanNode => node !== undefined);
    const nodes = [tee, ...primaryNodeRows, green].filter((node): node is PlanNode => node !== null);
    const allNodes = [tee, ...input.shots.map(shot => nodeByShotId.get(shot.id)!), green]
        .filter((node): node is PlanNode => node !== null);
    const legs = allLegs.filter(leg => leg.primary);

    let totalHorizontalM = 0;
    let totalPlaysLikeM = 0;
    let measured = 0;
    for (const leg of legs) {
        totalHorizontalM += leg.horizontalM;
        if (leg.playsLikeM !== undefined) {
            totalPlaysLikeM += leg.playsLikeM;
            measured++;
        }
    }

    return {
        nodes,
        legs,
        allNodes,
        allLegs,
        totalHorizontalM,
        totalPlaysLikeM: measured > 0 ? totalPlaysLikeM : undefined,
    };
}

// ── Option score chips (feature-plan-shot-options.md O4, T30) ───────────────
//
// At every decision point with more than one sibling, each option gets the
// score/risk triple from `scoreOptionChain` (shared/strategy): probable hole
// score leading, penalty% beside, blow-up (CVaR₈₀) on hover/expand. The
// chain behind each chip is the option shot followed by its RANK-0
// continuation to the branch leaf (the option's own planned line); the
// terminal expected strokes from the leaf landing live inside the chain
// scorer. Probable hole score = strokes already played to reach the decision
// point (tree depth) + the chain EV — Arccos-style presentation per O4.
//
// COMPUTE CADENCE: `buildOptionChips` runs `scoreOptionChain`, which sweeps
// `optimizeAim` per clubbed leg — the same cost class as `enrichPlanStrategy`.
// Callers invoke it ONLY on the strategy enrich cadence (shot-place /
// drag-release, coalesced — see PlannerToolService.refreshStrategy), never
// per drag frame.

/** One option's score chip at a multi-sibling decision point. */
export interface OptionChip {
    /** The option shot at the decision point (the chain's first landing). */
    shotId: string;
    /** Sibling rank within the decision point (0 = current primary choice). */
    rank: number;
    /** True when the option shot sits on the hole's primary line. */
    primary: boolean;
    /** The option leg's assigned club name, when set. */
    clubName: string | null;
    /** Strokes already played to reach the decision point (tree depth). */
    strokesBefore: number;
    /** Probable hole score: strokesBefore + chain expectedStrokes. */
    probableScore: number;
    /** Chain-aggregate penalty probability (0..1). */
    penaltyProb: number;
    /** Probable blow-up score: strokesBefore + chain tailStrokes (CVaR₈₀). */
    tailScore: number;
    /** Chip anchor — the option shot's landing point (WGS84). */
    lat: number;
    lon: number;
}

/**
 * "prob. 4.2 · 12% pen", plus ", blow-up 5.6" when `tailScore` is present —
 * the SAME vocabulary as iOS `ScoreRiskFormat.triple` (options doc O4: decide
 * choices and option chips must speak identically across surfaces).
 */
export function scoreRiskTriple(probableScore: number, penaltyShare: number, tailScore?: number): string {
    let out = `prob. ${probableScore.toFixed(1)} · ${Math.round(penaltyShare * 100)}% pen`;
    if (tailScore !== undefined) out += `, blow-up ${tailScore.toFixed(1)}`;
    return out;
}

/** Map-chip label: club leading ("Driver · prob. 4.2 · 12% pen"), tail when expanded. */
export function optionChipLabel(chip: OptionChip, expanded: boolean): string {
    const triple = scoreRiskTriple(
        chip.probableScore, chip.penaltyProb, expanded ? chip.tailScore : undefined);
    return chip.clubName ? `${chip.clubName} · ${triple}` : triple;
}

/**
 * Score chips for every option at every multi-sibling decision point of the
 * plan. Pure; runs the aim sweep per clubbed chain leg — enrich cadence only
 * (see the section comment). Legs without a club price as the point estimate
 * inside `scoreOptionChain`, so chips appear as soon as siblings exist.
 */
export function buildOptionChips(plan: HolePlan, ctx: LegStrategyContext): OptionChip[] {
    const shots = plan.allNodes
        .filter(node => node.kind === 'shot' && node.shot !== undefined)
        .map(node => node.shot!);
    const nodeByShotId = new Map(
        plan.allNodes.filter(node => node.shot !== undefined).map(node => [node.shot!.id, node]));
    const legByShotId = new Map(
        plan.allLegs
            .filter(leg => leg.to.kind === 'shot' && leg.to.shot !== undefined)
            .map(leg => [leg.to.shot!.id, leg]));
    const children = orderedChildren(shots);
    // ONE definition of "the chain an option is priced on" and "the context it
    // is priced in" — the simulator calls the same two helpers, so an EV chip
    // and its distribution can never be computed over different geometry.
    const chainCtx = chainScoreContext(ctx);

    const chips: OptionChip[] = [];
    for (const siblings of children.values()) {
        if (siblings.length < 2) continue; // not a decision point
        siblings.forEach((shot, rank) => {
            // The option's planned line: this shot, then rank-0 descendants.
            const legs = branchChainLegs(plan, shot.id);
            if (!legs) return; // no origin resolved (e.g. missing tee) — no chip
            const node = nodeByShotId.get(shot.id);
            if (!node) return;
            const score = scoreOptionChain(legs, chainCtx);
            const strokesBefore = node.depth; // shots played before this decision
            chips.push({
                shotId: shot.id,
                rank,
                primary: node.primary,
                clubName: legByShotId.get(shot.id)?.club?.name ?? null,
                strokesBefore,
                probableScore: strokesBefore + score.expectedStrokes,
                penaltyProb: score.penaltyProb,
                tailScore: strokesBefore + score.tailStrokes,
                lat: node.lat,
                lon: node.lon,
            });
        });
    }
    return chips;
}

/**
 * The `ChainLeg[]` for ONE branch of the option tree: the leg landing on
 * `startShotId`, then its rank-0 descendants — i.e. exactly the chain
 * `buildOptionChips` prices, extracted so the simulator (which needs the same
 * chain, just a distribution instead of an EV) cannot drift from it.
 *
 * `startShotId === null` walks the hole's PRIMARY line from the tee. Returns
 * null when a leg can't be resolved (e.g. no tee yet), which is the caller's
 * cue that there is nothing to simulate.
 */
export function branchChainLegs(plan: HolePlan, startShotId: string | null): ChainLeg[] | null {
    const shots = plan.allNodes
        .filter(node => node.kind === 'shot' && node.shot !== undefined)
        .map(node => node.shot!);
    const legByShotId = new Map(
        plan.allLegs
            .filter(leg => leg.to.kind === 'shot' && leg.to.shot !== undefined)
            .map(leg => [leg.to.shot!.id, leg]));
    const children = orderedChildren(shots);

    let current: PlanShot | undefined = startShotId === null
        ? children.get(null)?.[0]
        : shots.find(shot => shot.id === startShotId);
    if (!current) return null;

    const legs: ChainLeg[] = [];
    while (current) {
        const leg = legByShotId.get(current.id);
        if (!leg) return null;
        const groundSlope = leg.playsLikeM !== undefined && leg.horizontalM > 0
            ? (leg.playsLikeM - leg.horizontalM) / leg.horizontalM
            : 0;
        legs.push({
            origin: { x: leg.from.x, y: leg.from.y },
            landing: { x: leg.to.x, y: leg.to.y },
            club: leg.club,
            groundSlope,
            ...(leg.recommendedBearingDeg !== undefined
                ? { recommendedBearingDeg: leg.recommendedBearingDeg }
                : {}),
        });
        current = children.get(current.id)?.[0];
    }
    return legs;
}

/** The strategy context in `scoreOptionChain`/`simulateChain` shape (one place). */
export function chainScoreContext(ctx: LegStrategyContext): ChainScoreContext {
    return {
        surfaces: ctx.lieMap.surfaces(),
        greenCenter: ctx.greenCenter,
        ...(ctx.wind !== null
            ? { wind: { speedMps: ctx.wind.speedMps, directionDeg: ctx.wind.directionDeg } }
            : {}),
    };
}

/** Tree depth of `shotId` in the plan (0 = a root option), or 0 when unknown. */
export function shotDepthInPlan(plan: HolePlan, shotId: string): number {
    const node = plan.allNodes.find(n => n.shot?.id === shotId);
    return node?.depth ?? 0;
}

// ── Corridor-gate geometry ─────────────────────────────────────────────────

/**
 * Perpendicular foot of `p` on segment a → b, clamped to the segment.
 * `t` is the normalized position along a → b in [0, 1].
 */
export function perpendicularFoot(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const raw = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    const t = Math.min(1, Math.max(0, raw));
    return { point: { x: a.x + abx * t, y: a.y + aby * t }, t };
}

export interface LegFoot {
    legIndex: number;
    /** Foot point on the leg, EPSG:3006 meters. */
    point: Vec2;
    /** Planar distance from `p` to the foot, meters. */
    distM: number;
    t: number;
}

/** The nearest leg's perpendicular foot for `p`, or null with no legs. */
export function nearestLegFoot(p: Vec2, legs: readonly PlanLeg[]): LegFoot | null {
    let best: LegFoot | null = null;
    for (const leg of legs) {
        const { point, t } = perpendicularFoot(p, leg.from, leg.to);
        const distM = Math.hypot(p.x - point.x, p.y - point.y);
        if (!best || distM < best.distM) best = { legIndex: leg.index, point, distM, t };
    }
    return best;
}

/**
 * The gate ruler's endpoints: the ruler runs PERPENDICULAR to the stored
 * corridor-axis bearing (directionDeg). "Left"/"right" are relative to the
 * play direction — left = bearing − 90°, right = bearing + 90°.
 */
export function gateEndpoints(
    station: Vec2,
    directionDeg: number,
    halfWidthLeftM: number,
    halfWidthRightM: number,
): { left: Vec2; right: Vec2 } {
    const leftUnit = bearingToUnitVector(directionDeg - 90);
    const rightUnit = bearingToUnitVector(directionDeg + 90);
    return {
        left: { x: station.x + leftUnit.x * halfWidthLeftM, y: station.y + leftUnit.y * halfWidthLeftM },
        right: { x: station.x + rightUnit.x * halfWidthRightM, y: station.y + rightUnit.y * halfWidthRightM },
    };
}

// ── Auto-gates (computed corridor gates) ────────────────────────────────────
//
// "Compute instead of eyeball" (DECADE doc §3): a manual gate is a player
// eyeballing corridor width; an auto-gate reads it straight off the mapped
// hazard rings via corridorWidth(). One computed gate per leg, stationed at
// the leg's MIDPOINT (a single representative cross-section — matching the
// existing manual "drop a gate on this leg" affordance, which also places
// one gate per click rather than sampling the whole leg). Half-widths are
// corridorWidth()'s in-play widths, capped at `maxHalfWidthM` same as manual
// gates default to (GATE_DEFAULT_HALF_WIDTH_M as the cap keeps auto-gates
// the same visual scale as hand-placed ones on hazard-free legs).

/** A computed gate's fields, ready for `PlanService.addGate` (source: 'computed'). */
export interface AutoGate {
    legIndex: number;
    lat: number;
    lon: number;
    directionDeg: number;
    halfWidthLeftM: number;
    halfWidthRightM: number;
    source: 'computed';
}

/**
 * One computed corridor gate per leg that has a club (legs without a club
 * have no aim line to cast a corridor from). Station = leg midpoint;
 * half-widths from `corridorWidth()` against `hazards`, capped at
 * `GATE_DEFAULT_HALF_WIDTH_M` so an open leg (no nearby hazard) still draws
 * a sane-sized gate rather than the corridorWidth default 100 m cap.
 */
export function autoGatesForPlan(
    legs: readonly PlanLeg[],
    hazards: readonly FlatRing[],
): AutoGate[] {
    const gates: AutoGate[] = [];
    for (const leg of legs) {
        if (!leg.club) continue;
        const station: Vec2 = { x: (leg.from.x + leg.to.x) / 2, y: (leg.from.y + leg.to.y) / 2 };
        const width = corridorWidth({
            station,
            axisBearingDeg: leg.bearingDeg,
            obstacles: hazards,
            maxHalfWidthM: GATE_DEFAULT_HALF_WIDTH_M,
        });
        const { lat, lon } = sweref99tmToWgs84(station.x, station.y);
        gates.push({
            legIndex: leg.index,
            lat,
            lon,
            directionDeg: leg.bearingDeg,
            halfWidthLeftM: width.leftM,
            halfWidthRightM: width.rightM,
            source: 'computed',
        });
    }
    return gates;
}

// ── Overlay GeoJSON ────────────────────────────────────────────────────────

export interface PlanOverlayInput {
    plan: HolePlan | null;
    gates: readonly PlanGate[];
    /**
     * Score chips for multi-sibling decision points (T30), computed on the
     * strategy enrich cadence — absent/empty mid-drag, like all enrichment.
     */
    optionChips?: readonly OptionChip[];
    selectedShotId: string | null;
    selectedGateId: string | null;
    /**
     * Hole aim points in tee→green order (WGS84). When supplied, a leg that
     * ENDS at the green renders as the ROUTED polyline through the still-ahead
     * aims (shared route-chainage filter, gated straight within
     * AIM_ROUTING_THRESHOLD_M of the green) instead of a straight cut — a
     * 500 m tee→green fallback leg follows the hole's doglegs. The leg's
     * label then shows the routed ground distance. Rendering only: strategy
     * (bearing/ellipse/EV) still works on the straight leg.
     */
    aimPoints?: readonly { lat: number; lon: number }[];
}

function toPosition(p: Vec2): Position {
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    return [lon, lat];
}

/**
 * Leg label: ground distance, then the "plays-as" (elevation plays-like)
 * distance, then the assigned club and its ABSOLUTE (nominal) carry — so the
 * map shows both how far the shot plays and what the club actually carries.
 * e.g. "184 m · plays 176 m · 7 Iron 150 m" (club/plays parts omitted when
 * absent).
 */
export function legLabel(leg: PlanLeg, routedM?: number): string {
    // A routed (through-the-aims) rendering labels the routed ground distance;
    // plays-as keeps the leg's elevation delta on top of it.
    const groundM = routedM ?? leg.horizontalM;
    const parts = [`${Math.round(groundM)} m`];
    if (leg.playsLikeM !== undefined) {
        parts.push(`plays ${Math.round(groundM + (leg.playsLikeM - leg.horizontalM))} m`);
    }
    if (leg.club) parts.push(`${leg.club.name} ${Math.round(leg.club.carryM)} m`);
    const drift = legDriftLabel(leg);
    if (drift) parts.push(drift);
    return parts.join(' · ');
}

/** Show the crosswind hold only once it matters on the ground. */
export const DRIFT_LABEL_MIN_M = 3;

/**
 * "drift 9 m R" for a clubbed leg whose pattern the wind shifts by at least
 * DRIFT_LABEL_MIN_M laterally (positive driftM = shot-right), else null.
 * Reads the leg's own ellipse — present whenever the leg has a club, on the
 * live geometry path too, so the label survives mid-drag.
 */
export function legDriftLabel(leg: PlanLeg): string | null {
    const driftM = leg.ellipse?.driftM ?? 0;
    if (Math.abs(driftM) < DRIFT_LABEL_MIN_M) return null;
    return `drift ${Math.round(Math.abs(driftM))} m ${driftM > 0 ? 'R' : 'L'}`;
}

/** "L 24 m | R 31 m" gate width label. */
export function gateLabel(gate: PlanGate): string {
    return `L ${Math.round(gate.halfWidthLeftM)} m | R ${Math.round(gate.halfWidthRightM)} m`;
}

/**
 * Routed rendering for a leg that ENDS at the green: the polyline through the
 * still-ahead aim points (shared route-chainage filter; gated straight within
 * AIM_ROUTING_THRESHOLD_M of the green, in which case this returns null and
 * the leg draws straight). Aim vertices reuse the source rows' WGS84 lat/lon
 * (no projection round-trip drift). Null when there is nothing to route
 * through — no aims supplied, non-green leg, or every aim already passed.
 */
function routedLegLine(
    plan: HolePlan,
    leg: PlanLeg,
    aimPoints: readonly { lat: number; lon: number }[] | undefined,
): { coordinates: Position[]; routedM: number } | null {
    if (!aimPoints || aimPoints.length === 0 || leg.to.kind !== 'green') return null;
    const aims = aimPoints.map(a => wgs84ToSweref99tm(a.lat, a.lon));
    const teeNode = plan.allNodes.find(n => n.kind === 'tee');
    const route = gatedForwardRoutePoints({
        origin: { x: leg.from.x, y: leg.from.y },
        aims,
        green: { x: leg.to.x, y: leg.to.y },
        ...(teeNode ? { tee: { x: teeNode.x, y: teeNode.y } } : {}),
    });
    const kept = Math.max(0, route.length - 2);
    if (kept === 0) return null;
    let routedM = 0;
    for (let i = 0; i < route.length - 1; i++) {
        routedM += Math.hypot(route[i + 1].x - route[i].x, route[i + 1].y - route[i].y);
    }
    const keptAims = aimPoints.slice(aimPoints.length - kept);
    return {
        coordinates: [
            [leg.from.lon, leg.from.lat],
            ...keptAims.map(a => [a.lon, a.lat] as Position),
            [leg.to.lon, leg.to.lat],
        ],
        routedM,
    };
}

/**
 * The plan overlay FeatureCollection (WGS84). Roles: `leg` (LineString with
 * a distance label), `ellipse` (Polygon per clubbed leg, selected = the
 * selected shot's landing ellipse), `node` (tee/shot/green markers), and
 * `gate-line` / `gate-handle` / `gate-label` for corridor rulers.
 */
export function buildPlanGeojson(input: PlanOverlayInput): FeatureCollection {
    const features: Feature[] = [];
    const plan = input.plan;

    if (plan) {
        for (const leg of plan.allLegs) {
            const routed = routedLegLine(plan, leg, input.aimPoints);
            features.push({
                type: 'Feature',
                properties: {
                    role: 'leg',
                    index: leg.index,
                    depth: leg.depth,
                    primary: leg.primary,
                    label: legLabel(leg, routed?.routedM),
                    // Approach-leg confidence light (null on non-approach / un-enriched
                    // legs) → tints the leg line; see legLight().
                    light: legLight(leg) ?? '',
                },
                geometry: {
                    type: 'LineString',
                    coordinates: routed?.coordinates
                        ?? [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]],
                },
            });
            if (leg.ellipse) {
                const selected = leg.to.kind === 'shot'
                    && leg.to.shot !== undefined
                    && leg.to.shot.id === input.selectedShotId;
                features.push({
                    type: 'Feature',
                    properties: {
                        role: 'ellipse',
                        legIndex: leg.index,
                        primary: leg.primary,
                        selected,
                    },
                    geometry: { type: 'Polygon', coordinates: [leg.ellipse.polygon.map(toPosition)] },
                });
            }
        }

        // Ghost recommended-aim group per enriched leg (DECADE Phase D): the
        // hollow aim marker ("point here"), the dashed pattern that aim would
        // produce, a dot at its drift-shifted center ("you'd finish here"),
        // and a connector between the two so the wind hold reads at a glance.
        // Only enriched legs (recommendedBearingDeg set) yield these — the
        // per-frame drag path never enriches, so none of it flickers mid-drag.
        for (const leg of plan.allLegs) {
            const ghost = ghostAimForLeg(leg);
            if (!ghost) continue;
            const rec = leg.recommendedEllipse;
            if (rec) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'ghost-ellipse', legIndex: ghost.legIndex, primary: leg.primary },
                    geometry: { type: 'Polygon', coordinates: [rec.polygon.map(toPosition)] },
                });
                features.push({
                    type: 'Feature',
                    properties: { role: 'ghost-center', legIndex: ghost.legIndex, primary: leg.primary },
                    geometry: { type: 'Point', coordinates: toPosition(rec.center) },
                });
                // Aim → finish connector: only worth drawing once the drift is
                // visible at map scale (same threshold as the leg label).
                if (Math.abs(rec.driftM) >= DRIFT_LABEL_MIN_M) {
                    features.push({
                        type: 'Feature',
                        properties: {
                            role: 'ghost-drift',
                            legIndex: ghost.legIndex,
                            primary: leg.primary,
                            label: `drift ${Math.round(Math.abs(rec.driftM))} m ${rec.driftM > 0 ? 'R' : 'L'}`,
                        },
                        geometry: {
                            type: 'LineString',
                            coordinates: [[ghost.lon, ghost.lat], toPosition(rec.center)],
                        },
                    });
                }
            }
            features.push({
                type: 'Feature',
                properties: { role: 'ghost-aim', legIndex: ghost.legIndex, primary: leg.primary },
                geometry: { type: 'Point', coordinates: [ghost.lon, ghost.lat] },
            });
        }

        for (const node of plan.allNodes) {
            const siblings = node.shot
                ? plan.allNodes.filter(candidate => candidate.shot?.parentShotId === node.shot?.parentShotId)
                : [];
            const optionIndex = node.shot
                ? siblings.findIndex(candidate => candidate.shot?.id === node.shot?.id)
                : -1;
            const shotLabel = node.kind === 'shot'
                ? `${node.depth + 1}${optionIndex > 0 ? String.fromCharCode(97 + optionIndex) : ''}`
                : '';
            features.push({
                type: 'Feature',
                properties: {
                    role: 'node',
                    kind: node.kind,
                    id: node.shot?.id ?? null,
                    primary: node.primary,
                    label: node.kind === 'tee' ? 'T' : node.kind === 'green' ? 'G' : shotLabel,
                    selected: node.kind === 'shot' && node.shot?.id === input.selectedShotId,
                },
                geometry: { type: 'Point', coordinates: [node.lon, node.lat] },
            });
        }
    }

    // Option score chips (T30): one labelled point per option at a decision
    // point. The SELECTED option's chip expands with the blow-up (tail) score
    // — the map's "expand" affordance; the panel's is its hover tooltip.
    for (const chip of input.optionChips ?? []) {
        features.push({
            type: 'Feature',
            properties: {
                role: 'option-chip',
                shotId: chip.shotId,
                primary: chip.primary,
                label: optionChipLabel(chip, chip.shotId === input.selectedShotId),
            },
            geometry: { type: 'Point', coordinates: [chip.lon, chip.lat] },
        });
    }

    for (const gate of input.gates) {
        const station = wgs84ToSweref99tm(gate.lat, gate.lon);
        const { left, right } = gateEndpoints(
            station, gate.directionDeg, gate.halfWidthLeftM, gate.halfWidthRightM);
        const selected = gate.id === input.selectedGateId;
        features.push({
            type: 'Feature',
            properties: { role: 'gate-line', id: gate.id, selected, label: gateLabel(gate) },
            geometry: { type: 'LineString', coordinates: [toPosition(left), toPosition(right)] },
        });
        for (const [side, p] of [['left', left], ['right', right]] as const) {
            features.push({
                type: 'Feature',
                properties: { role: 'gate-handle', id: gate.id, side, selected },
                geometry: { type: 'Point', coordinates: toPosition(p) },
            });
        }
        features.push({
            type: 'Feature',
            properties: { role: 'gate-label', id: gate.id, label: gateLabel(gate) },
            geometry: { type: 'Point', coordinates: [gate.lon, gate.lat] },
        });
    }

    return { type: 'FeatureCollection', features };
}

// ── Course route (tee → aim points → green) ────────────────────────────────
//
// The hole's ROUTING as authored in the course definition: aim-point count
// gives the par, aim-point positions give the doglegs. This is deliberately
// NOT part of `HolePlan` — plan legs are the player's strategy (plan shots),
// while this line is course data that exists whether or not a plan does. The
// planner draws it as its own overlay UNDER the plan legs so a hole with no
// (or a partial) plan still shows where the hole actually goes, instead of
// only the tee → green fallback leg. Mirrors the furniture editor's
// `aim-line` (same polyline, same dashed treatment) and iOS's course route.

/** Overlay/source id for the course-route line. */
export const COURSE_ROUTE_OVERLAY_ID = 'plan-course-route';

/** A course-route aim vertex — the source aim row's position + display label. */
export interface CourseRouteAim {
    id: string;
    lat: number;
    lon: number;
    label: string | null;
}

export interface CourseRouteInput {
    /** Resolved origin tee (same tee the plan anchors on), or null. */
    tee: { lat: number; lon: number } | null;
    /** Hole aim points in tee→green order (sortOrder). */
    aims: readonly CourseRouteAim[];
    /** Green center, or null. */
    green: { lat: number; lon: number } | null;
}

/**
 * The course-route FeatureCollection: one `route` LineString through
 * tee → aims → green, plus a numbered `route-aim` dot per aim. Vertices reuse
 * the source rows' WGS84 lat/lon (no projection round-trip drift). Returns an
 * empty collection when there is no aim point (nothing to route through — the
 * plan's own tee → green leg already draws that) or fewer than two vertices.
 */
export function buildCourseRouteGeojson(input: CourseRouteInput): FeatureCollection {
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    if (input.aims.length === 0) return empty;

    const coordinates: Position[] = [];
    if (input.tee) coordinates.push([input.tee.lon, input.tee.lat]);
    for (const aim of input.aims) coordinates.push([aim.lon, aim.lat]);
    if (input.green) coordinates.push([input.green.lon, input.green.lat]);
    if (coordinates.length < 2) return empty;

    const features: Feature[] = [{
        type: 'Feature',
        properties: { role: 'route' },
        geometry: { type: 'LineString', coordinates },
    }];
    input.aims.forEach((aim, index) => {
        features.push({
            type: 'Feature',
            properties: {
                role: 'route-aim',
                id: aim.id,
                label: aim.label?.trim() || `Aim ${index + 1}`,
            },
            geometry: { type: 'Point', coordinates: [aim.lon, aim.lat] },
        });
    });
    return { type: 'FeatureCollection', features };
}

/**
 * Layer specs for the course-route overlay. Neutral + dashed so the routing
 * reads as course data rather than as a played leg — the plan's own legs keep
 * the orange `--map-shot-line` treatment and draw on top of this.
 */
export function courseRouteLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${COURSE_ROUTE_OVERLAY_ID}-line`,
            type: 'line',
            filter: role('route'),
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': ROUTE_COLOR,
                'line-width': 2,
                'line-opacity': 0.8,
                'line-dasharray': [2, 1.5] as never,
            },
        },
        {
            id: `${COURSE_ROUTE_OVERLAY_ID}-aim`,
            type: 'circle',
            filter: role('route-aim'),
            paint: {
                'circle-radius': 4,
                'circle-color': ROUTE_COLOR,
                'circle-stroke-color': MARKER_FILL,
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: `${COURSE_ROUTE_OVERLAY_ID}-aim-label`,
            type: 'symbol',
            filter: role('route-aim'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 10,
                'text-offset': [0, -1.3],
                'text-anchor': 'bottom',
                'text-allow-overlap': false,
            },
            paint: {
                'text-color': OVERLAY_TEXT,
                'text-halo-color': OVERLAY_TEXT_HALO,
                'text-halo-width': 1.2,
            },
        },
    ];
}

const role = (value: string): FilterSpecification =>
    ['==', ['get', 'role'], value] as FilterSpecification;

const roleAndPrimary = (value: string, primary: boolean): FilterSpecification =>
    ['all', role(value), ['==', ['get', 'primary'], primary]] as FilterSpecification;

const LEG_COLOR = SHOT_LINE_COLOR; // '#E4A15A' — --map-shot-line (guide §03 shot lines)
const ELLIPSE_COLOR = CAT.moss; // '#5C6B4A' — --data-cat-4, landing dispersion
const GATE_COLOR = CAT.teal; // '#3E8EA0' — --data-cat-2
const GHOST_COLOR = CAT.plum; // '#8A5A6E' — --data-cat-6, distinct from legs/gates/ellipses
/** Course-route (tee → aims → green) line + vertices — quiet, non-strategy. */
const ROUTE_COLOR = STATUS_NEUTRAL; // '#9C917A' — --data-neutral

/** Confidence-light colours (L&L data-viz semantic ramp — good / risk / bad). */
export const LIGHT_GREEN_COLOR = STATUS_GOOD; // '#4E7A46' — --data-good
export const LIGHT_YELLOW_COLOR = STATUS_RISK; // '#C68A2E' — --data-risk
export const LIGHT_RED_COLOR = STATUS_BAD; // '#B24A32' — --data-bad

/** Layer specs for the plan overlay (ids prefixed with the overlay id). */
export function planLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${PLAN_OVERLAY_ID}-ellipse-fill`,
            type: 'fill',
            filter: role('ellipse'),
            paint: {
                'fill-color': ELLIPSE_COLOR,
                'fill-opacity': [
                    'case',
                    ['==', ['get', 'selected'], true], ['case', ['get', 'primary'], 0.3, 0.18],
                    ['get', 'primary'], 0.15,
                    0.06,
                ] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ellipse-outline`,
            type: 'line',
            filter: role('ellipse'),
            paint: {
                'line-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, ELLIPSE_COLOR] as never,
                'line-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.2] as never,
                'line-opacity': ['case', ['get', 'primary'], 0.9, 0.4] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-leg-option`,
            type: 'line',
            filter: roleAndPrimary('leg', false),
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': [
                    'match', ['get', 'light'],
                    'green', LIGHT_GREEN_COLOR,
                    'yellow', LIGHT_YELLOW_COLOR,
                    'red', LIGHT_RED_COLOR,
                    LEG_COLOR,
                ] as never,
                'line-width': SHOT_LINE_WIDTH,
                'line-opacity': 0.48,
                'line-dasharray': [2, 2] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-leg`,
            type: 'line',
            filter: roleAndPrimary('leg', true),
            // Guide §03 shot lines: 3px with rounded ("pill") ends.
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': [
                    'match', ['get', 'light'],
                    'green', LIGHT_GREEN_COLOR,
                    'yellow', LIGHT_YELLOW_COLOR,
                    'red', LIGHT_RED_COLOR,
                    LEG_COLOR,
                ] as never,
                'line-width': SHOT_LINE_WIDTH,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-leg-label`,
            type: 'symbol',
            filter: role('leg'),
            layout: {
                'symbol-placement': 'line-center',
                'text-field': ['get', 'label'] as never,
                'text-size': 12,
                'text-offset': [0, -1],
                // Guide §03: never let two labels overlap — MapLibre's collision
                // engine hides the loser instead of drawing mush at low zoom.
                'text-allow-overlap': false,
            },
            // Scrim-equivalent for canvas text: overlay-text on a heavy pine halo.
            paint: {
                'text-color': OVERLAY_TEXT,
                'text-halo-color': OVERLAY_TEXT_HALO,
                'text-halo-width': 1.5,
                'text-opacity': ['case', ['get', 'primary'], 1, 0.55] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ghost-ellipse`,
            type: 'line',
            filter: role('ghost-ellipse'),
            paint: {
                'line-color': GHOST_COLOR,
                'line-width': 1.5,
                'line-opacity': ['case', ['get', 'primary'], 0.8, 0.35] as never,
                'line-dasharray': [2, 2] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ghost-drift`,
            type: 'line',
            filter: role('ghost-drift'),
            paint: {
                'line-color': GHOST_COLOR,
                'line-width': 1.5,
                'line-opacity': ['case', ['get', 'primary'], 0.9, 0.4] as never,
                'line-dasharray': [1, 1.5] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ghost-drift-label`,
            type: 'symbol',
            filter: role('ghost-drift'),
            layout: {
                'symbol-placement': 'line-center',
                'text-field': ['get', 'label'] as never,
                'text-size': 11,
                'text-offset': [0, 1],
                'text-allow-overlap': false, // hide before overlapping (guide §03)
            },
            paint: { 'text-color': OVERLAY_TEXT, 'text-halo-color': OVERLAY_TEXT_HALO, 'text-halo-width': 1.5 },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ghost-center`,
            type: 'circle',
            filter: role('ghost-center'),
            paint: {
                'circle-radius': 3.5,
                'circle-color': GHOST_COLOR,
                'circle-stroke-color': MARKER_RING, // '#FFFFFF' — --overlay-text
                'circle-stroke-width': 1,
                'circle-opacity': ['case', ['get', 'primary'], 1, 0.5] as never,
                'circle-stroke-opacity': ['case', ['get', 'primary'], 1, 0.5] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ghost-aim`,
            type: 'circle',
            filter: role('ghost-aim'),
            paint: {
                'circle-radius': 6,
                'circle-color': 'transparent',
                'circle-stroke-color': GHOST_COLOR,
                'circle-stroke-width': 2,
                'circle-stroke-opacity': ['case', ['get', 'primary'], 0.9, 0.4] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-gate-line`,
            type: 'line',
            filter: role('gate-line'),
            paint: {
                'line-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, GATE_COLOR] as never,
                'line-width': 3,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-gate-handle`,
            type: 'circle',
            filter: role('gate-handle'),
            paint: {
                'circle-radius': 6,
                'circle-color': OVERLAY_TEXT, // '#FFFFFF' — --overlay-text
                'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, GATE_COLOR] as never,
                'circle-stroke-width': 2,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-gate-label`,
            type: 'symbol',
            filter: role('gate-label'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 11,
                'text-offset': [0, 1.6],
                'text-anchor': 'top',
                'text-allow-overlap': false, // hide before overlapping (guide §03)
            },
            paint: { 'text-color': OVERLAY_TEXT, 'text-halo-color': OVERLAY_TEXT_HALO, 'text-halo-width': 1.5 },
        },
        {
            id: `${PLAN_OVERLAY_ID}-node-sel`,
            type: 'circle',
            filter: ['all', role('node'), ['==', ['get', 'selected'], true]] as FilterSpecification,
            paint: {
                'circle-radius': 11,
                'circle-color': 'transparent',
                'circle-stroke-color': PLAN_SELECTION_COLOR,
                'circle-stroke-width': 2.5,
            },
        },
        {
            // Guide §03 markers: pine circle + 2px bone ring + bone glyph;
            // the GREEN node takes the feature colour with a dark glyph.
            id: `${PLAN_OVERLAY_ID}-node`,
            type: 'circle',
            filter: role('node'),
            paint: {
                'circle-radius': ['match', ['get', 'kind'], 'shot', 7, 6] as never,
                'circle-color': [
                    'match', ['get', 'kind'],
                    'green', MAP_GREEN_FILL, // '#7FC489' — --map-green-fill
                    MARKER_FILL, // '#1E2B22' — --color-surface-brand (pine): tee + shots
                ] as never,
                'circle-stroke-color': MARKER_RING, // '#FFFFFF' — --overlay-text (bone)
                'circle-stroke-width': MARKER_RING_WIDTH,
                'circle-opacity': ['case', ['get', 'primary'], 1, 0.62] as never,
                'circle-stroke-opacity': ['case', ['get', 'primary'], 1, 0.62] as never,
            },
        },
        {
            // Option score chips (T30): the probable-score/penalty readout
            // under each option marker at a decision point. Collision-hidden
            // before overlapping (guide §03); the primary choice's chip wins
            // visual weight over its alternatives.
            id: `${PLAN_OVERLAY_ID}-option-chip`,
            type: 'symbol',
            filter: role('option-chip'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 11,
                'text-offset': [0, 1.4],
                'text-anchor': 'top',
                'text-allow-overlap': false,
            },
            paint: {
                'text-color': OVERLAY_TEXT,
                'text-halo-color': OVERLAY_TEXT_HALO,
                'text-halo-width': 1.5,
                'text-opacity': ['case', ['get', 'primary'], 1, 0.75] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-node-label`,
            type: 'symbol',
            filter: role('node'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 10,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] as never,
                'text-allow-overlap': true, // marker glyphs, must never disappear
            },
            paint: {
                // Bone glyph on pine markers; dark glyph on the green-fill marker.
                'text-color': ['match', ['get', 'kind'], 'green', MARKER_FILL, OVERLAY_TEXT] as never,
                'text-halo-color': ['match', ['get', 'kind'], 'green', MAP_GREEN_FILL, MARKER_FILL] as never,
                'text-halo-width': 1,
                'text-opacity': ['case', ['get', 'primary'], 1, 0.62] as never,
            },
        },
    ];
}
