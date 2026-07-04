import { Signal, effect, untrack } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent, FilterSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent, OverlayLayerSpec } from '../map/map.service';
import type { FeaturesService } from './features.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { lngLatToSweref99tm, sweref99tmToWgs84 } from '../geo/transform';
import {
    flattenOpenPath,
    nearestOnRing,
    pointInGeometry,
    outerRingArea,
    type AnchorPoint,
    type FeatureGeometry,
    type Point,
} from '../geo/bezier';
import {
    DrawState,
    moveAnchor,
    moveHandle,
    setSymmetricHandles,
    clearHandles,
    hasHandles,
    deleteAnchor,
    insertAnchor,
} from './draw-state';
import { SELECTION_COLOR, type FeatureType } from './feature-palette';

/** Interaction-claim id AND overlay id prefix for the draw tool. */
export const DRAW_TOOL_ID = 'draw';
/** Preview overlay (draft line, vertex + bezier-handle markers). */
export const DRAW_OVERLAY_ID = 'draw';

// Screen-space hit tolerances (px)
const VERTEX_HIT_PX = 9;
const HANDLE_HIT_PX = 7;
const EDGE_HIT_PX = 6;
const CLOSE_RING_PX = 12;
const DRAG_MOVE_THRESHOLD_PX = 3;

interface DragTarget {
    kind: 'anchor' | 'handle' | 'newHandles';
    which?: 'hIn' | 'hOut';
    featureId: string;
    ringIdx: number;
    idx: number;
    alt: boolean;
    hadHandles: boolean;
    startScreen: { x: number; y: number };
    moved: boolean;
}

/**
 * Course-feature drawing/editing interactions. Registered as the `draw`
 * EditorTool (see draw-tool.ts); DrawPanelComponent shares this DI
 * singleton for its UI state.
 *
 * Modes (see DrawState):
 * - select (default): click a feature to select it; click empty ortho to
 *   deselect. A selected feature shows draggable vertex handles: drag to
 *   move (autosaves on mouseup), alt-drag to pull out symmetric bezier
 *   handles, alt-click to straighten a curved vertex, right-click to
 *   delete a vertex, click on an edge to insert a vertex (curve-preserving
 *   split), drag the small round handles to bend segments. Delete/Backspace
 *   removes the selected feature (confirm).
 * - draw (N or panel button): click to place anchors, Enter / double-click
 *   / click-on-first-vertex to close the ring — which creates the feature
 *   (autosave) with the panel's type + hole. ESC cancels.
 */
export class DrawToolService {
    readonly state = new DrawState();
    /** Feature type used for the next created polygon. */
    readonly drawType = new Signal<FeatureType>('bunker');
    /** Hole assignment for the next created polygon (null = course level). */
    readonly drawHoleId = new Signal<string | null>(null);

    /** Live cursor position while drawing (rubber-band preview). */
    private cursor = new Signal<{ lng: number; lat: number } | null>(null);
    private ctx: ToolContext | null = null;
    private features: FeaturesService | null = null;
    private drag: DragTarget | null = null;
    private suppressClick = false;
    private previewAdded = false;

    // ── EditorTool lifecycle (called via draw-tool.ts) ────────────────────

    /** Canvas mount: load the course's features + persistent overlay. */
    attach(ctx: ToolContext): void {
        this.features = ctx.features;
        void ctx.features.load(ctx.courseId);
        ctx.track(ctx.features.attachOverlay(ctx.map));
    }

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.features = ctx.features;

        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

        // Raw map handlers (mousedown/up for vertex drags, dblclick to
        // close, contextmenu to delete vertices) — re-bound if the map is
        // recreated while the tool is active.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const map = ctx.map.map.get();
            if (!map) return;
            untrack(() => this.bindRawHandlers(map, ctx));
        }));

        // Preview overlay: draft outline + vertex/bezier-handle markers.
        ctx.track(effect(() => {
            const ready = ctx.map.ready.get();
            const data = this.previewGeojson();
            if (!ready) {
                this.previewAdded = false;
                return;
            }
            if (!this.previewAdded) {
                ctx.map.addOverlayLayer(DRAW_OVERLAY_ID, data, previewLayers());
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

        // Crosshair cursor while drawing.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const drawing = this.state.isDrawing.get();
            const canvas = ctx.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = drawing ? 'crosshair' : '';
        }));
        ctx.track(() => {
            const canvas = ctx.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = '';
        });
    }

    deactivate(): void {
        this.endDrag();
        this.state.disarm();
        this.cursor.set(null);
        this.features?.select(null);
        this.suppressClick = false;
        this.ctx = null;
    }

    /** ESC: cancel drawing → drop selection → (unconsumed) deactivate. */
    onEscape(): boolean {
        if (this.state.handleEscape()) return true;
        if (this.features?.selectedId.peek()) {
            this.features.select(null);
            return true;
        }
        return false;
    }

    // ── Map event handling ────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.ctx?.map.interactionMode.peek() === DRAW_TOOL_ID;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.suppressClick) return;

        const p = lngLatToSweref99tm(e.lngLat);

        if (this.state.isDrawing.peek()) {
            const draft = this.state.draft.peek();
            if (draft.length >= 3 && this.screenDist(draft[0], e.point) < CLOSE_RING_PX) {
                this.closeDraft();
                return;
            }
            this.state.addPoint(p);
            return;
        }

        // Select mode. Edge click on the selected feature inserts a vertex.
        const selected = this.features?.selected.peek() ?? null;
        if (selected) {
            const insertion = this.edgeInsertionHit(selected, p, e.lngLat.lat);
            if (insertion) {
                const geometry = insertAnchor(selected.geometry, insertion.ringIdx, insertion.segIdx, insertion.t);
                this.commitGeometry(selected.id, geometry);
                return;
            }
        }
        const hit = this.hitFeature(p);
        this.features?.select(hit?.id ?? null);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;

        if (this.state.isDrawing.peek()) {
            this.cursor.set(e.lngLat);
            return;
        }

        const drag = this.drag;
        if (!drag || !this.features) return;
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        drag.moved = true;

        const feature = this.features.store.items.peek().find(f => f.id === drag.featureId);
        if (!feature) return;
        const p = lngLatToSweref99tm(e.lngLat);
        let geometry: FeatureGeometry;
        if (drag.kind === 'anchor') {
            geometry = moveAnchor(feature.geometry, drag.ringIdx, drag.idx, p);
        } else if (drag.kind === 'handle') {
            geometry = moveHandle(feature.geometry, drag.ringIdx, drag.idx, drag.which!, p);
        } else {
            geometry = setSymmetricHandles(feature.geometry, drag.ringIdx, drag.idx, p);
        }
        this.features.patchLocal(drag.featureId, geometry);
    }

    private bindRawHandlers(map: MaplibreMap, ctx: ToolContext): void {
        const onMouseDown = (e: MapMouseEvent) => this.onMouseDown(e, map);
        const onMouseUp = () => this.onMouseUp(map);
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
        if (this.state.mode.peek() !== 'select') return;
        const selected = this.features?.selected.peek();
        if (!selected) return;

        const hit = this.hitVertexOrHandle(map, selected, e.point);
        if (!hit) return;

        e.preventDefault(); // stops the map's drag-pan for this gesture
        map.dragPan.disable();

        const anchor = selected.geometry.rings[hit.ringIdx].points[hit.idx];
        const alt = e.originalEvent.altKey;
        this.drag = {
            kind: hit.kind === 'handle' ? 'handle' : alt ? 'newHandles' : 'anchor',
            which: hit.which,
            featureId: selected.id,
            ringIdx: hit.ringIdx,
            idx: hit.idx,
            alt,
            hadHandles: hasHandles(anchor),
            startScreen: { x: e.point.x, y: e.point.y },
            moved: false,
        };
    }

    private onMouseUp(map: MaplibreMap): void {
        const drag = this.drag;
        if (!drag || !this.features) return;
        this.endDrag(map);

        // Swallow the click MapLibre synthesizes right after this mouseup.
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);

        if (drag.moved) {
            const feature = this.features.store.items.peek().find(f => f.id === drag.featureId);
            if (feature) void this.features.update(drag.featureId, { geometry: feature.geometry });
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
        // The dblclick's two click events each placed an anchor; the second
        // is a duplicate of the intended final point — drop it, then close.
        if (this.state.draft.peek().length > 3) this.state.popPoint();
        this.closeDraft();
    }

    private onContextMenu(e: MapMouseEvent, map: MaplibreMap): void {
        if (!this.isMyClaim()) return;
        const selected = this.features?.selected.peek();
        if (!selected) return;
        const hit = this.hitVertexOrHandle(map, selected, e.point);
        if (!hit || hit.kind !== 'anchor') return;
        e.preventDefault();
        const geometry = deleteAnchor(selected.geometry, hit.ringIdx, hit.idx);
        if (geometry) this.commitGeometry(selected.id, geometry);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;

        if (e.key === 'Enter') {
            if (this.state.isDrawing.peek() && this.state.canClose.peek()) {
                e.preventDefault();
                this.closeDraft();
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            const selected = this.features?.selected.peek();
            if (selected) {
                e.preventDefault();
                this.deleteSelected();
            }
        } else if (e.key === 'n' || e.key === 'N') {
            if (!this.state.isDrawing.peek()) {
                e.preventDefault();
                this.state.arm();
            }
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────

    /** Close the draft ring and autosave it as a new feature. */
    closeDraft(): void {
        const ring = this.state.closeDraft();
        if (!ring || !this.features) return;
        this.cursor.set(null);
        void this.features.create({
            type: this.drawType.peek(),
            holeId: this.drawHoleId.peek(),
            geometry: { crs: 'EPSG:3006', rings: [ring] },
        });
    }

    /** Delete the selected feature after confirmation (key or panel button). */
    deleteSelected(): void {
        const selected = this.features?.selected.peek();
        if (!selected || !this.features) return;
        if (!window.confirm(`Delete this ${selected.type} feature?`)) return;
        void this.features.removeFeature(selected.id);
    }

    private commitGeometry(id: string, geometry: FeatureGeometry): void {
        if (!this.features) return;
        this.features.patchLocal(id, geometry); // instant visual feedback
        void this.features.update(id, { geometry });
    }

    private endDrag(map?: MaplibreMap): void {
        if (!this.drag) return;
        this.drag = null;
        (map ?? this.ctx?.map.map.peek())?.dragPan.enable();
    }

    // ── Hit testing ───────────────────────────────────────────────────────

    /** Topmost (smallest outer ring) feature containing the EPSG:3006 point. */
    private hitFeature(p: Point): CourseFeature | null {
        if (!this.features) return null;
        let best: CourseFeature | null = null;
        let bestArea = Infinity;
        for (const feature of this.features.store.items.peek()) {
            if (!pointInGeometry(p, feature.geometry)) continue;
            const area = outerRingArea(feature.geometry);
            if (area < bestArea) {
                bestArea = area;
                best = feature;
            }
        }
        return best;
    }

    private hitVertexOrHandle(
        map: MaplibreMap,
        feature: CourseFeature,
        screen: { x: number; y: number },
    ): { kind: 'anchor' | 'handle'; which?: 'hIn' | 'hOut'; ringIdx: number; idx: number } | null {
        // Handles first: they are smaller and rendered on top.
        for (let r = 0; r < feature.geometry.rings.length; r++) {
            const points = feature.geometry.rings[r].points;
            for (let i = 0; i < points.length; i++) {
                for (const which of ['hIn', 'hOut'] as const) {
                    const handle = points[i][which];
                    if (!handle) continue;
                    if (this.screenDist(handle, screen, map) < HANDLE_HIT_PX) {
                        return { kind: 'handle', which, ringIdx: r, idx: i };
                    }
                }
            }
        }
        for (let r = 0; r < feature.geometry.rings.length; r++) {
            const points = feature.geometry.rings[r].points;
            for (let i = 0; i < points.length; i++) {
                if (this.screenDist(points[i], screen, map) < VERTEX_HIT_PX) {
                    return { kind: 'anchor', ringIdx: r, idx: i };
                }
            }
        }
        return null;
    }

    /**
     * If the EPSG:3006 point lies within EDGE_HIT_PX of the selected
     * feature's outline (but not near an existing vertex), return the
     * insertion spot.
     */
    private edgeInsertionHit(
        feature: CourseFeature,
        p: Point,
        lat: number,
    ): { ringIdx: number; segIdx: number; t: number } | null {
        const zoom = this.ctx?.map.zoom.peek() ?? 18;
        const metersPerPx = (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / 2 ** (zoom + 8);
        const tol = EDGE_HIT_PX * metersPerPx;

        for (let r = 0; r < feature.geometry.rings.length; r++) {
            const ring = feature.geometry.rings[r];
            const hit = nearestOnRing(ring, p);
            if (!hit || hit.dist > tol) continue;
            // Too close to an existing vertex → treat as a missed vertex
            // grab, not an insertion.
            const nearVertex = ring.points.some(
                a => Math.hypot(a.x - p.x, a.y - p.y) < tol * 2,
            );
            if (nearVertex) continue;
            return { ringIdx: r, segIdx: hit.segIdx, t: hit.t };
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

    /** Draft outline + vertex/handle markers as a WGS84 FeatureCollection. */
    private previewGeojson(): FeatureCollection {
        const features: Feature[] = [];
        const toLngLat = (p: Point): Position => {
            const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
            return [lon, lat];
        };

        if (this.state.isDrawing.get()) {
            const draft = this.state.draft.get();
            const cursor = this.cursor.get();
            const line: Position[] = flattenOpenPath(draft, 0.25).map(([x, y]) => toLngLat({ x, y }));
            if (cursor && line.length > 0) line.push([cursor.lng, cursor.lat]);
            if (line.length >= 2) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'draft-line' },
                    geometry: { type: 'LineString', coordinates: line },
                });
            }
            if (line.length >= 3) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'draft-fill' },
                    geometry: { type: 'Polygon', coordinates: [[...line, line[0]]] },
                });
            }
            draft.forEach((p, i) => {
                features.push({
                    type: 'Feature',
                    properties: { role: i === 0 ? 'first-vertex' : 'vertex' },
                    geometry: { type: 'Point', coordinates: toLngLat(p) },
                });
            });
        } else {
            const selected = this.selectedForPreview();
            if (selected) {
                for (const ring of selected.geometry.rings) {
                    ring.points.forEach((p: AnchorPoint) => {
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
                        features.push({
                            type: 'Feature',
                            properties: { role: 'vertex' },
                            geometry: { type: 'Point', coordinates: toLngLat(p) },
                        });
                    });
                }
            }
        }
        return { type: 'FeatureCollection', features };
    }

    /** Reactive read of the selected feature (null when tool inactive). */
    private selectedForPreview(): CourseFeature | null {
        return this.features ? this.features.selected.get() : null;
    }
}

/** Preview overlay layer specs (ids prefixed with the overlay id). */
function previewLayers(): OverlayLayerSpec[] {
    const role = (value: string): FilterSpecification =>
        ['==', ['get', 'role'], value] as FilterSpecification;
    return [
        {
            id: 'draw-draft-fill',
            type: 'fill',
            filter: role('draft-fill'),
            paint: { 'fill-color': SELECTION_COLOR, 'fill-opacity': 0.15 },
        },
        {
            id: 'draw-draft-line',
            type: 'line',
            filter: role('draft-line'),
            paint: { 'line-color': SELECTION_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        {
            id: 'draw-handle-lines',
            type: 'line',
            filter: role('handle-line'),
            paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.8 },
        },
        {
            id: 'draw-vertices',
            type: 'circle',
            filter: ['in', ['get', 'role'], ['literal', ['vertex', 'first-vertex']]] as FilterSpecification,
            paint: {
                'circle-radius': ['case', ['==', ['get', 'role'], 'first-vertex'], 7, 5] as never,
                'circle-color': '#ffffff',
                'circle-stroke-color': '#1d3b2a',
                'circle-stroke-width': 2,
            },
        },
        {
            id: 'draw-handles',
            type: 'circle',
            filter: role('handle'),
            paint: {
                'circle-radius': 4,
                'circle-color': '#4dabf7',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        },
    ];
}
