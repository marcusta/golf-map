import { Signal, Computed, effect, untrack, di } from '@basics/core/client/core';
import { toolHotRestart, type ToolContext } from '../editor/tool';
import type { DragBinding } from '../editor/drag-binding';
import { ownedOverlay } from '../editor/owned-overlay';
import { canvasCursor } from '../editor/canvas-cursor';
import { ConfirmService } from '../app/confirm-dialog.component';
import { geometryToWgs84Rings, type FeaturesService } from './features.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { FeatureGeometry, Point } from '../geo/bezier';
import { ScreenPointCache } from './screen-cache';
import { fitClosedBspline } from '../geo/spline-fit';
import {
    DrawState,
    MIN_RING_POINTS,
    TraceGesture,
    toggleVertexCorner,
    isCornerVertex,
    bakeBsplineToBezier,
    translateGeometry,
    translateAnchors,
    toggleVerticesCorner,
    offsetGeometry,
    mergedSurroundGeometries,
    simplifyGeometry,
    deleteVertices,
    insertBetweenVertices,
    parseVertexKey,
} from './draw-state';
import { EditHistory, snapshotOf, type HistoryEntry } from './history';
import {
    FEATURE_TYPES,
    SURROUND_PAIRINGS,
    type FeatureType,
} from './feature-palette';
import { FrameBatch, FrameSignal, defaultFrameScheduler, type FrameScheduler } from './draw-frame';
import { metersPerPixel, type VertexRef } from './draw-hover';
import {
    DRAW_TOOL_ID,
    bindDrawPointer,
    cancelMoveDrag,
    cancelStampDrag,
    cancelTrace,
    endDrag,
    type AltCycle,
    type DragTarget,
    type DrawPointerHost,
    type GhostFeature,
    type Marquee,
    type MoveDrag,
    type StampDrag,
    type StampSource,
    type StampTemplate,
} from './draw-pointer';
import { bindDrawKeys, nudgeDirection, type DrawKeysHost, type ReorderKey } from './draw-keys';
import { drawPreviewGeojson, drawPreviewLayers, type DrawRenderHost } from './draw-render';
import type { SnapMarker } from './draw-snap';

// DrawToolService is the coordinator: it owns the signals, the gesture state
// and the ToolContext, and runs the actions (one history entry each). The
// interaction code lives in sibling modules that take a narrow host
// interface and never import this file back, so an edit to any of them
// propagates here and hot-swaps (see the HMR section at the end):
// - draw-pointer.ts: click, press, move, release, dblclick, contextmenu.
// - draw-hover.ts: feature and vertex hit-testing, hover tracking.
// - draw-keys.ts: keydown, arrow nudge, Space hold.
// - draw-render.ts: the preview overlay FeatureCollection and layer specs.
// - draw-frame.ts: per-frame coalescing (FrameBatch, FrameSignal).

// Moved symbols stay importable from here.
export { DRAW_TOOL_ID, buildMoveEntry } from './draw-pointer';
export { containingTopDown, advanceAltCycle } from './draw-hover';
export { NUDGE_PX, NUDGE_SHIFT_PX } from './draw-keys';
export { defaultFrameScheduler, type FrameScheduler } from './draw-frame';

/** Preview overlay (draft line, vertex + bezier-handle markers). */
export const DRAW_OVERLAY_ID = 'draw';

/** Deletes of up to this many features skip the confirm dialog (undo restores them). */
export const DELETE_CONFIRM_THRESHOLD = 10;
/** How long the post-delete undo hint stays up (ms). */
export const NOTICE_MS = 4000;
/** Repeats of the same arrow key within this window share one history entry. */
export const NUDGE_COALESCE_MS = 300;

/** Label of the undo modifier: "Cmd" on Apple platforms, else "Ctrl". */
function undoModifierLabel(): string {
    const nav = typeof navigator === 'undefined' ? null : navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav?.userAgentData?.platform ?? nav?.platform ?? nav?.userAgent ?? '';
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Cmd' : 'Ctrl';
}

// New-shape type policy persistence (survives reloads; per browser).
const TYPE_FOLLOWS_LAST_KEY = 'golfmap.draw.typeFollowsLast';
const DEFAULT_TYPE_KEY = 'golfmap.draw.defaultType';

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
 *   editable: drag to move (a selected vertex drags the whole vertex
 *   selection), right-click to delete, press an edge to insert a vertex
 *   (dragging places it; one undo step), 'C' toggles smooth↔corner on the
 *   vertex selection or else the hovered vertex, arrows nudge the vertex
 *   selection 1 px (Shift: 10 px; repeats within 300 ms share one undo
 *   step), Shift+click toggles a vertex into
 *   the multi-vertex selection, Shift+drag marquee-selects vertices,
 *   Delete removes selected vertices (≥3 must remain), 'I' inserts a
 *   vertex between two selected ones with even redistribution. On BEZIER
 *   features additionally: alt-drag pulls out symmetric handles, alt-click
 *   straightens, handle dots bend segments. Delete/Backspace deletes the
 *   selected feature(s): up to 10 at once without a dialog (sets `notice`),
 *   more after a confirm. Cmd/Ctrl+D duplicates (+10 m offset).
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
 *   once click-placement has begun, left-drag keeps the native pan.
 */
export class DrawToolService {
    private confirm = di.get(ConfirmService);
    readonly state = new DrawState();
    /** Snapshot-based undo/redo of committed edits (see history.ts). */
    readonly history = new EditHistory();
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
        (FEATURE_TYPES as readonly string[]).includes(storedPref(DEFAULT_TYPE_KEY) ?? '')
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
     * arm paths ('N', the command bar's + toggle) go through here; chain-draw
     * (staying armed after a close) applies the same policy in `closeDraft`.
     */
    armDraw(): void {
        if (!this.typeFollowsLast.peek()) this.drawType.set(this.defaultDrawType.peek());
        this.state.arm();
    }
    /** Hole assignment for the next created polygon (null = course level). */
    readonly drawHoleId = new Signal<string | null>(null);
    /**
     * Vertex under the cursor on the selected feature (select mode) — the
     * target for the 'C' smooth↔corner toggle. Sticky until the cursor
     * hits another vertex or the selection changes.
     */
    readonly hoverVertex = new Signal<VertexRef | null>(null);
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
    /**
     * Short-lived hint after an edit that skipped its confirm dialog, e.g.
     * "Deleted 3. Cmd+Z to undo.". `until` is the epoch ms at which it
     * clears; the next committed edit, undo or redo clears it sooner. The
     * dock footer renders it.
     */
    readonly notice = new Signal<{ text: string; until: number } | null>(null);
    private noticeTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Live arrow-key nudge run (24c). Repeats of `key` within
     * NUDGE_COALESCE_MS extend `diff`, the after side of the history entry
     * the first press recorded, as long as the feature still holds
     * `geometry` (no other edit, undo or reload in between).
     */
    private nudge: {
        key: string;
        at: number;
        featureId: string;
        geometry: FeatureGeometry;
        diff: HistoryEntry[number];
    } | null = null;

    /**
     * Runs the preview frame flush. rAF in the browser; tests swap in a
     * manual scheduler to drive frames synchronously.
     */
    frameScheduler: FrameScheduler = defaultFrameScheduler;
    /** Wall clock for the nudge coalescing window; tests swap it. */
    clock: () => number = () => Date.now();
    /** Projected anchors and handles per (geometry, camera); see screen-cache.ts. */
    private readonly screenPoints = new ScreenPointCache();
    private readonly frames = new FrameBatch(cb => this.frameScheduler(cb));
    /**
     * Live cursor position while drawing (rubber-band preview), EPSG:3006.
     * Null while the draft is empty: a lone cursor point draws nothing.
     */
    private cursor = new FrameSignal<Point | null>(null, this.frames);
    /** Snap marker at the snapped pointer position (draw-snap.ts). */
    private snapMarker = new FrameSignal<SnapMarker | null>(null, this.frames);
    /** Active marquee rectangle (reactive — drives the preview overlay). */
    private marquee = new FrameSignal<Marquee | null>(null, this.frames);
    /**
     * Live copies of the feature(s) being dragged, rendered as fill +
     * outline in the (small) preview overlay while the originals are
     * hidden via feature-state (features.setDragging). Per-frame drag
     * cost is therefore proportional to the DRAGGED features only — the
     * store, the derived course FeatureCollection and the main overlay
     * source are untouched until the mouseup commit.
     */
    private dragGhost = new FrameSignal<GhostFeature[] | null>(null, this.frames);
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
    private trace = new FrameSignal<Point[] | null>(null, this.frames);
    /** Armed repeat-stamp template, or null when stamp mode is inactive. */
    private stampMode: StampTemplate | null = null;
    /** Raw mousedown/up binding (editor/drag-binding.ts); null while inactive. */
    private dragBinding: DragBinding | null = null;

    /** Alt/Option+click cycle state (D27); reset rules in draw-pointer.ts (`DrawPointerHost.altCycle`). */
    private altCycle: AltCycle | null = null;

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
        this.history.clear();
        this.history.notice.set(null);

        // Any failed save (optimistic-version conflict, network error)
        // re-syncs the store from the server — recorded diffs may no
        // longer match reality, so drop the history and tell the user.
        ctx.track(effect(() => {
            const err = ctx.features.saveError.get();
            if (!err) return;
            untrack(() => {
                if (this.history.canUndo.peek() || this.history.canRedo.peek()) {
                    this.history.clear();
                    this.history.notice.set('Edit history dropped after a failed save — re-synced from server.');
                }
            });
        }));
    }

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.features = ctx.features;
        // Draw means the whole active tool span, not only a currently armed
        // polygon. Its high-contrast vector palette makes existing surfaces
        // legible before the first tracing click.
        ctx.features.niceRendering.set(false);
        // QA hook (same pattern as MapService's window.__map): expose the
        // instance for scripted/visual verification tooling. Not public API.
        (window as unknown as Record<string, unknown>).__drawTool = this;

        const host = this.host;
        // Map click/move, raw mousedown/up (drags, marquee), dblclick and
        // contextmenu: draw-pointer.ts. Sets `dragBinding`.
        bindDrawPointer(host, ctx);
        // Window keydown, capture-phase arrow nudge, Space hold: draw-keys.ts.
        bindDrawKeys(host, ctx);

        // Arming a draw exits repeat-stamp mode (T42): a fresh draw supersedes
        // repeat placement. `stampMode` is a plain field, so clearing it is not
        // a signal write — no reactive cascade.
        ctx.track(effect(() => {
            const drawing = this.state.isDrawing.get();
            if (!drawing) return;
            untrack(() => {
                cancelStampDrag(host);
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
        ctx.track(ownedOverlay(ctx.map, DRAW_OVERLAY_ID, () => this.previewGeojson(), drawPreviewLayers, { keepOnTop: true }));

        // Crosshair cursor while drawing. Shift gestures belong to the
        // tool in BOTH modes (Shift+click corner points while drawing,
        // Shift+click/drag vertex selection while editing), so MapLibre's
        // shift-drag box zoom is disabled for the whole activation span.
        ctx.track(canvasCursor(ctx.map, () =>
            this.state.isDrawing.get() || this.state.boxSelect.get() || this.spaceHeld.get() ? 'crosshair' : ''));
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            ctx.map.map.get()?.boxZoom.disable();
        }));
        ctx.track(() => ctx.map.map.peek()?.boxZoom.enable());
    }

    deactivate(): void {
        const host = this.host;
        endDrag(host);
        cancelMoveDrag(host);
        cancelStampDrag(host);
        cancelTrace(host);
        this.stampMode = null;
        this.marquee.set(null);
        this.state.disarm();
        this.state.boxSelect.set(false);
        this.spaceHeld.set(false);
        this.cursor.set(null);
        this.snapMarker.set(null);
        this.clearTransientOpState();
        this.features?.select(null);
        this.features?.niceRendering.set(true);
        // Send debounced geometry saves now rather than after the debounce.
        void this.features?.flush();
        this.dragBinding = null;
        this.ctx = null;
    }

    /**
     * True while work a sub-mode switch would discard is open: placed draft
     * points, a freehand trace, or a live drag (vertex, move, stamp,
     * marquee). An armed tool with an empty draft is not busy, so chain-draw
     * does not block the sub-mode keys.
     */
    isBusy(): boolean {
        return (this.state.isDrawing.peek() && this.state.draft.peek().length > 0)
            || this.traceGesture !== null
            || this.drag !== null
            || this.moveDrag !== null
            || this.stampDrag !== null
            || this.marquee.peek() !== null;
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
            cancelTrace(this.host);
            return true;
        }
        if (this.state.handleEscape()) return true;
        // Exit repeat-stamp mode (T42) before the marquee: cancel any live
        // stamp/duplicate ghost and disarm further stamping.
        if (this.stampDrag || this.stampMode) {
            cancelStampDrag(this.host);
            this.stampMode = null;
            return true;
        }
        if (this.marquee.peek()) {
            this.marquee.set(null);
            this.dragBinding?.release();
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

    /**
     * Move the vertex selection `px` screen pixels in the arrow `key`'s
     * screen direction, converted to EPSG:3006 meters at the current zoom
     * and bearing. Repeats of the same key within NUDGE_COALESCE_MS extend
     * one history entry. Returns false when there is nothing to nudge.
     */
    nudgeSelectedVertices(key: string, px: number): boolean {
        const features = this.features;
        const selected = features?.editableSelected.peek();
        const keys = this.vertexSelection.peek();
        const bearingDeg = this.ctx?.map.map.peek()?.getBearing?.() ?? 0;
        const dir = nudgeDirection(key, bearingDeg);
        if (!dir || !features || !selected || keys.size === 0) return false;
        const first = parseVertexKey(keys.values().next().value!);
        const anchor = selected.geometry.rings[first.ringIdx]?.points[first.idx];
        if (!anchor) return false;

        const zoom = this.ctx?.map.zoom.peek() ?? 18;
        const meters = px * metersPerPixel(zoom, sweref99tmToWgs84(anchor.x, anchor.y).lat);
        const geometry = translateAnchors(selected.geometry, keys, dir.east * meters, dir.north * meters);

        const now = this.clock();
        const run = this.nudge;
        if (run && run.key === key && now - run.at < NUDGE_COALESCE_MS
            && run.featureId === selected.id && run.geometry === selected.geometry && run.diff.after) {
            run.diff.after = { ...run.diff.after, geometry };
            run.at = now;
            run.geometry = geometry;
        } else {
            const diff = {
                featureId: selected.id,
                before: snapshotOf(selected),
                after: { geometry, type: selected.type, holeId: selected.holeId },
                beforeVersion: selected.version,
            };
            this.record([diff]); // ends any previous run
            this.nudge = { key, at: now, featureId: selected.id, geometry, diff };
        }
        features.patchLocal(selected.id, geometry);
        void features.update(selected.id, { geometry });
        return true;
    }

    // ── Actions ───────────────────────────────────────────────────────────

    /** Undo the last committed edit (Cmd/Ctrl+Z, panel button). */
    undo(): void {
        if (!this.features) return;
        this.nudge = null;
        this.clearNotice();
        this.clearTransientOpState();
        void this.history.undo(this.features);
    }

    /** Redo the last undone edit (Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y, panel). */
    redo(): void {
        if (!this.features) return;
        this.nudge = null;
        this.clearNotice();
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
    private async reorderSelected(key: ReorderKey): Promise<void> {
        const features = this.features;
        if (!features) return;
        const ids = [...features.selectedIds.peek()];
        if (key === 'PageUp') await features.raise(ids);
        else if (key === 'PageDown') await features.lower(ids);
        else if (key === 'Home') await features.raiseToTop(ids);
        else await features.lowerToBottom(ids);
    }

    /**
     * Close the draft ring and autosave it as a new feature. New features
     * are B-SPLINES: the placed points are control points and the curve
     * smooths itself (corner points excepted).
     */
    closeDraft(): void {
        const ring = this.state.closeDraft();
        if (!ring || !this.features) return;
        this.cursor.set(null);
        const features = this.features;
        const type = this.drawType.peek();
        // Chain-draw stays armed without re-arming, so the new-shape type
        // policy must apply HERE too: the next chained shape starts as the
        // default type, not as whatever this one was.
        if (!this.typeFollowsLast.peek()) this.drawType.set(this.defaultDrawType.peek());
        void features.create({
            type,
            holeId: this.drawHoleId.peek(),
            geometry: { crs: 'EPSG:3006', curveType: 'bspline', rings: [ring] },
        }).then(created => {
            if (created) {
                this.record([{ featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null }]);
            }
        });
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
        const { controls } = fitClosedBspline(stroke, TRACE_TOLERANCE_M);
        if (controls.length < MIN_RING_POINTS) return false;
        this.state.draft.set(controls.map(p => ({ x: p.x, y: p.y })));
        this.closeDraft();
        return true;
    }

    /**
     * Toggle smooth↔corner ('C' key / panel button): every vertex of the
     * vertex selection when there is one, else the hovered vertex. One
     * history entry.
     */
    toggleHoveredVertexCorner(): void {
        const selected = this.features?.editableSelected.peek();
        if (!selected) return;
        const keys = this.vertexSelection.peek();
        if (keys.size > 0) {
            this.commitGeometry(selected.id, toggleVerticesCorner(selected.geometry, keys));
            return;
        }
        const hover = this.hoverVertex.peek();
        if (!hover) return;
        if (!selected.geometry.rings[hover.ringIdx]?.points[hover.idx]) return;
        this.commitGeometry(selected.id, toggleVertexCorner(selected.geometry, hover.ringIdx, hover.idx));
    }

    /** True when the hovered vertex is a corner (panel toggle label). */
    hoveredVertexIsCorner(): boolean {
        const selected = this.features?.editableSelected.get();
        const hover = this.hoverVertex.get();
        if (!selected || !hover) return false;
        if (!selected.geometry.rings[hover.ringIdx]?.points[hover.idx]) return false;
        return isCornerVertex(selected.geometry, hover.ringIdx, hover.idx);
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
     * Delete the whole selection (key or panel button) as ONE history
     * entry. Up to DELETE_CONFIRM_THRESHOLD features go without a dialog
     * and leave an undo hint in `notice`; larger deletes ask first.
     */
    async deleteSelected(): Promise<void> {
        const features = this.features;
        const items = features?.selectedFeatures.peek() ?? [];
        if (!features || items.length === 0) return;
        if (items.length <= DELETE_CONFIRM_THRESHOLD) {
            this.commitDelete(features, items);
            this.showNotice(`Deleted ${items.length}. ${undoModifierLabel()}+Z to undo.`);
            return;
        }
        const ok = await this.confirm.confirm({
            title: `Delete ${items.length} features?`,
            body: `Delete ${items.length} features from the course map.`,
            detail: 'Bulk deletes are saved as one history entry.',
            confirmLabel: 'Delete features',
            tone: 'danger',
            layout: 'review',
        });
        if (!ok) return;
        this.commitDelete(features, items);
    }

    private commitDelete(features: FeaturesService, items: CourseFeature[]): void {
        this.record(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: null,
            beforeVersion: f.version,
        })));
        void features.removeMany(items.map(f => f.id));
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
            // One createMany request; it selects the clones in the same batch.
            const created = await features.createMany(items.map(f => ({
                type: f.type,
                holeId: f.holeId,
                geometry: translateGeometry(f.geometry, DUPLICATE_OFFSET_M, DUPLICATE_OFFSET_M),
            })));
            if (!created) return; // save failed — history dropped via saveError watcher
            this.record(created.map(c => ({ featureId: c.id, before: null, after: snapshotOf(c), beforeVersion: null })));
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
        // One createMany request; it selects the new rings in the same batch.
        const created = await features.createMany(plan);
        if (!created) return; // save failed — history dropped via saveError watcher
        this.record(created.map(c => ({ featureId: c.id, before: null, after: snapshotOf(c), beforeVersion: null })));
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
        const geometry = deleteVertices(selected.geometry, keys);
        if (!geometry) {
            this.actionNotice.set('Cannot delete: each ring needs at least 3 points.');
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
        const result = insertBetweenVertices(selected.geometry, a.ringIdx, a.idx, b.idx);
        if (!result) return;
        this.actionNotice.set(null);
        this.hoverVertex.set(null);
        this.commitGeometry(selected.id, result.geometry);
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
        const hasSelection = (this.features?.selectedIds.peek().size ?? 0) > 0;
        if (!this.state.isDrawing.peek() && hasSelection) this.retypeSelection(type);
        else this.drawType.set(type);
    }

    /**
     * Re-type the whole selection (palette with a selection, not drawing).
     * ONE history entry covering every changed feature.
     */
    retypeSelection(type: FeatureType): void {
        const features = this.features;
        const items = (features?.editableSelectedFeatures.peek() ?? []).filter(f => f.type !== type);
        if (!features || items.length === 0) return;
        this.record(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: { ...snapshotOf(f), type },
            beforeVersion: f.version,
        })));
        void features.updateMany(items.map(f => ({ id: f.id, patch: { type } })), { local: true });
    }

    /** Re-assign the selection's hole (panel select). ONE history entry. */
    assignSelectionHole(holeId: string | null): void {
        const features = this.features;
        const items = (features?.editableSelectedFeatures.peek() ?? []).filter(f => f.holeId !== holeId);
        if (!features || items.length === 0) return;
        this.record(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: { ...snapshotOf(f), holeId },
            beforeVersion: f.version,
        })));
        void features.updateMany(items.map(f => ({ id: f.id, patch: { holeId } })), { local: true });
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
        this.record([{
            featureId: id,
            before: snapshotOf(current),
            after: { geometry, type: current.type, holeId: current.holeId },
            beforeVersion: current.version,
        }]);
        this.features.patchLocal(id, geometry); // instant visual feedback
        void this.features.update(id, { geometry });
    }

    /**
     * Record one committed edit. Every history push goes through here: a new
     * edit ends the current nudge run and clears the undo hint.
     */
    private record(entry: HistoryEntry): void {
        this.nudge = null;
        this.clearNotice();
        this.history.push(entry);
    }

    private showNotice(text: string): void {
        this.clearNotice();
        this.notice.set({ text, until: Date.now() + NOTICE_MS });
        this.noticeTimer = setTimeout(() => {
            this.noticeTimer = null;
            this.notice.set(null);
        }, NOTICE_MS);
    }

    private clearNotice(): void {
        if (this.noticeTimer) clearTimeout(this.noticeTimer);
        this.noticeTimer = null;
        if (this.notice.peek()) this.notice.set(null);
    }

    /** Selection-scoped transient state (vertex sel, previews, notices). */
    private clearTransientOpState(): void {
        this.hoverVertex.set(null);
        if (this.vertexSelection.peek().size > 0) this.vertexSelection.set(new Set());
        if (this.offsetDistance.peek() !== null) this.offsetDistance.set(null);
        if (this.simplifyActive.peek()) this.simplifyActive.set(false);
        if (this.actionNotice.peek()) this.actionNotice.set(null);
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
        // One createMany request; it selects the clones in the same batch.
        const created = await features.createMany(sources.map(s => ({
            type: s.type,
            holeId: s.holeId,
            geometry: translateGeometry(s.geometry, dx, dy),
        })));
        if (!created) return null; // save failed
        this.record(created.map(c => ({ featureId: c.id, before: null, after: snapshotOf(c), beforeVersion: null })));
        return created;
    }

    // ── Module host ───────────────────────────────────────────────────────

    /** Preview overlay content. e2e spec 28 reads it through `window.__drawTool`. */
    private previewGeojson(): ReturnType<typeof drawPreviewGeojson> {
        return drawPreviewGeojson(this.host);
    }

    /**
     * The narrow view of this instance that draw-pointer, draw-hover,
     * draw-keys and draw-render work through. Built once per instance per
     * module execution (`drawHosts` is module-level, so a hot update builds
     * a fresh one with the new shape). Readonly members are the instance's
     * own signals; mutable members are accessors onto its private fields.
     */
    private get host(): DrawHost {
        let host = drawHosts.get(this);
        if (!host) {
            host = this.createHost();
            drawHosts.set(this, host);
        }
        return host;
    }

    private createHost(): DrawHost {
        const self = this;
        return {
            state: this.state,
            screenPoints: this.screenPoints,
            hoverVertex: this.hoverVertex,
            vertexSelection: this.vertexSelection,
            spaceHeld: this.spaceHeld,
            cursor: this.cursor,
            snapMarker: this.snapMarker,
            marquee: this.marquee,
            dragGhost: this.dragGhost,
            trace: this.trace,
            opPreviewGeometry: this.opPreviewGeometry,
            get features() { return self.features; },
            get map() { return self.ctx?.map.map.peek() ?? null; },
            get zoom() { return self.ctx?.map.zoom.peek() ?? 18; },
            get dragging() { return self.drag !== null || self.moveDrag !== null; },
            get dragBinding() { return self.dragBinding; },
            set dragBinding(v) { self.dragBinding = v; },
            get drag() { return self.drag; },
            set drag(v) { self.drag = v; },
            get moveDrag() { return self.moveDrag; },
            set moveDrag(v) { self.moveDrag = v; },
            get stampDrag() { return self.stampDrag; },
            set stampDrag(v) { self.stampDrag = v; },
            get traceGesture() { return self.traceGesture; },
            set traceGesture(v) { self.traceGesture = v; },
            get stampMode() { return self.stampMode; },
            set stampMode(v) { self.stampMode = v; },
            get altCycle() { return self.altCycle; },
            set altCycle(v) { self.altCycle = v; },
            isMyClaim: () => self.ctx?.map.interactionMode.peek() === DRAW_TOOL_ID,
            closeDraft: () => self.closeDraft(),
            commitTrace: stroke => self.commitTrace(stroke),
            commitGeometry: (id, geometry) => self.commitGeometry(id, geometry),
            record: entry => self.record(entry),
            stampClones: (sources, dx, dy) => self.stampClones(sources, dx, dy),
            toggleVertexSelected: key => self.toggleVertexSelected(key),
            undo: () => self.undo(),
            redo: () => self.redo(),
            duplicateSelection: () => self.duplicateSelection(),
            deleteSelectedVertices: () => self.deleteSelectedVertices(),
            deleteSelected: () => self.deleteSelected(),
            insertBetweenSelectedVertices: () => self.insertBetweenSelectedVertices(),
            armDraw: () => self.armDraw(),
            toggleHoveredVertexCorner: () => self.toggleHoveredVertexCorner(),
            reorderSelected: key => self.reorderSelected(key),
            chooseType: type => self.chooseType(type),
            nudgeSelectedVertices: (key, px) => self.nudgeSelectedVertices(key, px),
        };
    }
}

/** Every host interface the sibling modules take; one object serves all. */
type DrawHost = DrawPointerHost & DrawKeysHost & DrawRenderHost;

/** Per-instance host cache. Module-level so each module execution starts empty. */
const drawHosts = new WeakMap<DrawToolService, DrawHost>();

// ─── Hot module replacement (dev only) ────────────────────────────────────
//
// An edit to this file swaps the code of the live DrawToolService in place
// instead of remounting the app (which rebuilds the MapLibre map). The live
// instance keeps its identity because the docks and the command bar hold it
// in fields (selection-panel, feature-stack-panel, feature-dock,
// command-bar); a fresh instance would leave them driving a detached one.

/**
 * Value imports whose identity the live instance depends on: classes it holds
 * instances of, DI keys, and module-level state. If a hot update re-executes
 * this module with any of them changed, the edit was in a dependency and the
 * live instance would keep running the old code. The accept handler then
 * refuses the swap and the update propagates to the app root (remount).
 */
export const DRAW_TOOL_HOT_DEPS: readonly unknown[] = [
    DrawState,
    TraceGesture,
    EditHistory,
    ScreenPointCache,
    ConfirmService,
    geometryToWgs84Rings, // stands for features.service.ts
    toolHotRestart, // editor/tool.ts
];

/**
 * Move the live DrawToolService onto the class `Next` from a re-executed
 * module. If Draw is the active tool, `restart` (EditorModeService.restartTool
 * through the editor/tool.ts seam) deactivates it with the old code, the
 * prototype changes, and it activates again with the new code under a fresh
 * claim. Feature selection survives the restart; an open draft does not
 * (deactivate disarms it). Undo history, draw type and the other signals stay
 * on the instance. `attach` does not re-run, so an edit to `attach` applies
 * on the next canvas mount.
 *
 * Returns false and changes nothing when `Next` declares an instance field
 * the live instance lacks: field initializers cannot run on an existing
 * object.
 */
export function hotSwapDrawTool(
    live: DrawToolService,
    Next: new () => DrawToolService,
    restart: ((toolId: string, between: () => void) => boolean) | null = toolHotRestart.run,
): boolean {
    const fresh = new Next();
    if (Object.keys(fresh).some(key => !Object.hasOwn(live, key))) return false;
    const features = (live as unknown as { features: FeaturesService | null }).features;
    const selected = features?.selectedIds.peek() ?? new Set<string>();
    const swap = (): void => {
        Object.setPrototypeOf(live, Next.prototype);
        di.set(Next, live);
    };
    const restarted = restart ? restart(DRAW_TOOL_ID, swap) : (swap(), false);
    if (restarted && selected.size > 0) features?.setSelection(selected);
    return true;
}

// Vite marks a module self-accepting only on the literal
// `import.meta.hot.accept(` call; an alias of `import.meta.hot` is not seen
// and the edit would fall through to a page reload.
if (import.meta.hot) {
    const hot = import.meta.hot;
    import.meta.hot.accept(next => {
        const mod = next as typeof import('./draw-tool.service') | undefined;
        if (!mod) return;
        const deps = mod.DRAW_TOOL_HOT_DEPS;
        const depsKept = deps.length === DRAW_TOOL_HOT_DEPS.length
            && deps.every((dep, i) => dep === DRAW_TOOL_HOT_DEPS[i]);
        if (!depsKept) {
            hot.invalidate('draw-tool.service: a stateful dependency changed');
            return;
        }
        // Old-module class key: every importer that was not re-executed
        // resolves the service through it.
        if (!mod.hotSwapDrawTool(di.get(DrawToolService), mod.DrawToolService)) {
            hot.invalidate('draw-tool.service: DrawToolService instance fields changed');
            return;
        }
        console.info('[hmr] draw-tool.service: swapped DrawToolService in place');
    });
}
