import type { Signal } from '@basics/core/client/core';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { MapPointerEvent } from '../map/map.service';
import type { FeaturesService } from './features.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    insertAnchor,
    insertControlPoint,
} from './draw-state';
import { nearestOnRing, pointInGeometry, type FeatureGeometry, type Point } from '../geo/bezier';
import { bsplineBezierCached } from '../geo/flat-cache';
import { hitScreenPoints, type ScreenHit, type ScreenPointCache } from './screen-cache';

// Hit-testing and hover tracking for the draw tool. Feature hits use the
// shared stack rule (`containingTopDown`); vertex and handle hits read the
// flat-projected ScreenPointCache, never the terrain-aware map.project.

// Screen-space hit tolerances (px)
const VERTEX_HIT_PX = 9;
const HANDLE_HIT_PX = 7;
const EDGE_HIT_PX = 6;

/** A vertex of the single selected feature, by ring and index. */
export interface VertexRef {
    ringIdx: number;
    idx: number;
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
}

/** Where an edge press inserts: a bezier split or a b-spline control. */
export type EdgeInsertion =
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
 * ALL visible features containing `p`, topmost-first (D23 stack order).
 * Drives Alt/Option+click cycling (D27) — repeated alt-clicks step down
 * this list. `hitFeature` is just its first element.
 */
export function hitStack(features: FeaturesService | null, p: Point): CourseFeature[] {
    if (!features) return [];
    return containingTopDown(
        features.stackTopDown.peek(),
        features.hiddenTypes.peek(),
        p,
        features.hiddenIds.peek(),
        features.hiddenSources.peek(),
    );
}

/**
 * Topmost-in-stack VISIBLE feature containing the EPSG:3006 point (D23):
 * the first element of `hitStack` — the SAME rule render, `hitGreen` and
 * lie classification now share. Hidden types are not selectable.
 */
export function hitFeature(features: FeaturesService | null, p: Point): CourseFeature | null {
    return hitStack(features, p)[0] ?? null;
}

export function hitVertexOrHandle(
    screenPoints: ScreenPointCache,
    map: MaplibreMap,
    feature: CourseFeature,
    screen: { x: number; y: number },
): ScreenHit | null {
    // Screen points are cached per (geometry identity, camera state):
    // the first scan after a camera move projects every anchor and
    // handle once with the flat transform, later scans read the cache,
    // and a cursor outside the feature's screen bbox costs one test.
    // Hit order and radii are those of the old per-event scan.
    const sp = screenPoints.get(map, feature.geometry);
    return hitScreenPoints(sp, screen.x, screen.y, HANDLE_HIT_PX, VERTEX_HIT_PX);
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
    const hit = hitVertexOrHandle(host.screenPoints, map, selected, e.point);
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
 */
export function edgeInsertionHit(
    feature: CourseFeature,
    p: Point,
    lat: number,
    zoom: number,
): EdgeInsertion | null {
    const tol = EDGE_HIT_PX * metersPerPixel(zoom, lat);
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

/** Apply an edge insertion; returns the new geometry and the new vertex index. Pure. */
export function applyInsertion(
    geometry: FeatureGeometry,
    insertion: EdgeInsertion,
): { geometry: FeatureGeometry; idx: number } {
    if (insertion.kind === 'control') {
        return {
            geometry: insertControlPoint(geometry, insertion.ringIdx, insertion.afterIdx, insertion.point),
            idx: insertion.afterIdx + 1,
        };
    }
    return {
        geometry: insertAnchor(geometry, insertion.ringIdx, insertion.segIdx, insertion.t),
        idx: insertion.segIdx + 1,
    };
}
