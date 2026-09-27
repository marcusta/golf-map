import { Signal, Computed, effect, untrack, batch, di } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent, FilterSpecification, LngLat } from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent, OverlayLayerSpec } from '../map/map.service';
import { ConfirmService } from '../app/confirm-dialog.component';
import { ZoneTypesService, zoneTypeKeyOf } from '../zones/zone-types.service';
import { geometryToWgs84Rings, attributesPatchOf, sameScope, scopeOf, type FeatureAttributesPatch, type FeaturesService, type StackScope } from './features.service';
import { ROUGHS_LAYER, isRoughsLayerType, type FeatureLayer } from '../../../shared/render/stack-key';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { lngLatToSweref99tm, sweref99tmToWgs84 } from '../geo/transform';
import {
    flattenOpenPath,
    flattenRing,
    nearestOnRing,
    pointInGeometry,
    type AnchorPoint,
    type CurveType,
    type FeatureGeometry,
    type Point,
} from '../geo/bezier';
import { bsplineRingToBezierWithMap } from '../geo/bspline';
import { fitClosedBspline } from '../geo/spline-fit';
import {
    DRAWN_CORNER_TURN_DEG,
    autoCorners,
    centerlineGeometry,
    flattenCenterline,
    nearestOnCenterline,
} from '../../../shared/features/centerline';
import { PATH_SURFACE_ATTRIBUTE, isPathSurface, type PathSurface } from '../../../shared/features/path-surface';
import { takesBankVeg } from '../../../shared/features/creek-vegetation';
import { isGeneratedFeature } from './generated-features';
import {
    DrawState,
    MIN_RING_POINTS,
    TraceGesture,
    moveAnchor,
    moveHandle,
    setSymmetricHandles,
    clearHandles,
    hasHandles,
    deleteAnchor,
    insertAnchor,
    insertControlPoint,
    toggleVertexCorner,
    isCornerVertex,
    bakeBsplineToBezier,
    translateGeometry,
    offsetGeometry,
    mergedSurroundGeometries,
    simplifyGeometry,
    deleteVertices,
    insertBetweenVertices,
    applyVertexEdit,
    rdpSimplify,
    editViewOf,
    fromEditView,
    minVertexCount,
    withCenterlineWidth,
    featuresInRect,
    verticesInRect,
    rectFromCorners,
    vertexKey,
    parseVertexKey,
} from './draw-state';
import { EditHistory, snapshotOf, type HistoryEntry } from './history';
import { CAT, MARKER_FILL, OVERLAY_TEXT, STATUS_RISK } from '../map/map-palette';
import {
    DIGIT_FEATURE_TYPES,
    DRAW_FILL_OPACITY,
    FEATURE_TYPES,
    OUTLINE_ONLY_TYPES,
    RULES_TYPES,
    SELECTION_COLOR,
    SURROUND_PAIRINGS,
    VEGETATION_TYPES,
    isRulesType,
    isVegetationType,
    typeColorExpression,
    type FeatureType,
} from './feature-palette';

/**
 * Cached WGS84 lng/lat for a feature's anchor points + bezier handles, so the
 * hover hit-test doesn't re-run the (heavy inverse-TM) datum transform for
 * every vertex on every mouse-move. Keyed on geometry identity — geometry is
 * replaced wholesale on edit (see features.service), so the WeakMap collects
 * stale entries and the cache is never stale.
 */
interface RingLngLat {
    anchor: Position[];
    hIn: (Position | null)[];
    hOut: (Position | null)[];
}
const vertexLngLatCache = new WeakMap<FeatureGeometry, RingLngLat[]>();

function vertexLngLatFor(geometry: FeatureGeometry): RingLngLat[] {
    const cached = vertexLngLatCache.get(geometry);
    if (cached) return cached;
    const ll = (p: Point): Position => {
        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
        return [lon, lat];
    };
    const rings = geometry.rings.map(ring => ({
        anchor: ring.points.map(ll),
        hIn: ring.points.map(p => (p.hIn ? ll(p.hIn) : null)),
        hOut: ring.points.map(p => (p.hOut ? ll(p.hOut) : null)),
    }));
    vertexLngLatCache.set(geometry, rings);
    return rings;
}

/** Interaction-claim id AND overlay id prefix for the draw tool. */
export const DRAW_TOOL_ID = 'draw';
/** Preview overlay (draft line, vertex + bezier-handle markers). */
export const DRAW_OVERLAY_ID = 'draw';

// Screen-space hit tolerances (px)
const VERTEX_HIT_PX = 9;
const HANDLE_HIT_PX = 7;
const EDGE_HIT_PX = 6;
/** Screen-px reach of a boundary-only line (OOB) for selecting and grabbing it. */
const RULE_LINE_HIT_PX = 8;
const CLOSE_RING_PX = 12;
const DRAG_MOVE_THRESHOLD_PX = 3;
/** Feature-move drag: movement registers past this (prototype: 2 px). */
const MOVE_THRESHOLD_PX = 2;
/** Marquee: below this the gesture counts as a click (prototype: 5 px). */
const MARQUEE_MIN_PX = 5;
/**
 * Draw mode: a press that travels this far is no longer a MapLibre click
 * (its default clickTolerance), so the tool places the point itself.
 */
const PLACE_CLICK_TOLERANCE_PX = 3;
/**
 * Hover hit-tests on shapes up to this many vertices use terrain-precise
 * projection (~40 us/vertex); larger shapes hover on the flat transform.
 */
const PRECISE_HOVER_MAX_VERTICES = 150;

// New-shape type policy persistence (survives reloads; per browser).
const TYPE_FOLLOWS_LAST_KEY = 'golfmap.draw.typeFollowsLast';
const DEFAULT_TYPE_KEY = 'golfmap.draw.defaultType';
const PATH_WIDTH_KEY = 'golfmap.draw.pathWidthM';
const PATH_SURFACE_KEY = 'golfmap.draw.pathSurface';
/** A cart path: two carts can't pass, one plus a walker can. */
const DEFAULT_PATH_WIDTH_M = 2.5;

/** The surface new paths get ('' = unknown); a cart path is asphalt more often than not. */
function readPathSurface(): PathSurface | '' {
    const stored = storedPref(PATH_SURFACE_KEY);
    if (stored === null) return 'asphalt';
    return isPathSurface(stored) ? stored : '';
}

function readPathWidth(): number {
    const stored = Number(storedPref(PATH_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_PATH_WIDTH_M;
}

/** Safe localStorage read (privacy mode / embedded contexts can throw). */
function storedPref(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function storePref(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Best-effort — the in-memory signal still holds for the session.
    }
}
/** Cmd/Ctrl+D clone offset in EPSG:3006 meters (prototype: 10 units). */
export const DUPLICATE_OFFSET_M = 10;
/** Expand/contract preset distances in meters (prototype table). */
export const OFFSET_PRESETS = [0.5, 1, 2, 5] as const;
/**
 * Freehand-trace fit tolerance in meters (T40): the fitted b-spline stays
 * within this of the traced stroke (control count adapts 8 → 20).
 */
export const TRACE_TOLERANCE_M = 0.75;
/**
 * Path (centerline + width): a clicked bend turning at least this much is a
 * corner of the line (straight in, straight out); gentler bends stay smooth.
 */
export const PATH_CORNER_TURN_DEG = DRAWN_CORNER_TURN_DEG;
/**
 * Freehand path trace: the stroke is thinned to the points within this of it
 * (m); the curve through them smooths the hand's wobble away.
 */
export const PATH_TRACE_TOLERANCE_M = 0.5;

/**
 * The geometry a path draft commits as: the clicked centerline — Shift-clicked
 * points and bends of PATH_CORNER_TURN_DEG or more are corners — at `widthM`,
 * its corridor derived. Null for fewer than two distinct points or an
 * unusable width. Pure — exported for tests.
 */
export function draftCenterlineGeometry(points: AnchorPoint[], widthM: number): FeatureGeometry | null {
    return centerlineGeometry('EPSG:3006', { points: autoCorners(points, PATH_CORNER_TURN_DEG), widthM });
}

interface DragTarget {
    kind: 'anchor' | 'handle' | 'newHandles';
    which?: 'hIn' | 'hOut';
    featureId: string;
    /** Feature type at drag start (ghost overlay palette color). */
    featureType: string;
    ringIdx: number;
    idx: number;
    alt: boolean;
    hadHandles: boolean;
    startScreen: { x: number; y: number };
    /** Geometry before the drag — the history entry's `before` side. */
    startGeometry: FeatureGeometry;
    startVersion: number;
    moved: boolean;
    /**
     * Latest edited geometry (per-frame). Lives on the drag — the store is
     * NOT patched per frame (a store write rebuilds + re-sends the whole
     * course FeatureCollection to the MapLibre worker, ~250 ms for a full
     * course). Committed through the normal funnel on mouseup.
     */
    currentGeometry: FeatureGeometry | null;
}

/** Whole-feature move drag (all selected features translate together). */
interface MoveDrag {
    startEpsg: Point;
    startScreen: { x: number; y: number };
    features: Array<{ id: string; geometry: FeatureGeometry; type: string; holeId: string | null; version: number }>;
    moved: boolean;
    /** Cumulative EPSG:3006 translation of the drag so far. */
    dx: number;
    dy: number;
}

/** A dragged feature's live copy, rendered in the preview overlay. */
interface GhostFeature {
    id: string;
    type: string;
    geometry: FeatureGeometry;
}

/** A source feature captured for cloning (Alt-duplicate-drag / repeat stamp). */
interface StampSource {
    /** Original feature id — the ghost borrows its stackKey for z-order. */
    id: string;
    type: string;
    holeId: string | null;
    /** Carried so a stamped Roughs-layer shape stays in the Roughs layer. */
    layer: FeatureLayer;
    geometry: FeatureGeometry;
    /** Carried so a stamped vegetation zone keeps its zone type (null otherwise). */
    attributes?: FeatureAttributesPatch | null;
}

/**
 * Alt-duplicate-drag or repeat-stamp gesture (T42). Both create clones on
 * drop; they differ only in the reference point the translation is measured
 * from and in what a sub-threshold press means:
 * - `duplicate`: Alt+press inside the selection. `refEpsg` is the grab point;
 *   a sub-threshold drag decays to the Alt-cycle click (no clone).
 * - `stamp`: press on empty ground while stamp mode is armed. `refEpsg` is the
 *   template anchor (the previous drop point) so the copy sits under the
 *   cursor immediately; every drop — even a click — stamps a copy.
 */
interface StampDrag {
    kind: 'duplicate' | 'stamp';
    refEpsg: Point;
    startScreen: { x: number; y: number };
    sources: StampSource[];
    moved: boolean;
    /** Cumulative EPSG:3006 translation from `refEpsg` (drives the ghost). */
    dx: number;
    dy: number;
}

/**
 * Armed repeat-stamp template (set after an Alt-duplicate-drag drop). Each
 * subsequent empty-ground drag stamps another copy of `templates`, grabbed at
 * the same relative point (`anchor`, the previous drop point). Cleared on Esc,
 * tool deactivate, or arming a draw.
 */
interface StampTemplate {
    anchor: Point;
    templates: StampSource[];
}

/**
 * History entry for committing a whole-selection move: each feature's
 * pre-drag snapshot vs its snapshot translated by the drag total (dx, dy)
 * in EPSG:3006 meters. Pure — exported for tests.
 */
export function buildMoveEntry(
    features: MoveDrag['features'],
    dx: number,
    dy: number,
): HistoryEntry {
    return features.map(f => ({
        featureId: f.id,
        before: { geometry: f.geometry, type: f.type, holeId: f.holeId },
        after: { geometry: translateGeometry(f.geometry, dx, dy), type: f.type, holeId: f.holeId },
        beforeVersion: f.version,
    }));
}

/** Marquee rectangle drag ('features' on empty ground, 'vertices' via Shift). */
interface Marquee {
    kind: 'features' | 'vertices';
    start: Point;
    current: Point;
    startScreen: { x: number; y: number };
}

/**
 * Course-feature drawing/editing interactions. Registered as the `draw`
 * EditorTool (see draw-tool.ts); DrawPanelComponent shares this DI
 * singleton for its UI state.
 *
 * Modes (see DrawState):
 * - select (default): click a feature to select it; Cmd/Ctrl+click toggles
 *   multi-select membership; drag on empty ground draws a marquee (features
 *   fully inside select; Alt during the drag = any-overlap mode); drag
 *   INSIDE a selected feature moves the whole selection (2 px threshold,
 *   one undo step). With exactly ONE feature selected its vertices are
 *   editable: drag to move, right-click to delete, click an edge to
 *   insert, 'C' toggles smooth↔corner, Shift+click toggles a vertex into
 *   the multi-vertex selection, Shift+drag marquee-selects vertices,
 *   Delete removes selected vertices (≥3 must remain), 'I' inserts a
 *   vertex between two selected ones with even redistribution. On BEZIER
 *   features additionally: alt-drag pulls out symmetric handles, alt-click
 *   straightens, handle dots bend segments. Delete/Backspace deletes the
 *   selected feature(s) (confirm). Cmd/Ctrl+D duplicates (+10 m offset).
 *   Alt+drag INSIDE the selection clones it in one gesture (a stationary
 *   Alt-click still cycles the hit stack); the drop arms repeat-stamp mode,
 *   where each empty-ground drag stamps another copy (one undo per stamp)
 *   until Esc, deactivate, or arming a draw.
 *   Cmd/Ctrl+Z / Shift+Z / Y = undo / redo (snapshot history, autosaved).
 * - draw (N or panel button): click to place B-SPLINE control points
 *   (Shift+click = sharp corner), Enter / click-on-first to close,
 *   Cmd/Ctrl+Z removes the last placed point (first point cancels). ESC
 *   cancels. Double-click is swallowed as an accidental duplicate point, not
 *   as a close gesture. Press-DRAG (fresh shape, empty draft) freehand-
 *   traces instead: the stroke is sampled, least-squares fitted to a
 *   ~8-20-control closed b-spline (geo/spline-fit.ts, TRACE_TOLERANCE_M)
 *   and committed through the same closeDraft funnel — a sub-threshold
 *   drag decays to the plain click. Middle-button (and ⌘-drag) still pans;
 *   once click-placement has begun, every left press places a point (even
 *   one that slips mid-click) — pan with middle-button (or ⌘-drag).
 */
/**
 * Visible features containing `p`, preserving the given topmost-first stack
 * order (D23). The one hit rule the draw tool shares with render / lie: pass
 * `FeaturesService.stackTopDown`, the hidden-type set, and the EPSG:3006
 * point; `hitFeature` is the first element, `hitStack` the whole list.
 * Pure + exported for tests (the tool itself is map-coupled).
 */
export function containingTopDown(
    stackTopDown: readonly CourseFeature[],
    hidden: ReadonlySet<string>,
    p: Point,
    hiddenIds: ReadonlySet<string> = EMPTY_ID_SET,
    hiddenSources: ReadonlySet<string> = EMPTY_ID_SET,
): CourseFeature[] {
    return stackTopDown.filter(f =>
        !hidden.has(f.type) && !hiddenIds.has(f.id)
        && !(f.source !== null && hiddenSources.has(f.source))
        && pointInGeometry(p, f.geometry));
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

/**
 * The feature types hit testing must walk PAST right now: the ones the user
 * has hidden, plus every outline-only type (OOB) that is not the armed draw
 * type.
 *
 * An outline-only type is painted as a boundary line, not a fill, and OOB in
 * particular is drawn as one ring around the whole property — so its interior
 * is the entire course. Treating that interior as clickable makes the OOB ring
 * answer every click and swallow every marquee drag, hiding everything under
 * it. Arming OOB in the feature-type picker is the deliberate "I mean this
 * one" gesture that makes its ring selectable again.
 *
 * Pure + exported for tests.
 */
export function unhittableTypes(hidden: ReadonlySet<string>, armedType: string): ReadonlySet<string> {
    const skipped = [...OUTLINE_ONLY_TYPES].filter(type => type !== armedType);
    if (skipped.every(type => hidden.has(type))) return hidden;
    return new Set([...hidden, ...skipped]);
}

/**
 * Next Alt/Option+click cycle state (D27). Same stack as last time → step one
 * deeper, wrapping at the bottom; a different stack (or no prior cycle) → the
 * topmost (index 0). Pure + exported for tests.
 */
export function advanceAltCycle(
    prev: { ids: string[]; index: number } | null,
    ids: string[],
): { ids: string[]; index: number } {
    const same = prev !== null
        && prev.ids.length === ids.length
        && prev.ids.every((id, i) => id === ids[i]);
    return { ids, index: same ? (prev!.index + 1) % ids.length : 0 };
}

/** One auto-surround source (or intermediate ring the chain walks from). */
export interface SurroundSource {
    type: FeatureType;
    holeId: string | null;
    geometry: FeatureGeometry;
}

/**
 * Pure auto-surround planner (T41). Each pass applies one level of
 * SURROUND_PAIRINGS to `current`: sources sharing a target type merge into
 * ONE surround (`mergedSurroundGeometries` — union → offset →
 * straight-segment rings; one output per disjoint polygon of the union),
 * lone sources expand via `offset` (default `offsetGeometry`, injectable
 * for tests). `holeId` = the group's common source holeId, else null. With
 * `chain` the walk repeats on each level's OUTPUT until the pairings are
 * exhausted (e.g. green → fairway(+0.5) → semi_rough(+1) → rough(+5) →
 * deep_rough(+8)); chain + merge compose because merging happens per ring
 * level. A step whose offset collapses (null / empty merge) truncates that
 * branch — earlier rings are kept. Returns the creates in walk order.
 */
export function planSurrounds(
    sources: SurroundSource[],
    chain: boolean,
    offset: (geometry: FeatureGeometry, distance: number) => FeatureGeometry | null = offsetGeometry,
): SurroundSource[] {
    const creates: SurroundSource[] = [];
    let current = sources;
    do {
        const jobs = current
            .map(s => ({ source: s, pairing: SURROUND_PAIRINGS[s.type] ?? null }))
            .filter((j): j is { source: SurroundSource; pairing: { targetType: FeatureType; expandAmount: number } } => j.pairing !== null);
        if (jobs.length === 0) break;
        const groups = new Map<FeatureType, typeof jobs>();
        for (const j of jobs) {
            const group = groups.get(j.pairing.targetType);
            if (group) group.push(j);
            else groups.set(j.pairing.targetType, [j]);
        }
        const next: SurroundSource[] = [];
        for (const [targetType, group] of groups) {
            const holeId = new Set(group.map(j => j.source.holeId)).size === 1
                ? group[0].source.holeId
                : null;
            const geometries: FeatureGeometry[] = [];
            if (group.length === 1) {
                const expanded = offset(group[0].source.geometry, group[0].pairing.expandAmount);
                if (expanded) geometries.push(expanded);
            } else {
                // Mixed expand amounts inside one group (tee +0.5 and
                // fairway +1 both target semi_rough) take the group max.
                const amount = Math.max(...group.map(j => j.pairing.expandAmount));
                geometries.push(...mergedSurroundGeometries(group.map(j => j.source.geometry), amount));
            }
            for (const geometry of geometries) {
                const created = { type: targetType, holeId, geometry };
                creates.push(created);
                next.push(created);
            }
        }
        current = next;
    } while (chain);
    return creates;
}

/**
 * What the draw engine edits. `surfaces` is Draw mode: every type but the
 * rules lines and the vegetation zones, which are hidden there. `rules` is
 * the same engine run by the Furniture tool for the penalty areas and OOB
 * only (RULES_TYPES): nothing else is hit or created, the map stays in nice
 * rendering, clicks on the furniture markers are left to the Furniture tool.
 * `vegetation` is Vegetation mode: the zones only (VEGETATION_TYPES), drawn
 * over the course shown as an outline backdrop. Each scope has its own undo
 * history.
 */
export type DrawScope = 'surfaces' | 'rules' | 'vegetation';

/** True when `type` is edited in `scope` (see `DrawScope`). Pure + exported for tests. */
export function scopeOwnsType(scope: DrawScope, type: string): boolean {
    if (scope === 'rules') return isRulesType(type);
    if (scope === 'vegetation') return isVegetationType(type);
    return !isRulesType(type) && !isVegetationType(type);
}

/**
 * Whether a click in `scope` may select a `type` feature: the scope's own
 * types, plus in Vegetation mode the creeks and water, selected there only to
 * set their bank vegetation (they stay backdrop: read-only, see
 * `FeaturesService.editableSelected`). Pure + exported for tests.
 */
export function scopeSelectsType(scope: DrawScope, type: string): boolean {
    return scopeOwnsType(scope, type) || (scope === 'vegetation' && takesBankVeg(type));
}

/**
 * Vegetation mode's hit order over a topmost-first stack: hand-drawn zones,
 * then the creeks and water, then generated zones (the generated creek-bank
 * zones lie over the water they were planted from; a click there means the
 * water). Stable within each group. Pure + exported for tests.
 */
export function vegetationHitOrder(stackTopDown: readonly CourseFeature[]): CourseFeature[] {
    const rank = (f: CourseFeature) => takesBankVeg(f.type) ? 1 : isGeneratedFeature(f) ? 2 : 0;
    return stackTopDown.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(x => x.f);
}

/** Draw's own types: the course features. */
const SURFACE_TYPES: readonly FeatureType[] = FEATURE_TYPES.filter(type => scopeOwnsType('surfaces', type));

/** How a host tool other than Draw runs the engine (see `DrawScope`). */
export interface DrawActivation {
    scope: DrawScope;
    /** The host tool's id: the interaction mode the engine answers to. */
    toolId: string;
    /** True when a select-mode press/click at this screen point belongs to the host (a marker under it, a placement armed). */
    yieldTo?: (screen: { x: number; y: number }) => boolean;
}

export class DrawToolService {
    private confirm = di.get(ConfirmService);
    /** The course's zone-type legend — defaults for a zone this tool creates or retypes into. */
    private zoneTypes = di.get(ZoneTypesService);
    readonly state = new DrawState();
    /** What the engine edits right now (see `DrawScope`); `surfaces` whenever it is not running for Furniture. */
    readonly scope = new Signal<DrawScope>('surfaces');
    private readonly histories: Record<DrawScope, EditHistory> = {
        surfaces: new EditHistory(),
        rules: new EditHistory(),
        vegetation: new EditHistory(),
    };
    /** Snapshot-based undo/redo of committed edits (see history.ts), one per scope. */
    get history(): EditHistory {
        return this.histories[this.scope.get()];
    }
    /** The interaction mode the engine answers to (Draw's own, or the host tool's). */
    private hostToolId = DRAW_TOOL_ID;
    private yieldTo: DrawActivation['yieldTo'] | null = null;
    /** Draw mode's type, kept while another scope borrows `drawType`. */
    private surfacesDrawType: FeatureType | null = null;
    /**
     * Zone type (a key of the course's zone-type table) for the next drawn
     * vegetation zone; '' = the table's first. Set by the Vegetation mode's
     * zone-type picker.
     */
    readonly drawZoneType = new Signal<string>('');
    /** Feature type used for the next created polygon. */
    readonly drawType = new Signal<FeatureType>('bunker');
    /**
     * New-shape type policy: true (default) = the next armed shape keeps the
     * last-used type (chain-draw feel), false = every arm resets `drawType`
     * to `defaultDrawType`. Persisted per browser; set via the feature-type
     * dropdown's footer.
     */
    readonly typeFollowsLast = new Signal<boolean>(storedPref(TYPE_FOLLOWS_LAST_KEY) !== '0');
    /** The type new shapes reset to when `typeFollowsLast` is off. Persisted. */
    readonly defaultDrawType = new Signal<FeatureType>(
        (SURFACE_TYPES as readonly string[]).includes(storedPref(DEFAULT_TYPE_KEY) ?? '')
            ? storedPref(DEFAULT_TYPE_KEY) as FeatureType
            : 'bunker');

    /** Set + persist the new-shape type policy. */
    setTypeFollowsLast(follows: boolean): void {
        this.typeFollowsLast.set(follows);
        storePref(TYPE_FOLLOWS_LAST_KEY, follows ? '1' : '0');
        if (!follows) this.drawType.set(this.defaultDrawType.peek());
    }

    /** Set + persist the default new-shape type (applies immediately when armed). */
    setDefaultDrawType(type: FeatureType): void {
        this.defaultDrawType.set(type);
        storePref(DEFAULT_TYPE_KEY, type);
        if (!this.typeFollowsLast.peek()) this.drawType.set(type);
    }

    /**
     * Arm polygon drawing, applying the new-shape type policy first. All UI
     * arm paths ('N', the command bar's + toggle) go through here.
     */
    armDraw(): void {
        this.pathMode.set(false);
        if (this.scope.peek() === 'surfaces' && !this.typeFollowsLast.peek()) this.drawType.set(this.defaultDrawType.peek());
        this.state.arm();
    }

    /** Rules scope: arm a new penalty area / OOB line of `type`. */
    armRules(type: FeatureType): void {
        if (this.scope.peek() !== 'rules' || !isRulesType(type)) return;
        this.drawType.set(type);
        this.pathMode.set(false);
        this.state.arm();
    }
    /**
     * Path drawing (cart paths, T-roads): while armed, the draft is a
     * CENTERLINE — the clicks run down the middle of the path — and Enter
     * commits it as the corridor `pathWidthM` wide (a closed spline feature
     * of type `path`, like any other shape), instead of closing a ring.
     * Committing leaves drawing mode like any close; 'N' / the + button arm
     * a plain polygon again.
     */
    readonly pathMode = new Signal(false);
    /** Total path width in metres for the next committed path. Persisted. */
    readonly pathWidthM = new Signal<number>(readPathWidth());
    /** Surface every newly drawn `path` gets (attributes.surface); '' leaves it unknown. */
    readonly pathSurface = new Signal<PathSurface | ''>(readPathSurface());

    /**
     * Arm centerline drawing: the next Enter commits the draft as a
     * centerline feature — a `path`, or a creek when Creek is the chosen draw
     * type (its line is what the creek digs and the R.A.M. export follow).
     */
    armPath(): void {
        if (this.drawType.peek() !== 'water_creek') this.drawType.set('path');
        this.pathMode.set(true);
        this.state.arm();
    }

    /** Set + persist the surface new paths get ('' = unknown). */
    setPathSurface(surface: PathSurface | ''): void {
        if (surface !== '' && !isPathSurface(surface)) return;
        this.pathSurface.set(surface);
        storePref(PATH_SURFACE_KEY, surface);
    }

    /** Set + persist the path width (metres, > 0). */
    setPathWidthM(widthM: number): void {
        if (!Number.isFinite(widthM) || widthM <= 0) return;
        this.pathWidthM.set(widthM);
        storePref(PATH_WIDTH_KEY, String(widthM));
    }

    /** Hole assignment for the next created polygon (null = course level). */
    readonly drawHoleId = new Signal<string | null>(null);
    /**
     * Vertex under the cursor on the selected feature (select mode) — the
     * target for the 'C' smooth↔corner toggle. Sticky until the cursor
     * hits another vertex or the selection changes.
     */
    readonly hoverVertex = new Signal<{ ringIdx: number; idx: number } | null>(null);
    /**
     * Multi-vertex selection on the single selected feature (vertexKey
     * strings) — target of bulk vertex delete / 'I' insert-between.
     */
    readonly vertexSelection = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Armed expand/contract distance in meters (positive = expand), or
     * null. While armed the offset result renders as a dashed preview;
     * `applyOffset` commits it as one history entry.
     */
    readonly offsetDistance = new Signal<number | null>(null);
    /** True while the RDP-simplify preview is armed (panel action). */
    readonly simplifyActive = new Signal(false);
    /** RDP epsilon in meters (panel slider; prototype default 0.5). */
    readonly simplifyEpsilon = new Signal(0.5);
    /** One-line guard/action feedback for the panel (cleared on next op). */
    readonly actionNotice = new Signal<string | null>(null);

    /** Live cursor position while drawing (rubber-band preview). */
    private cursor = new Signal<{ lng: number; lat: number } | null>(null);
    /** Active marquee rectangle (reactive — drives the preview overlay). */
    private marquee = new Signal<Marquee | null>(null);
    /**
     * Live copies of the feature(s) being dragged, rendered as fill +
     * outline in the (small) preview overlay while the originals are
     * hidden via feature-state (features.setDragging). Per-frame drag
     * cost is therefore proportional to the DRAGGED features only — the
     * store, the derived course FeatureCollection and the main overlay
     * source are untouched until the mouseup commit.
     */
    private dragGhost = new Signal<GhostFeature[] | null>(null);
    /**
     * Space held down (reactive — drives the cursor + the momentary box-select
     * override). While true, a left-drag rubber-bands features even off a
     * shape, exactly like the sticky `state.boxSelect` mode but without
     * toggling. Tracked on window keydown/keyup for the tool's active span.
     */
    private spaceHeld = new Signal(false);
    private ctx: ToolContext | null = null;
    private features: FeaturesService | null = null;
    private drag: DragTarget | null = null;
    private moveDrag: MoveDrag | null = null;
    /** Active Alt-duplicate-drag / repeat-stamp gesture (T42). */
    private stampDrag: StampDrag | null = null;
    /** Active freehand press-drag trace while armed (T40), or null. */
    private traceGesture: TraceGesture | null = null;
    /**
     * The live trace stroke for the preview overlay (EPSG:3006). Mirrors
     * `traceGesture.points` but only updates when a sample is KEPT, so the
     * preview re-renders at trace-sample granularity, not every mousemove.
     */
    private trace = new Signal<Point[] | null>(null);
    /**
     * Claimed left-press while placing points (non-empty draft): the press
     * always places a point, even when the mouse slips past the click
     * tolerance mid-click (onMouseUp places it at the press location).
     */
    private placePress: { startScreen: { x: number; y: number }; lngLat: LngLat; shift: boolean } | null = null;
    /** Armed repeat-stamp template, or null when stamp mode is inactive. */
    private stampMode: StampTemplate | null = null;
    private suppressClick = false;
    private previewAdded = false;

    /**
     * Alt/Option+click cycle state (D27): repeated alt-clicks at the same
     * point step DOWN the hit stack, wrapping. `ids` is the stack under the
     * cursor at cycle start (topmost-first); `index` is the currently
     * selected depth. Reset imperatively on a plain/meta click — NOT via a
     * reactive effect on the selection, which would cascade off our own
     * alt-select and clear the cycle every step (the reactive-cascade
     * gotcha). Deliberately NOT reset on pointer-move: the pointer always
     * jitters a pixel between two physical clicks (trackpads especially),
     * which would make the cycle unable to advance. Moving to a spot whose
     * hit stack differs resets naturally via `advanceAltCycle`'s ids
     * comparison (Inkscape behaves the same way).
     */
    private altCycle: { ids: string[]; index: number } | null = null;

    /**
     * The armed offset/simplify result for the selected feature (dashed
     * preview + the geometry `applyOffset`/`applySimplify` commit). Null
     * when nothing is armed or the guard rejects the offset.
     */
    readonly opPreviewGeometry = new Computed<FeatureGeometry | null>(() => {
        // Read ALL signal deps unconditionally: Computed evaluates eagerly
        // at construction (before `features` is injected via attach) and
        // only re-runs on registered deps — a short-circuit here would
        // freeze it at null forever.
        const distance = this.offsetDistance.get();
        const simplifyActive = this.simplifyActive.get();
        const epsilon = this.simplifyEpsilon.get();
        const selected = this.features?.editableSelected.get() ?? null;
        if (!selected) return null;
        if (distance !== null) return offsetGeometry(selected.geometry, distance);
        if (simplifyActive) return simplifyGeometry(selected.geometry, epsilon);
        return null;
    });

    // ── EditorTool lifecycle (called via draw-tool.ts) ────────────────────

    /**
     * Canvas mount: bind to the feature store and reset edit history.
     *
     * The feature LOAD + map overlay do NOT live here: they are the /course
     * page's content in every server mode (the green-analysis tool hit-tests
     * the same stack), and this tool is builder-only, so the toolbar owns
     * them (editor/toolbar.component.ts).
     */
    attach(ctx: ToolContext): void {
        this.features = ctx.features;
        for (const history of Object.values(this.histories)) {
            history.clear();
            history.notice.set(null);
        }

        // Any failed save (optimistic-version conflict, network error)
        // re-syncs the store from the server — recorded diffs may no
        // longer match reality, so drop the history and tell the user.
        ctx.track(effect(() => {
            const err = ctx.features.saveError.get();
            if (!err) return;
            untrack(() => {
                for (const history of Object.values(this.histories)) {
                    if (history.canUndo.peek() || history.canRedo.peek()) {
                        history.clear();
                        history.notice.set('Edit history dropped after a failed save — re-synced from server.');
                    }
                }
            });
        }));
    }

    activate(ctx: ToolContext, host?: DrawActivation): void {
        this.ctx = ctx;
        this.features = ctx.features;
        const scope = host?.scope ?? 'surfaces';
        this.scope.set(scope);
        this.hostToolId = host?.toolId ?? DRAW_TOOL_ID;
        this.yieldTo = host?.yieldTo ?? null;
        if (scope === 'rules') {
            // Furniture keeps its photo-blended view; the penalty lines keep
            // their stroke so there is something to click and edit.
            ctx.features.rulesOutlines.set(true);
            this.surfacesDrawType = this.drawType.peek();
            if (!isRulesType(this.drawType.peek())) this.drawType.set(RULES_TYPES[0]!);
        } else if (scope === 'vegetation') {
            // The zones in Draw's palette over the course as an outline
            // backdrop: its edges stay readable, but nothing there is hit.
            ctx.features.niceRendering.set(false);
            ctx.features.modeHiddenTypes.set(new Set(RULES_TYPES));
            ctx.features.modeBackdropTypes.set(new Set(SURFACE_TYPES));
            this.surfacesDrawType = this.drawType.peek();
            this.drawType.set(VEGETATION_TYPES[0]!);
        } else {
            // Draw means the whole active tool span, not only a currently armed
            // polygon. Its high-contrast vector palette makes existing surfaces
            // legible before the first tracing click.
            ctx.features.niceRendering.set(false);
            // The rules lines belong to Furniture, the zones to Vegetation.
            ctx.features.modeHiddenTypes.set(new Set([...RULES_TYPES, ...VEGETATION_TYPES]));
            if (!scopeOwnsType('surfaces', this.drawType.peek())) this.drawType.set(this.defaultDrawType.peek());
        }
        // QA hook (same pattern as MapService's window.__map): expose the
        // instance for scripted/visual verification tooling. Not public API.
        (window as unknown as Record<string, unknown>).__drawTool = this;

        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

        // Space-release ends the momentary box-select override. Bound
        // separately (keydown is routed through onKeyDown's claim/input
        // guards); the release must always fire so the flag never sticks.
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === ' ' || e.code === 'Space') this.spaceHeld.set(false);
        };
        window.addEventListener('keyup', onKeyUp);
        ctx.track(() => window.removeEventListener('keyup', onKeyUp));

        // Focus loss mid-hold (⌘Tab, devtools, macOS overlays) eats the
        // keyup — without this the flag latches and EVERY subsequent drag
        // becomes a marquee until reload.
        const onBlur = () => this.spaceHeld.set(false);
        window.addEventListener('blur', onBlur);
        ctx.track(() => window.removeEventListener('blur', onBlur));

        // Raw map handlers (mousedown/up for drags + marquee, dblclick to
        // swallow duplicate draw points, contextmenu to delete vertices) —
        // re-bound if the map is recreated while the tool is active.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const map = ctx.map.map.get();
            if (!map) return;
            untrack(() => this.bindRawHandlers(map, ctx));
        }));

        // Arming a draw exits repeat-stamp mode (T42): a fresh draw supersedes
        // repeat placement. `stampMode` is a plain field, so clearing it is not
        // a signal write — no reactive cascade.
        ctx.track(effect(() => {
            const drawing = this.state.isDrawing.get();
            if (!drawing) return;
            untrack(() => {
                this.cancelStampDrag();
                this.stampMode = null;
            });
        }));

        // Selection changes invalidate all selection-scoped transient
        // state (vertex selection, hover target, armed previews).
        let lastSelection = ctx.features.selectedIds.peek();
        ctx.track(effect(() => {
            const selection = ctx.features.selectedIds.get();
            untrack(() => {
                if (selection === lastSelection) return;
                lastSelection = selection;
                this.clearTransientOpState();
            });
        }));

        // Preview overlay: draft outline + vertex/bezier-handle markers +
        // marquee rectangle + offset/simplify dashed previews.
        ctx.track(effect(() => {
            const ready = ctx.map.ready.get();
            const data = this.previewGeojson();
            if (!ready) {
                this.previewAdded = false;
                return;
            }
            if (!this.previewAdded) {
                ctx.map.addOverlayLayer(DRAW_OVERLAY_ID, data, previewLayers(), { keepOnTop: true });
                this.previewAdded = true;
            } else {
                ctx.map.updateOverlayData(DRAW_OVERLAY_ID, data);
            }
        }));
        ctx.track(() => {
            if (this.previewAdded) {
                ctx.map.removeOverlayLayer(DRAW_OVERLAY_ID);
                this.previewAdded = false;
            }
        });

        // Crosshair cursor while drawing. Shift gestures belong to the
        // tool in BOTH modes (Shift+click corner points while drawing,
        // Shift+click/drag vertex selection while editing), so MapLibre's
        // shift-drag box zoom is disabled for the whole activation span.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const drawing = this.state.isDrawing.get();
            const boxMode = this.state.boxSelect.get() || this.spaceHeld.get();
            const map = ctx.map.map.get();
            if (!map) return;
            map.getCanvas().style.cursor = drawing || boxMode ? 'crosshair' : '';
            map.boxZoom.disable();
        }));
        ctx.track(() => {
            const map = ctx.map.map.peek();
            if (!map) return;
            map.getCanvas().style.cursor = '';
            map.boxZoom.enable();
        });
    }

    deactivate(): void {
        this.endDrag();
        this.cancelMoveDrag();
        this.cancelStampDrag();
        this.cancelTrace();
        this.stampMode = null;
        this.marquee.set(null);
        this.state.disarm();
        this.state.boxSelect.set(false);
        this.spaceHeld.set(false);
        this.cursor.set(null);
        this.clearTransientOpState();
        this.features?.select(null);
        this.features?.resetModeView();
        if (this.scope.peek() !== 'surfaces' && this.surfacesDrawType) this.drawType.set(this.surfacesDrawType);
        this.surfacesDrawType = null;
        this.scope.set('surfaces');
        this.hostToolId = DRAW_TOOL_ID;
        this.yieldTo = null;
        this.suppressClick = false;
        this.ctx = null;
    }

    /**
     * ESC chain: discard a mid-trace stroke (stays armed) → cancel drawing
     * → exit repeat-stamp mode → cancel marquee/armed preview → clear
     * vertex selection → drop feature selection → (unconsumed) deactivate.
     */
    onEscape(): boolean {
        // ESC mid-trace discards the stroke only — the tool stays armed for
        // the next trace/click (a second ESC then disarms via handleEscape).
        if (this.traceGesture) {
            this.cancelTrace();
            return true;
        }
        if (this.state.handleEscape()) return true;
        // Exit repeat-stamp mode (T42) before the marquee: cancel any live
        // stamp/duplicate ghost and disarm further stamping.
        if (this.stampDrag || this.stampMode) {
            this.cancelStampDrag();
            this.stampMode = null;
            return true;
        }
        if (this.marquee.peek()) {
            this.marquee.set(null);
            this.ctx?.map.map.peek()?.dragPan.enable();
            return true;
        }
        if (this.offsetDistance.peek() !== null || this.simplifyActive.peek()) {
            this.offsetDistance.set(null);
            this.simplifyActive.set(false);
            return true;
        }
        if (this.vertexSelection.peek().size > 0) {
            this.vertexSelection.set(new Set());
            return true;
        }
        if (this.features && this.features.selectedIds.peek().size > 0) {
            this.features.select(null);
            return true;
        }
        return false;
    }

    // ── Map event handling ────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.ctx?.map.interactionMode.peek() === this.hostToolId;
    }

    /** True while the engine is armed or mid-gesture: the host tool keeps its hands off the map then. */
    isEngaged(): boolean {
        return this.state.isDrawing.peek() || this.drag !== null || this.moveDrag !== null
            || this.stampDrag !== null || this.marquee.peek() !== null;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.suppressClick) return;

        const p = lngLatToSweref99tm(e.lngLat);

        if (this.state.isDrawing.peek()) {
            this.placeDraftPoint(p, e.point, e.originalEvent.shiftKey);
            return;
        }
        if (this.yieldTo?.(e.point)) return;

        // Cmd/Ctrl+click toggles multi-select membership.
        if (e.originalEvent.metaKey || e.originalEvent.ctrlKey) {
            this.altCycle = null;
            const hit = this.hitFeature(p);
            if (hit) this.features?.toggleSelected(hit.id);
            return;
        }

        // Alt/Option+click cycles the selection DOWN through the hit stack
        // (D27): first click selects the topmost containing feature (same as
        // a plain click); each subsequent alt-click over the same hit stack
        // steps one deeper, wrapping. A plain/meta click resets it; so does
        // alt-clicking where the hit stack differs (advanceAltCycle).
        if (e.originalEvent.altKey) {
            const stack = this.hitStack(p);
            if (stack.length === 0) {
                this.altCycle = null;
                this.hoverVertex.set(null);
                this.features?.select(null);
                return;
            }
            this.altCycle = advanceAltCycle(this.altCycle, stack.map(f => f.id));
            this.hoverVertex.set(null);
            this.features?.select(this.altCycle.ids[this.altCycle.index]);
            return;
        }

        // Select mode. Edge click on the (single) selected feature inserts
        // a vertex — suspended in box-select mode (no geometry editing).
        const boxMode = this.state.boxSelect.peek() || this.spaceHeld.peek();
        const selected = this.features?.editableSelected.peek() ?? null;
        if (selected && !boxMode) {
            const insertion = this.edgeInsertionHit(selected, p, e.lngLat.lat);
            if (insertion) {
                const geometry = applyVertexEdit(selected.geometry, view => insertion.kind === 'control'
                    ? insertControlPoint(view, insertion.ringIdx, insertion.afterIdx, insertion.point)
                    : insertAnchor(view, insertion.ringIdx, insertion.segIdx, insertion.t));
                this.vertexSelection.set(new Set()); // indices shifted
                if (geometry) this.commitGeometry(selected.id, geometry);
                return;
            }
        }
        this.altCycle = null; // plain click resets alt-cycling to topmost
        const hit = this.hitFeature(p);
        const prev = this.features?.selectedIds.peek() ?? new Set();
        if (!hit || !(prev.size === 1 && prev.has(hit.id))) this.hoverVertex.set(null);
        this.features?.select(hit?.id ?? null);
    }

    /** Place a draft control point, or close the ring when on the first point. */
    private placeDraftPoint(p: Point, screen: { x: number; y: number }, shift: boolean): void {
        const draft = this.state.draft.peek();
        // A path's first point is just its start — clicking near it again is
        // a point, not the close gesture (Enter commits a path).
        if (!this.pathMode.peek() && draft.length >= 3 && this.screenDist(draft[0], screen) < CLOSE_RING_PX) {
            this.closeDraft();
            return;
        }
        // Shift+click places a sharp corner control point.
        this.state.addPoint(p, shift);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;

        if (this.state.isDrawing.peek()) {
            const trace = this.traceGesture;
            if (trace) {
                // Refresh the stroke preview only when the spacing gate
                // keeps the sample (≥ TRACE_SAMPLE_PX apart on screen).
                if (trace.sample(e.point, lngLatToSweref99tm(e.lngLat))) {
                    this.trace.set([...trace.points]);
                }
                return;
            }
            this.cursor.set(e.lngLat);
            return;
        }

        const marquee = this.marquee.peek();
        if (marquee) {
            this.marquee.set({ ...marquee, current: lngLatToSweref99tm(e.lngLat) });
            return;
        }

        const stamp = this.stampDrag;
        if (stamp && this.features) {
            // A duplicate-drag is threshold-gated (sub-threshold decays to the
            // Alt-cycle click); a stamp shows its copy under the cursor at once.
            if (stamp.kind === 'duplicate' && !stamp.moved
                && this.pxDist(stamp.startScreen, e.point) < MOVE_THRESHOLD_PX) return;
            stamp.moved = true;
            const p = lngLatToSweref99tm(e.lngLat);
            stamp.dx = p.x - stamp.refEpsg.x;
            stamp.dy = p.y - stamp.refEpsg.y;
            this.dragGhost.set(stamp.sources.map(s => ({
                id: s.id,
                type: s.type,
                geometry: translateGeometry(s.geometry, stamp.dx, stamp.dy),
            })));
            return;
        }

        const move = this.moveDrag;
        if (move && this.features) {
            if (!move.moved && this.pxDist(move.startScreen, e.point) < MOVE_THRESHOLD_PX) return;
            if (!move.moved) {
                move.moved = true;
                this.features.setDragging(move.features.map(f => f.id), true);
            }
            const p = lngLatToSweref99tm(e.lngLat);
            move.dx = p.x - move.startEpsg.x;
            move.dy = p.y - move.startEpsg.y;
            this.dragGhost.set(move.features.map(f => ({
                id: f.id,
                type: f.type,
                geometry: translateGeometry(f.geometry, move.dx, move.dy),
            })));
            return;
        }

        const drag = this.drag;
        if (!drag || !this.features) {
            // Hover highlighting only matters with the mouse button up. While a
            // button is held the user is panning (or dragging) — skip the
            // O(vertices) hover hit-test, which otherwise re-projects every
            // vertex of the selected shape on every frame of a pan (2-5 fps on
            // a large rough).
            if (e.originalEvent.buttons === 0) this.trackHoverVertex(e);
            return;
        }
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        if (!drag.moved) {
            drag.moved = true;
            this.features.setDragging([drag.featureId], true);
        }

        // Derive from the drag-start geometry — all three ops set ABSOLUTE
        // positions, so this is frame-order independent and needs no store
        // reads (the store is not patched until the mouseup commit).
        const p = lngLatToSweref99tm(e.lngLat);
        // On a road the view is its centerline: moving a control point
        // re-derives the whole corridor round it.
        const geometry = applyVertexEdit(drag.startGeometry, view => {
            if (drag.kind === 'anchor') return moveAnchor(view, drag.ringIdx, drag.idx, p);
            if (drag.kind === 'handle') return moveHandle(view, drag.ringIdx, drag.idx, drag.which!, p);
            return setSymmetricHandles(view, drag.ringIdx, drag.idx, p);
        });
        if (!geometry) return; // the line collapsed (a point dropped on its only neighbour)
        drag.currentGeometry = geometry;
        this.dragGhost.set([{ id: drag.featureId, type: drag.featureType, geometry }]);
    }

    private bindRawHandlers(map: MaplibreMap, ctx: ToolContext): void {
        const onMouseDown = (e: MapMouseEvent) => this.onMouseDown(e, map);
        const onMouseUp = (e: MapMouseEvent) => this.onMouseUp(e, map);
        const onDblClick = (e: MapMouseEvent) => this.onDblClick(e);
        const onContextMenu = (e: MapMouseEvent) => this.onContextMenu(e, map);
        map.on('mousedown', onMouseDown);
        map.on('mouseup', onMouseUp);
        map.on('dblclick', onDblClick);
        map.on('contextmenu', onContextMenu);
        ctx.track(() => {
            map.off('mousedown', onMouseDown);
            map.off('mouseup', onMouseUp);
            map.off('dblclick', onDblClick);
            map.off('contextmenu', onContextMenu);
        });
    }

    private onMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (!this.isMyClaim()) return;
        if (e.originalEvent.button !== 0) return;
        if (this.state.mode.peek() === 'draw') {
            this.onDrawMouseDown(e, map);
            return;
        }
        if (this.yieldTo?.(e.point)) return;
        const features = this.features;
        if (!features) return;

        const meta = e.originalEvent.metaKey || e.originalEvent.ctrlKey;
        const shift = e.originalEvent.shiftKey;
        const single = features.editableSelected.peek();

        // 0. Box-select (sticky 'B' toggle or Space held): a left-drag
        //    rubber-bands features regardless of what it lands on — even a
        //    shape that a plain drag would move, or the selected feature's
        //    vertices. Meta still falls through so ⌘/Ctrl-click toggle-select
        //    keeps working; a sub-threshold drag decays to a plain click in
        //    onMouseUp (selects the shape under the cursor).
        if ((this.state.boxSelect.peek() || this.spaceHeld.peek()) && !meta) {
            e.preventDefault();
            map.dragPan.disable();
            const start = lngLatToSweref99tm(e.lngLat);
            this.marquee.set({ kind: 'features', start, current: start, startScreen: { x: e.point.x, y: e.point.y } });
            return;
        }

        // 1. Vertex/handle interactions on the single selected feature.
        if (single && !meta) {
            const hit = this.hitVertexOrHandle(map, single, e.point);
            if (hit) {
                if (shift && hit.kind === 'anchor') {
                    // Shift+click a vertex: toggle multi-vertex selection.
                    e.preventDefault();
                    this.toggleVertexSelected(vertexKey(hit.ringIdx, hit.idx));
                    this.suppressNextClick();
                    return;
                }
                e.preventDefault(); // stops the map's drag-pan for this gesture
                map.dragPan.disable();
                const view = editViewOf(single.geometry);
                const anchor = view.rings[hit.ringIdx].points[hit.idx];
                // Bezier handles don't exist on spline features (nor on a
                // road's centerline): alt-drag falls back to a plain
                // control-point drag there.
                const isSpline = view.curveType === 'bspline';
                const alt = e.originalEvent.altKey && !isSpline;
                // Plain grab of a vertex outside the multi-vertex selection
                // drops that selection (prototype behavior).
                if (hit.kind === 'anchor' && !this.vertexSelection.peek().has(vertexKey(hit.ringIdx, hit.idx))) {
                    if (this.vertexSelection.peek().size > 0) this.vertexSelection.set(new Set());
                }
                this.drag = {
                    kind: hit.kind === 'handle' ? 'handle' : alt ? 'newHandles' : 'anchor',
                    which: hit.which,
                    featureId: single.id,
                    featureType: single.type,
                    ringIdx: hit.ringIdx,
                    idx: hit.idx,
                    alt,
                    hadHandles: hasHandles(anchor),
                    startScreen: { x: e.point.x, y: e.point.y },
                    startGeometry: single.geometry,
                    startVersion: single.version,
                    moved: false,
                    currentGeometry: null,
                };
                return;
            }
        }

        // Cmd/Ctrl+press is a selection-toggle click — never a tool drag.
        // Returning WITHOUT preventDefault/dragPan.disable deliberately leaves
        // MapLibre's native dragPan engaged, so ⌘-drag PANS the map — the
        // trackpad equivalent of the middle-button pan escape hatch in
        // map.service.ts (MapLibre's pan accepts meta; only ctrl is reserved
        // for rotate). A real drag exceeds clickTolerance and suppresses the
        // click, so the selection toggle only fires on a stationary ⌘-click.
        if (meta) return;

        const p = lngLatToSweref99tm(e.lngLat);

        // 1b. Alt+press inside the selection (not on a vertex/handle — those
        //     were consumed above): start a duplicate-drag over CLONES (T42).
        //     A sub-threshold drag decays to the Alt-cycle click in onMouseUp,
        //     so a stationary Alt-click still cycles the hit stack as before.
        if (e.originalEvent.altKey && !shift) {
            const selectedFeatures = features.editableSelectedFeatures.peek();
            if (selectedFeatures.some(f => this.grabs(f, p))) {
                e.preventDefault();
                map.dragPan.disable();
                this.stampDrag = {
                    kind: 'duplicate',
                    refEpsg: p,
                    startScreen: { x: e.point.x, y: e.point.y },
                    sources: selectedFeatures.map(f => ({
                        id: f.id, type: f.type, holeId: f.holeId, layer: f.layer ?? null, geometry: f.geometry, attributes: attributesPatchOf(f.attributes),
                    })),
                    moved: false,
                    dx: 0,
                    dy: 0,
                };
                return;
            }
        }

        // 2. Shift+drag with exactly one selected feature: vertex marquee
        //    (axis-aligned, only that feature's control/anchor points).
        if (shift) {
            if (single) {
                e.preventDefault();
                map.dragPan.disable();
                this.marquee.set({ kind: 'vertices', start: p, current: p, startScreen: { x: e.point.x, y: e.point.y } });
            }
            return;
        }

        // 3. Drag inside a selected feature: move the whole selection.
        const selectedFeatures = features.editableSelectedFeatures.peek();
        if (selectedFeatures.some(f => this.grabs(f, p))) {
            e.preventDefault();
            map.dragPan.disable();
            this.moveDrag = {
                startEpsg: p,
                startScreen: { x: e.point.x, y: e.point.y },
                features: selectedFeatures.map(f => ({
                    id: f.id,
                    geometry: f.geometry,
                    type: f.type,
                    holeId: f.holeId,
                    version: f.version,
                })),
                moved: false,
                dx: 0,
                dy: 0,
            };
            return;
        }

        // 4. Drag on empty ground (no visible feature): stamp a repeat copy
        //    (T42) when stamp mode is armed, else a feature marquee.
        //    (A drag starting inside an UNSELECTED feature stays with the
        //    map's default pan; plain clicks still select it.) In the rules
        //    scope an empty-ground drag pans, as it always has in Furniture;
        //    B / Space still rubber-band.
        if (this.scope.peek() === 'rules' && !this.stampMode) return;
        if (!this.hitFeature(p)) {
            e.preventDefault();
            map.dragPan.disable();
            if (this.stampMode) {
                this.startStampDrag(p, { x: e.point.x, y: e.point.y });
            } else {
                this.marquee.set({ kind: 'features', start: p, current: p, startScreen: { x: e.point.x, y: e.point.y } });
            }
        }
    }

    /**
     * Left-press while the draw tool is armed (T40): start a freehand
     * trace. The gesture claims the drag (preventDefault + dragPan off —
     * the marquee pattern) and onMouseMove samples the stroke at
     * ≥ TRACE_SAMPLE_PX screen spacing; a sub-threshold release decays to
     * the plain click (click-to-place / Shift-corner / close-ring hit all
     * unchanged via onClick).
     *
     * Once click-placement has begun (non-empty draft) a left press always
     * places a point — a press that slips while clicking quickly is still
     * a point, never a pan (placePress; a trace always starts a FRESH shape).
     *
     * Pan escape hatches while armed: middle-button (map.service) and
     * ⌘/Ctrl-drag — returning without preventDefault keeps MapLibre's
     * native dragPan engaged, exactly like the select-mode meta-pan below.
     */
    private onDrawMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (e.originalEvent.metaKey || e.originalEvent.ctrlKey) return;
        e.preventDefault();
        map.dragPan.disable();
        if (this.state.draft.peek().length > 0) {
            this.placePress = { startScreen: { x: e.point.x, y: e.point.y }, lngLat: e.lngLat, shift: e.originalEvent.shiftKey };
            return;
        }
        this.traceGesture = new TraceGesture(
            { x: e.point.x, y: e.point.y },
            lngLatToSweref99tm(e.lngLat),
        );
        this.trace.set([...this.traceGesture.points]);
    }

    /**
     * Begin a repeat-stamp drag from the armed template. The copy is anchored
     * under the cursor immediately (grab point = the template `anchor`, the
     * previous drop point) and tracks pointer moves; the drop always creates.
     */
    private startStampDrag(p: Point, startScreen: { x: number; y: number }): void {
        const mode = this.stampMode;
        if (!mode) return;
        const dx = p.x - mode.anchor.x;
        const dy = p.y - mode.anchor.y;
        this.stampDrag = {
            kind: 'stamp',
            refEpsg: mode.anchor,
            startScreen,
            sources: mode.templates,
            moved: false,
            dx,
            dy,
        };
        this.dragGhost.set(mode.templates.map(s => ({
            id: s.id,
            type: s.type,
            geometry: translateGeometry(s.geometry, dx, dy),
        })));
    }

    private onMouseUp(e: MapMouseEvent, map: MaplibreMap): void {
        const place = this.placePress;
        if (place) {
            this.placePress = null;
            map.dragPan.enable();
            // Within tolerance MapLibre synthesizes the click (onClick
            // places the point); past it there is no click, so place the
            // point where the press landed.
            if (this.pxDist(place.startScreen, e.point) < PLACE_CLICK_TOLERANCE_PX) return;
            this.suppressNextClick();
            if (this.state.isDrawing.peek()) {
                this.placeDraftPoint(lngLatToSweref99tm(place.lngLat), place.startScreen, place.shift);
            }
            return;
        }

        const trace = this.traceGesture;
        if (trace) {
            this.traceGesture = null;
            this.trace.set(null);
            map.dragPan.enable();
            // Sub-threshold press decays to a plain click: do NOT suppress
            // the click MapLibre synthesizes — onClick places the point
            // (Shift-corner / close-ring hit included) exactly as before.
            if (!trace.moved) return;
            this.suppressNextClick();
            this.commitTrace(trace.finish(lngLatToSweref99tm(e.lngLat)));
            return;
        }

        const stamp = this.stampDrag;
        if (stamp) {
            this.stampDrag = null;
            map.dragPan.enable();
            this.dragGhost.set(null);
            // Sub-threshold duplicate-drag: decay to the Alt-cycle click. Do
            // NOT suppress the synthesized click — onClick's Alt path cycles
            // the hit stack exactly as a stationary Alt-click always has.
            if (stamp.kind === 'duplicate' && !stamp.moved) return;
            this.suppressNextClick();
            const p = lngLatToSweref99tm(e.lngLat);
            const dx = p.x - stamp.refEpsg.x;
            const dy = p.y - stamp.refEpsg.y;
            void (async () => {
                const created = await this.stampClones(stamp.sources, dx, dy);
                // A duplicate-drag drop arms repeat-stamp mode: the fresh clones
                // become the template, grabbed at this drop point.
                if (created && stamp.kind === 'duplicate') {
                    this.stampMode = {
                        anchor: p,
                        templates: created.map(c => ({
                            id: c.id, type: c.type, holeId: c.holeId, layer: c.layer ?? null, geometry: c.geometry, attributes: attributesPatchOf(c.attributes),
                        })),
                    };
                }
            })();
            return;
        }

        const marquee = this.marquee.peek();
        if (marquee) {
            this.marquee.set(null);
            map.dragPan.enable();
            if (this.pxDist(marquee.startScreen, e.point) < MARQUEE_MIN_PX) return; // a click — let onClick handle it
            this.suppressNextClick();
            const rect = rectFromCorners(marquee.start, lngLatToSweref99tm(e.lngLat));
            if (!this.features) return;
            if (marquee.kind === 'features') {
                // Default 'contain' (fully inside); Alt = 'intersect'.
                const mode = e.originalEvent.altKey ? 'intersect' : 'contain';
                const features = this.features;
                const scope = this.scope.peek();
                const visible = features.store.items.peek()
                    .filter(f => !features.isHidden(f) && scopeOwnsType(scope, f.type));
                this.features.setSelection(featuresInRect(visible, rect, mode));
            } else {
                const single = this.features.editableSelected.peek();
                if (single) this.vertexSelection.set(new Set(verticesInRect(editViewOf(single.geometry), rect)));
            }
            return;
        }

        const move = this.moveDrag;
        if (move) {
            this.moveDrag = null;
            map.dragPan.enable();
            if (!move.moved || !this.features) return; // plain click — let onClick handle it
            this.suppressNextClick();
            const features = this.features;
            this.dragGhost.set(null);
            features.setDragging(move.features.map(f => f.id), false);
            // Commit the final translation: ONE store batch (a single
            // FeatureCollection rebuild), ONE history entry for the whole
            // multi-feature move, one autosave per feature.
            const entry = buildMoveEntry(move.features, move.dx, move.dy);
            batch(() => {
                for (const diff of entry) {
                    features.patchLocal(diff.featureId, diff.after!.geometry); // instant visual snap
                }
            });
            for (const diff of entry) {
                void features.update(diff.featureId, { geometry: diff.after!.geometry });
            }
            this.history.push(entry);
            return;
        }

        const drag = this.drag;
        if (!drag || !this.features) return;
        this.endDrag(map);

        // Swallow the click MapLibre synthesizes right after this mouseup.
        this.suppressNextClick();

        if (drag.moved) {
            const geometry = drag.currentGeometry;
            const feature = this.features.store.items.peek().find(f => f.id === drag.featureId);
            if (feature && geometry) {
                this.history.push([{
                    featureId: drag.featureId,
                    before: { geometry: drag.startGeometry, type: feature.type, holeId: feature.holeId },
                    after: { geometry, type: feature.type, holeId: feature.holeId },
                    beforeVersion: drag.startVersion,
                }]);
                this.features.patchLocal(drag.featureId, geometry); // instant visual snap
                void this.features.update(drag.featureId, { geometry });
            }
            return;
        }
        // Alt-click (no movement) on a curved vertex straightens it.
        if (drag.kind === 'newHandles' && drag.hadHandles) {
            const feature = this.features.store.items.peek().find(f => f.id === drag.featureId);
            if (feature) {
                this.commitGeometry(drag.featureId, clearHandles(feature.geometry, drag.ringIdx, drag.idx));
            }
        }
    }

    private onDblClick(e: MapMouseEvent): void {
        if (!this.isMyClaim()) return;
        if (!this.state.isDrawing.peek()) return;
        e.preventDefault(); // no double-click zoom while drawing
        this.state.discardDoubleClickDuplicate();
    }

    private onContextMenu(e: MapMouseEvent, map: MaplibreMap): void {
        if (!this.isMyClaim()) return;
        const selected = this.features?.editableSelected.peek();
        if (!selected) return;
        const hit = this.hitVertexOrHandle(map, selected, e.point);
        if (!hit || hit.kind !== 'anchor') return;
        e.preventDefault();
        const geometry = applyVertexEdit(selected.geometry, view =>
            deleteAnchor(view, hit.ringIdx, hit.idx, minVertexCount(selected.geometry)));
        if (geometry) {
            this.hoverVertex.set(null); // indices shifted — drop stale target
            this.vertexSelection.set(new Set());
            this.commitGeometry(selected.id, geometry);
        }
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;

        const meta = e.metaKey || e.ctrlKey;

        // Space held = momentary box-select override (released in the keyup
        // listener). preventDefault stops the page from scrolling. Auto-repeat
        // re-fires keydown harmlessly.
        if ((e.key === ' ' || e.code === 'Space') && !meta) {
            e.preventDefault();
            this.spaceHeld.set(true);
            return;
        }

        if (meta && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (this.state.isDrawing.peek()) {
                // Mid-draw point undo/redo — separate ephemeral stack. When it
                // has nothing to do (e.g. an empty draft just re-armed by a
                // sticky close), fall through to committed history so the
                // just-created feature is undoable without leaving chain mode.
                if (e.shiftKey) {
                    if (!this.state.redoPoint()) this.redo();
                } else if (!this.state.undoPoint()) {
                    this.undo();
                }
            } else if (e.shiftKey) {
                this.redo();
            } else {
                this.undo();
            }
        } else if (meta && (e.key === 'y' || e.key === 'Y')) {
            e.preventDefault();
            if (this.state.isDrawing.peek()) {
                if (!this.state.redoPoint()) this.redo();
            } else this.redo();
        } else if (meta && (e.key === 'd' || e.key === 'D')) {
            e.preventDefault();
            this.duplicateSelection();
        } else if (e.key === 'Enter') {
            if (this.state.isDrawing.peek() && this.pathMode.peek()) {
                const draft = this.state.draft.peek();
                if (draft.length >= 2) {
                    e.preventDefault();
                    this.commitCenterline(draft, this.pathWidthM.peek());
                }
            } else if (this.state.isDrawing.peek() && this.state.canClose.peek()) {
                e.preventDefault();
                this.closeDraft();
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.vertexSelection.peek().size > 0 && this.features?.editableSelected.peek()) {
                e.preventDefault();
                this.deleteSelectedVertices();
            } else if ((this.features?.selectedIds.peek().size ?? 0) > 0) {
                e.preventDefault();
                void this.deleteSelected();
            }
        } else if ((e.key === 'i' || e.key === 'I') && !meta) {
            if (this.vertexSelection.peek().size === 2 && this.features?.editableSelected.peek()) {
                e.preventDefault();
                this.insertBetweenSelectedVertices();
            }
        } else if (e.key === 'n' || e.key === 'N') {
            if (!this.state.isDrawing.peek() && !meta) {
                e.preventDefault();
                this.armDraw();
            }
        } else if (e.key === 'p' || e.key === 'P') {
            if (!this.state.isDrawing.peek() && !meta && this.scope.peek() === 'surfaces') {
                e.preventDefault();
                this.armPath();
            }
        } else if (e.key === 'b' || e.key === 'B') {
            if (!this.state.isDrawing.peek() && !meta) {
                e.preventDefault();
                this.state.toggleBoxSelect();
            }
        } else if (e.key === 'c' || e.key === 'C') {
            if (!meta && !this.state.isDrawing.peek() && this.hoverVertex.peek() && this.features?.editableSelected.peek()) {
                e.preventDefault();
                this.toggleHoveredVertexCorner();
            }
        } else if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
            // D27 stack-reorder bindings (Inkscape-style — not [ / ], which
            // needs AltGr on Swedish layouts). The map claims paging/Home/End
            // for its own navigation, so preventDefault whenever we act.
            if (!meta && !this.state.isDrawing.peek() && (this.features?.selectedIds.peek().size ?? 0) > 0) {
                e.preventDefault();
                void this.reorderSelected(e.key as 'PageUp' | 'PageDown' | 'Home' | 'End');
            }
        } else if (!meta && !e.altKey && DIGIT_FEATURE_TYPES[e.key] && this.scope.peek() === 'surfaces') {
            // Bare digit = pick a feature type without opening the palette
            // dropdown (⌘/Ctrl/Alt-digit is browser tab switching etc. — never
            // preventDefault there). Same verb as the palette button.
            e.preventDefault();
            this.chooseType(DIGIT_FEATURE_TYPES[e.key]);
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────

    /** Undo the last committed edit (Cmd/Ctrl+Z, panel button). */
    undo(): void {
        if (!this.features) return;
        this.clearTransientOpState();
        void this.history.undo(this.features);
    }

    /** Redo the last undone edit (Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y, panel). */
    redo(): void {
        if (!this.features) return;
        this.clearTransientOpState();
        void this.history.redo(this.features);
    }

    /**
     * D27 stack-reorder verbs for the selected feature(s) (PageUp/PageDown/
     * Home/End, panel buttons). Deliberately NOT undo-history integrated —
     * `EditHistory` entries are per-feature geometry/type/holeId diffs
     * (history.ts), which doesn't fit a whole-group order rewrite; see the
     * T23 report.
     */
    private async reorderSelected(key: 'PageUp' | 'PageDown' | 'Home' | 'End'): Promise<void> {
        const features = this.features;
        if (!features) return;
        // A mode's backdrop rows (Vegetation's creeks and water) keep Draw's order.
        const backdrop = features.modeBackdropTypes.peek();
        if (features.selectedFeatures.peek().some(f => backdrop.has(f.type))) return;
        const ids = [...features.selectedIds.peek()];
        if (key === 'PageUp') await features.raise(ids);
        else if (key === 'PageDown') await features.lower(ids);
        else if (key === 'Home') await features.raiseToTop(ids);
        else await features.lowerToBottom(ids);
    }

    /**
     * Close the draft ring and autosave it as a new feature. New features
     * are B-SPLINES: the placed points are control points and the curve
     * smooths itself (corner points excepted). Closing leaves drawing mode:
     * `create()` selects the new feature, so its nodes show and the type
     * palette retypes it straight away ('N' arms the next shape).
     */
    closeDraft(curveType: CurveType = 'bspline'): void {
        const ring = this.state.closeDraft();
        if (!ring || !this.features) return;
        this.cursor.set(null);
        this.state.disarm();
        const features = this.features;
        const type = this.drawType.peek();
        void features.create({
            type,
            holeId: this.drawHoleId.peek(),
            geometry: { crs: 'EPSG:3006', curveType, rings: [ring] },
            ...this.newShapeAttributes(type),
        }).then(created => {
            if (created) {
                this.history.push([{ featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null }]);
            }
        });
    }

    /**
     * Attributes a freshly drawn shape of `type` starts with: a path's set
     * surface, a zone's picked zone type (the table's defaults otherwise,
     * filled in by `FeaturesService.create`).
     */
    private newShapeAttributes(type: FeatureType): { attributes?: FeatureAttributesPatch } {
        const surface = type === 'path' ? this.pathSurface.peek() : '';
        if (surface) return { attributes: { [PATH_SURFACE_ATTRIBUTE]: surface } };
        const zoneType = type === 'vegetation_zone' ? this.drawZoneType.peek() : '';
        if (zoneType) return { attributes: { ...this.zoneTypes.defaultAttributes(), zoneType, zoneVariant: this.zoneTypes.startVariantOf(zoneType) } };
        return {};
    }

    /**
     * Fit a traced freehand stroke (EPSG:3006) to a closed b-spline and
     * commit it through the normal closeDraft funnel — a regular editable
     * spline feature of the armed type, ONE create history entry
     * (`before: null`), chain-draw keeps the tool armed. Returns false when
     * the fit degenerated (< 3 controls) and the stroke was discarded.
     * Public: it is the trace gesture's testable commit seam (the pointer
     * wiring needs a live MaplibreMap — same rationale as `stampClones`).
     */
    commitTrace(stroke: Point[]): boolean {
        if (this.state.mode.peek() !== 'draw') return false;
        // Path mode: the stroke runs down the middle of the road — thin it to
        // the points a curve through them needs and commit it as a centerline.
        if (this.pathMode.peek()) {
            return this.commitCenterline(rdpSimplify(stroke, PATH_TRACE_TOLERANCE_M), this.pathWidthM.peek());
        }
        const { controls } = fitClosedBspline(stroke, TRACE_TOLERANCE_M);
        if (controls.length < MIN_RING_POINTS) return false;
        this.state.draft.set(controls.map(p => ({ x: p.x, y: p.y })));
        this.closeDraft();
        return true;
    }

    /**
     * Commit a centerline (EPSG:3006) as a `path` `widthM` wide: a
     * CENTERLINE feature — the clicked line (with its corners, see
     * `draftCenterlineGeometry`) is the shape, the corridor is derived from
     * it, and editing it later moves points on the line, not on the kerbs.
     * One create history entry; leaves drawing mode like any close. False
     * (nothing committed) for fewer than two distinct points or an unusable
     * width. Public: the path gesture's testable seam.
     */
    commitCenterline(points: AnchorPoint[], widthM: number): boolean {
        if (this.state.mode.peek() !== 'draw' || !this.features) return false;
        const geometry = draftCenterlineGeometry(points, widthM);
        if (!geometry) return false;
        this.cursor.set(null);
        this.state.disarm();
        const type = this.drawType.peek();
        void this.features.create({
            type,
            holeId: this.drawHoleId.peek(),
            geometry,
            ...this.newShapeAttributes(type),
        }).then(created => {
            if (created) {
                this.history.push([{ featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null }]);
            }
        });
        return true;
    }

    /**
     * Set the selected road's width (selection panel): the line stays, the
     * corridor is re-derived round it. One history entry.
     */
    setSelectedCenterlineWidth(widthM: number): void {
        const selected = this.features?.editableSelected.peek();
        if (!selected?.geometry.centerline || widthM === selected.geometry.centerline.widthM) return;
        const geometry = withCenterlineWidth(selected.geometry, widthM);
        if (geometry) this.commitGeometry(selected.id, geometry);
    }

    /** Toggle the hovered vertex smooth↔corner ('C' key / panel button). */
    toggleHoveredVertexCorner(): void {
        const selected = this.features?.editableSelected.peek();
        const hover = this.hoverVertex.peek();
        if (!selected || !hover) return;
        if (!editViewOf(selected.geometry).rings[hover.ringIdx]?.points[hover.idx]) return;
        const geometry = applyVertexEdit(selected.geometry, view => toggleVertexCorner(view, hover.ringIdx, hover.idx));
        if (geometry) this.commitGeometry(selected.id, geometry);
    }

    /** True when the hovered vertex is a corner (panel toggle label). */
    hoveredVertexIsCorner(): boolean {
        const selected = this.features?.editableSelected.get();
        const hover = this.hoverVertex.get();
        if (!selected || !hover) return false;
        const view = editViewOf(selected.geometry);
        if (!view.rings[hover.ringIdx]?.points[hover.idx]) return false;
        return isCornerVertex(view, hover.ringIdx, hover.idx);
    }

    /**
     * Convert the selected b-spline feature to its exact bezier equivalent
     * (bakes control points into on-curve anchors + handles). One-way:
     * bezier → b-spline is lossy and not offered.
     */
    async convertSelectedToBezier(): Promise<void> {
        const selected = this.features?.editableSelected.peek();
        if (!selected || selected.geometry.curveType !== 'bspline') return;
        const ok = await this.confirm.confirm({
            title: 'Convert spline to bezier?',
            body: 'The outline will stay the same, but spline controls will become bezier anchors and handles.',
            detail: 'This cannot be converted back into the original spline controls.',
            confirmLabel: 'Convert',
            tone: 'warning',
            layout: 'default',
        });
        if (!ok) return;
        this.hoverVertex.set(null);
        this.vertexSelection.set(new Set());
        this.commitGeometry(selected.id, bakeBsplineToBezier(selected.geometry));
    }

    /**
     * Delete the whole selection after confirmation (key or panel button).
     * Bulk deletes are ONE history entry.
     */
    async deleteSelected(): Promise<void> {
        const features = this.features;
        // Generated rows may be deleted (false positives); a mode's backdrop
        // (a creek selected in Vegetation for its bank vegetation) may not.
        const backdrop = features?.modeBackdropTypes.peek() ?? new Set<string>();
        const items = (features?.selectedFeatures.peek() ?? []).filter(f => !backdrop.has(f.type));
        if (!features || items.length === 0) return;
        const label = items.length === 1 ? `this ${items[0].type} feature` : `${items.length} features`;
        const ok = await this.confirm.confirm({
            title: items.length === 1 ? 'Delete feature?' : `Delete ${items.length} features?`,
            body: `Delete ${label} from the course map.`,
            detail: items.length >= 5 ? 'Bulk deletes are saved as one history entry.' : '',
            confirmLabel: items.length === 1 ? 'Delete feature' : 'Delete features',
            tone: 'danger',
            layout: items.length >= 5 ? 'review' : 'default',
        });
        if (!ok) return;
        this.history.push(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: null,
            beforeVersion: f.version,
        })));
        void (async () => {
            for (const f of items) await features.removeFeature(f.id);
        })();
    }

    /**
     * Cmd/Ctrl+D: duplicate the selection offset +10 m in EPSG:3006 x/y,
     * select the clones. ONE history entry for all clones.
     */
    duplicateSelection(): void {
        const features = this.features;
        const items = features?.editableSelectedFeatures.peek() ?? [];
        if (!features || items.length === 0) return;
        void (async () => {
            const entry: HistoryEntry = [];
            const ids: string[] = [];
            for (const f of items) {
                const created = await features.create({
                    type: f.type,
                    holeId: f.holeId,
                    layer: f.layer ?? null,
                    geometry: translateGeometry(f.geometry, DUPLICATE_OFFSET_M, DUPLICATE_OFFSET_M),
                    // A vegetation zone's copy keeps its zone type and edge
                    // settings; every other type has nothing to carry.
                    attributes: attributesPatchOf(f.attributes),
                });
                if (!created) return; // save failed — history dropped via saveError watcher
                entry.push({ featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null });
                ids.push(created.id);
            }
            features.setSelection(ids);
            this.history.push(entry);
        })();
    }

    /**
     * Auto-surround (T41): insert the surround feature(s) golf implies for
     * the selection (the fixed type z-order renders them behind the
     * sources). Plain click = one level of SURROUND_PAIRINGS; Shift
     * (`chain`) walks the pairings to exhaustion (green → fairway →
     * semi_rough → rough → deep_rough), each ring offset from the PREVIOUS
     * ring. Selected features sharing a target type union into ONE merged
     * surround instead of N overlapping clones (see `planSurrounds`).
     * ONE history entry; selection moves to all new rings.
     */
    async autoSurroundSelection(chain = false): Promise<void> {
        const features = this.features;
        const items = features?.editableSelectedFeatures.peek() ?? [];
        if (!features || items.length === 0) return;
        const sources: SurroundSource[] = items.map(f => ({
            type: f.type as FeatureType,
            holeId: f.holeId,
            geometry: f.geometry,
        }));
        const plan = planSurrounds(sources, chain);
        if (plan.length === 0) {
            this.actionNotice.set(sources.some(s => SURROUND_PAIRINGS[s.type])
                ? 'Surround collapsed — nothing created.'
                : 'No surround pairing for the selected type(s).');
            return;
        }
        this.actionNotice.set(null);
        const entry: HistoryEntry = [];
        const ids: string[] = [];
        for (const create of plan) {
            const created = await features.create(create);
            if (!created) return; // save failed — history dropped via saveError watcher
            entry.push({ featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null });
            ids.push(created.id);
        }
        features.setSelection(ids);
        this.history.push(entry);
    }

    /**
     * Surround pairing for the current selection (panel button label),
     * plus the terminal type a Shift-chain would walk to. `chainEnd`
     * equals `targetType` when the target itself has no further pairing
     * (no chain hint to show).
     */
    selectionSurroundPairing(): { targetType: FeatureType; expandAmount: number; chainEnd: FeatureType } | null {
        const items = this.features?.editableSelectedFeatures.get() ?? [];
        for (const f of items) {
            const pairing = SURROUND_PAIRINGS[f.type as FeatureType];
            if (pairing) {
                let chainEnd = pairing.targetType;
                while (SURROUND_PAIRINGS[chainEnd]) {
                    chainEnd = SURROUND_PAIRINGS[chainEnd]!.targetType;
                }
                return { ...pairing, chainEnd };
            }
        }
        return null;
    }

    /**
     * Arm the expand/contract preview (positive = expand, negative =
     * contract, null = cancel). The dashed preview renders until
     * `applyOffset` commits or the selection changes.
     */
    setOffsetDistance(distance: number | null): void {
        this.simplifyActive.set(false);
        this.actionNotice.set(null);
        if (distance !== null) {
            const selected = this.features?.editableSelected.peek();
            if (!selected) return;
            if (offsetGeometry(selected.geometry, distance) === null) {
                this.offsetDistance.set(null);
                this.actionNotice.set(`Contract by ${Math.abs(distance)} m would collapse this feature.`);
                return;
            }
        }
        this.offsetDistance.set(distance);
    }

    /** Commit the armed offset preview (one history entry). */
    applyOffset(): void {
        const selected = this.features?.editableSelected.peek();
        const geometry = this.offsetDistance.peek() !== null ? this.opPreviewGeometry.peek() : null;
        this.offsetDistance.set(null);
        if (!selected || !geometry) return;
        this.commitGeometry(selected.id, geometry);
    }

    /** Arm/disarm the RDP-simplify preview (panel action). */
    setSimplifyActive(active: boolean): void {
        this.offsetDistance.set(null);
        this.actionNotice.set(null);
        this.simplifyActive.set(active);
    }

    /** Commit the armed simplify preview (one history entry). */
    applySimplify(): void {
        const selected = this.features?.editableSelected.peek();
        const geometry = this.simplifyActive.peek() ? this.opPreviewGeometry.peek() : null;
        this.simplifyActive.set(false);
        if (!selected || !geometry) return;
        this.hoverVertex.set(null);
        this.vertexSelection.set(new Set()); // indices shifted
        this.commitGeometry(selected.id, geometry);
    }

    /** Toggle one vertex's membership in the multi-vertex selection. */
    toggleVertexSelected(key: string): void {
        const next = new Set(this.vertexSelection.peek());
        if (next.has(key)) next.delete(key);
        else next.add(key);
        this.vertexSelection.set(next);
    }

    /**
     * Bulk-delete the selected vertices (Delete key / panel button).
     * All-or-nothing: rejected with a notice when any ring would drop
     * below 3 points. One history entry.
     */
    deleteSelectedVertices(): void {
        const selected = this.features?.editableSelected.peek();
        const keys = this.vertexSelection.peek();
        if (!selected || keys.size === 0) return;
        const geometry = applyVertexEdit(selected.geometry, view => deleteVertices(view, keys, minVertexCount(selected.geometry)));
        if (!geometry) {
            this.actionNotice.set(selected.geometry.centerline
                ? 'Cannot delete: a path needs at least 2 points.'
                : 'Cannot delete: each ring needs at least 3 points.');
            return;
        }
        this.actionNotice.set(null);
        this.hoverVertex.set(null);
        this.vertexSelection.set(new Set());
        this.commitGeometry(selected.id, geometry);
    }

    /**
     * 'I' key: insert a vertex between the two selected vertices with even
     * redistribution along the chord (see insertBetweenVertices).
     */
    insertBetweenSelectedVertices(): void {
        const selected = this.features?.editableSelected.peek();
        const keys = [...this.vertexSelection.peek()];
        if (!selected || keys.length !== 2) return;
        const a = parseVertexKey(keys[0]);
        const b = parseVertexKey(keys[1]);
        if (a.ringIdx !== b.ringIdx) {
            this.actionNotice.set('Select two vertices on the same ring to insert between.');
            return;
        }
        const result = insertBetweenVertices(editViewOf(selected.geometry), a.ringIdx, a.idx, b.idx, !!selected.geometry.centerline);
        const geometry = result ? fromEditView(selected.geometry, result.geometry) : null;
        if (!result || !geometry) return;
        this.actionNotice.set(null);
        this.hoverVertex.set(null);
        this.commitGeometry(selected.id, geometry);
        this.vertexSelection.set(new Set(result.selection));
    }

    /**
     * The feature-type verb behind the palette buttons and the bare digits.
     * While drawing is armed the pick is for the NEXT shape: `create()`
     * selects every new feature, so mid-chain there is always a selection
     * (the previous shape), and retyping it is never what the user meant.
     * Not armed: a selection is retyped, otherwise the draw type is set.
     */
    chooseType(type: FeatureType): void {
        // Each scope picks only its own types (Draw never makes a rules line, Furniture only those).
        if (!scopeOwnsType(this.scope.peek(), type)) return;
        const hasSelection = (this.features?.selectedIds.peek().size ?? 0) > 0;
        if (!this.state.isDrawing.peek() && hasSelection) this.retypeSelection(type);
        else this.drawType.set(type);
    }

    /**
     * The zone-type picker's verb (Vegetation mode), the zone counterpart of
     * `chooseType`: while armed, or with no zone selected, it sets the zone
     * type of the next drawn zone; otherwise the selected zones take it (its
     * Default mix, keeping weight/feather/noise). Attribute saves, like the
     * selection panel's zone section: not in the undo history.
     */
    chooseZoneType(zoneType: string): void {
        const features = this.features;
        const zones = this.state.isDrawing.peek() ? []
            : (features?.editableSelectedFeatures.peek() ?? []).filter(f => isVegetationType(f.type));
        if (!features || zones.length === 0) {
            this.drawZoneType.set(zoneType);
            return;
        }
        for (const f of zones) {
            if (zoneTypeKeyOf(f.attributes) === zoneType) continue;
            void features.update(f.id, { attributes: { ...this.zoneTypes.attributesOf(f.attributes), zoneType, zoneVariant: this.zoneTypes.startVariantOf(zoneType) } });
        }
    }

    /**
     * Re-type the whole selection (palette with a selection, not drawing).
     * ONE history entry covering every changed feature.
     */
    retypeSelection(type: FeatureType): void {
        const features = this.features;
        const items = (features?.editableSelectedFeatures.peek() ?? []).filter(f => f.type !== type);
        if (!features || items.length === 0) return;
        this.history.push(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: { ...snapshotOf(f), type },
            beforeVersion: f.version,
        })));
        // Retyping INTO a vegetation zone has to give it a zone type: the
        // rasterizer has nothing to draw without one, and the server rejects
        // zone attributes that lack it.
        for (const f of items) {
            const needsZone = type === 'vegetation_zone' && !zoneTypeKeyOf(f.attributes);
            void features.update(f.id, needsZone
                ? { type, attributes: { ...(attributesPatchOf(f.attributes) ?? {}), ...this.zoneTypes.defaultAttributes() } }
                : { type });
        }
    }

    /**
     * Move the selection to another stack group — a hole, course-level or
     * the Roughs layer (panel select). ONE history entry. Only rough types
     * may enter the Roughs layer (D28); anything else in the selection stays
     * where it is.
     */
    assignSelectionScope(scope: StackScope): void {
        const features = this.features;
        const items = (features?.editableSelectedFeatures.peek() ?? [])
            .filter(f => !sameScope(scopeOf(f), scope))
            .filter(f => scope.layer === null || isRoughsLayerType(f.type));
        if (!features || items.length === 0) return;
        this.history.push(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: { ...snapshotOf(f), ...scope },
            beforeVersion: f.version,
        })));
        for (const f of items) void features.update(f.id, { ...scope });
    }

    /**
     * Commit a single-feature geometry edit: one history entry, instant
     * local patch, autosave. THE mutation funnel for click-sized edits
     * (drag commits build their entries from the drag's start snapshot).
     */
    private commitGeometry(id: string, geometry: FeatureGeometry): void {
        if (!this.features) return;
        const current = this.features.store.items.peek().find(f => f.id === id);
        if (!current) return;
        this.history.push([{
            featureId: id,
            before: snapshotOf(current),
            after: { geometry, type: current.type, holeId: current.holeId },
            beforeVersion: current.version,
        }]);
        this.features.patchLocal(id, geometry); // instant visual feedback
        void this.features.update(id, { geometry });
    }

    /** Selection-scoped transient state (vertex sel, previews, notices). */
    private clearTransientOpState(): void {
        this.hoverVertex.set(null);
        if (this.vertexSelection.peek().size > 0) this.vertexSelection.set(new Set());
        if (this.offsetDistance.peek() !== null) this.offsetDistance.set(null);
        if (this.simplifyActive.peek()) this.simplifyActive.set(false);
        if (this.actionNotice.peek()) this.actionNotice.set(null);
    }

    private suppressNextClick(): void {
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);
    }

    private endDrag(map?: MaplibreMap): void {
        if (!this.drag) return;
        if (this.drag.moved) {
            this.dragGhost.set(null);
            this.features?.setDragging([this.drag.featureId], false);
        }
        this.drag = null;
        (map ?? this.ctx?.map.map.peek())?.dragPan.enable();
    }

    /** Abort an in-progress whole-selection move without committing. */
    private cancelMoveDrag(): void {
        const move = this.moveDrag;
        if (!move) return;
        this.moveDrag = null;
        if (move.moved) {
            this.dragGhost.set(null);
            this.features?.setDragging(move.features.map(f => f.id), false);
        }
        this.ctx?.map.map.peek()?.dragPan.enable();
    }

    /** Leave drawing mode without making a shape (a host panel's arm button toggled off). */
    cancelDrawing(): void {
        this.cancelTrace();
        this.state.disarm();
        this.cursor.set(null);
    }

    /** Discard an in-progress freehand trace (ESC / deactivate). */
    private cancelTrace(): void {
        if (this.placePress) {
            this.placePress = null;
            this.ctx?.map.map.peek()?.dragPan.enable();
        }
        if (!this.traceGesture) return;
        this.traceGesture = null;
        this.trace.set(null);
        this.ctx?.map.map.peek()?.dragPan.enable();
    }

    /** Abort an in-progress duplicate-drag / stamp-drag without committing. */
    private cancelStampDrag(): void {
        if (!this.stampDrag) return;
        this.stampDrag = null;
        this.dragGhost.set(null);
        this.ctx?.map.map.peek()?.dragPan.enable();
    }

    /**
     * Commit a set of clones translated by (dx, dy) as ONE history entry and
     * select them — the shared drop-commit for the Alt-duplicate-drag and each
     * repeat stamp (T42). Mirrors `duplicateSelection`'s create-diff shape
     * (`before: null`, `beforeVersion: null`). Returns the created features, or
     * null if a save failed (history is dropped via the saveError watcher).
     */
    async stampClones(sources: StampSource[], dx: number, dy: number): Promise<CourseFeature[] | null> {
        const features = this.features;
        if (!features || sources.length === 0) return null;
        const entry: HistoryEntry = [];
        const created: CourseFeature[] = [];
        for (const s of sources) {
            const c = await features.create({
                type: s.type,
                holeId: s.holeId,
                layer: s.layer,
                geometry: translateGeometry(s.geometry, dx, dy),
                attributes: s.attributes ?? null,
            });
            if (!c) return null; // save failed
            entry.push({ featureId: c.id, before: null, after: snapshotOf(c), beforeVersion: null });
            created.push(c);
        }
        features.setSelection(created.map(c => c.id));
        this.history.push(entry);
        return created;
    }

    // ── Hit testing ───────────────────────────────────────────────────────

    /**
     * Topmost-in-stack VISIBLE feature containing the EPSG:3006 point (D23):
     * the first element of `hitStack` — the SAME rule render, `hitGreen` and
     * lie classification now share. Hidden types are not selectable, nor are
     * unarmed outline-only types (see `unhittableTypes`).
     */
    private hitFeature(p: Point): CourseFeature | null {
        return this.hitStack(p)[0] ?? null;
    }

    /**
     * ALL hittable features containing `p`, topmost-first (D23 stack order).
     * Drives Alt/Option+click cycling (D27) — repeated alt-clicks step down
     * this list. `hitFeature` is just its first element.
     *
     * "Hittable" is `unhittableTypes`: visible, and either a filled type or
     * the outline-only type the picker currently has armed. In Vegetation
     * mode the creeks and water are hittable too (`scopeSelectsType`), in
     * `vegetationHitOrder`.
     */
    private hitStack(p: Point): CourseFeature[] {
        const features = this.features;
        if (!features) return [];
        if (this.scope.peek() === 'rules') {
            return features.stackTopDown.peek()
                .filter(f => isRulesType(f.type) && !features.isHidden(f) && this.grabs(f, p));
        }
        const scope = this.scope.peek();
        const roughsOff = features.roughsLayerOff.peek();
        const stack = features.stackTopDown.peek()
            .filter(f => scopeSelectsType(scope, f.type) && !(roughsOff && f.layer === ROUGHS_LAYER));
        return containingTopDown(
            scope === 'vegetation' ? vegetationHitOrder(stack) : stack,
            unhittableTypes(features.effectiveHiddenTypes.peek(), this.drawType.peek()),
            p,
            features.hiddenIds.peek(),
            features.hiddenSources.peek(),
        );
    }

    /**
     * Whether a press at `p` lands on `f`: inside it, or for a boundary-only
     * type (OOB, a ring round the whole property whose inside is the course)
     * within RULE_LINE_HIT_PX of its line.
     */
    private grabs(f: CourseFeature, p: Point): boolean {
        if (!OUTLINE_ONLY_TYPES.has(f.type as FeatureType)) return pointInGeometry(p, f.geometry);
        const zoom = this.ctx?.map.zoom.peek() ?? 18;
        const { lat } = sweref99tmToWgs84(p.x, p.y);
        const tol = RULE_LINE_HIT_PX * (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / 2 ** (zoom + 8);
        return f.geometry.rings.some(ring => {
            const converted = f.geometry.curveType === 'bspline' ? bsplineRingToBezierWithMap(ring) : null;
            const hit = nearestOnRing(converted ? converted.ring : ring, p);
            return hit !== null && hit.dist <= tol;
        });
    }

    /**
     * Track which vertex of the selected feature the cursor is over
     * (select mode, no drag in progress) — the 'C' toggle target. Sticky:
     * cleared only on selection change, not when the cursor leaves.
     */
    private trackHoverVertex(e: MapPointerEvent): void {
        const selected = this.features?.editableSelected.peek();
        const map = this.ctx?.map.map.peek();
        if (!selected || !map) return;
        // Per-mousemove: terrain-precise only while the shape is small
        // enough that the DEM raycasts stay cheap (see hitVertexOrHandle).
        const vertexCount = editViewOf(selected.geometry).rings.reduce((n, r) => n + r.points.length, 0);
        const hit = this.hitVertexOrHandle(map, selected, e.point, vertexCount <= PRECISE_HOVER_MAX_VERTICES);
        if (!hit || hit.kind !== 'anchor') return;
        const current = this.hoverVertex.peek();
        if (current && current.ringIdx === hit.ringIdx && current.idx === hit.idx) return;
        this.hoverVertex.set({ ringIdx: hit.ringIdx, idx: hit.idx });
    }

    private hitVertexOrHandle(
        map: MaplibreMap,
        feature: CourseFeature,
        screen: { x: number; y: number },
        precise = true,
    ): { kind: 'anchor' | 'handle'; which?: 'hIn' | 'hOut'; ringIdx: number; idx: number } | null {
        // Vertex lng/lat are cached per geometry (invariant until the shape is
        // edited). `precise` projects with map.project, which places the point
        // ON the terrain exactly where the draped vertex markers render. The
        // flat transform ignores elevation: on a pitched view that misses the
        // marker by far more than the hit radius, so a press on a node fell
        // through to the whole-shape move. map.project raycasts the DEM
        // (~40 us/call) though, so a per-mouse-move hover on a large imported
        // shape (hundreds of vertices) opts out and takes the flat transform.
        const rings = vertexLngLatFor(editViewOf(feature.geometry));
        const tr = map.transform as unknown as {
            locationToScreenPoint?: (l: { lng: number; lat: number }) => { x: number; y: number };
        };
        const project = !precise && tr.locationToScreenPoint
            ? (ll: Position) => tr.locationToScreenPoint!({ lng: ll[0], lat: ll[1] })
            : (ll: Position) => map.project(ll as [number, number]);
        const pxDistTo = (ll: Position): number => {
            const pr = project(ll);
            return Math.hypot(pr.x - screen.x, pr.y - screen.y);
        };
        // Handles first: they are smaller and rendered on top. (B-spline
        // control points have no handles — the scan is a no-op there.)
        for (let r = 0; r < rings.length; r++) {
            const { hIn, hOut } = rings[r];
            for (let i = 0; i < hIn.length; i++) {
                const inLl = hIn[i];
                if (inLl && pxDistTo(inLl) < HANDLE_HIT_PX) {
                    return { kind: 'handle', which: 'hIn', ringIdx: r, idx: i };
                }
                const outLl = hOut[i];
                if (outLl && pxDistTo(outLl) < HANDLE_HIT_PX) {
                    return { kind: 'handle', which: 'hOut', ringIdx: r, idx: i };
                }
            }
        }
        // Nearest anchor within reach, not the first: closely spaced control
        // points otherwise grab whichever comes first in ring order.
        let best: { kind: 'anchor'; ringIdx: number; idx: number } | null = null;
        let bestDist = VERTEX_HIT_PX;
        for (let r = 0; r < rings.length; r++) {
            const { anchor } = rings[r];
            for (let i = 0; i < anchor.length; i++) {
                const d = pxDistTo(anchor[i]);
                if (d < bestDist) {
                    bestDist = d;
                    best = { kind: 'anchor', ringIdx: r, idx: i };
                }
            }
        }
        return best;
    }

    /**
     * If the EPSG:3006 point lies within EDGE_HIT_PX of the selected
     * feature's outline (but not near an existing vertex), return the
     * insertion spot.
     *
     * - bezier ('anchor'): curve-preserving de Casteljau split at (segIdx, t).
     * - bspline ('control'): a new smooth control at the nearest curve
     *   point, spliced after control `afterIdx` (the conversion's
     *   segment → control map picks the bracketing controls).
     */
    private edgeInsertionHit(
        feature: CourseFeature,
        p: Point,
        lat: number,
    ):
        | { kind: 'anchor'; ringIdx: number; segIdx: number; t: number }
        | { kind: 'control'; ringIdx: number; afterIdx: number; point: Point }
        | null {
        const zoom = this.ctx?.map.zoom.peek() ?? 18;
        const metersPerPx = (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / 2 ** (zoom + 8);
        const tol = EDGE_HIT_PX * metersPerPx;
        const centerline = feature.geometry.centerline;
        if (centerline) {
            // A road: click ON its line (open — no closing segment) to add a
            // control point where the line runs, between the span's ends.
            const hit = nearestOnCenterline(centerline.points, p);
            if (!hit || hit.dist > tol) return null;
            if (centerline.points.some(a => Math.hypot(a.x - p.x, a.y - p.y) < tol * 2)) return null;
            return { kind: 'control', ringIdx: 0, afterIdx: hit.span, point: hit.point };
        }
        const isSpline = feature.geometry.curveType === 'bspline';

        for (let r = 0; r < feature.geometry.rings.length; r++) {
            const ring = feature.geometry.rings[r];
            // For splines, hit-test the ACTUAL curve (bezier equivalent),
            // not the control polygon.
            const converted = isSpline ? bsplineRingToBezierWithMap(ring) : null;
            const hit = nearestOnRing(converted ? converted.ring : ring, p);
            if (!hit || hit.dist > tol) continue;
            // Too close to an existing vertex (control point for splines)
            // → treat as a missed vertex grab, not an insertion.
            const nearVertex = ring.points.some(
                a => Math.hypot(a.x - p.x, a.y - p.y) < tol * 2,
            );
            if (nearVertex) continue;
            if (converted) {
                return {
                    kind: 'control',
                    ringIdx: r,
                    afterIdx: converted.segInsertAfter[hit.segIdx],
                    point: hit.point,
                };
            }
            return { kind: 'anchor', ringIdx: r, segIdx: hit.segIdx, t: hit.t };
        }
        return null;
    }

    /** Screen-pixel distance from an EPSG:3006 point to a screen position. */
    private screenDist(p: Point, screen: { x: number; y: number }, map?: MaplibreMap): number {
        const m = map ?? this.ctx?.map.map.peek();
        if (!m) return Infinity;
        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
        const projected = m.project([lon, lat]);
        return Math.hypot(projected.x - screen.x, projected.y - screen.y);
    }

    private pxDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    // ── Preview overlay ───────────────────────────────────────────────────

    /**
     * Draft outline + selected-feature vertex/handle markers + marquee
     * rectangle + armed offset/simplify preview, as a WGS84
     * FeatureCollection. Vertex markers render only for a SINGLE selected
     * feature (multi-select shows the outline highlight from the features
     * overlay instead).
     */
    private previewGeojson(): FeatureCollection {
        const features: Feature[] = [];
        const toLngLat = (p: Point): Position => {
            const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
            return [lon, lat];
        };

        if (this.state.isDrawing.get()) {
            // Live freehand-trace stroke (T40): the raw sampled polyline as
            // the familiar dashed draft line (samples are plain points, so
            // no flattening is needed).
            const trace = this.trace.get();
            if (trace) {
                if (trace.length >= 2) {
                    features.push({
                        type: 'Feature',
                        properties: { role: 'draft-line' },
                        geometry: { type: 'LineString', coordinates: trace.map(p => toLngLat(p)) },
                    });
                }
                return { type: 'FeatureCollection', features };
            }

            const draft = this.state.draft.get();
            const cursor = this.cursor.get();
            // Preview controls: placed points + the cursor as a provisional
            // smooth control (rubber-band).
            const controls: AnchorPoint[] = [...draft];
            if (cursor) controls.push(lngLatToSweref99tm(cursor));

            // In-progress b-spline drawing shows the open control path only,
            // Inkscape-style: no closed-curve extrapolation and no fill until
            // the user explicitly closes the ring. A path shows the curve its
            // centerline will be.
            const path = this.pathMode.get() && controls.length >= 2;
            const line = (path
                ? flattenCenterline(autoCorners(controls, PATH_CORNER_TURN_DEG)).map(q => [q.x, q.y] as [number, number])
                : flattenOpenPath(controls, 0.25)
            ).map(([x, y]) => toLngLat({ x, y }));
            if (line.length >= 2) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'draft-line' },
                    geometry: { type: 'LineString', coordinates: line },
                });
            }
            // Path mode: the corridor Enter will commit, around the centerline.
            if (path) {
                const corridor = draftCenterlineGeometry(controls, this.pathWidthM.get());
                for (const ring of corridor?.rings ?? []) {
                    const coords = ring.points.map(q => toLngLat(q));
                    coords.push(coords[0]);
                    features.push({
                        type: 'Feature',
                        properties: { role: 'draft-line' },
                        geometry: { type: 'LineString', coordinates: coords },
                    });
                }
            }
            draft.forEach((p, i) => {
                features.push({
                    type: 'Feature',
                    properties: { role: i === 0 ? 'first-vertex' : p.corner ? 'vertex-corner' : 'vertex' },
                    geometry: { type: 'Point', coordinates: toLngLat(p) },
                });
            });
            return { type: 'FeatureCollection', features };
        }

        // Drag ghosts: live fill + outline of the feature(s) being dragged
        // (whole-feature move or vertex/handle edit). The originals are
        // hidden via feature-state while these render, so the ACTUAL shape
        // appears to follow the cursor — at the cost of re-flattening only
        // the dragged features, not the whole course.
        const ghosts = this.dragGhost.get();
        if (ghosts) {
            for (const ghost of ghosts) {
                features.push({
                    type: 'Feature',
                    // Carry the original feature's D24 stackKey so the ghost
                    // z-sorts identically to the persistent overlay (the
                    // ghost-fill layer sorts on it, not the type heuristic).
                    properties: {
                        role: 'ghost',
                        type: ghost.type,
                        stackKey: this.features?.stackKeyForId(ghost.id) ?? 0,
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: geometryToWgs84Rings(ghost.geometry),
                    },
                });
            }
        }

        // Marquee rectangle (feature or vertex selection drag).
        const marquee = this.marquee.get();
        if (marquee) {
            const r = rectFromCorners(marquee.start, marquee.current);
            const corners: Position[] = [
                toLngLat({ x: r.minX, y: r.minY }),
                toLngLat({ x: r.maxX, y: r.minY }),
                toLngLat({ x: r.maxX, y: r.maxY }),
                toLngLat({ x: r.minX, y: r.maxY }),
            ];
            corners.push(corners[0]);
            features.push({
                type: 'Feature',
                properties: { role: 'marquee' },
                geometry: { type: 'Polygon', coordinates: [corners] },
            });
        }

        // Armed offset/simplify preview: dashed outline of the result.
        const opPreview = this.opPreviewGeometry.get();
        if (opPreview) {
            for (const ring of opPreview.rings) {
                const flat = flattenRing(ring, 0.25, opPreview.curveType);
                if (flat.length < 2) continue;
                const line = flat.map(([x, y]) => toLngLat({ x, y }));
                line.push(line[0]);
                features.push({
                    type: 'Feature',
                    properties: { role: 'op-preview' },
                    geometry: { type: 'LineString', coordinates: line },
                });
            }
        }

        const selected = this.selectedForPreview();
        if (selected) {
            // While dragging, markers/handles/cage follow the live ghost
            // geometry (the store keeps the pre-drag shape until commit).
            const live = ghosts?.find(g => g.id === selected.id)?.geometry ?? selected.geometry;
            // A road's markers are its centerline's control points (the edit
            // view), drawn on the line itself instead of a control cage.
            const geometry = editViewOf(live);
            const isSpline = geometry.curveType === 'bspline';
            const vertexSel = this.vertexSelection.get();
            if (live.centerline) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'centerline' },
                    geometry: { type: 'LineString', coordinates: flattenCenterline(live.centerline.points).map(q => toLngLat(q)) },
                });
            }
            geometry.rings.forEach((ring, ringIdx) => {
                if (isSpline && ring.points.length >= 2 && !live.centerline) {
                    // Control cage: the off-curve control polygon, so
                    // the pull relationship is visible.
                    const cage = ring.points.map((p: AnchorPoint) => toLngLat(p));
                    cage.push(cage[0]);
                    features.push({
                        type: 'Feature',
                        properties: { role: 'control-cage' },
                        geometry: { type: 'LineString', coordinates: cage },
                    });
                }
                ring.points.forEach((p: AnchorPoint, idx: number) => {
                    if (!isSpline) {
                        for (const which of ['hIn', 'hOut'] as const) {
                            const handle = p[which];
                            if (!handle) continue;
                            features.push({
                                type: 'Feature',
                                properties: { role: 'handle-line' },
                                geometry: { type: 'LineString', coordinates: [toLngLat(p), toLngLat(handle)] },
                            });
                            features.push({
                                type: 'Feature',
                                properties: { role: 'handle' },
                                geometry: { type: 'Point', coordinates: toLngLat(handle) },
                            });
                        }
                    }
                    const role = vertexSel.has(vertexKey(ringIdx, idx))
                        ? 'vertex-selected'
                        : isSpline && p.corner ? 'vertex-corner' : 'vertex';
                    features.push({
                        type: 'Feature',
                        properties: { role },
                        geometry: { type: 'Point', coordinates: toLngLat(p) },
                    });
                });
            });
        }
        return { type: 'FeatureCollection', features };
    }

    /** Reactive read of the selected feature (null when tool inactive). */
    private selectedForPreview(): CourseFeature | null {
        return this.features ? this.features.editableSelected.get() : null;
    }
}

/** Preview overlay layer specs (ids prefixed with the overlay id). */
function previewLayers(): OverlayLayerSpec[] {
    const role = (value: string): FilterSpecification =>
        ['==', ['get', 'role'], value] as FilterSpecification;
    const outlineOnly = (): FilterSpecification =>
        ['in', ['get', 'type'], ['literal', [...OUTLINE_ONLY_TYPES]]] as unknown as FilterSpecification;
    return [
        {
            // Drag ghosts: palette-true live copies of dragged features
            // (their hidden originals' stand-in). Same colors/opacity and
            // z-sort as the main features overlay so a drag is visually
            // seamless.
            id: 'draw-ghost-fill',
            type: 'fill',
            // Outline-only types (OOB) have no fill to ghost — dragging one
            // would flash a course-wide white blob. `draw-ghost-line` below
            // carries them, in the same bone white the map paints them.
            filter: ['all', role('ghost'), ['!', outlineOnly()]] as FilterSpecification,
            layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
            paint: {
                'fill-color': typeColorExpression('draw') as never,
                'fill-opacity': DRAW_FILL_OPACITY,
            },
        },
        {
            id: 'draw-ghost-line',
            type: 'line',
            filter: role('ghost'),
            paint: {
                'line-color': typeColorExpression('outline') as never,
                'line-width': 1.5,
            },
        },
        {
            id: 'draw-draft-fill',
            type: 'fill',
            filter: role('draft-fill'),
            paint: { 'fill-color': SELECTION_COLOR, 'fill-opacity': 0.15 },
        },
        {
            id: 'draw-marquee-fill',
            type: 'fill',
            filter: role('marquee'),
            paint: { 'fill-color': CAT.sky /* '#6FA8C9' — --data-cat-7 */, 'fill-opacity': 0.12 },
        },
        {
            id: 'draw-marquee-line',
            type: 'line',
            filter: role('marquee'),
            paint: { 'line-color': CAT.sky /* '#6FA8C9' — --data-cat-7 */, 'line-width': 1.5, 'line-dasharray': [2, 2] },
        },
        {
            id: 'draw-draft-line',
            type: 'line',
            filter: role('draft-line'),
            paint: { 'line-color': SELECTION_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        {
            // Armed offset/simplify result: dashed "what you'll get" line —
            // amber = armed-but-uncommitted state.
            id: 'draw-op-preview',
            type: 'line',
            filter: role('op-preview'),
            paint: { 'line-color': STATUS_RISK /* '#C68A2E' — --data-risk */, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        {
            // A selected road's centerline: the line its points edit.
            id: 'draw-centerline',
            type: 'line',
            filter: role('centerline'),
            paint: { 'line-color': SELECTION_COLOR, 'line-width': 2, 'line-opacity': 0.9 },
        },
        {
            id: 'draw-handle-lines',
            type: 'line',
            filter: role('handle-line'),
            paint: { 'line-color': OVERLAY_TEXT /* --overlay-text */, 'line-width': 1, 'line-opacity': 0.8 },
        },
        {
            id: 'draw-control-cage',
            type: 'line',
            filter: role('control-cage'),
            paint: {
                'line-color': OVERLAY_TEXT, // --overlay-text
                'line-width': 1,
                'line-opacity': 0.5,
                'line-dasharray': [1, 2],
            },
        },
        {
            id: 'draw-vertices',
            type: 'circle',
            filter: ['in', ['get', 'role'], ['literal', ['vertex', 'first-vertex']]] as FilterSpecification,
            paint: {
                'circle-radius': ['case', ['==', ['get', 'role'], 'first-vertex'], 7, 5] as never,
                'circle-color': OVERLAY_TEXT, // '#FFFFFF' — --overlay-text
                'circle-stroke-color': MARKER_FILL, // '#1E2B22' — --color-surface-brand
                'circle-stroke-width': 2,
            },
        },
        {
            // Corner control points: visually distinct from smooth ones.
            id: 'draw-vertices-corner',
            type: 'circle',
            filter: role('vertex-corner'),
            paint: {
                'circle-radius': 5,
                'circle-color': CAT.wheat, // '#D8A441' — --data-cat-3
                'circle-stroke-color': MARKER_FILL, // --color-surface-brand
                'circle-stroke-width': 2,
            },
        },
        {
            // Multi-vertex selection members (bulk delete / 'I' insert).
            id: 'draw-vertices-selected',
            type: 'circle',
            filter: role('vertex-selected'),
            paint: {
                'circle-radius': 6,
                'circle-color': SELECTION_COLOR,
                'circle-stroke-color': MARKER_FILL, // --color-surface-brand
                'circle-stroke-width': 2,
            },
        },
        {
            id: 'draw-handles',
            type: 'circle',
            filter: role('handle'),
            paint: {
                'circle-radius': 4,
                'circle-color': CAT.sky, // '#6FA8C9' — --data-cat-7 (pairs with the marquee)
                'circle-stroke-color': OVERLAY_TEXT, // --overlay-text
                'circle-stroke-width': 1.5,
            },
        },
    ];
}
