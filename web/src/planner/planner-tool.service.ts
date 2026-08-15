import { API_BASE } from '@basics/core/client/base';
import { Signal, Computed, effect, untrack, di, Router } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { Hole } from '../../../shared/api/holes.gen';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Club } from '../../../shared/api/clubs.gen';
import type { PlanGate, PlanShot } from '../../../shared/api/game-plans.gen';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    bearingToUnitVector,
    closestClub,
    featureDistances,
    optimizeAim,
    playsAsM,
    ringExtentAlongLines,
    ringExtentAlongRay,
    runCaddy,
    segmentStats,
    TAPPABLE_RING_TYPES,
    windEffect,
    type AimResult,
    type CaddyAdvice,
    type CaddyContext,
    type CaddyRule,
    type DistanceTarget,
    type FeatureDistance,
    type ChainScoreContext,
    type ClubSpec,
    type FlatRing,
    type GreenSlopeSummary,
    type HoleHazard,
    type StrategyPoint,
    type Vec2,
    type VariantHoleContext,
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
import { ConfirmService } from '../app/confirm-dialog.component';
import { ElevationService } from '../map/elevation.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FurnitureService } from '../furniture/furniture.service';
import { FeaturesService } from '../draw/features.service';
import { lngLatToSweref99tm, sweref99tmToWgs84, wgs84ToSweref99tm } from '../geo/transform';
import { PlanService, type PlanHoleRow } from './plan.service';
import { ClubsService } from '../player/clubs.service';
import {
    COURSE_ROUTE_OVERLAY_ID,
    PLAN_OVERLAY_ID,
    GATE_DEFAULT_HALF_WIDTH_M,
    autoGatesForPlan,
    branchChainLegs,
    buildCourseRouteGeojson,
    buildHolePlan,
    buildOptionChips,
    buildPlanGeojson,
    chainScoreContext,
    courseRouteLayers,
    enrichPlanStrategy,
    ghostAimForLeg,
    nearestLegFoot,
    planarBearingDeg,
    planLayers,
    shotDepthInPlan,
    type EffectiveWind,
    type GhostAim,
    type HolePlan,
    type OptionChip,
    type PlanLeg,
} from './plan-overlay';
import { buildLieMap, type LieMap } from './lie-map';
import { PuttReadService } from './putt-read.service';
import {
    PUTT_OVERLAY_ID,
    buildPuttGeojson,
    puttLayers,
} from './putt-overlay';
import {
    bearingBetween,
    browseForwardRoute,
    browseTargetActivation,
    buildBrowseLadder,
    type BrowseLadderRow,
    type BrowsePointTarget,
} from './browse-ladder';
import type { AimPoint } from '../../../shared/api/aim-points.gen';
import maplibregl from 'maplibre-gl';
import { AnalysisOverlayRenderer } from '../analysis/analysis-overlay';
import { computeSlopeGrid, computeStats, sampleSlopeAt, type SlopeGrid, type AnalysisStats, type SlopeProbe } from '../analysis/analysis-math';
import type { AnalysisView } from '../analysis/analysis-tool.service';
import { createAnalysisClient, type AnalysisApi, type SampleGrid } from '../../../shared/api/analysis.gen';
import { puttLabelDescriptors } from './putt-labels';
import { summarizeGreenSlope, type GreenRefPoint } from './green-slope';
import { HoleSimService, PRIMARY_BRANCH_ID, type SimBranchRequest } from './hole-sim.service';
import {
    SCATTER_BEFORE_LAYER_ID,
    SIM_SCATTER_OVERLAY_ID,
    VARIANT_OVERLAY_ID,
    buildScatterGeojson,
    buildVariantGeojson,
    scatterLayers,
    variantBranchId,
    variantLayers,
    type GhostVariant,
    type ScatterPoint,
} from './sim-overlay';

/** Interaction-claim id for the planner's single tool. */
export const PLANNER_TOOL_ID = 'planner';

/** Overlay id for the caddy-advice markers (separate from the plan overlay). */
export const CADDY_OVERLAY_ID = 'plan-caddy';

/** Transient arbitrary-origin marker/line shown while browsing in Plan mode. */
export const BROWSE_OVERLAY_ID = 'plan-browse';

function browseLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${BROWSE_OVERLAY_ID}-line`,
            type: 'line',
            filter: ['==', ['get', 'role'], 'line'] as never,
            paint: {
                'line-color': '#22d3ee',
                'line-width': 2,
                'line-opacity': 0.85,
                'line-dasharray': [2, 2] as never,
            },
        },
        {
            id: `${BROWSE_OVERLAY_ID}-inspect-line`,
            type: 'line',
            filter: ['==', ['get', 'role'], 'inspect-line'] as never,
            paint: {
                'line-color': '#f5b301',
                'line-width': 2,
                'line-opacity': 0.9,
            },
        },
        {
            id: `${BROWSE_OVERLAY_ID}-origin`,
            type: 'circle',
            filter: ['==', ['get', 'role'], 'origin'] as never,
            paint: {
                'circle-radius': 8,
                'circle-color': '#14281c',
                'circle-stroke-color': '#22d3ee',
                'circle-stroke-width': 3,
            },
        },
        {
            id: `${BROWSE_OVERLAY_ID}-target`,
            type: 'circle',
            filter: ['==', ['get', 'role'], 'target'] as never,
            paint: {
                'circle-radius': 6,
                'circle-color': '#f5b301',
                'circle-stroke-color': '#14281c',
                'circle-stroke-width': 2,
            },
        },
        // Tapped-shape inspection: the ring itself gets an amber wash +
        // outline (inspect family), and the two measured edge points carry
        // their front/carry figures as labels.
        {
            id: `${BROWSE_OVERLAY_ID}-feature-fill`,
            type: 'fill',
            filter: ['==', ['get', 'role'], 'feature-ring'] as never,
            paint: { 'fill-color': '#f5b301', 'fill-opacity': 0.15 },
        },
        {
            id: `${BROWSE_OVERLAY_ID}-feature-outline`,
            type: 'line',
            filter: ['==', ['get', 'role'], 'feature-ring'] as never,
            layout: { 'line-join': 'round' },
            paint: { 'line-color': '#f5b301', 'line-width': 2.5, 'line-opacity': 0.95 },
        },
        {
            id: `${BROWSE_OVERLAY_ID}-edge`,
            type: 'circle',
            filter: ['==', ['get', 'role'], 'edge'] as never,
            paint: {
                'circle-radius': 5,
                'circle-color': '#f5b301',
                'circle-stroke-color': '#14281c',
                'circle-stroke-width': 2,
            },
        },
        // The edge figures themselves are DOM markers (the editor style has
        // no glyphs endpoint, so symbol text layers can't render) — see the
        // inspected-feature label effect in start().
    ];
}

/**
 * Inline style for a tapped-shape edge figure ("96" / "112") DOM marker —
 * inspect-family amber pill, same idiom as the putt aim label.
 */
function edgeLabelCss(): string {
    return 'font: 600 11px/1.3 system-ui, sans-serif; padding: 1px 5px;'
        + ' border-radius: 5px; pointer-events: none; white-space: nowrap;'
        + ' background: rgba(245, 179, 1, 0.92); color: #14281c;';
}

/** Marker + label layers for the caddy advice overlay. */
/** Inline style for an on-graphics putt label marker, by kind. */
function puttLabelCss(kind: 'dist' | 'aim' | 'slope'): string {
    const base = 'font: 600 11px/1.3 system-ui, sans-serif; padding: 1px 5px;'
        + ' border-radius: 5px; pointer-events: none; white-space: nowrap;';
    if (kind === 'aim') return base + ' background: rgba(245, 179, 1, 0.92); color: #14281c;';
    if (kind === 'slope') return base + ' background: rgba(10, 20, 14, 0.6); color: #fff; font-size: 10px;';
    return base + ' background: rgba(10, 20, 14, 0.82); color: #fff;'; // dist
}

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
/** Screen-px point-to-segment tolerance for clicking a suggested (ghost) line. */
const VARIANT_LINE_HIT_PX = 10;
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
 * DEM grid buffer for the green-slope caddy fetch (D10 seam) — the same
 * margin as the putt-read grid (PUTT_GRID_BUFFER_M), the analysis minimum
 * that still gives central-difference slope cells a little room near the
 * green boundary.
 */
const GREEN_SLOPE_BUFFER_M = 10;
/** DEM grid resolution for the green-slope fetch — the DEM's native 0.5 m. */
const GREEN_SLOPE_RESOLUTION_M = 0.5;

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

export type PlannerMode = 'select' | 'add-shot' | 'add-alternative' | 'add-gate' | 'putt';

export type PlannerSelection = { kind: 'shot' | 'gate'; id: string } | null;

export interface BrowseOrigin {
    holeId: string;
    lat: number;
    lon: number;
    elevation: number | null;
    isOverride: boolean;
}

type BrowseInspection =
    | { source: 'ladder'; holeId: string; rowId: string }
    | { source: 'map'; holeId: string; id: string; position: StrategyPoint }
    | {
        source: 'map-feature';
        holeId: string;
        id: string;
        label: string;
        ring: FlatRing;
        /** The clicked point (planar) — the ray anchor in ray mode. */
        at: StrategyPoint;
        /**
         * A browse-to point that was inspected when the shape was clicked —
         * KEPT, and the shape's window measures along origin → this line
         * instead of the ray through the click.
         */
        lineTo: StrategyPoint | null;
    };

/** Feature kinds the tap-a-shape hit test answers for (hazards + green). */
const TAPPABLE_KINDS: ReadonlySet<string> = new Set(TAPPABLE_RING_TYPES);

/** "water_creek" → "Water creek" — display label for a tapped ring's kind. */
function ringKindLabel(kind: string): string {
    const spaced = kind.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type DragTarget =
    | { kind: 'shot'; id: string }
    | { kind: 'gate-side'; id: string; side: 'left' | 'right' }
    | { kind: 'gate-move'; id: string }
    | { kind: 'putt-ball' }
    | { kind: 'putt-hole' };

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
    private confirm = di.get(ConfirmService);
    /** Putt-read state (feature-putting-green-reading §5.1). Shared with the panel. */
    readonly puttRead = di.get(PuttReadService);
    /** Hole simulator + suggest-lines state (feature-hole-sim-and-variants). */
    readonly sim = di.get(HoleSimService);

    /** Injectable for tests (green-slope fetch, D10 seam) — real default hits `/api`. */
    constructor(private analysisApi: AnalysisApi = createAnalysisClient(API_BASE)) {}

    readonly mode = new Signal<PlannerMode>('select');
    readonly selection = new Signal<PlannerSelection>(null);
    /** Transient hint shown in the panel (placement guidance / rejections). */
    readonly notice = new Signal<string | null>(null);

    private drag: Drag | null = null;
    private suppressClick = false;
    private overlayAdded = false;
    private caddyOverlayAdded = false;
    private puttOverlayAdded = false;
    private browseOverlayAdded = false;
    private courseRouteOverlayAdded = false;
    private browseSampleSeq = 0;
    private browseInspectionSeq = 0;

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

    /**
     * Transient arbitrary browse origin. It is deliberately not persisted into
     * the game plan: selecting another hole falls back to that hole's tee.
     */
    private readonly browseOverride = new Signal<BrowseOrigin | null>(null);
    private readonly browseInspection = new Signal<BrowseInspection | null>(null);
    readonly browseOrigin = new Computed<BrowseOrigin | null>(() => {
        const hole = this.selectedHole.get();
        if (!hole) return null;
        const moved = this.browseOverride.get();
        if (moved?.holeId === hole.id) return moved;
        const tee = this.originTee.get();
        return tee ? {
            holeId: hole.id,
            lat: tee.lat,
            lon: tee.lon,
            elevation: tee.elevation,
            isOverride: false,
        } : null;
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

    /** Rank-0 traversal through the selected hole's option tree. */
    readonly primaryShots = new Computed<PlanShot[]>(() => {
        const ph = this.planHole.get();
        return ph ? this.plan.primaryLineForHole(ph.id) : [];
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
            primaryShots: this.primaryShots.get(),
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
        buildLieMap(
            this.features.store.items.get(),
            new Map(this.courseDetail.holes.get().map(h => [h.id, h.number])),
        ));

    /** Sorted yardage ladder measured from the current transient browse origin. */
    readonly browseRows = new Computed<BrowseLadderRow[]>(() => {
        const hole = this.selectedHole.get();
        const originWgs = this.browseOrigin.get();
        if (!hole || !originWgs) return [];
        const originProjected = wgs84ToSweref99tm(originWgs.lat, originWgs.lon);
        const origin = { ...originProjected, elevation: originWgs.elevation };
        const points: BrowsePointTarget[] = [];

        this.holeShots.get().forEach((shot, index) => {
            const p = wgs84ToSweref99tm(shot.lat, shot.lon);
            points.push({
                id: `plan-${shot.id}`,
                label: shot.label?.trim() || `Plan ${index + 1}`,
                role: 'layup',
                point: { ...p, elevation: shot.elevation },
            });
        });

        this.furniture.aimsForHole(hole.id).forEach((aim, index) => {
            const p = wgs84ToSweref99tm(aim.lat, aim.lon);
            points.push({
                id: `aim-${aim.id}`,
                label: aim.label?.trim() || `Aim ${index + 1}`,
                role: 'aim',
                point: { ...p, elevation: aim.elevation },
            });
        });

        const green = this.furniture.greenForHole(hole.id);
        let greenCenterPoint: BrowsePointTarget['point'] | null = null;
        if (green) {
            const addGreen = (
                id: string, label: string, role: BrowsePointTarget['role'],
                lat: number | null, lon: number | null, elevation: number | null = null,
            ): void => {
                if (lat === null || lon === null) return;
                const p = wgs84ToSweref99tm(lat, lon);
                const target = { id, label, role, point: { ...p, elevation } };
                points.push(target);
            };
            addGreen('green-front', 'Green front', 'green_front', green.frontLat, green.frontLon);
            greenCenterPoint = { ...wgs84ToSweref99tm(green.centerLat, green.centerLon), elevation: green.elevation };
            points.push({ id: 'green-center', label: 'Green', role: 'green_center', point: greenCenterPoint });
            addGreen('green-back', 'Green back', 'green_back', green.backLat, green.backLon);

            const pin = this.furniture.pinsForHole(hole.id).find(p => p.active);
            if (pin) addGreen(`pin-${pin.id}`, pin.name || 'Pin', 'pin', pin.lat, pin.lon);
        }

        const reference = greenCenterPoint ?? points.at(-1)?.point ?? origin;
        // Hazard rays / wind hold reference bearing follows the FIRST LEG of the
        // forward route (origin → first still-ahead aim), so a dogleg casts its
        // carry/front rays down the played corner rather than straight at the
        // green (parity with iOS). Within AIM_ROUTING_THRESHOLD_M of the green
        // the route is gated straight, so route[1] IS the green and the rays go
        // straight at it. Ladder point rows stay straight-line.
        const bearingDeg = greenCenterPoint
            ? bearingBetween(origin, this.browseFirstLegTarget(hole, origin, greenCenterPoint))
            : bearingBetween(origin, reference);
        const hazards = this.lieMap.get().hazardRings().map((ring, index) => ({
            id: `hazard-${index}`,
            label: ring.kind.charAt(0).toUpperCase() + ring.kind.slice(1),
            ring,
        }));
        return buildBrowseLadder({
            origin,
            points,
            hazards,
            bearingDeg,
            wind: this.effectiveWind.get() ?? undefined,
            clubs: this.orderedClubs.get(),
        });
    });

    /**
     * The projected forward play-line for a browse origin (origin → still-ahead
     * aims → green via the shared route-chainage filter, gated STRAIGHT to
     * [origin, green] within AIM_ROUTING_THRESHOLD_M of the green) plus the
     * hole's aim rows in order. `route.length - 2` is the count of aims kept
     * (0 when gated), so callers that need drift-free lat/lon vertices use
     * `aims.slice(aims.length - kept)`. The tee (route's first vertex for the
     * chainage projection) is the hole's resolved `originTee`, independent of
     * where the browse origin sits.
     */
    private browseRoute(hole: Hole, origin: StrategyPoint, green: StrategyPoint): {
        route: StrategyPoint[];
        aims: AimPoint[];
    } {
        const aims = this.furniture.aimsForHole(hole.id);
        const aimPoints = aims.map(a => ({ ...wgs84ToSweref99tm(a.lat, a.lon), elevation: a.elevation }));
        const tee = this.originTee.get();
        const teePoint = tee
            ? { ...wgs84ToSweref99tm(tee.lat, tee.lon), elevation: tee.elevation }
            : undefined;
        return { route: browseForwardRoute(origin, teePoint, aimPoints, green), aims };
    }

    /** First-leg target of the forward route: the first still-ahead aim, else
     *  the green center — the reference the hazard rays / wind hold cast toward.
     *  Within the routing gate route[1] IS the green, so this goes straight. */
    private browseFirstLegTarget(hole: Hole, origin: StrategyPoint, green: StrategyPoint): StrategyPoint {
        return this.browseRoute(hole, origin, green).route[1] ?? green;
    }

    /** Target currently being inspected from the UNCHANGED browse origin. */
    readonly inspectedBrowseRow = new Computed<BrowseLadderRow | null>(() => {
        const inspection = this.browseInspection.get();
        const hole = this.selectedHole.get();
        if (!inspection || inspection.holeId !== hole?.id) return null;
        if (inspection.source === 'ladder') {
            return this.browseRows.get().find(row => row.id === inspection.rowId) ?? null;
        }
        if (inspection.source === 'map-feature') {
            return this.inspectedFeatureData.get()?.row ?? null;
        }
        const originWgs = this.browseOrigin.get();
        if (!originWgs) return null;
        const originProjected = wgs84ToSweref99tm(originWgs.lat, originWgs.lon);
        const [row] = buildBrowseLadder({
            origin: { ...originProjected, elevation: originWgs.elevation },
            points: [{
                id: inspection.id,
                label: 'Selected point',
                role: 'aim',
                point: inspection.position,
            }],
            bearingDeg: bearingBetween(originProjected, inspection.position),
            wind: this.effectiveWind.get() ?? undefined,
            clubs: this.orderedClubs.get(),
        });
        return row ?? null;
    });

    /**
     * The tap-a-shape inspection, row + geometry: the readout row for the
     * panel plus the tapped ring and the two play-line edge points the map
     * overlay highlights and labels. Null when nothing (or a non-shape) is
     * inspected.
     */
    private readonly inspectedFeatureData = new Computed<{
        row: BrowseLadderRow;
        ring: FlatRing;
        frontPoint: StrategyPoint;
        carryPoint: StrategyPoint;
        lineTo: StrategyPoint | null;
    } | null>(() => {
        const inspection = this.browseInspection.get();
        const hole = this.selectedHole.get();
        if (!inspection || inspection.source !== 'map-feature' || inspection.holeId !== hole?.id) {
            return null;
        }
        return this.buildInspectedFeature(inspection);
    });

    /**
     * The tap-a-shape readout row + geometry. Ray mode (no kept browse-to):
     * the window is the ray origin → click extended through the ring, so the
     * edge points sit ON the shape's lips and there is no side tag. Browse-to
     * mode: the window projects onto the chosen origin → browse-to line
     * (edge points on that line, side prefix kept). `clubName` is the club
     * that carries the FAR edge.
     */
    private buildInspectedFeature(
        inspection: Extract<BrowseInspection, { source: 'map-feature' }>,
    ): {
        row: BrowseLadderRow;
        ring: FlatRing;
        frontPoint: StrategyPoint;
        carryPoint: StrategyPoint;
        lineTo: StrategyPoint | null;
    } | null {
        const originWgs = this.browseOrigin.get();
        if (!originWgs) return null;
        const originProjected = wgs84ToSweref99tm(originWgs.lat, originWgs.lon);
        const origin: StrategyPoint = { ...originProjected, elevation: originWgs.elevation };

        const extent = inspection.lineTo
            ? ringExtentAlongLines([[origin, inspection.lineTo]], inspection.ring)
            : ringExtentAlongRay(origin, inspection.at, inspection.ring);
        if (!extent) return null;

        const side = extent.side === 'left' ? 'L ' : extent.side === 'right' ? 'R ' : '';
        const carryClub = closestClub(this.orderedClubs.get(), extent.carryM);
        return {
            row: {
                id: inspection.id,
                kind: 'hazard_front',
                label: `${side}${inspection.label}`,
                lineM: extent.frontM,
                farM: extent.carryM,
                playsAsM: null,
                elevationDeltaM: null,
                windDeltaM: null,
                clubName: carryClub?.name ?? null,
                position: extent.centroid,
            },
            ring: inspection.ring,
            frontPoint: extent.frontPoint,
            carryPoint: extent.carryPoint,
            lineTo: inspection.lineTo,
        };
    }

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
     * E2E cadence instrumentation (inert in prod): a monotonic counter bumped
     * once per COMPLETED enrichment pass — i.e. each time `refreshStrategy`'s
     * coalesced microtask actually runs `enrichPlanStrategy`. Reflected onto
     * the planner panel root as `data-enrich-count`; the smoke suite asserts it
     * stays flat across drag frames and increments exactly once on release,
     * proving the compute-cadence guarantee (DECADE §4.5) for real. Behaviour-
     * neutral: nothing in the app reads it.
     */
    readonly enrichCount = new Signal<number>(0);

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
        const shots = this.holeShots.get()
            .map(s => `${s.id}:${s.parentShotId ?? 'root'}:${s.sortOrder}:${s.clubId ?? ''}`)
            .join(',');
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
                this.optionChipsResult.set(null);
                return;
            }
            const strategyCtx = {
                lieMap: this.lieMap.peek(),
                greenCenter,
                wind: this.effectiveWind.peek(),
            };
            const enriched = enrichPlanStrategy(base, strategyCtx);
            this.enrichedPlan.set({ base, enriched });
            // Caddy advice runs on the SAME cadence as EV enrichment (shot-place
            // / drag-release, coalesced onto this microtask) — never per frame
            // (feature-smart-caddy.md §4.5). It reads the just-enriched plan so
            // every rule sees the settled geometry + lie breakdowns.
            this.caddyResult.set({ base, advice: this.computeCaddyAdvice(enriched) });
            // Option score chips (T30) ride the same coalesced pass — the chain
            // scorer sweeps optimizeAim per clubbed option leg, which is exactly
            // the cost class the cadence guarantee keeps off the drag hot loop.
            this.optionChipsResult.set({ base, chips: buildOptionChips(enriched, strategyCtx) });
            // Cadence instrumentation — one bump per completed enrichment pass.
            this.enrichCount.set(this.enrichCount.peek() + 1);
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

    // ── Hole simulation (feature-hole-sim-and-variants Phase B/C) ──────────

    /**
     * Signature of the live plan for SIM invalidation (V8). Unlike
     * `strategyInputs` this deliberately INCLUDES shot positions: any plan
     * edit — a drag frame included — must grey the histogram. Nothing
     * recomputes off this; it is compared, not reacted to.
     *
     * THE RULE: everything `buildSimRequests` feeds `simulateChain` must be in
     * here, or the panel would present a distribution computed from inputs the
     * map no longer shows. That is the shot chain (ids/parents/order/clubs AND
     * positions), the tee, the wind, the par — plus the two things that reach
     * the engine indirectly: the CLUB SET (`orderedClubs` + the hole's
     * preferred club, the same sources `strategyInputs` watches, since they
     * decide each leg's dispersion) and the TARGET GEOMETRY (the green centre
     * and the surface set behind `lieMap`). Nothing viewport-derived is in
     * here, so pan/zoom can never flip it.
     */
    private readonly simPlanSignature = new Computed<string>(() => {
        const hole = this.selectedHole.get();
        const shots = this.holeShots.get()
            .map(s => `${s.id}:${s.parentShotId ?? 'root'}:${s.sortOrder}:${s.clubId ?? ''}`
                + `:${s.lat.toFixed(7)}:${s.lon.toFixed(7)}`)
            .join(',');
        const wind = this.effectiveWind.get();
        // Club IDENTITY is not enough here (it is for `strategyInputs`, which
        // only needs to know the bag changed shape): the engine reads carry and
        // dispersion off each club, so an edited club must grey the result too.
        const clubs = this.orderedClubs.get()
            .map(c => `${c.id}:${c.carryM}:${c.dispersionM}`).join(',');
        const preferred = this.planHole.get()?.preferredClubId ?? '';
        const green = this.holePlan.get()?.nodes.find(n => n.kind === 'green');
        const greenSig = green ? `${green.x.toFixed(2)}/${green.y.toFixed(2)}` : 'none';
        // Surface-set token: an edited feature bumps its `version`, an
        // added/removed one changes the count. Numeric fold — no per-edit
        // string building on a signature that recomputes every drag frame.
        let featureCount = 0;
        let featureVersions = 0;
        for (const feature of this.features.store.items.get()) {
            featureCount++;
            featureVersions += feature.version;
        }
        return `${hole?.id ?? ''}|${hole?.par ?? ''}|${this.originTee.get()?.id ?? ''}`
            + `|${wind ? `${wind.speedMps}/${wind.directionDeg}` : 'calm'}`
            + `|${clubs}|${preferred}|${greenSig}|${featureCount}/${featureVersions}|${shots}`;
    });

    /**
     * Branch ids queued for the next simulate run — option shot ids, or the
     * single sentinel `PRIMARY_BRANCH_ID` for the hole's main line. Two or
     * more sibling ids is the comparison case (§5).
     */
    readonly simSelection = new Signal<readonly string[]>([]);

    /** Compact branch label — "1A" style, matching the shot list's index. */
    private branchLabel(shot: PlanShot): string {
        const siblings = this.plan.childShots(shot.gamePlanHoleId, shot.parentShotId);
        const rank = siblings.findIndex(candidate => candidate.id === shot.id);
        const suffix = siblings.length > 1 ? String.fromCharCode(65 + Math.max(0, rank)) : '';
        const plan = this.holePlan.peek();
        const depth = plan ? shotDepthInPlan(plan, shot.id) : 0;
        const authored = shot.label?.trim();
        return authored ? `${depth + 1}${suffix} ${authored}` : `${depth + 1}${suffix}`;
    }

    /**
     * Turn branch ids into simulate requests off the ENRICHED plan (so legs
     * carry the recommended bearings the EV chips were priced with, and the
     * two numbers stay comparable — §5 "they should agree; that's the point").
     * Silently drops branches whose chain can't be resolved.
     */
    private buildSimRequests(branchIds: readonly string[]): SimBranchRequest[] {
        const plan = this.overlayPlan.peek();
        const greenCenter = this.greenCenterVec();
        const hole = this.selectedHole.peek();
        if (!plan || !greenCenter || !hole) return [];
        const ctx: ChainScoreContext = chainScoreContext({
            lieMap: this.lieMap.peek(),
            greenCenter,
            wind: this.effectiveWind.peek(),
        });
        const par = hole.par ?? 4;
        const shotsById = new Map(this.holeShots.peek().map(shot => [shot.id, shot]));
        const requests: SimBranchRequest[] = [];
        for (const branchId of branchIds) {
            const startShotId = branchId === PRIMARY_BRANCH_ID ? null : branchId;
            const legs = branchChainLegs(plan, startShotId);
            if (!legs || legs.length === 0) continue;
            const shot = startShotId ? shotsById.get(startShotId) : undefined;
            requests.push({
                branchId,
                label: shot ? this.branchLabel(shot) : 'Primary line',
                par,
                strokesBefore: shot ? shotDepthInPlan(plan, shot.id) : 0,
                legs,
                ctx,
            });
        }
        return requests;
    }

    /**
     * Run the simulation for the queued branches (falling back to the primary
     * line when nothing is queued). This is the ONLY entry point — it is
     * called from the explicit "Simulate" action and from branch selection,
     * never from an effect on plan geometry, which is what keeps distributions
     * out of the enrich/drag cadence (V8).
     */
    async simulateNow(): Promise<void> {
        const queued = this.simSelection.peek();
        const branchIds = queued.length > 0 ? queued : [PRIMARY_BRANCH_ID];
        const requests = this.buildSimRequests(branchIds);
        if (requests.length === 0) {
            this.notice.set('Nothing to simulate yet — the hole needs a tee, a green, and a shot.');
            return;
        }
        this.notice.set(null);
        await this.sim.simulate(requests);
    }

    /** Add/remove a branch from the comparison set (panel checkbox / chip). */
    toggleSimBranch(shotId: string): void {
        const current = this.simSelection.peek();
        this.simSelection.set(current.includes(shotId)
            ? current.filter(id => id !== shotId)
            : [...current, shotId]);
    }

    /**
     * Auto-simulate on BRANCH SELECT (V8's second trigger). Deliberately not
     * an effect on the plan: it fires only when the *selection* lands on an
     * option at a decision point. Coalesced onto a microtask and deduped on
     * (branch set, plan signature) so re-selecting the same option under an
     * unchanged plan is free.
     *
     * THE DRAG INTERACTION, which is subtle: a mousedown on a marker sets the
     * selection AND opens `this.drag` in the same handler, and this microtask
     * runs after it — so a plain "click a marker to select it" arrives here
     * with a drag object already open. Bailing on `this.drag` alone would
     * therefore make marker clicks NEVER auto-simulate (the bug); bailing on
     * nothing would put 800 rollouts on the critical path of a gesture that is
     * about to move the shot anyway. So: skip only once the gesture has
     * actually MOVED, and let `onMouseUp` re-schedule the click case (a drag
     * that moved is a plan EDIT — V8 says grey it and wait, never
     * auto-recompute).
     */
    private simAutoScheduled = false;
    private simAutoKey: string | null = null;

    private scheduleAutoSimulate(): void {
        if (this.simAutoScheduled) return;
        this.simAutoScheduled = true;
        queueMicrotask(() => {
            this.simAutoScheduled = false;
            if (this.drag?.moved) return; // never DURING a live drag
            const shot = this.selectedShot.peek();
            if (!shot) return;
            const siblings = this.plan.childShots(shot.gamePlanHoleId, shot.parentShotId);
            if (siblings.length < 2) return; // not a decision point — nothing to compare
            const branchIds = siblings.map(s => s.id);
            const key = `${branchIds.join(',')}|${this.simPlanSignature.peek()}`;
            if (key === this.simAutoKey) return;
            this.simAutoKey = key;
            this.simSelection.set(branchIds);
            void this.simulateNow();
        });
    }

    // ── Suggest lines (V7) ────────────────────────────────────────────────

    /**
     * The hole's variant-discovery context: tee, green, aim points, the
     * flattened lie map, and the hazard rings tagged with stable ids (the
     * signature labels map those ids back to feature kinds).
     */
    private variantContext(): { ctx: VariantHoleContext; hazardKindById: Map<string, string> } | null {
        const hole = this.selectedHole.peek();
        const plan = this.holePlan.peek();
        const greenCenter = this.greenCenterVec();
        if (!hole || !plan || !greenCenter) return null;
        const teeNode = plan.nodes.find(n => n.kind === 'tee');
        if (!teeNode) return null;
        const lieMap = this.lieMap.peek();
        const hazardKindById = new Map<string, string>();
        const hazards: HoleHazard[] = lieMap.hazardRings().map((ring, index) => {
            const id = `hazard-${index}`;
            hazardKindById.set(id, ring.kind);
            return { ...ring, id };
        });
        const wind = this.effectiveWind.peek();
        const aimPoints = this.furniture.aimsForHole(hole.id)
            .map(aim => wgs84ToSweref99tm(aim.lat, aim.lon));
        return {
            hazardKindById,
            ctx: {
                tee: { x: teeNode.x, y: teeNode.y },
                greenCenter,
                aimPoints,
                surfaces: lieMap.surfaces(),
                hazards,
                clubs: this.orderedClubs.peek(),
                ...(wind ? { wind: { speedMps: wind.speedMps, directionDeg: wind.directionDeg } } : {}),
            },
        };
    }

    /** Toolbar action: enumerate the hole's distinct lines as ghost branches. */
    async suggestLines(): Promise<number> {
        const built = this.variantContext();
        if (!built) {
            this.notice.set('Suggest lines needs a tee and a mapped green on this hole.');
            return 0;
        }
        this.notice.set(null);
        const count = await this.sim.discover(built.ctx, built.hazardKindById);
        if (count === 0) this.notice.set('No distinct lines found for this hole.');
        return count;
    }

    /**
     * Accept a ghost: materialise it as an ordinary option branch through the
     * EXISTING addShot(parentShotId) chain (V7). Provenance ends at creation —
     * once written it is an authored option like any other, and the ghost is
     * forgotten. Returns the shots created.
     */
    async acceptVariant(id: string): Promise<number> {
        const hole = this.selectedHole.peek();
        const ghost = this.sim.variants.peek().find(g => g.id === id);
        if (!hole || !ghost) return 0;
        // The graph path is tee → landings… → green; only the intermediate
        // landings become shots (the tee and the green are not plan rows).
        const landings = ghost.variant.nodes.slice(1, -1);
        if (landings.length === 0) {
            this.notice.set('That line has no landing points to place.');
            return 0;
        }
        // ROOT-LEVEL, always. Discovery anchors every variant at the TEE
        // (`variantContext`), so the first landing's leg is a tee shot. Hanging
        // it off whatever happens to be selected would draw that leg from a
        // mid-chain landing instead — a line the user never saw and the chip
        // never priced. The ghost is a whole alternative hole, so it becomes a
        // root option; the current selection is irrelevant to it.
        let parentShotId: string | null = null;
        const teeNode = ghost.variant.nodes[0];
        let origin = sweref99tmToWgs84(teeNode.point.x, teeNode.point.y);
        let created = 0;
        for (const [index, node] of landings.entries()) {
            const { lat, lon } = sweref99tmToWgs84(node.point.x, node.point.y);
            // The club the VARIANT was priced with (the graph's wind-adjusted
            // reachability pick), not a fresh plays-like nearest — the accepted
            // branch has to price like the chip the user clicked. Auto-club is
            // only the fallback for a leg that carries none.
            const clubId = this.clubIdForSpec(ghost.variant.legs[index]?.club)
                ?? this.autoClubForShot(
                    { lng: lon, lat }, null, { lat: origin.lat, lon: origin.lon, elevation: null });
            origin = { lat, lon };
            const shot = await this.plan.addShot(hole.number, {
                lat,
                lon,
                elevation: null,
                // Only the branch head carries the signature label; the
                // continuation shots stay unlabelled like hand-placed ones.
                label: index === 0 ? ghost.label : null,
                parentShotId,
                ...(clubId ? { clubId } : {}),
            });
            if (!shot) break;
            parentShotId = shot.id;
            created++;
        }
        this.sim.dismissVariant(id);
        if (created > 0) this.refreshStrategy();
        return created;
    }

    /**
     * The bag row a variant leg's `ClubSpec` came from. Discovery is handed
     * `orderedClubs` directly, but the specs come back through a structured
     * clone (worker) that strips identity, so match on name and fall back to
     * carry — the same club, just a copy. Null when the leg was clubless or the
     * bag changed under the ghost.
     */
    private clubIdForSpec(spec: ClubSpec | null | undefined): string | null {
        if (!spec) return null;
        const clubs = this.orderedClubs.peek();
        const byName = spec.name ? clubs.find(club => club.name === spec.name) : undefined;
        return (byName ?? clubs.find(club => club.carryM === spec.carryM))?.id ?? null;
    }

    /** Forget a ghost without writing anything (V7 dismiss). */
    dismissVariant(id: string): void {
        this.sim.dismissVariant(id);
    }

    /** Hover a ghost to preview its corridor (paint-only, no geometry rebuild). */
    hoverVariant(id: string | null): void {
        this.sim.hoveredVariantId.set(id);
    }

    /**
     * Pin a ghost (click a row, or the same row again to unpin). Selecting is
     * what makes a suggestion inspectable: the corridor stays put once the
     * pointer leaves, the ellipses and leg labels appear, and the ghost is
     * SIMULATED alongside the primary line so its histogram sits next to the
     * plan's — the doc's "lazily, on selection" distribution (§V5), which the
     * hover-only version never had a trigger for.
     *
     * Simulating here is still V8-legal: it fires on an explicit user action,
     * never from an effect on plan geometry.
     */
    selectVariant(id: string | null): void {
        this.sim.selectVariant(id);
        const selected = this.sim.selectedVariantId.peek();
        if (!selected) return;
        const requests = this.buildVariantSimRequests(selected);
        if (requests.length === 0) return;
        void this.sim.simulate(requests);
    }

    /**
     * The selected ghost as simulate requests, with the primary line alongside
     * it when the hole has one — a suggestion's distribution only means
     * something next to the distribution of what you're already planning.
     */
    private buildVariantSimRequests(variantId: string): SimBranchRequest[] {
        const ghost = this.sim.variants.peek().find(g => g.id === variantId);
        const hole = this.selectedHole.peek();
        const greenCenter = this.greenCenterVec();
        if (!ghost || !hole || !greenCenter || ghost.variant.legs.length === 0) return [];
        const ctx: ChainScoreContext = chainScoreContext({
            lieMap: this.lieMap.peek(),
            greenCenter,
            wind: this.effectiveWind.peek(),
        });
        const par = hole.par ?? 4;
        return [
            ...this.buildSimRequests([PRIMARY_BRANCH_ID]),
            {
                branchId: variantBranchId(variantId),
                label: ghost.label,
                par,
                // Discovery anchors every variant at the TEE (`variantContext`),
                // so nothing has been played before its first leg.
                strokesBefore: 0,
                legs: ghost.variant.legs,
                ctx,
            },
        ];
    }

    // ── Sim overlays ──────────────────────────────────────────────────────

    private simScatterAdded = false;
    private variantOverlayAdded = false;

    /**
     * Sampled landings from the current result, classified by lie for colour.
     * Empty (so the overlay renders nothing) while the toggle is off or the
     * result is stale — a dot cloud drawn against a plan it no longer matches
     * is the most misleading thing this feature could put on the map.
     */
    private readonly scatterPoints = new Computed<readonly ScatterPoint[]>(() => {
        if (!this.sim.scatterVisible.get()) return [];
        if (this.sim.stale.get()) return [];
        const lieMap = this.lieMap.get();
        const points: ScatterPoint[] = [];
        for (const branch of this.sim.branches.get()) {
            branch.perLegLandings.forEach((landings, depth) => {
                for (const point of landings) {
                    points.push({ depth, lie: lieMap.classifyLie(point), point });
                }
            });
        }
        return points;
    });

    private readonly simScatterData = new Computed<FeatureCollection>(
        () => buildScatterGeojson(this.scatterPoints.get()));

    private readonly variantOverlayData = new Computed<FeatureCollection>(() => {
        const wind = this.effectiveWind.get();
        return buildVariantGeojson(this.sim.variants.get(), {
            hoveredId: this.sim.hoveredVariantId.get(),
            selectedId: this.sim.selectedVariantId.get(),
            // The same wind the variant was priced with, so the selected
            // ghost's ellipse centers sit where its chip's number came from.
            ...(wind ? { wind: { speedMps: wind.speedMps, directionDeg: wind.directionDeg } } : {}),
        });
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

    /** Green-feature id `greenSlopeSummary` was last fetched for (or cleared
     *  toward) — the dedupe key `attachGreenSlope` uses so unrelated re-renders
     *  (feature edits elsewhere, unrelated signal churn) don't re-fetch. */
    private greenSlopeFeatureId: string | null = null;
    /** Bumped on every hole/green change; a resolved fetch checks it against
     *  the current value to drop a response superseded by a newer selection. */
    private greenSlopeSeq = 0;

    /**
     * Wire the green-slope caddy seam (D10, feature-smart-caddy.md §4.6): when
     * the selected hole's green (course feature) changes — including on
     * initial load — clear `greenSlopeSummary` IMMEDIATELY (synchronously, in
     * this same effect run) so stale slope advice never shows, then fetch a
     * fresh grid off a microtask and feed the derived summary back in once it
     * settles. Dedupes on the green feature id so a burst of unrelated
     * `features`/`selectedHole` recomputes (e.g. another feature edited
     * elsewhere) is a no-op — exactly one fetch per hole/green selection,
     * never per drag frame (nothing here is on the drag path at all: drags
     * only touch `plan.shots`/`plan.gates`, not `features` or `selectedHole`).
     *
     * The microtask defer for the FETCH (not the clear) sidesteps the
     * reactive-cascade gotcha (AGENTS.md): `originTee`, read inside the fetch
     * to pick the front/back axis, is itself derived from `selectedHole` and
     * could still be settling to the new hole's tee within the same
     * synchronous signal-write cascade that changed `selectedHole` here.
     */
    private attachGreenSlope(track: (dispose: () => void) => void): void {
        let disposed = false;
        track(() => { disposed = true; });
        track(effect(() => {
            const hole = this.selectedHole.get();
            const features = this.features.store.items.get();
            const greenFeature = hole
                ? features.find(f => f.type === 'green' && f.holeId === hole.id) ?? null
                : null;
            const featureId = greenFeature?.id ?? null;
            if (featureId === this.greenSlopeFeatureId) return; // same green — keep the summary
            this.greenSlopeFeatureId = featureId;
            const seq = ++this.greenSlopeSeq; // invalidate any fetch in flight for the old green
            this.setGreenSlopeSummary(null); // immediate — no stale advice while the new grid loads
            if (!hole || !greenFeature) return; // no green mapped — stays cleared (degrades silently)
            queueMicrotask(() => {
                if (disposed || seq !== this.greenSlopeSeq) return;
                void this.fetchGreenSlopeSummary(seq, hole, greenFeature);
            });
        }));
    }

    /**
     * Fetch the green's DEM sample grid and derive the D10 summary
     * (green-slope.ts), or leave the summary cleared on any failure (no
     * furniture green row for a front/back axis, no green polygon mapped yet,
     * a DEM fetch error, or an all-nodata/dead-flat grid) — the caddy simply
     * won't fire, no error surfaced to the user (requirement: degrade
     * silently). `seq` guards against a response for a since-superseded
     * hole/green selection overwriting a newer one.
     */
    private async fetchGreenSlopeSummary(seq: number, hole: Hole, greenFeature: CourseFeature): Promise<void> {
        const greenRow = this.furniture.greenForHole(hole.id);
        if (!greenRow) return; // no furniture green row → no honest front/back axis

        // Front/back axis for the summary's half-split: the green centre
        // nudged either side of the tee→green bearing, the same nominal-depth
        // convention `buildLegContext` uses per leg — here at hole
        // granularity since this fetch runs once per selection, not per leg.
        // Unused by the rule's fire decision (bearing + magnitude only), so a
        // coarse stand-in is honest enough (green-slope.ts docstring).
        const center = wgs84ToSweref99tm(greenRow.centerLat, greenRow.centerLon);
        const tee = this.originTee.peek();
        const axisBearingDeg = tee
            ? planarBearingDeg(wgs84ToSweref99tm(tee.lat, tee.lon), center)
            : 0;
        const dir = bearingToUnitVector(axisBearingDeg);
        const front: GreenRefPoint = {
            e: center.x - dir.x * NOMINAL_GREEN_DEPTH_M,
            n: center.y - dir.y * NOMINAL_GREEN_DEPTH_M,
        };
        const back: GreenRefPoint = {
            e: center.x + dir.x * NOMINAL_GREEN_DEPTH_M,
            n: center.y + dir.y * NOMINAL_GREEN_DEPTH_M,
        };

        let grid: SampleGrid;
        try {
            grid = await this.analysisApi.sampleGrid({
                courseId: greenFeature.courseId,
                featureId: greenFeature.id,
                bufferM: GREEN_SLOPE_BUFFER_M,
                resolutionM: GREEN_SLOPE_RESOLUTION_M,
            });
        } catch {
            return; // DEM fetch error → degrade silently, summary stays cleared
        }
        if (seq !== this.greenSlopeSeq) return; // superseded by a newer hole/green selection
        this.setGreenSlopeSummary(summarizeGreenSlope(grid, front, back));
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
     * The last option-chip pass (T30), paired with the `holePlan` it was
     * derived from — the same base-guard pattern as `enrichedPlan` /
     * `caddyResult`, so chips drop out mid-drag and reappear priced against
     * the settled plan on release.
     */
    private readonly optionChipsResult = new Signal<
        { base: HolePlan; chips: readonly OptionChip[] } | null
    >(null);

    /**
     * Score chips for every option at multi-sibling decision points
     * (feature-plan-shot-options.md O4): probable hole score + penalty% +
     * blow-up tail per option, from `scoreOptionChain`. Recomputed ONLY on
     * the strategy enrich cadence (shot-place / drag-release); empty while
     * the live plan has moved past the last enrichment (mid-drag) or when
     * there is nothing to price.
     */
    readonly optionChips = new Computed<readonly OptionChip[]>(() => {
        const live = this.holePlan.get();
        const result = this.optionChipsResult.get();
        return result && result.base === live ? result.chips : [];
    });

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
            { index: leg.depth, toKind: leg.to.kind, par: shared.par, originLie },
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
        if (!plan || plan.allNodes.length === 0) return null;
        const hole = this.selectedHole.peek();
        if (!hole) return null;
        let w = plan.allNodes[0]!.lon, e = w, s = plan.allNodes[0]!.lat, n = s;
        for (const p of plan.allNodes) {
            if (p.lon < w) w = p.lon;
            if (p.lon > e) e = p.lon;
            if (p.lat < s) s = p.lat;
            if (p.lat > n) n = p.lat;
        }
        return { holeId: hole.id, bounds: [w, s, e, n] };
    });

    private readonly overlayData = new Computed<FeatureCollection>(() => {
        // Putt mode owns the map: the shot plan (markers, aim lines, gates)
        // would otherwise draw a full-club aim line across the green view and
        // read as part of the putt read (feature-putting-green-reading §5.1).
        if (this.mode.get() === 'putt') return { type: 'FeatureCollection', features: [] };
        const sel = this.selection.get();
        return buildPlanGeojson({
            plan: this.overlayPlan.get(),
            gates: this.holeGates.get(),
            optionChips: this.optionChips.get(),
            selectedShotId: sel?.kind === 'shot' ? sel.id : null,
            selectedGateId: sel?.kind === 'gate' ? sel.id : null,
        });
    });

    /**
     * The selected hole's COURSE ROUTE — tee → aim points → green — as its own
     * FeatureCollection. Course definition, not player strategy: the plan
     * overlay's legs come from plan shots and collapse to a single tee → green
     * segment on an unplanned hole, which hides the hole's doglegs. This line
     * draws them regardless (and stays put once shots exist, under the legs).
     * Empty when the hole has no aim points — then the plan's own tee → green
     * leg already IS the route, and a second identical line would just double it.
     */
    private readonly courseRouteData = new Computed<FeatureCollection>(() => {
        const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
        // Putt mode owns the map (same reason as the plan overlay above).
        if (this.mode.get() === 'putt') return empty;
        const hole = this.selectedHole.get();
        if (!hole) return empty;
        const tee = this.originTee.get();
        const green = this.furniture.greenForHole(hole.id);
        return buildCourseRouteGeojson({
            tee: tee ? { lat: tee.lat, lon: tee.lon } : null,
            aims: this.furniture.aimsForHole(hole.id).map(a => ({
                id: a.id, lat: a.lat, lon: a.lon, label: a.label,
            })),
            green: green ? { lat: green.centerLat, lon: green.centerLon } : null,
        });
    });

    private readonly browseOverlayData = new Computed<FeatureCollection>(() => {
        if (this.mode.get() === 'putt') return { type: 'FeatureCollection', features: [] };
        const origin = this.browseOrigin.get();
        if (!origin) return { type: 'FeatureCollection', features: [] };
        const features: FeatureCollection['features'] = [];
        if (origin.isOverride) {
            features.push({
                type: 'Feature',
                properties: { role: 'origin' },
                geometry: { type: 'Point', coordinates: [origin.lon, origin.lat] },
            });
            const hole = this.selectedHole.get();
            const green = hole ? this.furniture.greenForHole(hole.id) : null;
            if (hole && green) {
                // Route the distance line origin → still-ahead aims → green so a
                // dogleg follows its played corners instead of a straight cut
                // (parity with iOS's browseForwardRoute) — except within
                // AIM_ROUTING_THRESHOLD_M of the green, where the line is gated
                // straight (an aim a few meters ahead is not a shot target).
                // Aim vertices reuse the source rows' lat/lon (no projection
                // round-trip drift).
                const originProjected = wgs84ToSweref99tm(origin.lat, origin.lon);
                const greenPoint = {
                    ...wgs84ToSweref99tm(green.centerLat, green.centerLon),
                    elevation: green.elevation,
                };
                const { route, aims } = this.browseRoute(
                    hole, { ...originProjected, elevation: origin.elevation }, greenPoint,
                );
                const keptCount = Math.max(0, route.length - 2);
                const keptAims = aims.slice(aims.length - keptCount);
                const coordinates: [number, number][] = [
                    [origin.lon, origin.lat],
                    ...keptAims.map(a => [a.lon, a.lat] as [number, number]),
                    [green.centerLon, green.centerLat],
                ];
                features.push({
                    type: 'Feature',
                    properties: { role: 'line' },
                    geometry: { type: 'LineString', coordinates },
                });
            }
        }
        const feature = this.inspectedFeatureData.get();
        const inspected = this.inspectedBrowseRow.get();
        if (feature) {
            // Tapped-shape inspection: highlight the ring itself, run the
            // measuring line origin → front edge → far edge, and print both
            // figures at the edge points they measure to.
            const ringCoords = feature.ring.points.map(p => {
                const w = sweref99tmToWgs84(p.x, p.y);
                return [w.lon, w.lat] as [number, number];
            });
            if (ringCoords.length >= 3) {
                ringCoords.push(ringCoords[0]);
                features.push({
                    type: 'Feature',
                    properties: { role: 'feature-ring' },
                    geometry: { type: 'Polygon', coordinates: [ringCoords] },
                });
            }
            const front = sweref99tmToWgs84(feature.frontPoint.x, feature.frontPoint.y);
            const far = sweref99tmToWgs84(feature.carryPoint.x, feature.carryPoint.y);
            // Ray mode: the line runs origin → through the shape to its far
            // lip. Browse-to mode: the line is the CHOSEN one, extended out
            // to the far edge when the shape reaches past the browse-to
            // point, with the kept point marked.
            let lineEnd = far;
            if (feature.lineTo) {
                const target = sweref99tmToWgs84(feature.lineTo.x, feature.lineTo.y);
                const originPl = wgs84ToSweref99tm(origin.lat, origin.lon);
                const targetFarther = Math.hypot(feature.lineTo.x - originPl.x, feature.lineTo.y - originPl.y)
                    > Math.hypot(feature.carryPoint.x - originPl.x, feature.carryPoint.y - originPl.y);
                if (targetFarther) lineEnd = target;
                features.push({
                    type: 'Feature',
                    properties: { role: 'target' },
                    geometry: { type: 'Point', coordinates: [target.lon, target.lat] },
                });
            }
            features.unshift({
                type: 'Feature',
                properties: { role: 'inspect-line' },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [origin.lon, origin.lat],
                        [lineEnd.lon, lineEnd.lat],
                    ],
                },
            });
            features.push({
                type: 'Feature',
                properties: { role: 'edge', label: String(Math.round(feature.row.lineM)) },
                geometry: { type: 'Point', coordinates: [front.lon, front.lat] },
            });
            features.push({
                type: 'Feature',
                properties: { role: 'edge', label: String(Math.round(feature.row.farM ?? 0)) },
                geometry: { type: 'Point', coordinates: [far.lon, far.lat] },
            });
        } else if (inspected) {
            const target = sweref99tmToWgs84(inspected.position.x, inspected.position.y);
            features.unshift({
                type: 'Feature',
                properties: { role: 'inspect-line' },
                geometry: {
                    type: 'LineString',
                    coordinates: [[origin.lon, origin.lat], [target.lon, target.lat]],
                },
            });
            features.push({
                type: 'Feature',
                properties: { role: 'target' },
                geometry: { type: 'Point', coordinates: [target.lon, target.lat] },
            });
        }
        return { type: 'FeatureCollection', features };
    });

    /**
     * A tiny separate overlay for caddy advice: a labelled marker at each
     * advice `anchor` (green front for the slope rule). Kept independent of the
     * plan overlay's GeoJSON (buildPlanGeojson, another task's module) so this
     * task adds no edits there — its own source/layers, added in `start()`.
     */
    private readonly caddyOverlayData = new Computed<FeatureCollection>(() => {
        // Hidden in putt mode (see overlayData) — the "aim your Driver" advice
        // marker has no place over a green read.
        if (this.mode.get() === 'putt') return { type: 'FeatureCollection', features: [] };
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

    // ── Putt read (feature-putting-green-reading §5.1, Phase B) ─────────────

    /** Reuses the Green-analysis Slope/Height heat map + fall-line arrows +
     *  slope% labels under the putt read — NOT a bespoke overlay. */
    private readonly puttAnalysisRenderer = new AnalysisOverlayRenderer();
    /** DEM-derived slope/stats for the putt green, cached per grid object. */
    private puttDerivedCache: { grid: SampleGrid; slope: SlopeGrid; stats: AnalysisStats } | null = null;
    /** Tapped-point slope readout, pinned to the grid it was sampled from. */
    private readonly puttProbe = new Signal<{ grid: SampleGrid; probe: SlopeProbe } | null>(null);
    /** DOM-marker labels on the graphics (distance/plays/aim + cross-slope). */
    private puttLabelMarkers: maplibregl.Marker[] = [];
    /** DOM markers carrying the tapped-shape front/carry figures. */
    private featureEdgeMarkers: maplibregl.Marker[] = [];

    /**
     * The reused analysis view for the putt green (null → nothing / cleared):
     * only in putt mode, with a grid + context, and the overlay toggle not on
     * 'none'. Same view shape the Green-analysis tool renders.
     */
    private readonly puttAnalysisView = new Computed<AnalysisView | null>(() => {
        if (this.mode.get() !== 'putt') return null;
        const mode = this.puttRead.overlayMode.get();
        if (mode === 'none') return null;
        const grid = this.puttRead.grid.get();
        const ctx = this.puttRead.context.get();
        const probe = this.puttProbe.get();
        if (!grid || !ctx) return null;
        if (!this.puttDerivedCache || this.puttDerivedCache.grid !== grid) {
            const slope = computeSlopeGrid(grid);
            this.puttDerivedCache = { grid, slope, stats: computeStats(grid, slope) };
        }
        return {
            grid,
            mode,
            geometry: ctx.geometry,
            slope: this.puttDerivedCache.slope,
            stats: this.puttDerivedCache.stats,
            // Height reading gets the full green-book treatment: 1 m white
            // grid + 2 cm contours. Slope mode keeps its arrows uncluttered.
            showGrid: mode === 'height',
            showContours: mode === 'height',
            probe: mode === 'slope' && probe?.grid === grid ? probe.probe : null,
        };
    });

    /**
     * Putt overlay GeoJSON. Ball/hole/reference-line are LIVE (drag frames
     * move them — cheap geometry only); the break path + aim marker come from
     * the SETTLED read and drop out mid-drag (PuttReadService.read goes null
     * when the input signature diverges), so nothing stale renders.
     */
    private readonly puttOverlayData = new Computed<FeatureCollection>(() => {
        if (this.mode.get() !== 'putt') return { type: 'FeatureCollection', features: [] };
        const display = this.puttRead.display.get();
        return buildPuttGeojson({
            ball: this.puttRead.ball.get(),
            hole: this.puttRead.hole.get(),
            read: display.read,
            soft: display.status === 'soft',
        });
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
        const leg = plan?.allLegs.find(l => l.to.kind === 'shot' && l.to.shot?.id === sel.id);
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

        // Plan overlay — re-added whenever the map becomes ready. The signals
        // are eager/push-based, so one tree mutation can briefly expose mixed
        // parent/primary projections. Subscribe synchronously but perform the
        // MapLibre side effect once on a microtask from the settled geometry.
        let planOverlayScheduled = false;
        let planOverlayDisposed = false;
        track(() => { planOverlayDisposed = true; });
        track(effect(() => {
            this.map.ready.get();
            this.overlayData.get();
            if (planOverlayScheduled) return;
            planOverlayScheduled = true;
            queueMicrotask(() => {
                planOverlayScheduled = false;
                if (planOverlayDisposed) return;
                const ready = this.map.ready.peek();
                const data = this.overlayData.peek();
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
            });
        }));
        track(() => {
            if (this.overlayAdded) {
                this.map.removeOverlayLayer(PLAN_OVERLAY_ID);
                this.overlayAdded = false;
            }
        });

        // Course route (tee → aims → green). Its own overlay so the routing
        // never mutates or re-shapes the plan, slotted UNDER the plan overlay's
        // first layer (`beforeId`) so the player's legs always draw on top.
        // On the very first pass the plan overlay does not exist yet (it lands
        // on a microtask) — `beforeId` then degrades to "on top", which gives
        // the same stacking anyway, since the plan layers are added after.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.courseRouteData.get();
            if (!ready) {
                this.courseRouteOverlayAdded = false;
                return;
            }
            if (!this.courseRouteOverlayAdded) {
                this.map.addOverlayLayer(COURSE_ROUTE_OVERLAY_ID, data, courseRouteLayers(),
                    { beforeId: `${PLAN_OVERLAY_ID}-ellipse-fill` });
                this.courseRouteOverlayAdded = true;
            } else {
                this.map.updateOverlayData(COURSE_ROUTE_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.courseRouteOverlayAdded) {
                this.map.removeOverlayLayer(COURSE_ROUTE_OVERLAY_ID);
                this.courseRouteOverlayAdded = false;
            }
        });

        // Transient browse origin + its direct line to the green. Kept in a
        // separate overlay so browsing never mutates or re-shapes the plan.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.browseOverlayData.get();
            if (!ready) {
                this.browseOverlayAdded = false;
                return;
            }
            if (!this.browseOverlayAdded) {
                this.map.addOverlayLayer(BROWSE_OVERLAY_ID, data, browseLayers());
                this.browseOverlayAdded = true;
            } else {
                this.map.updateOverlayData(BROWSE_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.browseOverlayAdded) {
                this.map.removeOverlayLayer(BROWSE_OVERLAY_ID);
                this.browseOverlayAdded = false;
            }
        });

        // Tapped-shape edge figures: the front/carry numbers printed AT the
        // two measured play-line points — DOM markers (the editor style has no
        // glyphs endpoint, so symbol text layers can't render). Recreated on
        // change; two nodes, cheap.
        track(effect(() => {
            const ready = this.map.ready.get();
            const raw = this.map.map.get();
            const feature = this.inspectedFeatureData.get();
            for (const m of this.featureEdgeMarkers) m.remove();
            this.featureEdgeMarkers = [];
            if (!ready || !raw || !feature) return;
            // Nudge each figure a few meters OUTWARD along the measuring line
            // (front toward the origin, carry past the far edge) so the two
            // never collide over a narrow shape.
            const dx = feature.carryPoint.x - feature.frontPoint.x;
            const dy = feature.carryPoint.y - feature.frontPoint.y;
            const len = Math.hypot(dx, dy);
            const nudge = 8;
            const ux = len > 1e-9 ? dx / len : 0;
            const uy = len > 1e-9 ? dy / len : 1;
            const labels = [
                {
                    point: { x: feature.frontPoint.x - ux * nudge, y: feature.frontPoint.y - uy * nudge },
                    text: String(Math.round(feature.row.lineM)),
                },
                {
                    point: { x: feature.carryPoint.x + ux * nudge, y: feature.carryPoint.y + uy * nudge },
                    text: String(Math.round(feature.row.farM ?? 0)),
                },
            ];
            for (const l of labels) {
                const el = document.createElement('div');
                el.className = 'browse-edge-label';
                el.textContent = l.text;
                el.style.cssText = edgeLabelCss();
                const { lat, lon } = sweref99tmToWgs84(l.point.x, l.point.y);
                this.featureEdgeMarkers.push(
                    new maplibregl.Marker({ element: el, anchor: 'center', offset: [0, -14] })
                        .setLngLat([lon, lat]).addTo(raw),
                );
            }
        }));
        track(() => {
            for (const m of this.featureEdgeMarkers) m.remove();
            this.featureEdgeMarkers = [];
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

        // Reused Green-analysis Slope/Height heat map + fall-line arrows +
        // slope% labels under the putt read (not a bespoke overlay). Rendered
        // BEFORE the putt geometry so the break path sits on top; the heat
        // image is added at the top of the stack, so re-raise the putt
        // geometry after each (re)render.
        track(effect(() => {
            if (!this.map.ready.get()) return;
            this.puttAnalysisRenderer.render(this.map, this.puttAnalysisView.get());
            this.raisePuttGeometry();
        }));
        track(() => this.puttAnalysisRenderer.clear(this.map));

        // Putt-read overlay — its own source/layers, same ready-gated re-add
        // lifecycle as the plan/caddy overlays.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.puttOverlayData.get();
            if (!ready) {
                this.puttOverlayAdded = false;
                return;
            }
            if (!this.puttOverlayAdded) {
                this.map.addOverlayLayer(PUTT_OVERLAY_ID, data, puttLayers());
                this.puttOverlayAdded = true;
            } else {
                this.map.updateOverlayData(PUTT_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.puttOverlayAdded) {
                this.map.removeOverlayLayer(PUTT_OVERLAY_ID);
                this.puttOverlayAdded = false;
            }
        });

        // On-graphics read labels: distance + plays-like, aim amount, and a
        // cross-slope % at each sampled station — DOM markers (the editor map
        // style has no glyphs endpoint, so symbol text layers can't render).
        // Recreated on change; a handful of nodes, cheap even mid-drag.
        track(effect(() => {
            const ready = this.map.ready.get();
            const raw = this.map.map.get();
            const isPutt = this.mode.get() === 'putt';
            for (const m of this.puttLabelMarkers) m.remove();
            this.puttLabelMarkers = [];
            if (!ready || !raw || !isPutt) return;
            const labels = puttLabelDescriptors({
                ball: this.puttRead.ball.get(),
                hole: this.puttRead.hole.get(),
                read: this.puttRead.display.get().read,
                slopeSamples: this.puttRead.pathSlopeSamples.get(),
            });
            for (const l of labels) {
                const el = document.createElement('div');
                el.className = `putt-map-label putt-map-label--${l.kind}`;
                el.textContent = l.text;
                el.style.cssText = puttLabelCss(l.kind);
                const { lat, lon } = sweref99tmToWgs84(l.point.x, l.point.y);
                // Deconflict vertically: read labels above the line, cross-slope
                // readings below it, so they don't stack on the same point.
                const offset: [number, number] = l.kind === 'slope' ? [0, 13] : [0, -13];
                this.puttLabelMarkers.push(
                    new maplibregl.Marker({ element: el, anchor: 'center', offset })
                        .setLngLat([lon, lat]).addTo(raw),
                );
            }
        }));
        track(() => {
            for (const m of this.puttLabelMarkers) m.remove();
            this.puttLabelMarkers = [];
        });

        this.attachPuttActivation(track);
        track(() => this.puttRead.deactivate());

        this.attachHoleFraming(track);
        this.attachGreenSlope(track);

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

        // ── Hole simulation (V7/V8) ───────────────────────────────────────
        // Push the live plan signature at the sim service. This is the ONLY
        // plan-geometry subscription the simulator has, and it does not
        // compute anything: it just lets `sim.stale` flip so the panel greys.
        track(effect(() => {
            this.sim.planSignature.set(this.simPlanSignature.get());
        }));

        // Auto-simulate when the SELECTION lands on a decision point (V8's
        // second trigger). Subscribes to the selection only — never to plan
        // geometry — and the handler bails while a drag is live.
        track(effect(() => {
            this.selection.get();
            this.scheduleAutoSimulate();
        }));

        // Ghosts and distributions are per-hole and transient: switching holes
        // forgets both (V7 "ghosts clear on hole switch", V8 derived state).
        track(effect(() => {
            this.selectedHole.get();
            untrack(() => {
                this.sim.reset();
                this.simSelection.set([]);
                this.simAutoKey = null;
            });
        }));

        // Landing scatter — slotted under the vector feature fills so the
        // course still reads through the cloud.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.simScatterData.get();
            if (!ready) {
                this.simScatterAdded = false;
                return;
            }
            if (!this.simScatterAdded) {
                this.map.addOverlayLayer(SIM_SCATTER_OVERLAY_ID, data, scatterLayers(),
                    { beforeId: SCATTER_BEFORE_LAYER_ID });
                this.simScatterAdded = true;
            } else {
                this.map.updateOverlayData(SIM_SCATTER_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.simScatterAdded) {
                this.map.removeOverlayLayer(SIM_SCATTER_OVERLAY_ID);
                this.simScatterAdded = false;
            }
        });

        // Suggest-lines ghost branches — topmost, like the plan overlay, since
        // they are things to click, not context to read through.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.variantOverlayData.get();
            if (!ready) {
                this.variantOverlayAdded = false;
                return;
            }
            if (!this.variantOverlayAdded) {
                this.map.addOverlayLayer(VARIANT_OVERLAY_ID, data, variantLayers());
                this.variantOverlayAdded = true;
            } else {
                this.map.updateOverlayData(VARIANT_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.variantOverlayAdded) {
                this.map.removeOverlayLayer(VARIANT_OVERLAY_ID);
                this.variantOverlayAdded = false;
            }
        });
        // Leaving the planner drops the distributions AND the worker thread —
        // it is only ever needed while this tool is on screen.
        track(() => this.sim.dispose());

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
            this.browseOverride.set(null);
            this.browseInspection.set(null);
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

    /**
     * Arm/disarm the putt read for the selected hole's green whenever putt
     * mode or the underlying data (hole, features, furniture) changes. The
     * context resolves the green COURSE FEATURE (DEM grid key), the furniture
     * green row (calibration key + centre), and the default hole position —
     * the ACTIVE PIN when one exists, else the green centre, else the green
     * polygon's vertex centroid. `activate` is idempotent per green feature,
     * so data-reload re-runs don't refetch or stomp the user's markers.
     */
    private attachPuttActivation(track: (dispose: () => void) => void): void {
        track(effect(() => {
            const mode = this.mode.get();
            const hole = this.selectedHole.get();
            const features = this.features.store.items.get();
            const greens = this.furniture.greens.get();
            const pins = this.furniture.pins.items.get();
            if (mode !== 'putt' || !hole) {
                this.puttRead.deactivate();
                return;
            }
            const greenFeature = features.find(f => f.type === 'green' && f.holeId === hole.id)
                ?? null;
            if (!greenFeature) {
                this.puttRead.deactivate();
                this.notice.set('This hole has no green drawn yet — nothing to read a putt from.');
                return;
            }
            const row = greens.find(g => g.holeId === hole.id) ?? null;
            const activePin = row
                ? pins.find(p => p.greenId === row.id && p.active) ?? null
                : null;
            const defaultHole: Vec2 = activePin
                ? wgs84ToSweref99tm(activePin.lat, activePin.lon)
                : row
                    ? wgs84ToSweref99tm(row.centerLat, row.centerLon)
                    : ringCentroid(greenFeature.geometry.rings[0]?.points ?? []);
            untrack(() => void this.puttRead.activate({
                courseId: greenFeature.courseId,
                greenFeatureId: greenFeature.id,
                geometry: greenFeature.geometry,
                greenId: row?.id ?? null,
                defaultHole,
            }));
        }));
    }

    /**
     * Raise the putt geometry (break path, aim line, markers) to the top of
     * the layer stack. The reused analysis heat image is added at the top when
     * it (re)renders, so call this after it to keep the read drawn above it.
     */
    private raisePuttGeometry(): void {
        const raw = this.map.map.peek();
        if (!raw || !this.puttOverlayAdded) return;
        for (const spec of puttLayers()) {
            if (raw.getLayer(spec.id)) raw.moveLayer(spec.id); // no beforeId → to top
        }
    }

    /** Arm an add mode (toggles back to select when already armed). */
    setMode(mode: Exclude<PlannerMode, 'select'>): void {
        this.notice.set(null);
        if (this.mode.peek() === mode) {
            this.mode.set('select');
            return;
        }
        // Shot modes deliberately preserve a selected shot: ordinary add-shot
        // makes it the continuation parent; add-alternative places a sibling.
        if (mode !== 'add-shot' && mode !== 'add-alternative') this.selection.set(null);
        if ((mode === 'add-shot' || mode === 'add-alternative')
            && this.selection.peek()?.kind !== 'shot') this.selection.set(null);
        if (mode === 'add-alternative' && !this.selectedShot.peek()) {
            this.notice.set('Select a shot first, then add its alternative.');
            return;
        }
        this.mode.set(mode);
    }

    /** Promote a shot within its sibling option group. */
    async setPrimary(id: string): Promise<void> {
        if (await this.plan.setPrimary(id)) this.refreshStrategy();
    }

    /** Return to the planner's browse/select mode without changing the origin. */
    enterBrowseMode(): void {
        this.notice.set(null);
        this.selection.set(null);
        this.mode.set('select');
    }

    /** Reset the transient origin to the selected tee. */
    resetBrowseFrom(): void {
        this.browseSampleSeq++;
        this.browseInspectionSeq++;
        this.browseOverride.set(null);
        this.browseInspection.set(null);
        this.enterBrowseMode();
    }

    /** Select a ladder rung for readout without changing the current origin. */
    activateBrowseRow(row: BrowseLadderRow): void {
        if (browseTargetActivation('ladder') === 'promote-origin') {
            this.browseFromRow(row);
            return;
        }
        const hole = this.selectedHole.peek();
        if (!hole) return;
        this.browseInspectionSeq++;
        this.enterBrowseMode();
        this.browseInspection.set({ source: 'ladder', holeId: hole.id, rowId: row.id });
    }

    /**
     * Inspect a tapped course shape (bunker / water / green / trees / …):
     * hit-test the lie map at the click point and, on a hit, surface the
     * ring's front/carry window (`inspectedBrowseRow`). Two measuring modes:
     * by default the window is the RAY origin → click extended through the
     * shape (figures land on the shape's own lips); when a browse-to target
     * was being inspected (map point or ladder rung), that point is KEPT and
     * the window projects onto the chosen origin → browse-to line instead.
     * Returns false when the click landed on no tappable shape, so the map
     * handler can fall back to the plain point readout.
     */
    inspectBrowseFeature(position: { lng: number; lat: number }): boolean {
        const hole = this.selectedHole.peek();
        if (!hole) return false;
        const at = lngLatToSweref99tm(position);
        const ring = this.lieMap.peek().ringAt(at, TAPPABLE_KINDS);
        if (!ring) return false;

        // The measuring line's far end: whatever browse-to target is up right
        // now. A previous shape inspection passes its own kept line along, so
        // clicking bunker after bunker stays on the same chosen line.
        const current = this.browseInspection.peek();
        let lineTo: StrategyPoint | null = null;
        if (current?.source === 'map-feature') {
            lineTo = current.lineTo;
        } else if (current) {
            lineTo = this.inspectedBrowseRow.peek()?.position ?? null;
        }

        const seq = ++this.browseInspectionSeq;
        this.enterBrowseMode();
        this.browseInspection.set({
            source: 'map-feature',
            holeId: hole.id,
            id: `map-feature-${seq}`,
            label: ringKindLabel(ring.kind),
            ring,
            at: { ...at },
            lineTo,
        });
        return true;
    }

    /** Select an arbitrary map point for readout without changing the origin. */
    async inspectBrowsePoint(position: { lng: number; lat: number }): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) return;
        const seq = ++this.browseInspectionSeq;
        const id = `map-${seq}`;
        const projected = wgs84ToSweref99tm(position.lat, position.lng);
        this.enterBrowseMode();
        this.browseInspection.set({
            source: 'map',
            holeId: hole.id,
            id,
            position: { ...projected, elevation: null },
        });
        const elevation = await this.elevation.elevationAt(position);
        if (seq !== this.browseInspectionSeq) return;
        const current = this.browseInspection.peek();
        if (current?.source !== 'map' || current.holeId !== hole.id || current.id !== id) return;
        this.browseInspection.set({
            ...current,
            position: { ...current.position, elevation },
        });
    }

    /** Explicitly make the inspected target the next browse origin. */
    promoteInspectedBrowseTarget(): void {
        const row = this.inspectedBrowseRow.peek();
        if (row) this.browseFromRow(row);
    }

    /** Promote a ladder rung into the next arbitrary browse origin. */
    browseFromRow(row: BrowseLadderRow): void {
        const wgs = sweref99tmToWgs84(row.position.x, row.position.y);
        void this.setBrowseFrom({ lng: wgs.lon, lat: wgs.lat }, row.position.elevation ?? null);
    }

    /**
     * Move the transient browse origin immediately, then fill its terrain
     * elevation asynchronously. A sequence token drops a late sample after a
     * newer map/rung tap.
     */
    async setBrowseFrom(
        position: { lng: number; lat: number },
        knownElevation: number | null = null,
    ): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) return;
        const seq = ++this.browseSampleSeq;
        this.browseInspectionSeq++;
        this.enterBrowseMode();
        this.browseInspection.set(null);
        this.browseOverride.set({
            holeId: hole.id,
            lat: position.lat,
            lon: position.lng,
            elevation: knownElevation,
            isOverride: true,
        });
        if (knownElevation !== null) return;
        const elevation = await this.elevation.elevationAt(position);
        if (seq !== this.browseSampleSeq) return;
        const current = this.browseOverride.peek();
        if (!current || current.holeId !== hole.id) return;
        this.browseOverride.set({ ...current, elevation });
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
        const gates = autoGatesForPlan(plan.allLegs, this.lieMap.peek().hazardRings());
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
        const confirmed = await this.confirm.confirm({
            title: `Delete ${label}?`,
            body: `This ${label} will be removed from the hole plan.`,
            confirmLabel: `Delete ${label}`,
            tone: 'danger',
            layout: 'default',
        });
        if (!confirmed) return;
        const ok = sel.kind === 'shot'
            ? await this.plan.removeShot(sel.id, 'splice')
            : await this.plan.removeGate(sel.id);
        if (ok && this.selection.peek() === sel) this.selection.set(null);
    }

    /** Cascade-delete one option and every continuation below it. */
    async deleteOption(id: string): Promise<void> {
        const shot = this.plan.shots.items.peek().find(candidate => candidate.id === id);
        if (!shot) return;
        const confirmed = await this.confirm.confirm({
            title: 'Delete option?',
            body: 'This option and all of its continuation shots will be removed.',
            confirmLabel: 'Delete option',
            tone: 'danger',
            layout: 'default',
        });
        if (!confirmed) return;
        const ok = await this.plan.removeShot(id, 'cascade');
        if (ok && this.selection.peek()?.kind === 'shot' && this.selection.peek()?.id === id) {
            this.selection.set(null);
        }
    }

    // ── Event handling ──────────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.map.interactionMode.peek() === PLANNER_TOOL_ID;
    }

    /**
     * Putt-mode tap while the slope overlay is up: read the interpolated
     * slope under the click (the same tap that places ball/hole — slope at
     * the point you just placed is exactly the read you want). Off-grid taps
     * clear the readout.
     */
    private probePutt(p: { x: number; y: number }): void {
        if (this.puttRead.overlayMode.peek() !== 'slope') return;
        const grid = this.puttRead.grid.peek();
        if (!grid) return;
        if (!this.puttDerivedCache || this.puttDerivedCache.grid !== grid) {
            const slope = computeSlopeGrid(grid);
            this.puttDerivedCache = { grid, slope, stats: computeStats(grid, slope) };
        }
        const probe = sampleSlopeAt(grid, this.puttDerivedCache.slope, p.x, p.y);
        this.puttProbe.set(probe ? { grid, probe } : null);
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.suppressClick) return;

        const mode = this.mode.peek();
        if (mode === 'add-shot' || mode === 'add-alternative') {
            void this.placeShot(e.lngLat);
            return;
        }
        if (mode === 'add-gate') {
            void this.placeGate(e);
            return;
        }
        if (mode === 'putt') {
            // Click places whichever point the "Tap places" selector has
            // active — ball first, then auto-advances to the hole, so both
            // the origin and the target are user-chosen. Clicks on an existing
            // marker never get here (mousedown grabs them for a drag and the
            // synthesized click is swallowed).
            const p = lngLatToSweref99tm(e.lngLat);
            this.puttRead.placeNext(p);
            this.probePutt(p);
            return;
        }

        const hit = this.hitTest(e.point);
        // Putt targets are unreachable here (select mode never offers them).
        if (hit && hit.kind !== 'putt-ball' && hit.kind !== 'putt-hole') {
            this.selection.set({ kind: hit.kind === 'shot' ? 'shot' : 'gate', id: hit.id });
            return;
        }
        // Ghost lines are clickable too — pinning a suggestion from the map is
        // the natural gesture when you are looking at the lines, not the list.
        // After markers (an authored shot always wins the pixel), before the
        // browse fallbacks (a click ON a ghost is never an empty-map click).
        const ghostId = this.variantHitTest(e.point);
        if (ghostId) {
            this.selectVariant(ghostId);
            return;
        }
        // Empty-map clicks inspect a target from the current origin. Moving the
        // origin is a separate, explicit action in the distance readout. A
        // click INSIDE a hazard/green shape inspects that shape (front/carry
        // along the play line) instead of the bare point under the cursor.
        if (browseTargetActivation('map') === 'inspect') {
            if (this.inspectBrowseFeature(e.lngLat)) return;
            void this.inspectBrowsePoint(e.lngLat);
        } else {
            void this.setBrowseFrom(e.lngLat);
        }
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

        // ⌘/Ctrl-drag is the guaranteed pan escape hatch (same convention as
        // the draw tool): never grab a marker, and return WITHOUT
        // preventDefault/dragPan.disable so MapLibre's native dragPan takes
        // the gesture. On a hole dense with markers this is the only drag
        // that reliably pans — a plain drag anywhere near the plan grabs a
        // shot/gate instead.
        if (e.originalEvent.metaKey || e.originalEvent.ctrlKey) return;

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
        // Putt markers are session-local — they carry no selection row.
        if (hit.kind !== 'putt-ball' && hit.kind !== 'putt-hole') {
            this.selection.set({ kind: hit.kind === 'shot' ? 'shot' : 'gate', id: hit.id });
        }
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
        const selected = this.selectedShot.peek();
        const alternative = this.mode.peek() === 'add-alternative';
        const parentShotId = alternative
            ? selected?.parentShotId
            : selected?.id;
        const origin = alternative
            ? this.nodePointForShot(selected?.parentShotId ?? null)
            : selected
                ? { lat: selected.lat, lon: selected.lon, elevation: selected.elevation }
                : this.previousNodePoint();
        const elevation = await this.elevation.elevationAt(lngLat);
        const clubId = this.autoClubForShot(lngLat, elevation, origin);
        const created = await this.plan.addShot(hole.number, {
            lat: lngLat.lat,
            lon: lngLat.lng,
            elevation,
            ...(parentShotId !== undefined ? { parentShotId } : {}),
            ...(clubId ? { clubId } : {}),
        });
        if (created) {
            this.notice.set(null);
            this.selection.set({ kind: 'shot', id: created.id });
            // Alternative placement is one-shot. The new option remains
            // selected and ordinary add-shot stays armed for its continuation.
            if (alternative) this.mode.set('add-shot');
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
    private autoClubForShot(
        lngLat: { lng: number; lat: number },
        elevation: number | null,
        origin: { lat: number; lon: number; elevation: number | null } | null = this.previousNodePoint(),
    ): string | null {
        const clubs = this.orderedClubs.peek();
        if (clubs.length === 0) return null;
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
            target = playsAsM(target, windEffect(wind.speedMps, wind.directionDeg, bearing, target));
        }
        return closestClub(clubs, target)?.id ?? null;
    }

    /**
     * The point a newly-placed shot's leg starts from: the hole's last shot
     * (by sortOrder), or — for the first shot — the origin tee. Null when the
     * hole has no tee.
     */
    private previousNodePoint(): { lat: number; lon: number; elevation: number | null } | null {
        const shots = this.primaryShots.peek();
        const last = shots[shots.length - 1];
        if (last) return { lat: last.lat, lon: last.lon, elevation: last.elevation };
        const tee = this.originTee.peek();
        return tee ? { lat: tee.lat, lon: tee.lon, elevation: tee.elevation } : null;
    }

    /** Resolve a tree parent to its landing point; null is the tee origin. */
    private nodePointForShot(
        shotId: string | null,
    ): { lat: number; lon: number; elevation: number | null } | null {
        if (shotId !== null) {
            const shot = this.plan.shots.items.peek().find(candidate => candidate.id === shotId);
            return shot ? { lat: shot.lat, lon: shot.lon, elevation: shot.elevation } : null;
        }
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
        if (!plan || plan.allLegs.length === 0 || !map) {
            this.notice.set('No legs to attach a gate to — the hole needs a tee/green (and optionally shots) first.');
            return;
        }
        const foot = nearestLegFoot(lngLatToSweref99tm(e.lngLat), plan.allLegs);
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
            directionDeg: plan.allLegs.find(leg => leg.index === foot.legIndex)!.bearingDeg,
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
        // Putt marker drags are LIVE geometry only (marker + reference line
        // follow the cursor); the readPutt integrator NEVER runs per frame —
        // release (`persistDrag`) commits the settled position and recomputes.
        if (target.kind === 'putt-ball') {
            this.puttRead.dragBall(lngLatToSweref99tm(e.lngLat));
            return;
        }
        if (target.kind === 'putt-hole') {
            this.puttRead.dragHole(lngLatToSweref99tm(e.lngLat));
            return;
        }
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
        if (target.kind === 'putt-ball' || target.kind === 'putt-hole') {
            // Session-local (nothing persisted) — drag-release recompute only.
            this.puttRead.commit();
            return;
        }
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

        // Putt markers first (only meaningful in putt mode; rendered on top).
        // Hit-testing happens on mousedown/click only — never per mouse-move —
        // so the terrain-aware map.project cost (~40 µs/call) is fine here,
        // matching the existing shot/gate hit path.
        if (this.mode.peek() === 'putt') {
            const ball = this.puttRead.ball.peek();
            if (ball) {
                const p = sweref99tmToWgs84(ball.x, ball.y);
                consider({ kind: 'putt-ball' }, p.lat, p.lon);
            }
            const hole = this.puttRead.hole.peek();
            if (hole) {
                const p = sweref99tmToWgs84(hole.x, hole.y);
                consider({ kind: 'putt-hole' }, p.lat, p.lon);
            }
        }

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

    /**
     * The ghost line under the cursor, or null. Same click-only cost profile as
     * `hitTest` (terrain-aware project is ~40 µs/call, never on mouse-move),
     * and a no-op the moment there are no ghosts — the common case.
     */
    private variantHitTest(screen: { x: number; y: number }): string | null {
        const ghosts = this.sim.variants.peek();
        if (ghosts.length === 0) return null;
        const map = this.map.map.peek();
        if (!map) return null;
        let best: string | null = null;
        let bestDist = VARIANT_LINE_HIT_PX;
        for (const ghost of ghosts) {
            const points = ghost.variant.nodes.map(node => {
                const { lat, lon } = sweref99tmToWgs84(node.point.x, node.point.y);
                return map.project([lon, lat]);
            });
            for (let i = 1; i < points.length; i++) {
                const d = pointToSegmentPx(screen, points[i - 1], points[i]);
                if (d < bestDist) { bestDist = d; best = ghost.id; }
            }
        }
        return best;
    }
}

/**
 * Vertex centroid of a feature ring's anchor points (EPSG:3006) — the
 * last-resort default hole position when a hole has a drawn green but no
 * furniture green row (no centre) and no active pin. Coarse but on the green.
 */
function ringCentroid(points: readonly { x: number; y: number }[]): Vec2 {
    if (points.length === 0) return { x: 0, y: 0 };
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
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
