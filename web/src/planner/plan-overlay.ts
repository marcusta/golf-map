// Pure planning-model + overlay-geojson builders for the game-plan editor.
// No MapLibre, no DOM, no services — unit-testable under happy-dom (same
// split as analysis-tool.service vs analysis-overlay). All strategy math
// comes from shared/strategy (single reference implementation); this module
// only assembles nodes/legs and converts geometry for rendering.
//
// Planning model (Phase 5 contract):
//  - Node sequence: origin = selected tee, then plan shots in sort order
//    (each shot's lat/lon = its landing point), terminal = green center.
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
    optimizeAim,
    pathSegmentStats,
    windEffect,
    type DispersionEllipse,
    type FlatRing,
    type Lie,
    type StrategyPoint,
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
    return { ...plan, legs: plan.legs.map(leg => enrichLegStrategy(leg, ctx)) };
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
    nodes: PlanNode[];
    legs: PlanLeg[];
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

/** Build the hole's node sequence + legs with all per-leg readouts. */
export function buildHolePlan(input: HolePlanInput): HolePlan {
    const clubById = new Map(input.clubs.map(c => [c.id, c]));

    const nodes: PlanNode[] = [];
    const push = (kind: PlanNode['kind'], p: PlanNodePoint, shot?: PlanShot) => {
        const { x, y } = wgs84ToSweref99tm(p.lat, p.lon);
        nodes.push({ kind, lat: p.lat, lon: p.lon, elevation: p.elevation, x, y, shot });
    };
    if (input.tee) push('tee', input.tee);
    for (const shot of input.shots) {
        push('shot', { lat: shot.lat, lon: shot.lon, elevation: shot.elevation }, shot);
    }
    if (input.green) push('green', input.green);

    const green = nodes.find(n => n.kind === 'green') ?? null;
    const stats = pathSegmentStats(nodes satisfies StrategyPoint[]);

    const legs: PlanLeg[] = [];
    for (let i = 1; i < nodes.length; i++) {
        const from = nodes[i - 1];
        const to = nodes[i];
        const index = i - 1;
        const bearingDeg = planarBearingDeg(from, to);

        // Club: the landing shot's club; the tee leg (index 0) falls back to
        // the hole's preferred club (also covers the par-3 zero-shot leg).
        const clubId = (to.kind === 'shot' ? to.shot?.clubId : null)
            ?? (index === 0 ? input.preferredClubId : null);
        const club = (clubId && clubById.get(clubId)) || null;

        // Forward application (paired with adjustedCarryM below): key the
        // effect on the club's nominal carry when a club is assigned; fall
        // back to the leg's plays-like/horizontal distance otherwise.
        const effect = input.wind
            ? windEffect(
                  input.wind.speedMps,
                  input.wind.directionDeg,
                  bearingDeg,
                  club?.carryM ?? stats[index].playsLikeSimpleM ?? stats[index].horizontalM,
              )
            : 0;
        // Leg slope (signed elevationΔ / horizontal) so the ellipse projects
        // the club's air carry onto the ground — keeps the dispersion circle
        // consistent with plays-like club selection (downhill reaches further).
        const seg = stats[index];
        const groundSlope = seg.elevationDeltaM !== undefined && seg.horizontalM > 0
            ? seg.elevationDeltaM / seg.horizontalM
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

        legs.push({
            index,
            from,
            to,
            bearingDeg,
            club,
            horizontalM: stats[index].horizontalM,
            playsLikeM: stats[index].playsLikeSimpleM,
            windEffect: effect,
            adjustedCarryM: club ? adjustedCarryM(club.carryM, effect) : undefined,
            ellipse,
            remainingToGreenM: green ? Math.hypot(green.x - to.x, green.y - to.y) : undefined,
        });
    }

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
        totalHorizontalM,
        totalPlaysLikeM: measured > 0 ? totalPlaysLikeM : undefined,
    };
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
    selectedShotId: string | null;
    selectedGateId: string | null;
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
export function legLabel(leg: PlanLeg): string {
    const parts = [`${Math.round(leg.horizontalM)} m`];
    if (leg.playsLikeM !== undefined) parts.push(`plays ${Math.round(leg.playsLikeM)} m`);
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
 * The plan overlay FeatureCollection (WGS84). Roles: `leg` (LineString with
 * a distance label), `ellipse` (Polygon per clubbed leg, selected = the
 * selected shot's landing ellipse), `node` (tee/shot/green markers), and
 * `gate-line` / `gate-handle` / `gate-label` for corridor rulers.
 */
export function buildPlanGeojson(input: PlanOverlayInput): FeatureCollection {
    const features: Feature[] = [];
    const plan = input.plan;

    if (plan) {
        for (const leg of plan.legs) {
            features.push({
                type: 'Feature',
                properties: {
                    role: 'leg',
                    index: leg.index,
                    label: legLabel(leg),
                    // Approach-leg confidence light (null on non-approach / un-enriched
                    // legs) → tints the leg line; see legLight().
                    light: legLight(leg) ?? '',
                },
                geometry: {
                    type: 'LineString',
                    coordinates: [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]],
                },
            });
            if (leg.ellipse) {
                const selected = leg.to.kind === 'shot'
                    && leg.to.shot !== undefined
                    && leg.to.shot.id === input.selectedShotId;
                features.push({
                    type: 'Feature',
                    properties: { role: 'ellipse', legIndex: leg.index, selected },
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
        for (const leg of plan.legs) {
            const ghost = ghostAimForLeg(leg);
            if (!ghost) continue;
            const rec = leg.recommendedEllipse;
            if (rec) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'ghost-ellipse', legIndex: ghost.legIndex },
                    geometry: { type: 'Polygon', coordinates: [rec.polygon.map(toPosition)] },
                });
                features.push({
                    type: 'Feature',
                    properties: { role: 'ghost-center', legIndex: ghost.legIndex },
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
                properties: { role: 'ghost-aim', legIndex: ghost.legIndex },
                geometry: { type: 'Point', coordinates: [ghost.lon, ghost.lat] },
            });
        }

        let shotNumber = 0;
        for (const node of plan.nodes) {
            if (node.kind === 'shot') shotNumber++;
            features.push({
                type: 'Feature',
                properties: {
                    role: 'node',
                    kind: node.kind,
                    id: node.shot?.id ?? null,
                    label: node.kind === 'tee' ? 'T' : node.kind === 'green' ? 'G' : String(shotNumber),
                    selected: node.kind === 'shot' && node.shot?.id === input.selectedShotId,
                },
                geometry: { type: 'Point', coordinates: [node.lon, node.lat] },
            });
        }
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

const role = (value: string): FilterSpecification =>
    ['==', ['get', 'role'], value] as FilterSpecification;

const LEG_COLOR = SHOT_LINE_COLOR; // '#E4A15A' — --map-shot-line (guide §03 shot lines)
const ELLIPSE_COLOR = CAT.moss; // '#5C6B4A' — --data-cat-4, landing dispersion
const GATE_COLOR = CAT.teal; // '#3E8EA0' — --data-cat-2
const GHOST_COLOR = CAT.plum; // '#8A5A6E' — --data-cat-6, distinct from legs/gates/ellipses

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
                'fill-opacity': ['case', ['==', ['get', 'selected'], true], 0.3, 0.15] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ellipse-outline`,
            type: 'line',
            filter: role('ellipse'),
            paint: {
                'line-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, ELLIPSE_COLOR] as never,
                'line-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.2] as never,
                'line-opacity': 0.9,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-leg`,
            type: 'line',
            filter: role('leg'),
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
            paint: { 'text-color': OVERLAY_TEXT, 'text-halo-color': OVERLAY_TEXT_HALO, 'text-halo-width': 1.5 },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ghost-ellipse`,
            type: 'line',
            filter: role('ghost-ellipse'),
            paint: {
                'line-color': GHOST_COLOR,
                'line-width': 1.5,
                'line-opacity': 0.8,
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
                'line-opacity': 0.9,
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
                'circle-stroke-opacity': 0.9,
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
            },
        },
    ];
}
