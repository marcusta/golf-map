import type { Signal } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { ToolContext } from '../editor/tool';
import { bindDrag, type DragBinding } from '../editor/drag-binding';
import { screenDistSweref } from '../editor/screen-point';
import type { MapPointerEvent } from '../map/map.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { lngLatToSweref99tm } from '../geo/transform';
import { pointInGeometry, type FeatureGeometry, type Point } from '../geo/bezier';
import {
    TraceGesture,
    moveAnchor,
    moveHandle,
    setSymmetricHandles,
    clearHandles,
    hasHandles,
    deleteAnchor,
    translateGeometry,
    translateAnchors,
    featuresInRect,
    verticesInRect,
    rectFromCorners,
    vertexKey,
    type DrawState,
} from './draw-state';
import type { HistoryEntry } from './history';
import type { FrameSignal } from './draw-frame';
import {
    advanceAltCycle,
    applyInsertion,
    edgeInsertionHit,
    hitFeature,
    hitStack,
    hitVertexOrHandle,
    hoverOnPointerMove,
    type DrawHoverHost,
} from './draw-hover';

// Pointer gestures of the draw tool: click, press, move and release under the
// draw claim, plus dblclick and contextmenu. Gesture state lives on the
// DrawToolService and is reached through DrawPointerHost; this module holds
// no state of its own.

/** Interaction-claim id AND overlay id prefix for the draw tool. */
export const DRAW_TOOL_ID = 'draw';

const CLOSE_RING_PX = 12;
const DRAG_MOVE_THRESHOLD_PX = 3;
/** Feature-move drag: movement registers past this (prototype: 2 px). */
const MOVE_THRESHOLD_PX = 2;
/** Marquee: below this the gesture counts as a click (prototype: 5 px). */
const MARQUEE_MIN_PX = 5;

export interface DragTarget {
    /**
     * 'anchor' moves one anchor to the cursor; 'anchors' translates every
     * vertex in `keys` by the grabbed anchor's displacement.
     */
    kind: 'anchor' | 'anchors' | 'handle' | 'newHandles';
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
    /**
     * Geometry the drag ops derive from. Equals `startGeometry` except
     * after an edge press, where it carries the inserted vertex.
     */
    baseGeometry: FeatureGeometry;
    /** True when the press inserted the vertex on an edge (24a). */
    inserted: boolean;
    /** Vertex keys moved together for kind 'anchors'. */
    keys: string[];
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
export interface MoveDrag {
    startEpsg: Point;
    startScreen: { x: number; y: number };
    features: Array<{ id: string; geometry: FeatureGeometry; type: string; holeId: string | null; version: number }>;
    moved: boolean;
    /** Cumulative EPSG:3006 translation of the drag so far. */
    dx: number;
    dy: number;
}

/** A dragged feature's live copy, rendered in the preview overlay. */
export interface GhostFeature {
    id: string;
    type: string;
    geometry: FeatureGeometry;
}

/** A source feature captured for cloning (Alt-duplicate-drag / repeat stamp). */
export interface StampSource {
    /** Original feature id — the ghost borrows its stackKey for z-order. */
    id: string;
    type: string;
    holeId: string | null;
    geometry: FeatureGeometry;
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
export interface StampDrag {
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
export interface StampTemplate {
    anchor: Point;
    templates: StampSource[];
}

/** Marquee rectangle drag ('features' on empty ground, 'vertices' via Shift). */
export interface Marquee {
    kind: 'features' | 'vertices';
    start: Point;
    current: Point;
    startScreen: { x: number; y: number };
}

/** Alt/Option+click cycle state (D27); see `DrawPointerHost.altCycle`. */
export interface AltCycle {
    ids: string[];
    index: number;
}

/**
 * What the pointer gestures read and write on the draw tool. The writable
 * fields are the tool's live gesture state; the methods are its commit
 * funnels (one history entry each).
 */
export interface DrawPointerHost extends DrawHoverHost {
    readonly state: DrawState;
    readonly vertexSelection: Signal<ReadonlySet<string>>;
    /** Space held: momentary box-select override. */
    readonly spaceHeld: Signal<boolean>;
    readonly cursor: FrameSignal<Point | null>;
    readonly marquee: FrameSignal<Marquee | null>;
    readonly dragGhost: FrameSignal<GhostFeature[] | null>;
    readonly trace: FrameSignal<Point[] | null>;
    /** Raw mousedown/up binding (editor/drag-binding.ts); null while inactive. */
    dragBinding: DragBinding | null;
    drag: DragTarget | null;
    moveDrag: MoveDrag | null;
    /** Active Alt-duplicate-drag / repeat-stamp gesture (T42). */
    stampDrag: StampDrag | null;
    /** Active freehand press-drag trace while armed (T40), or null. */
    traceGesture: TraceGesture | null;
    /** Armed repeat-stamp template, or null when stamp mode is inactive. */
    stampMode: StampTemplate | null;
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
    altCycle: AltCycle | null;
    /** True while the draw tool holds the map interaction claim. */
    isMyClaim(): boolean;
    closeDraft(): void;
    commitTrace(stroke: Point[]): boolean;
    commitGeometry(id: string, geometry: FeatureGeometry): void;
    record(entry: HistoryEntry): void;
    stampClones(sources: StampSource[], dx: number, dy: number): Promise<CourseFeature[] | null>;
    toggleVertexSelected(key: string): void;
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

/**
 * Bind the pointer handlers for one activation span: MapService click and
 * move, plus the raw drag binding. Every registration goes through
 * `ctx.track`, so deactivate removes them.
 */
export function bindDrawPointer(host: DrawPointerHost, ctx: ToolContext): void {
    ctx.track(ctx.map.onClick(e => onClick(host, e)));
    ctx.track(ctx.map.onMouseMove(e => onMouseMove(host, e)));

    // Raw map handlers (mousedown/up for drags + marquee, dblclick to
    // swallow duplicate draw points, contextmenu to delete vertices),
    // re-bound if the map is recreated while the tool is active. The
    // binding applies the left-button and Cmd/Ctrl pan-escape gates.
    host.dragBinding = bindDrag(ctx, {
        toolId: DRAW_TOOL_ID,
        onDown: (e, map) => onMouseDown(host, e, map),
        onUp: (e, map) => onMouseUp(host, e, map),
        bindExtra: map => bindExtraHandlers(host, map),
    });
}

function onClick(host: DrawPointerHost, e: MapPointerEvent): void {
    if (!host.isMyClaim()) return;
    if (host.dragBinding?.clickSuppressed) return;

    const p = lngLatToSweref99tm(e.lngLat);

    if (host.state.isDrawing.peek()) {
        const draft = host.state.draft.peek();
        if (draft.length >= 3 && screenDistTo(host, draft[0], e.point) < CLOSE_RING_PX) {
            host.closeDraft();
            return;
        }
        // Shift+click places a sharp corner control point.
        host.state.addPoint(p, e.originalEvent.shiftKey);
        return;
    }

    // Cmd/Ctrl+click toggles multi-select membership.
    if (e.originalEvent.metaKey || e.originalEvent.ctrlKey) {
        host.altCycle = null;
        const hit = hitFeature(host.features, p);
        if (hit) host.features?.toggleSelected(hit.id);
        return;
    }

    // Alt/Option+click cycles the selection DOWN through the hit stack
    // (D27): first click selects the topmost containing feature (same as
    // a plain click); each subsequent alt-click over the same hit stack
    // steps one deeper, wrapping. A plain/meta click resets it; so does
    // alt-clicking where the hit stack differs (advanceAltCycle).
    if (e.originalEvent.altKey) {
        const stack = hitStack(host.features, p);
        if (stack.length === 0) {
            host.altCycle = null;
            host.hoverVertex.set(null);
            host.features?.select(null);
            return;
        }
        host.altCycle = advanceAltCycle(host.altCycle, stack.map(f => f.id));
        host.hoverVertex.set(null);
        host.features?.select(host.altCycle.ids[host.altCycle.index]);
        return;
    }

    // Select mode. Edge click on the (single) selected feature inserts
    // a vertex — suspended in box-select mode (no geometry editing).
    // Plain presses insert in onMouseDown; this path serves Shift+click,
    // whose press starts a vertex marquee that decays to a click.
    const boxMode = host.state.boxSelect.peek() || host.spaceHeld.peek();
    const selected = host.features?.editableSelected.peek() ?? null;
    if (selected && !boxMode) {
        const insertion = edgeInsertionHit(selected, p, e.lngLat.lat, host.zoom);
        if (insertion) {
            const inserted = applyInsertion(selected.geometry, insertion);
            host.commitGeometry(selected.id, inserted.geometry);
            selectInsertedVertex(host, insertion.ringIdx, inserted.idx);
            return;
        }
    }
    host.altCycle = null; // plain click resets alt-cycling to topmost
    const hit = hitFeature(host.features, p);
    const prev = host.features?.selectedIds.peek() ?? new Set();
    if (!hit || !(prev.size === 1 && prev.has(hit.id))) host.hoverVertex.set(null);
    host.features?.select(hit?.id ?? null);
}

function onMouseMove(host: DrawPointerHost, e: MapPointerEvent): void {
    if (!host.isMyClaim()) return;

    if (host.state.isDrawing.peek()) {
        const trace = host.traceGesture;
        if (trace) {
            // Refresh the stroke preview only when the spacing gate
            // keeps the sample (≥ TRACE_SAMPLE_PX apart on screen).
            if (trace.sample(e.point, lngLatToSweref99tm(e.lngLat))) {
                host.trace.setLater(() => [...trace.points]);
            }
            return;
        }
        // Empty draft: the rubber band has nothing to attach to, so the
        // cursor is not tracked (no preview rebuild, no worker push).
        if (host.state.draft.peek().length === 0) {
            if (host.cursor.peek() !== null) host.cursor.set(null);
            return;
        }
        const p = lngLatToSweref99tm(e.lngLat);
        const prev = host.cursor.peek();
        if (prev && prev.x === p.x && prev.y === p.y) return;
        host.cursor.setLater(() => p);
        return;
    }

    const marquee = host.marquee.peek();
    if (marquee) {
        const current = lngLatToSweref99tm(e.lngLat);
        host.marquee.setLater(() => ({ ...marquee, current }));
        return;
    }

    const stamp = host.stampDrag;
    if (stamp && host.features) {
        // A duplicate-drag is threshold-gated (sub-threshold decays to the
        // Alt-cycle click); a stamp shows its copy under the cursor at once.
        if (stamp.kind === 'duplicate' && !stamp.moved
            && pxDist(stamp.startScreen, e.point) < MOVE_THRESHOLD_PX) return;
        stamp.moved = true;
        const p = lngLatToSweref99tm(e.lngLat);
        stamp.dx = p.x - stamp.refEpsg.x;
        stamp.dy = p.y - stamp.refEpsg.y;
        const { dx, dy } = stamp;
        host.dragGhost.setLater(() => stamp.sources.map(s => ({
            id: s.id,
            type: s.type,
            geometry: translateGeometry(s.geometry, dx, dy),
        })));
        return;
    }

    const move = host.moveDrag;
    if (move && host.features) {
        if (!move.moved && pxDist(move.startScreen, e.point) < MOVE_THRESHOLD_PX) return;
        if (!move.moved) {
            move.moved = true;
            host.features.setDragging(move.features.map(f => f.id), true);
        }
        const p = lngLatToSweref99tm(e.lngLat);
        move.dx = p.x - move.startEpsg.x;
        move.dy = p.y - move.startEpsg.y;
        const { dx, dy } = move;
        host.dragGhost.setLater(() => move.features.map(f => ({
            id: f.id,
            type: f.type,
            geometry: translateGeometry(f.geometry, dx, dy),
        })));
        return;
    }

    const drag = host.drag;
    if (!drag || !host.features) {
        // No gesture: hover tracking, gated off while a button is held
        // (draw-hover.ts hoverOnPointerMove).
        hoverOnPointerMove(host, e);
        return;
    }
    if (!drag.moved && pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
    if (!drag.moved) {
        drag.moved = true;
        host.features.setDragging([drag.featureId], true);
    }

    // Derive from the drag's base geometry — every op sets ABSOLUTE
    // positions, so this is frame-order independent and needs no store
    // reads (the store is not patched until the mouseup commit).
    const p = lngLatToSweref99tm(e.lngLat);
    const base = drag.baseGeometry;
    let geometry: FeatureGeometry;
    if (drag.kind === 'anchor') {
        geometry = moveAnchor(base, drag.ringIdx, drag.idx, p);
    } else if (drag.kind === 'anchors') {
        // The grabbed anchor follows the cursor; the rest of the vertex
        // selection keeps its offset to it.
        const grabbed = base.rings[drag.ringIdx].points[drag.idx];
        geometry = translateAnchors(base, drag.keys, p.x - grabbed.x, p.y - grabbed.y);
    } else if (drag.kind === 'handle') {
        geometry = moveHandle(base, drag.ringIdx, drag.idx, drag.which!, p);
    } else {
        geometry = setSymmetricHandles(base, drag.ringIdx, drag.idx, p);
    }
    drag.currentGeometry = geometry;
    host.dragGhost.setLater(() => [{ id: drag.featureId, type: drag.featureType, geometry }]);
}

/** dblclick, contextmenu and camera listeners; bound by the drag binding. */
function bindExtraHandlers(host: DrawPointerHost, map: MaplibreMap): () => void {
    const onDbl = (e: MapMouseEvent) => onDblClick(host, e);
    const onContext = (e: MapMouseEvent) => onContextMenu(host, e, map);
    map.on('dblclick', onDbl);
    map.on('contextmenu', onContext);
    // Camera changes invalidate the projected vertex cache. The camera
    // may also have moved while the tool was inactive, so start clean.
    host.screenPoints.invalidate();
    const onCamera = () => host.screenPoints.invalidate();
    map.on('move', onCamera);
    map.on('resize', onCamera);
    return () => {
        map.off('move', onCamera);
        map.off('resize', onCamera);
        map.off('dblclick', onDbl);
        map.off('contextmenu', onContext);
    };
}

/**
 * Left press under the draw claim. The drag binding already returned on
 * Cmd/Ctrl (the pan escape, editor/drag-binding.ts), so a Cmd/Ctrl press
 * never reaches here: MapLibre's native dragPan pans, and a stationary
 * Cmd/Ctrl-click still toggles selection in onClick.
 */
function onMouseDown(host: DrawPointerHost, e: MapMouseEvent, map: MaplibreMap): void {
    if (host.state.mode.peek() === 'draw') {
        onDrawMouseDown(host, e, map);
        return;
    }
    const features = host.features;
    if (!features) return;

    const shift = e.originalEvent.shiftKey;
    const single = features.editableSelected.peek();

    // 0. Box-select (sticky 'B' toggle or Space held): a left-drag
    //    rubber-bands features regardless of what it lands on — even a
    //    shape that a plain drag would move, or the selected feature's
    //    vertices. A sub-threshold drag decays to a plain click in
    //    onMouseUp (selects the shape under the cursor).
    if (host.state.boxSelect.peek() || host.spaceHeld.peek()) {
        host.dragBinding?.claim(e, map);
        const start = lngLatToSweref99tm(e.lngLat);
        host.marquee.set({ kind: 'features', start, current: start, startScreen: { x: e.point.x, y: e.point.y } });
        return;
    }

    // 1. Vertex/handle interactions on the single selected feature.
    if (single) {
        const hit = hitVertexOrHandle(host.screenPoints, map, single, e.point);
        if (hit) {
            if (shift && hit.kind === 'anchor') {
                // Shift+click a vertex: toggle multi-vertex selection.
                e.preventDefault();
                host.toggleVertexSelected(vertexKey(hit.ringIdx, hit.idx));
                host.dragBinding?.suppressNextClick();
                return;
            }
            host.dragBinding?.claim(e, map);
            const anchor = single.geometry.rings[hit.ringIdx].points[hit.idx];
            // Bezier handles don't exist on spline features: alt-drag
            // falls back to a plain control-point drag there.
            const isSpline = single.geometry.curveType === 'bspline';
            const alt = e.originalEvent.altKey && !isSpline;
            const key = vertexKey(hit.ringIdx, hit.idx);
            const vertexSel = host.vertexSelection.peek();
            // Plain grab of a vertex outside the multi-vertex selection
            // drops that selection (prototype behavior). A grab inside a
            // selection of two or more moves all of them.
            if (hit.kind === 'anchor' && !vertexSel.has(key) && vertexSel.size > 0) {
                host.vertexSelection.set(new Set());
            }
            const group = hit.kind === 'anchor' && !alt && vertexSel.has(key) && vertexSel.size > 1;
            host.drag = {
                kind: hit.kind === 'handle' ? 'handle' : alt ? 'newHandles' : group ? 'anchors' : 'anchor',
                which: hit.which,
                featureId: single.id,
                featureType: single.type,
                ringIdx: hit.ringIdx,
                idx: hit.idx,
                alt,
                hadHandles: hasHandles(anchor),
                startScreen: { x: e.point.x, y: e.point.y },
                startGeometry: single.geometry,
                baseGeometry: single.geometry,
                inserted: false,
                keys: group ? [...vertexSel] : [],
                startVersion: single.version,
                moved: false,
                currentGeometry: null,
            };
            return;
        }

        // 1a. Press on an edge (24a): insert a vertex there and grab it,
        //     so press-drag places the new vertex in one gesture. The
        //     store keeps the old shape until mouseup commits insert
        //     (+ move) as one history entry.
        if (!shift && !e.originalEvent.altKey) {
            const p = lngLatToSweref99tm(e.lngLat);
            const insertion = edgeInsertionHit(single, p, e.lngLat.lat, host.zoom);
            if (insertion) {
                host.dragBinding?.claim(e, map);
                const inserted = applyInsertion(single.geometry, insertion);
                // Indices shift with the insert: drop index-keyed state.
                host.hoverVertex.set(null);
                if (host.vertexSelection.peek().size > 0) host.vertexSelection.set(new Set());
                host.drag = {
                    kind: 'anchor',
                    featureId: single.id,
                    featureType: single.type,
                    ringIdx: insertion.ringIdx,
                    idx: inserted.idx,
                    alt: false,
                    hadHandles: false,
                    startScreen: { x: e.point.x, y: e.point.y },
                    startGeometry: single.geometry,
                    baseGeometry: inserted.geometry,
                    inserted: true,
                    keys: [],
                    startVersion: single.version,
                    moved: false,
                    currentGeometry: null,
                };
                return;
            }
        }
    }

    const p = lngLatToSweref99tm(e.lngLat);

    // 1b. Alt+press inside the selection (not on a vertex/handle — those
    //     were consumed above): start a duplicate-drag over CLONES (T42).
    //     A sub-threshold drag decays to the Alt-cycle click in onMouseUp,
    //     so a stationary Alt-click still cycles the hit stack as before.
    if (e.originalEvent.altKey && !shift) {
        const selectedFeatures = features.editableSelectedFeatures.peek();
        if (selectedFeatures.some(f => pointInGeometry(p, f.geometry))) {
            host.dragBinding?.claim(e, map);
            host.stampDrag = {
                kind: 'duplicate',
                refEpsg: p,
                startScreen: { x: e.point.x, y: e.point.y },
                sources: selectedFeatures.map(f => ({
                    id: f.id, type: f.type, holeId: f.holeId, geometry: f.geometry,
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
            host.dragBinding?.claim(e, map);
            host.marquee.set({ kind: 'vertices', start: p, current: p, startScreen: { x: e.point.x, y: e.point.y } });
        }
        return;
    }

    // 3. Drag inside a selected feature: move the whole selection.
    const selectedFeatures = features.editableSelectedFeatures.peek();
    if (selectedFeatures.some(f => pointInGeometry(p, f.geometry))) {
        host.dragBinding?.claim(e, map);
        host.moveDrag = {
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
    //    map's default pan; plain clicks still select it.)
    if (!hitFeature(host.features, p)) {
        host.dragBinding?.claim(e, map);
        if (host.stampMode) {
            startStampDrag(host, p, { x: e.point.x, y: e.point.y });
        } else {
            host.marquee.set({ kind: 'features', start: p, current: p, startScreen: { x: e.point.x, y: e.point.y } });
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
 * Pan escape hatches while armed: middle-button (map.service) and
 * Cmd/Ctrl-drag, which the drag binding filters before this runs. And
 * once click-placement has begun (non-empty draft) a left-drag
 * keeps the native pan too: a trace always starts a FRESH shape, so
 * mid-draft panning behaves exactly as before.
 */
function onDrawMouseDown(host: DrawPointerHost, e: MapMouseEvent, map: MaplibreMap): void {
    if (host.state.draft.peek().length > 0) return;
    host.dragBinding?.claim(e, map);
    const trace = new TraceGesture(
        { x: e.point.x, y: e.point.y },
        lngLatToSweref99tm(e.lngLat),
    );
    host.traceGesture = trace;
    host.trace.set([...trace.points]);
}

/**
 * Begin a repeat-stamp drag from the armed template. The copy is anchored
 * under the cursor immediately (grab point = the template `anchor`, the
 * previous drop point) and tracks pointer moves; the drop always creates.
 */
function startStampDrag(host: DrawPointerHost, p: Point, startScreen: { x: number; y: number }): void {
    const mode = host.stampMode;
    if (!mode) return;
    const dx = p.x - mode.anchor.x;
    const dy = p.y - mode.anchor.y;
    host.stampDrag = {
        kind: 'stamp',
        refEpsg: mode.anchor,
        startScreen,
        sources: mode.templates,
        moved: false,
        dx,
        dy,
    };
    host.dragGhost.set(mode.templates.map(s => ({
        id: s.id,
        type: s.type,
        geometry: translateGeometry(s.geometry, dx, dy),
    })));
}

function onMouseUp(host: DrawPointerHost, e: MapMouseEvent, map: MaplibreMap): void {
    const trace = host.traceGesture;
    if (trace) {
        host.traceGesture = null;
        host.trace.set(null);
        host.dragBinding?.release(map);
        // Sub-threshold press decays to a plain click: do NOT suppress
        // the click MapLibre synthesizes — onClick places the point
        // (Shift-corner / close-ring hit included) exactly as before.
        if (!trace.moved) return;
        host.dragBinding?.suppressNextClick();
        host.commitTrace(trace.finish(lngLatToSweref99tm(e.lngLat)));
        return;
    }

    const stamp = host.stampDrag;
    if (stamp) {
        host.stampDrag = null;
        host.dragBinding?.release(map);
        host.dragGhost.set(null);
        // Sub-threshold duplicate-drag: decay to the Alt-cycle click. Do
        // NOT suppress the synthesized click — onClick's Alt path cycles
        // the hit stack exactly as a stationary Alt-click always has.
        if (stamp.kind === 'duplicate' && !stamp.moved) return;
        host.dragBinding?.suppressNextClick();
        const p = lngLatToSweref99tm(e.lngLat);
        const dx = p.x - stamp.refEpsg.x;
        const dy = p.y - stamp.refEpsg.y;
        void (async () => {
            const created = await host.stampClones(stamp.sources, dx, dy);
            // A duplicate-drag drop arms repeat-stamp mode: the fresh clones
            // become the template, grabbed at this drop point.
            if (created && stamp.kind === 'duplicate') {
                host.stampMode = {
                    anchor: p,
                    templates: created.map(c => ({
                        id: c.id, type: c.type, holeId: c.holeId, geometry: c.geometry,
                    })),
                };
            }
        })();
        return;
    }

    const marquee = host.marquee.peek();
    if (marquee) {
        host.marquee.set(null);
        host.dragBinding?.release(map);
        if (pxDist(marquee.startScreen, e.point) < MARQUEE_MIN_PX) return; // a click — let onClick handle it
        host.dragBinding?.suppressNextClick();
        const rect = rectFromCorners(marquee.start, lngLatToSweref99tm(e.lngLat));
        if (!host.features) return;
        if (marquee.kind === 'features') {
            // Default 'contain' (fully inside); Alt = 'intersect'.
            const mode = e.originalEvent.altKey ? 'intersect' : 'contain';
            const features = host.features;
            const visible = features.store.items.peek().filter(f => !features.isHidden(f));
            host.features.setSelection(featuresInRect(visible, rect, mode));
        } else {
            const single = host.features.editableSelected.peek();
            if (single) host.vertexSelection.set(new Set(verticesInRect(single.geometry, rect)));
        }
        return;
    }

    const move = host.moveDrag;
    if (move) {
        host.moveDrag = null;
        host.dragBinding?.release(map);
        if (!move.moved || !host.features) return; // plain click — let onClick handle it
        host.dragBinding?.suppressNextClick();
        const features = host.features;
        host.dragGhost.set(null);
        features.setDragging(move.features.map(f => f.id), false);
        // Commit the final translation: ONE store batch (a single
        // FeatureCollection rebuild), ONE history entry and ONE
        // updateMany request for the whole multi-feature move.
        const entry = buildMoveEntry(move.features, move.dx, move.dy);
        void features.updateMany(
            entry.map(diff => ({ id: diff.featureId, patch: { geometry: diff.after!.geometry } })),
            { local: true },
        );
        host.record(entry);
        return;
    }

    const drag = host.drag;
    if (!drag || !host.features) return;
    endDrag(host, map);

    // Swallow the click MapLibre synthesizes right after this mouseup.
    host.dragBinding?.suppressNextClick();

    // A moved drag commits its last frame; an edge press without
    // movement commits the bare insertion. Either is one history entry
    // whose before side is the pre-press shape.
    const geometry = drag.moved ? drag.currentGeometry : drag.inserted ? drag.baseGeometry : null;
    if (geometry) {
        const feature = host.features.store.items.peek().find(f => f.id === drag.featureId);
        if (feature) {
            host.record([{
                featureId: drag.featureId,
                before: { geometry: drag.startGeometry, type: feature.type, holeId: feature.holeId },
                after: { geometry, type: feature.type, holeId: feature.holeId },
                beforeVersion: drag.startVersion,
            }]);
            host.features.patchLocal(drag.featureId, geometry); // instant visual snap
            void host.features.update(drag.featureId, { geometry });
            if (drag.inserted) selectInsertedVertex(host, drag.ringIdx, drag.idx);
        }
        return;
    }
    // Alt-click (no movement) on a curved vertex straightens it.
    if (drag.kind === 'newHandles' && drag.hadHandles) {
        const feature = host.features.store.items.peek().find(f => f.id === drag.featureId);
        if (feature) {
            host.commitGeometry(drag.featureId, clearHandles(feature.geometry, drag.ringIdx, drag.idx));
        }
    }
}

function onDblClick(host: DrawPointerHost, e: MapMouseEvent): void {
    if (!host.isMyClaim()) return;
    if (!host.state.isDrawing.peek()) return;
    e.preventDefault(); // no double-click zoom while drawing
    host.state.discardDoubleClickDuplicate();
}

function onContextMenu(host: DrawPointerHost, e: MapMouseEvent, map: MaplibreMap): void {
    if (!host.isMyClaim()) return;
    const selected = host.features?.editableSelected.peek();
    if (!selected) return;
    const hit = hitVertexOrHandle(host.screenPoints, map, selected, e.point);
    if (!hit || hit.kind !== 'anchor') return;
    e.preventDefault();
    const geometry = deleteAnchor(selected.geometry, hit.ringIdx, hit.idx);
    if (geometry) {
        host.hoverVertex.set(null); // indices shifted — drop stale target
        host.vertexSelection.set(new Set());
        host.commitGeometry(selected.id, geometry);
    }
}

/** After an insert: the new vertex is the vertex selection and the 'C' target. */
function selectInsertedVertex(host: DrawPointerHost, ringIdx: number, idx: number): void {
    host.vertexSelection.set(new Set([vertexKey(ringIdx, idx)]));
    host.hoverVertex.set({ ringIdx, idx });
}

/** End a vertex/handle drag without committing (mouseup commits separately). */
export function endDrag(host: DrawPointerHost, map?: MaplibreMap): void {
    const drag = host.drag;
    if (!drag) return;
    if (drag.moved) {
        host.dragGhost.set(null);
        host.features?.setDragging([drag.featureId], false);
    }
    host.drag = null;
    host.dragBinding?.release(map);
}

/** Abort an in-progress whole-selection move without committing. */
export function cancelMoveDrag(host: DrawPointerHost): void {
    const move = host.moveDrag;
    if (!move) return;
    host.moveDrag = null;
    if (move.moved) {
        host.dragGhost.set(null);
        host.features?.setDragging(move.features.map(f => f.id), false);
    }
    host.dragBinding?.release();
}

/** Discard an in-progress freehand trace (ESC / deactivate). */
export function cancelTrace(host: DrawPointerHost): void {
    if (!host.traceGesture) return;
    host.traceGesture = null;
    host.trace.set(null);
    host.dragBinding?.release();
}

/** Abort an in-progress duplicate-drag / stamp-drag without committing. */
export function cancelStampDrag(host: DrawPointerHost): void {
    if (!host.stampDrag) return;
    host.stampDrag = null;
    host.dragGhost.set(null);
    host.dragBinding?.release();
}

/** Flat screen-pixel distance from an EPSG:3006 point to a screen position. */
function screenDistTo(host: DrawPointerHost, p: Point, screen: { x: number; y: number }): number {
    const m = host.map;
    return m ? screenDistSweref(m, p, screen) : Infinity;
}

function pxDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
