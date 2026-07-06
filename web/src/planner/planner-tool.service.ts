import { Signal, Computed, effect, untrack, di, Router } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { Hole } from '../../../shared/api/holes.gen';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Club } from '../../../shared/api/clubs.gen';
import type { PlanGate, PlanShot } from '../../../shared/api/game-plans.gen';
import {
    bearingToUnitVector,
    closestClub,
    featureDistances,
    optimizeAim,
    playsAsM,
    runCaddy,
    segmentStats,
    windEffect,
    type AimResult,
    type CaddyAdvice,
    type CaddyContext,
    type CaddyRule,
    type DistanceTarget,
    type FeatureDistance,
    type FlatRing,
    type GreenSlopeSummary,
    type Vec2,
} from '../../../shared/strategy';
// The caddy rules are re-exported from the caddy barrel but not (yet) from the
// strategy index — that index line is owned by another task this wave, so we
// import the rules from the barrel directly.
import {
    greenSlopeHalfRule,
    noDoublesRule,
    par5AttackRule,
    shortSideGuardRule,
    specificTargetRule,
    takeYourMedicineRule,
} from '../../../shared/strategy/caddy';
import { MapService, type MapPointerEvent, type OverlayLayerSpec } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FurnitureService } from '../furniture/furniture.service';
import { FeaturesService } from '../draw/features.service';
import { lngLatToSweref99tm, sweref99tmToWgs84, wgs84ToSweref99tm } from '../geo/transform';
import { PlanService, type PlanHoleRow } from './plan.service';
import { ClubsService } from '../player/clubs.service';
import {
    PLAN_OVERLAY_ID,
    GATE_DEFAULT_HALF_WIDTH_M,
    autoGatesForPlan,
    buildHolePlan,
    buildPlanGeojson,
    enrichPlanStrategy,
    ghostAimForLeg,
    nearestLegFoot,
    planarBearingDeg,
    planLayers,
    type EffectiveWind,
    type GhostAim,
    type HolePlan,
    type PlanLeg,
} from './plan-overlay';
import { buildLieMap, type LieMap } from './lie-map';

/** Interaction-claim id for the planner's single tool. */
export const PLANNER_TOOL_ID = 'planner';

/** Overlay id for the caddy-advice markers (separate from the plan overlay). */
export const CADDY_OVERLAY_ID = 'plan-caddy';

/** Marker + label layers for the caddy advice overlay. */
function caddyLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${CADDY_OVERLAY_ID}-dot`,
            type: 'circle',
            paint: {
                'circle-radius': 5,
                'circle-color': '#f5b301',
                'circle-stroke-color': '#14281c',
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: `${CADDY_OVERLAY_ID}-label`,
            type: 'symbol',
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 11,
                'text-offset': [0, 1.4],
                'text-anchor': 'top',
                'text-max-width': 12,
                'text-allow-overlap': false,
            },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#14281c', 'text-halo-width': 1.5 },
        },
    ];
}

/** Screen-px radius for click-to-select and mousedown-to-drag hit testing. */
const MARKER_HIT_PX = 12;
/** Screen-px point-to-segment tolerance for gate-line (move) hits. */
const GATE_LINE_HIT_PX = 8;
/** Screen-px max distance from a leg for placing a gate on it. */
const GATE_PLACE_PX = 32;
/** Smallest draggable gate half-width, meters. */
const MIN_HALF_WIDTH_M = 1;
/**
 * Nominal half-depth of a green, meters — used to place `front`/`back`
 * reference points either side of the green centre along the approach bearing
 * for the caddy context (the plan model carries only the green centre, not its
 * polygon). ~9 m ≈ an 18 m deep green; a coarse but honest stand-in until the
 * full green geometry is wired through (T6).
 */
const NOMINAL_GREEN_DEPTH_M = 9;
const DRAG_MOVE_THRESHOLD_PX = 2;

/**
 * The full v1 caddy rule set (feature-smart-caddy.md §5). The evaluator
 * (`runCaddy`) is fixed; this is the growing list — order is irrelevant, the
 * evaluator ranks by priority × confidence and resolves vetoes (§4.4). Each
 * rule self-gates on the leg it cares about (green-slope/short-side/
 * specific-target on approaches, par5-attack on par-5 tee/layup,
 * take-your-medicine on recovery, no-doubles on any full shot), so passing the
 * whole set for every leg is correct — inapplicable rules simply return
 * nothing.
 */
const CADDY_RULES: readonly CaddyRule[] = [
    greenSlopeHalfRule,
    par5AttackRule,
    shortSideGuardRule,
    noDoublesRule,
    takeYourMedicineRule,
    specificTargetRule,
];

/** The inputs the locked leg-contract mapping decides on. */
export interface CaddyLegKindInput {
    /** Leg index within the plan (0 = tee shot). */
    index: number;
    /** The leg's destination node kind. */
    toKind: 'tee' | 'shot' | 'green';
    /** The hole par. */
    par: number;
    /** The strokes-gained lie the leg is played FROM (lie-map classification). */
    originLie: string;
}

/**
 * The LOCKED caddy leg-contract mapping (feature-smart-caddy.md / delegation
 * brief T10) — get this exactly right or rules silently never fire:
 *  - a leg played FROM a recovery lie is `'recovery'` (take-your-medicine) —
 *    a jailed shot is a punch-out regardless of shot number, so this wins;
 *  - a leg landing on the green is an `'approach'` (green-slope / short-side /
 *    specific-target / no-doubles);
 *  - the tee shot (index 0) is `'tee'`;
 *  - the par-5 SECOND shot (index 1, not into the green) is `'layup'` — this is
 *    what `par5AttackRule.appliesTo` checks;
 *  - any remaining full shot to a landing area maps to `'tee'` (closest honest
 *    kind; no rule mis-fires on it).
 *
 * Exported pure so the contract is unit-testable without the service graph.
 */
export function caddyLegKind(input: CaddyLegKindInput): CaddyContext['leg'] {
    if (input.originLie === 'recovery') return 'recovery';
    if (input.toKind === 'green') return 'approach';
    if (input.index === 0) return 'tee';
    if (input.par === 5 && input.index === 1) return 'layup';
    return 'tee';
}

export type PlannerMode = 'select' | 'add-shot' | 'add-gate';

export type PlannerSelection = { kind: 'shot' | 'gate'; id: string } | null;

type DragTarget =
    | { kind: 'shot'; id: string }
    | { kind: 'gate-side'; id: string; side: 'left' | 'right' }
    | { kind: 'gate-move'; id: string };

interface Drag {
    target: DragTarget;
    startScreen: { x: number; y: number };
    moved: boolean;
}

/**
 * The planner page's single map tool: shot placement/drag, corridor-gate
 * rulers, selection, and the plan overlay. Follows the furniture tool's
 * drag conventions (raw mousedown + dragPan.disable, patchLocal per frame,
 * persist on mouseup) and the measure tool's overlay lifecycle — but is NOT
 * an EditorTool: the planner hosts no builder toolbar, so `start()` claims
 * the interaction mode directly for the page's lifetime.
 *
 * Modes:
 * - select (default): click near a marker selects; drag a shot moves it
 *   (re-samples elevation); drag a gate endpoint adjusts that side's
 *   half-width; drag the gate line moves its station (stored bearing kept).
 * - add-shot: every click appends a shot at the click point — Esc to stop.
 * - add-gate: click near a leg drops a gate at the perpendicular foot with
 *   the leg's bearing and 30/30 m half-widths (one-shot; Shift keeps armed).
 */
export class PlannerToolService {
    private map = di.get(MapService);
    private elevation = di.get(ElevationService);
    private router = di.get(Router);
    private courseDetail = di.get(CourseDetailService);
    private furniture = di.get(FurnitureService);
    private features = di.get(FeaturesService);
    private plan = di.get(PlanService);
    private clubs = di.get(ClubsService);

    readonly mode = new Signal<PlannerMode>('select');
    readonly selection = new Signal<PlannerSelection>(null);
    /** Transient hint shown in the panel (placement guidance / rejections). */
    readonly notice = new Signal<string | null>(null);

    private drag: Drag | null = null;
    private suppressClick = false;
    private overlayAdded = false;
    private caddyOverlayAdded = false;

    /** ?hole= carries the hole NUMBER; resolve to the Hole for the course. */
    private readonly selectedHoleNumber = this.router.query('hole');
    readonly selectedHole = new Computed<Hole | null>(() => {
        const num = this.selectedHoleNumber.get();
        if (num === undefined) return null;
        return this.courseDetail.holes.get().find(h => String(h.number) === num) ?? null;
    });

    /** The plan-hole row for the selected hole (null until first edit). */
    readonly planHole = new Computed<PlanHoleRow | null>(() => {
        const hole = this.selectedHole.get();
        return hole ? this.plan.holeRow(hole.number) ?? null : null;
    });

    /**
     * Session-sticky tee NAME. Picking a tee on one hole (see the panel's tee
     * select) sets this, so holes WITHOUT an explicit `GamePlanHole.teeId`
     * anchor their plan on the same-named tee — "select Yellow once, every
     * hole plans from Yellow". Client-side only (not persisted); resets to null
     * on reload. Mirrors the builder's `FurnitureService.activeTeeName`.
     */
    readonly activeTeeName = new Signal<string | null>(null);

    /** Set (or clear with null) the sticky tee name. */
    setActiveTeeName(name: string | null): void {
        this.activeTeeName.set(name);
    }

    /**
     * Origin tee for the hole's plan, resolved in priority order:
     * 1) the hole's explicit `GamePlanHole.teeId` (a deliberate per-hole pick);
     * 2) the session-sticky `activeTeeName`, matched case-insensitively (this
     *    is what makes a tee choice follow across holes);
     * 3) the hole's first tee by sortOrder.
     */
    readonly originTee = new Computed<Tee | null>(() => {
        const hole = this.selectedHole.get();
        if (!hole) return null;
        const tees = this.furniture.teesForHole(hole.id);
        const teeId = this.planHole.get()?.teeId ?? null;
        if (teeId) {
            const explicit = tees.find(t => t.id === teeId);
            if (explicit) return explicit;
        }
        const name = this.activeTeeName.get();
        if (name) {
            const wanted = name.trim().toLowerCase();
            const byName = tees.find(t => t.name.trim().toLowerCase() === wanted);
            if (byName) return byName;
        }
        return tees[0] ?? null;
    });

    /** The bag in sortOrder (shared player ClubsService store). */
    readonly orderedClubs = new Computed<Club[]>(() =>
        [...this.clubs.store.items.get()].sort((a, b) => a.sortOrder - b.sortOrder));

    /** Effective wind: per-field hole override ?? plan wind; null = calm. */
    readonly effectiveWind = new Computed<EffectiveWind | null>(() => {
        const hole = this.planHole.get();
        const plan = this.plan.plan.get();
        const speedMps = hole?.windSpeedMps ?? plan?.windSpeedMps ?? null;
        const directionDeg = hole?.windDirectionDeg ?? plan?.windDirectionDeg ?? null;
        if (speedMps === null || directionDeg === null) return null;
        return { speedMps, directionDeg };
    });

    /** The selected hole's shots in sort order. */
    readonly holeShots = new Computed<PlanShot[]>(() => {
        const ph = this.planHole.get();
        return ph ? this.plan.shotsForHole(ph.id) : [];
    });

    /** The selected hole's gates in sort order. */
    readonly holeGates = new Computed<PlanGate[]>(() => {
        const ph = this.planHole.get();
        return ph ? this.plan.gatesForHole(ph.id) : [];
    });

    /** How many furniture aim points the selected hole has (0 = nothing to seed). */
    readonly aimCount = new Computed<number>(() => {
        const hole = this.selectedHole.get();
        return hole ? this.furniture.aimsForHole(hole.id).length : 0;
    });

    /** The full planning model for the selected hole (overlay + readouts). */
    readonly holePlan = new Computed<HolePlan | null>(() => {
        const hole = this.selectedHole.get();
        if (!hole) return null;
        const tee = this.originTee.get();
        const green = this.furniture.greenForHole(hole.id);
        return buildHolePlan({
            tee: tee ? { lat: tee.lat, lon: tee.lon, elevation: tee.elevation } : null,
            shots: this.holeShots.get(),
            green: green
                ? { lat: green.centerLat, lon: green.centerLon, elevation: green.elevation }
                : null,
            clubs: this.orderedClubs.get(),
            preferredClubId: this.planHole.get()?.preferredClubId ?? null,
            wind: this.effectiveWind.get(),
        });
    });

    /**
     * The hole's pre-flattened lie map (course features → shared/strategy
     * FlatRing[]), rebuilt when the feature store or the selected hole
     * changes. Peeked (not subscribed) inside the enrichment path so an
     * enrich pass reads a consistent snapshot; kept a Computed so it is only
     * re-flattened when features actually change, never per drag frame.
     */
    readonly lieMap = new Computed<LieMap>(() =>
        buildLieMap(this.features.store.items.get()));

    /** Green centre as EPSG:3006 Vec2 for the aim optimiser (null = no green). */
    private greenCenterVec(): Vec2 | null {
        const plan = this.holePlan.peek();
        const green = plan?.nodes.find(n => n.kind === 'green');
        return green ? { x: green.x, y: green.y } : null;
    }

    /**
     * The last strategy-enriched plan, paired with the exact `holePlan` object
     * it was derived from (`base`). DECADE EV / lights / ghost-aim
     * (`enrichPlanStrategy`) run on shot-place and drag-RELEASE ONLY (see
     * `refreshStrategy`), NEVER per drag frame — sweeping ~13 aim candidates ×
     * ~128 samples per mouse-move would melt the hot loop (DECADE §4.5).
     *
     * `overlayPlan` (below) renders `enriched` only while `base` is still the
     * live `holePlan` reference; the moment a drag frame recomputes `holePlan`
     * into a fresh object, the overlay falls back to plain geometry (no stale
     * lights/ghost mid-drag), and the next release re-enriches.
     */
    private readonly enrichedPlan = new Signal<{ base: HolePlan; enriched: HolePlan } | null>(null);

    /**
     * A signature of everything that should re-trigger DECADE enrichment but is
     * STABLE across a drag: the shot set + each shot's club, the tee/green, the
     * preferred club, and wind. Deliberately excludes shot lat/lon — those DO
     * change per drag frame (via `patchShotLocal`), and re-optimising on each
     * would break the compute cadence (DECADE §4.5). The drag-release itself
     * re-enriches explicitly (`persistDrag`), so positions still get picked up,
     * just off the hot loop. This signal is what the `start()` effect watches.
     */
    private readonly strategyInputs = new Computed<string>(() => {
        const hole = this.selectedHole.get()?.id ?? '';
        const tee = this.originTee.get()?.id ?? '';
        const preferred = this.planHole.get()?.preferredClubId ?? '';
        const wind = this.effectiveWind.get();
        const windSig = wind ? `${wind.speedMps}/${wind.directionDeg}` : 'calm';
        const shots = this.holeShots.get().map(s => `${s.id}:${s.clubId ?? ''}`).join(',');
        const clubs = this.orderedClubs.get().map(c => c.id).join(',');
        return `${hole}|${tee}|${preferred}|${windSig}|${shots}|${clubs}`;
    });

    /** True while `refreshStrategy` has a coalescing microtask pending. */
    private strategyScheduled = false;

    /**
     * Re-run DECADE enrichment for the current hole, coalesced onto a
     * microtask so a burst of eager @basics/core signal updates (place/release
     * touches shots → holeShots → holePlan) collapses into ONE optimizeAim
     * sweep over the SETTLED plan — the same coalescing pattern as
     * `attachHoleFraming`. Safe to call from `placeShot` / `persistDrag`; a
     * no-op when there is nothing to optimise (no plan / no green).
     *
     * NEVER called from the per-frame drag path (`applyDrag` / `patchShotLocal`
     * stay pure geometry) — that is the whole cadence guarantee.
     */
    private refreshStrategy(): void {
        if (this.strategyScheduled) return;
        this.strategyScheduled = true;
        queueMicrotask(() => {
            this.strategyScheduled = false;
            const base = this.holePlan.peek();
            const greenCenter = this.greenCenterVec();
            if (!base || !greenCenter) {
                this.enrichedPlan.set(null);
                this.caddyResult.set(null);
                return;
            }
            const enriched = enrichPlanStrategy(base, {
                lieMap: this.lieMap.peek(),
                greenCenter,
                wind: this.effectiveWind.peek(),
            });
            this.enrichedPlan.set({ base, enriched });
            // Caddy advice runs on the SAME cadence as EV enrichment (shot-place
            // / drag-release, coalesced onto this microtask) — never per frame
            // (feature-smart-caddy.md §4.5). It reads the just-enriched plan so
            // every rule sees the settled geometry + lie breakdowns.
            this.caddyResult.set({ base, advice: this.computeCaddyAdvice(enriched) });
        });
    }

    /**
     * The plan the overlay + panel read: the strategy-enriched plan while it
     * still matches the live `holePlan` (so EV/lights/ghost show), else the
     * plain live `holePlan` (geometry stays live during a drag, strategy
     * fields simply absent until the next release re-enriches).
     */
    readonly overlayPlan = new Computed<HolePlan | null>(() => {
        const live = this.holePlan.get();
        const enriched = this.enrichedPlan.get();
        return enriched && enriched.base === live ? enriched.enriched : live;
    });

    /**
     * Green-slope summary for the selected hole's green (D10 shape), or null.
     * The web adapter (green-slope.ts) derives this from a server sample grid;
     * the planner sets it here so the caddy can run. Kept a plain settable
     * Signal so the (async, server-backed) slope fetch stays OUT of the
     * per-frame reactive path — feeding a summary in makes `caddyAdvice` fire,
     * clearing it (null) makes the caddy silent. The pure rule never touches
     * analysis-math.ts; this signal is the seam (feature-smart-caddy.md §4.6).
     */
    readonly greenSlopeSummary = new Signal<GreenSlopeSummary | null>(null);

    /** Feed the caddy a green-slope summary (or clear it with null). */
    setGreenSlopeSummary(summary: GreenSlopeSummary | null): void {
        this.greenSlopeSummary.set(summary);
    }

    /**
     * The last caddy run, paired with the `holePlan` it was derived from
     * (`base`) — exactly like `enrichedPlan`. Populated by `refreshStrategy` on
     * the shot-place / drag-release cadence, so `runCaddy` (which itself calls
     * `optimizeAim` for the EV rules) never runs on the per-frame drag path.
     * `caddyAdvice` (below) only surfaces it while `base` is still the live
     * `holePlan`, so no stale advice shows mid-drag.
     */
    private readonly caddyResult = new Signal<{ base: HolePlan; advice: readonly CaddyAdvice[] } | null>(null);

    /**
     * Ranked smart-caddy advice for the current hole across ALL its legs
     * (feature-smart-caddy.md §5). Surfaces the stored `caddyResult` only while
     * its `base` still matches the live `holePlan` — during a drag `holePlan`
     * recomputes into a fresh object, so the advice falls silent until the next
     * release re-runs the caddy over the settled plan (same guard as
     * `overlayPlan`). Derived, never persisted (§4.5).
     */
    readonly caddyAdvice = new Computed<readonly CaddyAdvice[]>(() => {
        const live = this.holePlan.get();
        const result = this.caddyResult.get();
        return result && result.base === live ? result.advice : [];
    });

    /**
     * Assemble a `CaddyContext` per leg of the (already enriched) plan and run
     * the full rule set over each, returning the concatenated advice ranked as
     * the evaluator ordered it within each leg. Called only from
     * `refreshStrategy` (shot-place / drag-release cadence) — it re-runs
     * `optimizeAim` per clubbed leg to get the full `AimResult` (with the
     * per-candidate tail the `no-doubles` rule reads, D16), which is exactly
     * the sweep the cadence guarantee exists to keep off the hot loop.
     */
    private computeCaddyAdvice(plan: HolePlan): readonly CaddyAdvice[] {
        const greenCenter = this.greenCenterVec();
        if (!greenCenter) return [];
        const lieMap = this.lieMap.peek();
        const wind = this.effectiveWind.peek();
        const clubs = this.orderedClubs.peek();
        const par = this.selectedHole.peek()?.par ?? 4;
        const index = this.selectedHole.peek()?.number ?? 0;
        const summary = this.greenSlopeSummary.peek();
        const hazards = lieMap.hazardRings();
        const surfaces = lieMap.surfaces();

        const out: CaddyAdvice[] = [];
        for (const leg of plan.legs) {
            const ctx = this.buildLegContext(leg, {
                greenCenter, hazards, surfaces, clubs, wind, par, index, summary,
                classify: (p: Vec2) => lieMap.classifyLie(p),
            });
            if (!ctx) continue;
            for (const advice of runCaddy(ctx, CADDY_RULES)) out.push(advice);
        }
        return out;
    }

    /**
     * Build the per-leg `CaddyContext` (feature-smart-caddy.md §4.2), or null
     * for a leg no rule can act on (no club → no aim to reason about, and not a
     * recovery/approach the geometry-only rules gate on).
     *
     * LEG CONTRACT (locked — the rules gate on this exactly):
     *  - a leg landing on the green is an `'approach'` (green-slope / short-side
     *    / specific-target / no-doubles);
     *  - the tee shot (leg index 0) is `'tee'`;
     *  - the par-5 SECOND shot (index 1, not into the green) is `'layup'` — this
     *    is what `par5-attack.appliesTo` checks;
     *  - a leg played FROM a recovery lie is `'recovery'` (take-your-medicine),
     *    overriding the above so a jailed tee/second shot punches out.
     */
    private buildLegContext(
        leg: PlanLeg,
        shared: {
            greenCenter: Vec2;
            hazards: readonly FlatRing[];
            surfaces: readonly FlatRing[];
            clubs: readonly Club[];
            wind: EffectiveWind | null;
            par: number;
            index: number;
            summary: GreenSlopeSummary | null;
            classify: (p: Vec2) => string;
        },
    ): CaddyContext | null {
        const origin: Vec2 = { x: leg.from.x, y: leg.from.y };
        const originLie = shared.surfaces.length > 0 ? shared.classify(origin) : 'rough';
        const toGreen = leg.to.kind === 'green';
        const legKind = caddyLegKind(
            { index: leg.index, toKind: leg.to.kind, par: shared.par, originLie },
        );

        // Green reference points: the plan model carries only the green centre,
        // so front/back are the centre nudged ±NOMINAL_GREEN_DEPTH_M along this
        // leg's bearing (an honest stand-in until full green geometry lands).
        const center: Vec2 = toGreen
            ? { x: leg.to.x, y: leg.to.y }
            : shared.greenCenter;
        const dir = bearingToUnitVector(leg.bearingDeg);
        const front: Vec2 = {
            x: center.x - dir.x * NOMINAL_GREEN_DEPTH_M,
            y: center.y - dir.y * NOMINAL_GREEN_DEPTH_M,
        };
        const back: Vec2 = {
            x: center.x + dir.x * NOMINAL_GREEN_DEPTH_M,
            y: center.y + dir.y * NOMINAL_GREEN_DEPTH_M,
        };

        // Full AimResult (with the per-candidate tail no-doubles reads, D16) —
        // re-optimise this leg when it has a club. Off the hot loop by cadence.
        const aim: AimResult | undefined = leg.club
            ? optimizeAim({
                origin,
                club: { name: leg.club.name, carryM: leg.club.carryM, dispersionM: leg.club.dispersionM },
                targetBearingDeg: leg.bearingDeg,
                surfaces: shared.surfaces,
                greenCenter: center,
                ...(shared.wind !== null
                    ? { windSpeedMps: shared.wind.speedMps, windDirectionDeg: shared.wind.directionDeg }
                    : {}),
            })
            : undefined;

        const distances = this.buildLegDistances(leg, center, front, back, shared);

        // Only pass the slope summary on the green-terminated approach leg —
        // it describes THIS green and green-slope-half is an approach rule.
        const greenSlope = toGreen && shared.summary ? shared.summary : undefined;

        // A leg no rule can act on (no aim, not recovery, no slope) is skipped.
        if (!aim && legKind !== 'recovery' && !greenSlope) return null;

        return {
            leg: legKind,
            origin: { x: origin.x, y: origin.y, elevation: leg.from.elevation },
            target: { greenPoly: { kind: 'green', points: [] }, center, front, back },
            distances,
            ...(aim ? { aim } : {}),
            ...(greenSlope ? { greenSlope } : {}),
            hazards: shared.hazards,
            clubs: shared.clubs.map(c => ({ name: c.name, carryM: c.carryM, dispersionM: c.dispersionM })),
            ...(shared.wind !== null
                ? { wind: { speedMps: shared.wind.speedMps, directionDeg: shared.wind.directionDeg } }
                : {}),
            hole: { par: shared.par, index: shared.index },
            risk: { riskAversion: 0 },
        };
    }

    /**
     * The yardage rows (◄ feature-distances.ts / T4) for one leg's context:
     * green front/centre/back always, plus each hazard ring the shot line
     * crosses (front + carry rows). Cast along the leg bearing (D6). Cheap
     * pure composition; part of the per-leg context so distance-consuming rules
     * (future carry rule) have their inputs ready.
     */
    private buildLegDistances(
        leg: PlanLeg,
        center: Vec2,
        front: Vec2,
        back: Vec2,
        shared: { hazards: readonly FlatRing[]; clubs: readonly Club[]; wind: EffectiveWind | null },
    ): readonly FeatureDistance[] {
        const origin = { x: leg.from.x, y: leg.from.y, elevation: leg.from.elevation };
        const targets: DistanceTarget[] = [
            { kind: 'point', label: 'Green front', role: 'green_front', at: { x: front.x, y: front.y } },
            { kind: 'point', label: 'Green centre', role: 'green_center', at: { x: center.x, y: center.y } },
            { kind: 'point', label: 'Green back', role: 'green_back', at: { x: back.x, y: back.y } },
        ];
        for (let i = 0; i < shared.hazards.length; i++) {
            targets.push({ kind: 'hazard', label: `Hazard ${i + 1}`, ring: shared.hazards[i] });
        }
        return featureDistances({
            origin,
            targets,
            bearingDeg: leg.bearingDeg,
            ...(shared.wind !== null
                ? { wind: { speedMps: shared.wind.speedMps, directionDeg: shared.wind.directionDeg } }
                : {}),
            clubs: shared.clubs.map(c => ({ name: c.name, carryM: c.carryM, dispersionM: c.dispersionM })),
        });
    }

    /**
     * The camera framing target: which hole to frame and the WGS84 bbox
     * `[w,s,e,n]` around its plan nodes (tee → shots → green), or null when
     * there's no geometry yet. The framing effect reads this on a microtask,
     * AFTER the selection cascade settles — see `attachHoleFraming`.
     *
     * The hole id comes from `selectedHole.peek()` (non-subscribing) so this
     * doesn't form a reactive diamond with `holePlan`. The bbox is derived
     * from the same `holePlan.nodes` value read here, so id and bounds are
     * internally consistent within a single evaluation. Gates are excluded —
     * they sit on the legs, so the nodes already cover the extent.
     */
    private readonly holeFrame = new Computed<
        { holeId: string; bounds: [number, number, number, number] } | null
    >(() => {
        const plan = this.holePlan.get();
        if (!plan || plan.nodes.length === 0) return null;
        const hole = this.selectedHole.peek();
        if (!hole) return null;
        let w = plan.nodes[0]!.lon, e = w, s = plan.nodes[0]!.lat, n = s;
        for (const p of plan.nodes) {
            if (p.lon < w) w = p.lon;
            if (p.lon > e) e = p.lon;
            if (p.lat < s) s = p.lat;
            if (p.lat > n) n = p.lat;
        }
        return { holeId: hole.id, bounds: [w, s, e, n] };
    });

    private readonly overlayData = new Computed<FeatureCollection>(() => {
        const sel = this.selection.get();
        return buildPlanGeojson({
            plan: this.overlayPlan.get(),
            gates: this.holeGates.get(),
            selectedShotId: sel?.kind === 'shot' ? sel.id : null,
            selectedGateId: sel?.kind === 'gate' ? sel.id : null,
        });
    });

    /**
     * A tiny separate overlay for caddy advice: a labelled marker at each
     * advice `anchor` (green front for the slope rule). Kept independent of the
     * plan overlay's GeoJSON (buildPlanGeojson, another task's module) so this
     * task adds no edits there — its own source/layers, added in `start()`.
     */
    private readonly caddyOverlayData = new Computed<FeatureCollection>(() => {
        const features: FeatureCollection['features'] = [];
        for (const a of this.caddyAdvice.get()) {
            if (!a.anchor) continue;
            const { lat, lon } = sweref99tmToWgs84(a.anchor.x, a.anchor.y);
            features.push({
                type: 'Feature',
                properties: { role: 'caddy', label: a.headline },
                geometry: { type: 'Point', coordinates: [lon, lat] },
            });
        }
        return { type: 'FeatureCollection', features };
    });

    /** The selected shot row (for the panel), or null. */
    readonly selectedShot = new Computed<PlanShot | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'shot') return null;
        return this.plan.shots.items.get().find(s => s.id === sel.id) ?? null;
    });

    /**
     * The ghost recommended-aim marker for the SELECTED shot's landing leg
     * (from the enriched overlay plan), or null when no shot is selected or its
     * leg isn't enriched. Drives the panel's "Apply recommended aim" button.
     */
    readonly selectedShotGhostAim = new Computed<GhostAim | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'shot') return null;
        const plan = this.overlayPlan.get();
        const leg = plan?.legs.find(l => l.to.kind === 'shot' && l.to.shot?.id === sel.id);
        return leg ? ghostAimForLeg(leg) : null;
    });

    /**
     * Move the selected shot to its leg's recommended-aim (ghost) landing
     * point and persist it (re-sampling elevation) — the ghost marker's
     * "apply" affordance (DECADE Phase D). No-op when there's no ghost for the
     * selection. Re-enrichment fires from `updateShot`'s signature change.
     */
    async applyRecommendedAim(): Promise<void> {
        const sel = this.selection.peek();
        if (sel?.kind !== 'shot') return;
        const ghost = this.selectedShotGhostAim.peek();
        if (!ghost) return;
        const elevation = await this.elevation.elevationAt({ lng: ghost.lon, lat: ghost.lat });
        await this.plan.updateShot(sel.id, { lat: ghost.lat, lon: ghost.lon, elevation });
        this.refreshStrategy();
    }

    /** The selected gate row (for the panel), or null. */
    readonly selectedGate = new Computed<PlanGate | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'gate') return null;
        return this.plan.gates.items.get().find(g => g.id === sel.id) ?? null;
    });

    // ── Lifecycle (driven by PlannerComponent) ──────────────────────────────

    /**
     * Wire the tool to the live map for the page's lifetime. `track` is the
     * hosting component's disposer registry — everything (interaction claim,
     * handlers, overlay) unwinds when the page unmounts.
     */
    start(track: (dispose: () => void) => void): void {
        track(this.map.claimInteraction(PLANNER_TOOL_ID));

        track(this.map.onClick(e => this.onClick(e)));
        track(this.map.onMouseMove(e => this.onMouseMove(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        track(() => window.removeEventListener('keydown', onKeyDown));

        // Raw handlers for drags (mousedown near marker → move → up).
        track(effect(() => {
            if (!this.map.ready.get()) return;
            const map = this.map.map.get();
            if (!map) return;
            untrack(() => this.bindRawHandlers(map, track));
        }));

        // Plan overlay — re-added whenever the map becomes ready.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.overlayData.get();
            if (!ready) {
                this.overlayAdded = false; // overlay died with the map
                return;
            }
            if (!this.overlayAdded) {
                this.map.addOverlayLayer(PLAN_OVERLAY_ID, data, planLayers());
                this.overlayAdded = true;
            } else {
                this.map.updateOverlayData(PLAN_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.overlayAdded) {
                this.map.removeOverlayLayer(PLAN_OVERLAY_ID);
                this.overlayAdded = false;
            }
        });

        // Caddy advice overlay — its own source/layer so it never touches the
        // plan overlay's GeoJSON. Same ready-gated re-add lifecycle.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.caddyOverlayData.get();
            if (!ready) {
                this.caddyOverlayAdded = false;
                return;
            }
            if (!this.caddyOverlayAdded) {
                this.map.addOverlayLayer(CADDY_OVERLAY_ID, data, caddyLayers());
                this.caddyOverlayAdded = true;
            } else {
                this.map.updateOverlayData(CADDY_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.caddyOverlayAdded) {
                this.map.removeOverlayLayer(CADDY_OVERLAY_ID);
                this.caddyOverlayAdded = false;
            }
        });

        this.attachHoleFraming(track);

        // Re-run DECADE enrichment when the strategy inputs change (hole,
        // clubs, wind, shot set) — but NOT on the per-frame drag path: the
        // signature deliberately omits shot lat/lon, so a drag mutates geometry
        // without re-optimising (release re-enriches explicitly). Also fires
        // once on first load so lights/EV appear without a user edit.
        track(effect(() => {
            this.strategyInputs.get();
            this.lieMap.get();
            // The (async, server-fed) green-slope summary also re-runs the caddy
            // — subscribing here keeps that off the per-frame path (refreshStrategy
            // coalesces onto a microtask) while still reacting the moment a slope
            // summary is fed in or cleared.
            this.greenSlopeSummary.get();
            this.refreshStrategy();
        }));

        // Crosshair cursor while an add mode is armed.
        track(effect(() => {
            const armed = this.mode.get() !== 'select';
            if (!this.map.ready.get()) return;
            const canvas = this.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = armed ? 'crosshair' : '';
        }));

        track(() => {
            this.endDrag();
            this.mode.set('select');
            this.selection.set(null);
            this.notice.set(null);
            this.suppressClick = false;
        });
    }

    /**
     * Frame the selected hole (tee → shots → green) when the ?hole= selection
     * changes — and once when a late load first yields geometry or the map
     * turns ready.
     *
     * Why the microtask: selecting a hole triggers a SYNCHRONOUS cascade in
     * which `holePlan` recomputes several times (its inputs — `selectedHole`,
     * `originTee`, the green, `holeShots` — settle at different steps). Mid
     * cascade `holePlan` can hold the new hole's tee with the previous hole's
     * green (a transient mix), which would frame a bogus bbox if acted on
     * immediately. Subscribing to `holeFrame` but deferring the actual
     * `fitBounds` to a microtask coalesces the whole burst into ONE read of
     * the SETTLED `holeFrame`, after every recompute has run.
     *
     * Dedupe on hole id so plan EDITS (which change `holeFrame.bounds` but not
     * its id) don't re-pan the camera; only a genuine hole change reframes.
     */
    private attachHoleFraming(track: (dispose: () => void) => void): void {
        let lastFramedHoleId: string | null = null;
        let scheduled = false;
        let disposed = false;
        track(() => { disposed = true; });
        track(effect(() => {
            // Subscribe to both so the burst re-runs us; the microtask below
            // reads the settled values.
            this.holeFrame.get();
            this.map.ready.get();
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                if (disposed) return;
                const frame = this.holeFrame.peek();
                if (!this.map.ready.peek() || !frame) return;
                if (frame.holeId === lastFramedHoleId) return;
                lastFramedHoleId = frame.holeId;
                this.map.fitBounds(frame.bounds);
            });
        }));
    }

    /** Arm an add mode (toggles back to select when already armed). */
    setMode(mode: Exclude<PlannerMode, 'select'>): void {
        this.notice.set(null);
        if (this.mode.peek() === mode) {
            this.mode.set('select');
            return;
        }
        this.selection.set(null);
        this.mode.set(mode);
    }

    /**
     * Seed the selected hole's plan shots from its furniture aim points, so
     * the course's tee → aim → green becomes an editable starting plan (each
     * aim → a draggable shot at the same lat/lon/elevation, in aim sortOrder).
     *
     * `replace` clears the hole's existing shots first — the panel passes it
     * after confirming, so re-seeding doesn't stack duplicates onto a plan
     * that already has shots. Returns the number of shots created.
     */
    async seedShotsFromAims(replace: boolean): Promise<number> {
        const hole = this.selectedHole.peek();
        if (!hole) return 0;
        const aims = this.furniture.aimsForHole(hole.id);
        if (aims.length === 0) {
            this.notice.set('This hole has no aim points to seed from.');
            return 0;
        }
        if (replace) {
            // Sequential so the hole row + versions stay consistent (autosave).
            for (const shot of this.holeShots.peek()) {
                await this.plan.removeShot(shot.id);
            }
        }
        let created = 0;
        for (const aim of aims) {
            // Auto-club each seeded shot too (origin = the previous aim/tee),
            // so the seeded plan comes with clubs + dispersion ellipses.
            const clubId = this.autoClubForShot({ lng: aim.lon, lat: aim.lat }, aim.elevation);
            const shot = await this.plan.addShot(hole.number, {
                lat: aim.lat,
                lon: aim.lon,
                elevation: aim.elevation,
                label: aim.label,
                ...(clubId ? { clubId } : {}),
            });
            if (shot) created++;
        }
        this.notice.set(null);
        this.selection.set(null);
        return created;
    }

    /**
     * Generate one computed corridor gate per clubbed leg from the mapped
     * hazard rings (`autoGatesForPlan` over `corridorWidth`), persisting each
     * with `source:'computed'` via the ordinary gate-add path. "Compute
     * instead of eyeball" (DECADE doc §3). Returns the number created; a no-op
     * with a notice when the hole has no legs to cast a corridor from.
     */
    async generateAutoGates(): Promise<number> {
        const hole = this.selectedHole.peek();
        if (!hole) {
            this.notice.set('Select a hole first (pick one from the hole list).');
            return 0;
        }
        const plan = this.holePlan.peek();
        if (!plan || plan.legs.length === 0) {
            this.notice.set('No legs to gate — the hole needs a tee/green (and optionally shots) first.');
            return 0;
        }
        const gates = autoGatesForPlan(plan.legs, this.lieMap.peek().hazardRings());
        if (gates.length === 0) {
            this.notice.set('No clubbed legs to compute gates for.');
            return 0;
        }
        let created = 0;
        for (const g of gates) {
            // Sequential so the hole row + gate versions stay consistent (autosave).
            const row = await this.plan.addGate(hole.number, {
                lat: g.lat,
                lon: g.lon,
                directionDeg: g.directionDeg,
                halfWidthLeftM: g.halfWidthLeftM,
                halfWidthRightM: g.halfWidthRightM,
                source: g.source,
            });
            if (row) created++;
        }
        this.notice.set(null);
        return created;
    }

    /** Delete the selected shot/gate after confirmation (Del key / panel). */
    async deleteSelected(): Promise<void> {
        const sel = this.selection.peek();
        if (!sel) return;
        const label = sel.kind === 'shot' ? 'shot' : 'gate';
        if (!window.confirm(`Delete this ${label}?`)) return;
        const ok = sel.kind === 'shot'
            ? await this.plan.removeShot(sel.id)
            : await this.plan.removeGate(sel.id);
        if (ok && this.selection.peek() === sel) this.selection.set(null);
    }

    // ── Event handling ──────────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.map.interactionMode.peek() === PLANNER_TOOL_ID;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.suppressClick) return;

        const mode = this.mode.peek();
        if (mode === 'add-shot') {
            void this.placeShot(e.lngLat);
            return;
        }
        if (mode === 'add-gate') {
            void this.placeGate(e);
            return;
        }

        const hit = this.hitTest(e.point);
        this.selection.set(hit ? { kind: hit.kind === 'shot' ? 'shot' : 'gate', id: hit.id } : null);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        const drag = this.drag;
        if (!drag) return;
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
        this.applyDrag(drag.target, e);
    }

    private bindRawHandlers(map: MaplibreMap, track: (dispose: () => void) => void): void {
        const onMouseDown = (e: MapMouseEvent) => this.onMouseDown(e, map);
        const onMouseUp = () => this.onMouseUp(map);
        map.on('mousedown', onMouseDown);
        map.on('mouseup', onMouseUp);
        track(() => {
            map.off('mousedown', onMouseDown);
            map.off('mouseup', onMouseUp);
        });
    }

    private onMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (!this.isMyClaim()) return;
        if (e.originalEvent.button !== 0) return;

        // Grab an existing shot/gate marker in ANY mode (not just select) so
        // placed points stay draggable without first disarming add-shot /
        // add-gate — matching the furniture editor's "markers are always
        // grabbable" feel. A mousedown that hits a marker starts a drag and
        // `onMouseUp` swallows the synthesized click, so placement still only
        // happens on clicks that DON'T land on a marker.
        const hit = this.hitTest(e.point);
        if (!hit) return;
        e.preventDefault(); // stops the map's drag-pan for this gesture
        map.dragPan.disable();
        this.selection.set({ kind: hit.kind === 'shot' ? 'shot' : 'gate', id: hit.id });
        this.drag = {
            target: hit,
            startScreen: { x: e.point.x, y: e.point.y },
            moved: false,
        };
    }

    private onMouseUp(map: MaplibreMap): void {
        const drag = this.drag;
        if (!drag) return;
        this.endDrag(map);

        // Swallow the click MapLibre synthesizes right after this mouseup.
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);

        if (!drag.moved) return;
        void this.persistDrag(drag.target);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;

        if (e.key === 'Escape') {
            if (this.mode.peek() !== 'select') {
                this.mode.set('select');
                this.notice.set(null);
                e.preventDefault();
            } else if (this.selection.peek()) {
                this.selection.set(null);
                e.preventDefault();
            }
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selection.peek()) {
                e.preventDefault();
                void this.deleteSelected();
            }
        }
    }

    // ── Placement ───────────────────────────────────────────────────────────

    /**
     * Append a shot at a WGS84 position (samples elevation first, like
     * furniture placement). add-shot stays armed — planning a hole is a
     * click sequence; Esc (or the panel button) leaves the mode.
     */
    private async placeShot(lngLat: { lng: number; lat: number }): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) {
            this.notice.set('Select a hole first (pick one from the hole list).');
            return;
        }
        const elevation = await this.elevation.elevationAt(lngLat);
        const clubId = this.autoClubForShot(lngLat, elevation);
        const created = await this.plan.addShot(hole.number, {
            lat: lngLat.lat,
            lon: lngLat.lng,
            elevation,
            ...(clubId ? { clubId } : {}),
        });
        if (created) {
            this.notice.set(null);
            this.selection.set({ kind: 'shot', id: created.id });
            // Shot-place cadence (DECADE §4.5): re-run EV/lights/ghost now that
            // the plan has a new landing point.
            this.refreshStrategy();
        }
    }

    /**
     * Auto-pick the club whose nominal carry is closest to how far this shot
     * "plays as" from its origin (the previous shot, or the tee): the leg's
     * plays-like distance (horizontal + elevationΔ), then the wind "plays-as"
     * (÷ 1+windEffect) when a wind is set. Returns the club id, or null when
     * there are no clubs / no resolvable origin. Assigning a club is what makes
     * the leg draw its dispersion ellipse, so a placed shot immediately shows
     * where that club lands.
     */
    private autoClubForShot(lngLat: { lng: number; lat: number }, elevation: number | null): string | null {
        const clubs = this.orderedClubs.peek();
        if (clubs.length === 0) return null;
        const origin = this.previousNodePoint();
        if (!origin) return null;
        const a = wgs84ToSweref99tm(origin.lat, origin.lon);
        const b = wgs84ToSweref99tm(lngLat.lat, lngLat.lng);
        const stats = segmentStats(
            { x: a.x, y: a.y, elevation: origin.elevation },
            { x: b.x, y: b.y, elevation },
        );
        let target = stats.playsLikeSimpleM ?? stats.horizontalM;
        const wind = this.effectiveWind.peek();
        if (wind) {
            const bearing = planarBearingDeg(a, b);
            target = playsAsM(target, windEffect(wind.speedMps, wind.directionDeg, bearing));
        }
        return closestClub(clubs, target)?.id ?? null;
    }

    /**
     * The point a newly-placed shot's leg starts from: the hole's last shot
     * (by sortOrder), or — for the first shot — the origin tee. Null when the
     * hole has no tee.
     */
    private previousNodePoint(): { lat: number; lon: number; elevation: number | null } | null {
        const shots = this.holeShots.peek();
        const last = shots[shots.length - 1];
        if (last) return { lat: last.lat, lon: last.lon, elevation: last.elevation };
        const tee = this.originTee.peek();
        return tee ? { lat: tee.lat, lon: tee.lon, elevation: tee.elevation } : null;
    }

    /**
     * Drop a gate at the perpendicular foot of the click on the nearest leg:
     * station = foot, axis bearing = leg bearing, half-widths 30/30 m,
     * source 'manual'. One-shot (Shift keeps the mode armed).
     */
    private async placeGate(e: MapPointerEvent): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) {
            this.notice.set('Select a hole first (pick one from the hole list).');
            return;
        }
        const plan = this.holePlan.peek();
        const map = this.map.map.peek();
        if (!plan || plan.legs.length === 0 || !map) {
            this.notice.set('No legs to attach a gate to — the hole needs a tee/green (and optionally shots) first.');
            return;
        }
        const foot = nearestLegFoot(lngLatToSweref99tm(e.lngLat), plan.legs);
        if (!foot) return;
        const { lat, lon } = sweref99tmToWgs84(foot.point.x, foot.point.y);
        const projected = map.project([lon, lat]);
        if (this.pxDist(projected, e.point) > GATE_PLACE_PX) {
            this.notice.set('Click closer to a leg to place the gate on it.');
            return;
        }
        const created = await this.plan.addGate(hole.number, {
            lat,
            lon,
            directionDeg: plan.legs[foot.legIndex].bearingDeg,
            halfWidthLeftM: GATE_DEFAULT_HALF_WIDTH_M,
            halfWidthRightM: GATE_DEFAULT_HALF_WIDTH_M,
            source: 'manual',
        });
        if (created) {
            this.notice.set(null);
            this.selection.set({ kind: 'gate', id: created.id });
            if (!e.originalEvent.shiftKey) this.mode.set('select');
        }
    }

    // ── Dragging ────────────────────────────────────────────────────────────

    private applyDrag(target: DragTarget, e: MapPointerEvent): void {
        if (target.kind === 'shot') {
            this.plan.patchShotLocal(target.id, { lat: e.lngLat.lat, lon: e.lngLat.lng });
            return;
        }
        const gate = this.plan.gates.items.peek().find(g => g.id === target.id);
        if (!gate) return;
        if (target.kind === 'gate-move') {
            // Move the station; the stored corridor bearing is kept as-is
            // (deliberate — no recompute against the nearest leg).
            this.plan.patchGateLocal(target.id, { lat: e.lngLat.lat, lon: e.lngLat.lng });
            return;
        }
        // Endpoint drag: the new half-width is the cursor's projection onto
        // that side's ruler axis (perpendicular to the corridor bearing).
        const station = wgs84ToSweref99tm(gate.lat, gate.lon);
        const cursor = lngLatToSweref99tm(e.lngLat);
        const unit = bearingToUnitVector(gate.directionDeg + (target.side === 'left' ? -90 : 90));
        const width = Math.max(
            MIN_HALF_WIDTH_M,
            (cursor.x - station.x) * unit.x + (cursor.y - station.y) * unit.y,
        );
        this.plan.patchGateLocal(
            target.id,
            target.side === 'left' ? { halfWidthLeftM: width } : { halfWidthRightM: width },
        );
    }

    private async persistDrag(target: DragTarget): Promise<void> {
        if (target.kind === 'shot') {
            const shot = this.plan.shots.items.peek().find(s => s.id === target.id);
            if (!shot) return;
            const elevation = await this.elevation.elevationAt({ lng: shot.lon, lat: shot.lat });
            await this.plan.updateShot(target.id, { lat: shot.lat, lon: shot.lon, elevation });
            // Drag-RELEASE cadence (DECADE §4.5): the per-frame path stayed pure
            // geometry; now the shot has settled, re-run EV/lights/ghost.
            this.refreshStrategy();
            return;
        }
        const gate = this.plan.gates.items.peek().find(g => g.id === target.id);
        if (!gate) return;
        if (target.kind === 'gate-move') {
            await this.plan.updateGate(target.id, { lat: gate.lat, lon: gate.lon });
        } else if (target.side === 'left') {
            await this.plan.updateGate(target.id, { halfWidthLeftM: gate.halfWidthLeftM });
        } else {
            await this.plan.updateGate(target.id, { halfWidthRightM: gate.halfWidthRightM });
        }
    }

    private endDrag(map?: MaplibreMap): void {
        if (!this.drag) return;
        this.drag = null;
        (map ?? this.map.map.peek())?.dragPan.enable();
    }

    // ── Hit testing ─────────────────────────────────────────────────────────

    /**
     * Nearest drag/select target within tolerance: shot nodes and gate
     * endpoint handles first (point targets), then gate lines (segment
     * targets, for station moves) at a tighter tolerance.
     */
    private hitTest(screen: { x: number; y: number }): DragTarget | null {
        const map = this.map.map.peek();
        if (!map) return null;

        let best: DragTarget | null = null;
        let bestDist = MARKER_HIT_PX;
        const consider = (target: DragTarget, lat: number, lon: number) => {
            const p = map.project([lon, lat]);
            const d = Math.hypot(p.x - screen.x, p.y - screen.y);
            if (d < bestDist) { bestDist = d; best = target; }
        };

        for (const shot of this.holeShots.peek()) {
            consider({ kind: 'shot', id: shot.id }, shot.lat, shot.lon);
        }
        const gates = this.holeGates.peek();
        for (const gate of gates) {
            const station = wgs84ToSweref99tm(gate.lat, gate.lon);
            const left = bearingToUnitVector(gate.directionDeg - 90);
            const right = bearingToUnitVector(gate.directionDeg + 90);
            const lp = sweref99tmToWgs84(
                station.x + left.x * gate.halfWidthLeftM, station.y + left.y * gate.halfWidthLeftM);
            const rp = sweref99tmToWgs84(
                station.x + right.x * gate.halfWidthRightM, station.y + right.y * gate.halfWidthRightM);
            consider({ kind: 'gate-side', id: gate.id, side: 'left' }, lp.lat, lp.lon);
            consider({ kind: 'gate-side', id: gate.id, side: 'right' }, rp.lat, rp.lon);
        }
        if (best) return best;

        // No point target — try the gate lines (move the whole gate).
        let lineBest: DragTarget | null = null;
        let lineDist = GATE_LINE_HIT_PX;
        for (const gate of gates) {
            const station = wgs84ToSweref99tm(gate.lat, gate.lon);
            const left = bearingToUnitVector(gate.directionDeg - 90);
            const right = bearingToUnitVector(gate.directionDeg + 90);
            const lp = sweref99tmToWgs84(
                station.x + left.x * gate.halfWidthLeftM, station.y + left.y * gate.halfWidthLeftM);
            const rp = sweref99tmToWgs84(
                station.x + right.x * gate.halfWidthRightM, station.y + right.y * gate.halfWidthRightM);
            const a = map.project([lp.lon, lp.lat]);
            const b = map.project([rp.lon, rp.lat]);
            const d = pointToSegmentPx(screen, a, b);
            if (d < lineDist) { lineDist = d; lineBest = { kind: 'gate-move', id: gate.id }; }
        }
        return lineBest;
    }

    private pxDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }
}

/** Screen-space distance from a point to segment a→b, pixels. */
function pointToSegmentPx(
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
): number {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
