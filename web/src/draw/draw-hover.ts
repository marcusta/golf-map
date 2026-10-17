import type { Signal } from '@basics/core/client/core';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { MapPointerEvent } from '../map/map.service';
import type { FeaturesService } from './features.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { ROUGHS_LAYER } from '../../../shared/render/stack-key';
import { nearestOnCenterline } from '../../../shared/features/centerline';
import { takesBankVeg } from '../../../shared/features/creek-vegetation';
import {
    applyVertexEdit,
    editViewOf,
    insertAnchor,
    insertControlPoint,
} from './draw-state';
import { nearestOnRing, pointInGeometry, type FeatureGeometry, type Point } from '../geo/bezier';
import { bsplineBezierCached } from '../geo/flat-cache';
import { sweref99tmToWgs84 } from '../geo/transform';
import { OUTLINE_ONLY_TYPES, isRulesType, isVegetationType, type FeatureType } from './feature-palette';
import { isGeneratedFeature } from './generated-features';
import { hitScreenPoints, terrainOn, type ScreenHit, type ScreenPointCache } from './screen-cache';

// Hit-testing and hover tracking for the draw tool. Feature hits use the
// shared stack rule (`containingTopDown`), narrowed to what the engine's
// scope edits; vertex and handle hits read the ScreenPointCache (flat
// projection, terrain-precise where the terrain would move the markers).

// Screen-space hit tolerances (px)
const VERTEX_HIT_PX = 9;
const HANDLE_HIT_PX = 7;
const EDGE_HIT_PX = 6;
/** Screen-px reach of a boundary-only line (OOB) for selecting and grabbing it. */
const RULE_LINE_HIT_PX = 8;
/**
 * Hover hit-tests on shapes up to this many vertices use terrain-precise
 * projection (~40 us/vertex, once per camera state); larger shapes hover on
 * the flat transform.
 */
const PRECISE_HOVER_MAX_VERTICES = 150;

/** A vertex of the single selected feature, by ring and index. */
export interface VertexRef {
    ringIdx: number;
    idx: number;
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

/**
 * What hover tracking reads and writes on the draw tool. `map` and `zoom`
 * come from the active ToolContext (null and 18 while the tool is inactive).
 */
export interface DrawHoverHost {
    readonly features: FeaturesService | null;
    readonly map: MaplibreMap | null;
    readonly zoom: number;
    readonly screenPoints: ScreenPointCache;
    readonly hoverVertex: Signal<VertexRef | null>;
    /** What the engine edits right now: narrows every feature hit (see `DrawScope`). */
    readonly scope: Signal<DrawScope>;
    /** The armed draw type: the one outline-only type that is hittable (see `unhittableTypes`). */
    readonly drawType: Signal<FeatureType>;
}

/** Where an edge press inserts: a bezier split or a b-spline control. */
type EdgeInsertion =
    | { kind: 'anchor'; ringIdx: number; segIdx: number; t: number }
    | { kind: 'control'; ringIdx: number; afterIdx: number; point: Point };

/** Ground meters per screen pixel at `zoom` and latitude `lat` (web mercator, 512 px tiles). */
export function metersPerPixel(zoom: number, lat: number): number {
    return (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / 2 ** (zoom + 8);
}

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
export function hitStack(host: DrawHoverHost, p: Point): CourseFeature[] {
    const features = host.features;
    if (!features) return [];
    const scope = host.scope.peek();
    if (scope === 'rules') {
        return features.stackTopDown.peek()
            .filter(f => isRulesType(f.type) && !features.isHidden(f) && grabs(host, f, p));
    }
    const roughsOff = features.roughsLayerOff.peek();
    const stack = features.stackTopDown.peek()
        .filter(f => scopeSelectsType(scope, f.type) && !(roughsOff && f.layer === ROUGHS_LAYER));
    return containingTopDown(
        scope === 'vegetation' ? vegetationHitOrder(stack) : stack,
        unhittableTypes(features.effectiveHiddenTypes.peek(), host.drawType.peek()),
        p,
        features.effectiveHiddenIds.peek(),
        features.hiddenSources.peek(),
    );
}

/**
 * Topmost-in-stack VISIBLE feature containing the EPSG:3006 point (D23):
 * the first element of `hitStack` — the SAME rule render, `hitGreen` and
 * lie classification now share. Hidden types are not selectable, nor are
 * unarmed outline-only types (see `unhittableTypes`).
 */
export function hitFeature(host: DrawHoverHost, p: Point): CourseFeature | null {
    return hitStack(host, p)[0] ?? null;
}

/**
 * Whether a press at `p` lands on `f`: inside it, or for a boundary-only
 * type (OOB, a ring round the whole property whose inside is the course)
 * within RULE_LINE_HIT_PX of its line.
 */
export function grabs(host: DrawHoverHost, f: CourseFeature, p: Point): boolean {
    if (!OUTLINE_ONLY_TYPES.has(f.type as FeatureType)) return pointInGeometry(p, f.geometry);
    const { lat } = sweref99tmToWgs84(p.x, p.y);
    const tol = RULE_LINE_HIT_PX * metersPerPixel(host.zoom, lat);
    return f.geometry.rings.some(ring => {
        const converted = f.geometry.curveType === 'bspline' ? bsplineBezierCached(ring) : null;
        const hit = nearestOnRing(converted ? converted.ring : ring, p);
        return hit !== null && hit.dist <= tol;
    });
}

export function hitVertexOrHandle(
    screenPoints: ScreenPointCache,
    map: MaplibreMap,
    feature: CourseFeature,
    screen: { x: number; y: number },
    precise = true,
): ScreenHit | null {
    // Screen points are cached per (geometry identity, camera state):
    // the first scan after a camera move projects every anchor and
    // handle once, later scans read the cache, and a cursor outside the
    // feature's screen bbox costs one test. The points are those of the
    // edit view: on a road, its centerline's control points.
    //
    // `precise` projects ON the terrain, exactly where the draped vertex
    // markers render (see screen-cache.ts); it only differs from the flat
    // transform with terrain on, so without terrain the flat one serves.
    // A per-mouse-move hover on a large imported shape (hundreds of
    // vertices) opts out and takes the flat transform.
    const sp = screenPoints.get(map, editViewOf(feature.geometry), precise && terrainOn(map));
    // Nearest anchor within reach, not the first: closely spaced control
    // points otherwise grab whichever comes first in ring order.
    return hitScreenPoints(sp, screen.x, screen.y, HANDLE_HIT_PX, VERTEX_HIT_PX, true);
}

/**
 * Pointer move with no gesture in progress (select mode).
 *
 * Hover highlighting only matters with the mouse button up. While a
 * button is held the user is panning (or dragging) — skip the
 * O(vertices) hover hit-test, which otherwise re-projects every
 * vertex of the selected shape on every frame of a pan (2-5 fps on
 * a large rough).
 */
export function hoverOnPointerMove(host: DrawHoverHost, e: MapPointerEvent): void {
    if (e.originalEvent.buttons === 0) trackHoverVertex(host, e);
}

/**
 * Track which vertex of the selected feature the cursor is over
 * (select mode, no drag in progress) — the 'C' toggle target. Sticky:
 * cleared only on selection change, not when the cursor leaves.
 */
function trackHoverVertex(host: DrawHoverHost, e: MapPointerEvent): void {
    const selected = host.features?.editableSelected.peek();
    const map = host.map;
    if (!selected || !map) return;
    // Per-mousemove: terrain-precise only while the shape is small
    // enough that the DEM raycasts stay cheap (see hitVertexOrHandle).
    const vertexCount = editViewOf(selected.geometry).rings.reduce((n, r) => n + r.points.length, 0);
    const hit = hitVertexOrHandle(host.screenPoints, map, selected, e.point, vertexCount <= PRECISE_HOVER_MAX_VERTICES);
    if (!hit || hit.kind !== 'anchor') return;
    const current = host.hoverVertex.peek();
    if (current && current.ringIdx === hit.ringIdx && current.idx === hit.idx) return;
    host.hoverVertex.set({ ringIdx: hit.ringIdx, idx: hit.idx });
}

/**
 * If the EPSG:3006 point lies within EDGE_HIT_PX of the selected
 * feature's outline (but not near an existing vertex), return the
 * insertion spot. `zoom` converts the pixel tolerance to meters at `lat`.
 *
 * - bezier ('anchor'): curve-preserving de Casteljau split at (segIdx, t).
 * - bspline ('control'): a new smooth control at the nearest curve
 *   point, spliced after control `afterIdx` (the conversion's
 *   segment → control map picks the bracketing controls).
 * - centerline ('control', ring 0 of the edit view): a new control point
 *   on the road's line, between the ends of the span it lies on.
 */
export function edgeInsertionHit(
    feature: CourseFeature,
    p: Point,
    lat: number,
    zoom: number,
): EdgeInsertion | null {
    const tol = EDGE_HIT_PX * metersPerPixel(zoom, lat);
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
        const converted = isSpline ? bsplineBezierCached(ring) : null;
        const hit = nearestOnRing(converted ? converted.ring : ring, p, tol);
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

/**
 * Apply an edge insertion to the geometry's edit view (a road's centerline;
 * else the geometry itself); returns the new geometry and the new vertex
 * index in that view, or null when the line degenerated. Pure.
 */
export function applyInsertion(
    geometry: FeatureGeometry,
    insertion: EdgeInsertion,
): { geometry: FeatureGeometry; idx: number } | null {
    const inserted = applyVertexEdit(geometry, view => insertion.kind === 'control'
        ? insertControlPoint(view, insertion.ringIdx, insertion.afterIdx, insertion.point)
        : insertAnchor(view, insertion.ringIdx, insertion.segIdx, insertion.t));
    if (!inserted) return null;
    return {
        geometry: inserted,
        idx: insertion.kind === 'control' ? insertion.afterIdx + 1 : insertion.segIdx + 1,
    };
}
