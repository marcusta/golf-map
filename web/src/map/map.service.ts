import maplibregl from 'maplibre-gl';
import type { LayerSpecification, MapMouseEvent } from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import { Signal, batch, effect } from '@basics/core/client/core';
import type { TileManifest } from './tileset.service';
import {
    buildEditorStyle,
    boundsToArray,
    EDITOR_MAX_ZOOM,
    HILLSHADE_LAYER_ID,
    ORTHO_LAYER_ID,
    TERRAIN_SOURCE_ID,
    orthoLayerId,
} from './map-style';
import { InteractionClaims } from './interaction';

/** Normalized pointer event handed to onClick/onMouseMove subscribers. */
export interface MapPointerEvent {
    lngLat: { lng: number; lat: number };
    /** Screen-space pixel position within the map container. */
    point: { x: number; y: number };
    originalEvent: MouseEvent;
}

export type MapPointerHandler = (e: MapPointerEvent) => void;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A LayerSpecification minus `source` — overlay helpers bind the source themselves. */
export type OverlayLayerSpec = DistributiveOmit<LayerSpecification, 'source'>;

/**
 * DI singleton owning the editor's maplibregl.Map lifecycle. This is the
 * foundation API for the editor tools (drawing, furniture, measurement,
 * green analysis):
 *
 * - Lifecycle: `init(container, ...)` / `destroy()`. The editor canvas
 *   component drives both — $swap destroys/recreates it per navigation, so
 *   at most one map exists at a time. `map` and `ready` signal the state:
 *   tools should gate map access on `ready.get()` (style + terrain applied).
 * - Events: `onClick`/`onMouseMove` return unsubscribe functions (pass them
 *   straight to a component's `track()`). Subscriptions survive map
 *   destroy/re-init — subscribe once, they fire whenever a map is live.
 * - Exclusive tool input: `claimInteraction(mode)` / `interactionMode` —
 *   see the contract in interaction.ts. Tools MUST claim a mode before
 *   handling clicks and MUST check the mode in their handlers.
 * - Overlays: `addOverlayLayer`/`updateOverlayData`/`removeOverlayLayer`
 *   for GeoJSON feature rendering. Overlays live on the map instance: they
 *   are gone after `destroy()`, so tools re-add them when `ready` turns
 *   true again (watch it with an effect).
 */
export class MapService {
    /** The live map, or null before init / after destroy. */
    readonly map = new Signal<maplibregl.Map | null>(null);
    /** True once the style has loaded and terrain is applied. */
    readonly ready = new Signal(false);
    /** Current zoom level, updated live (status bars, LOD decisions). */
    readonly zoom = new Signal(0);
    /**
     * Terrain vertical exaggeration. Default 1.0 — flat-ish top-down 2D
     * editing; 1.5 makes relief pop for visual inspection.
     */
    readonly exaggeration = new Signal(1.0);
    /** Hillshade layer visibility. */
    readonly hillshadeVisible = new Signal(false);
    /**
     * Ortho (photo) layer visibility. Turn off to inspect terrain/hillshade
     * alone — useful when splining bunkers/water against relief.
     */
    readonly photoVisible = new Signal(true);
    /** Which ortho vintage (collection) is shown, or null (single/no vintages). */
    readonly activeOrtho = new Signal<string | null>(null);
    /** collection → ortho layer id, in manifest order. Empty until init. */
    private orthoLayers: Array<{ collection: string; layerId: string }> = [];

    private claims = new InteractionClaims();
    /** Current exclusive interaction mode (see interaction.ts contract). */
    readonly interactionMode = this.claims.mode;

    private clickHandlers = new Set<MapPointerHandler>();
    private moveHandlers = new Set<MapPointerHandler>();
    private disposers: Array<() => void> = [];
    /** overlay id → layer ids added for it */
    private overlays = new Map<string, string[]>();
    private tiles: { manifest: TileManifest } | null = null;

    /**
     * Create the editor map inside `container` for a course's tile set.
     * Camera starts fitted to the manifest bounds. Idempotence guard:
     * destroys any previous map first.
     */
    init(container: HTMLElement, mapKey: string, manifest: TileManifest, version: string): void {
        this.destroy();
        this.tiles = { manifest };

        // Ortho vintages → layer ids (mirrors buildEditorStyle). >1 vintage
        // means one layer per collection; otherwise the single flat ortho layer.
        const vintages = manifest.orthoVintages ?? [];
        this.orthoLayers = vintages.length > 1
            ? vintages.map(v => ({ collection: v.collection, layerId: orthoLayerId(v.collection) }))
            : [{ collection: manifest.activeOrtho ?? vintages[0]?.collection ?? '', layerId: ORTHO_LAYER_ID }];
        this.activeOrtho.set(manifest.activeOrtho ?? vintages[0]?.collection ?? null);

        const map = new maplibregl.Map({
            container,
            style: buildEditorStyle(mapKey, manifest, version),
            bounds: boundsToArray(manifest.bounds),
            fitBoundsOptions: { padding: 24 },
            minZoom: Math.min(manifest.layers.ortho.minzoom, manifest.layers.terrain.minzoom),
            maxZoom: EDITOR_MAX_ZOOM,
            // Attribution is rendered by the editor canvas's status pill
            // (single bottom-right overlay) instead of MapLibre's control,
            // which starts expanded and overlapped the cursor readout.
            attributionControl: false,
        });

        map.on('error', e => {
            // MapLibre swallows tile/style errors into 'error' events —
            // surface them so broken tiles are visible during development.
            console.error('[map]', e.error?.message ?? e.error ?? e);
        });
        map.on('load', () => {
            batch(() => {
                this.ready.set(true);
                this.zoom.set(map.getZoom());
            });
        });
        map.on('zoom', () => this.zoom.set(map.getZoom()));
        map.on('click', e => this.dispatch(this.clickHandlers, e));
        map.on('mousemove', e => this.dispatch(this.moveHandlers, e));

        // Reactive terrain + hillshade — re-applied whenever the signals
        // change (and initially when `ready` flips true).
        this.disposers.push(effect(() => {
            const exaggeration = this.exaggeration.get();
            if (!this.ready.get()) return;
            map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
        }));
        this.disposers.push(effect(() => {
            const visible = this.hillshadeVisible.get();
            if (!this.ready.get()) return;
            map.setLayoutProperty(HILLSHADE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
        }));
        // Ortho visibility: show only the active vintage's layer, and only when
        // the photo layer is on (off → hillshade/terrain-only). Toggling
        // visibility is instant — MapLibre keeps already-fetched tiles cached.
        this.disposers.push(effect(() => {
            const photo = this.photoVisible.get();
            const active = this.activeOrtho.get();
            if (!this.ready.get()) return;
            const single = this.orthoLayers.length === 1;
            for (const { collection, layerId } of this.orthoLayers) {
                const show = photo && (single || collection === active);
                map.setLayoutProperty(layerId, 'visibility', show ? 'visible' : 'none');
            }
        }));

        // Size watchdog. MapLibre's own ResizeObserver only flushes during
        // rendering frames; when the map is created in a context that is not
        // producing frames yet (hidden/background tab, container not laid
        // out, embedded preview), the canvas sticks at MapLibre's 400x300
        // fallback and the constructor's fitBounds ran against that bogus
        // size. Poll cheaply, resize on mismatch, and re-fit the course the
        // first time we recover from a degenerate initial size.
        const degenerateAtInit = container.clientWidth === 0 || container.clientHeight === 0;
        let needsRefit = degenerateAtInit;
        const watchdog = setInterval(() => {
            if (container.clientWidth === 0 || container.clientHeight === 0) return;
            const canvas = map.getCanvas();
            if (canvas.clientWidth !== container.clientWidth || canvas.clientHeight !== container.clientHeight) {
                map.resize();
                if (needsRefit) {
                    needsRefit = false;
                    map.fitBounds(boundsToArray(manifest.bounds), { padding: 24, duration: 0 });
                }
            }
        }, 250);
        this.disposers.push(() => clearInterval(watchdog));

        // Middle-button drag always pans, regardless of the active tool.
        // MapLibre's dragPan only responds to the left button, and tools
        // claim left-click/drag for their own gestures (drawing, marquee,
        // marker drags) — the middle button is the one input no tool uses,
        // so it stays a reliable escape hatch for navigation mid-gesture.
        const canvas = map.getCanvas();
        let panLast: { x: number; y: number } | null = null;
        const onMidDown = (e: MouseEvent) => {
            if (e.button !== 1) return;
            e.preventDefault(); // suppress browser autoscroll
            panLast = { x: e.clientX, y: e.clientY };
        };
        const onMidMove = (e: MouseEvent) => {
            if (!panLast) return;
            map.panBy([panLast.x - e.clientX, panLast.y - e.clientY], { duration: 0 });
            panLast = { x: e.clientX, y: e.clientY };
        };
        const onMidUp = (e: MouseEvent) => {
            if (e.button === 1) panLast = null;
        };
        canvas.addEventListener('mousedown', onMidDown);
        // Window-level move/up so the pan survives leaving the canvas mid-drag.
        window.addEventListener('mousemove', onMidMove);
        window.addEventListener('mouseup', onMidUp);
        this.disposers.push(() => {
            canvas.removeEventListener('mousedown', onMidDown);
            window.removeEventListener('mousemove', onMidMove);
            window.removeEventListener('mouseup', onMidUp);
        });

        this.map.set(map);
        // QA hook (same as the Phase 2 demo): expose the instance for
        // scripted/visual verification tooling. Not part of the public API.
        (window as any).__map = map;
    }

    /** Tear down the map. Safe to call when no map exists. */
    destroy(): void {
        for (const dispose of this.disposers) dispose();
        this.disposers = [];
        this.overlays.clear();
        this.tiles = null;
        const map = this.map.get();
        if (!map) return;
        batch(() => {
            this.ready.set(false);
            this.map.set(null);
        });
        map.remove();
    }

    // ── Camera ────────────────────────────────────────────────────────────

    /** Fit the camera to the course's tile-manifest bounds. */
    fitCourse(): void {
        const map = this.map.get();
        if (!map || !this.tiles) return;
        map.fitBounds(boundsToArray(this.tiles.manifest.bounds), { padding: 24 });
    }

    /**
     * Fly the camera to a position. Building block for per-hole navigation
     * (`flyToHole` lands with hole geometry — holes carry no coordinates
     * yet, so tools with feature geometry call this directly for now).
     */
    flyTo(center: { lng: number; lat: number }, zoomLevel?: number): void {
        this.map.get()?.flyTo({ center: [center.lng, center.lat], ...(zoomLevel !== undefined ? { zoom: zoomLevel } : {}) });
    }

    /**
     * Ease the camera to a WGS84 bounding box `[west, south, east, north]`.
     * Building block for framing a hole from its furniture (holes carry no
     * coordinates, so callers derive the box from tees/aims/green). A
     * zero-area box (a single point) degenerates to a `flyTo` at `maxZoom`.
     */
    fitBounds(
        bounds: [number, number, number, number],
        opts: { padding?: number; maxZoom?: number } = {},
    ): void {
        const map = this.map.get();
        if (!map) return;
        const [w, s, e, n] = bounds;
        const padding = opts.padding ?? 96;
        const maxZoom = opts.maxZoom ?? 18;
        if (w === e && s === n) {
            map.flyTo({ center: [w, s], zoom: maxZoom, duration: 700 });
            return;
        }
        map.fitBounds([[w, s], [e, n]], { padding, maxZoom, duration: 700 });
    }

    // ── Terrain / hillshade controls ──────────────────────────────────────

    /** Set terrain vertical exaggeration (applied live when the map is ready). */
    setExaggeration(value: number): void {
        this.exaggeration.set(value);
    }

    /** Show/hide the hillshade layer. */
    setHillshade(visible: boolean): void {
        this.hillshadeVisible.set(visible);
    }

    /** Show/hide the ortho (photo) layer — off leaves terrain/hillshade alone. */
    setPhoto(visible: boolean): void {
        this.photoVisible.set(visible);
    }

    /**
     * Switch the shown ortho vintage (client-side layer toggle — no server
     * re-tile). No-op when the collection isn't one of the map's vintages.
     */
    setActiveOrtho(collection: string): void {
        if (!this.orthoLayers.some(l => l.collection === collection)) return;
        this.activeOrtho.set(collection);
    }

    // ── Event plumbing for tools ──────────────────────────────────────────

    /**
     * Subscribe to map clicks. Returns an unsubscribe function — register
     * it with the calling component's `track()`. Handlers are broadcast to
     * ALL subscribers: tool handlers must gate on `interactionMode`.
     */
    onClick(handler: MapPointerHandler): () => void {
        this.clickHandlers.add(handler);
        return () => this.clickHandlers.delete(handler);
    }

    /** Subscribe to map mousemove. Same contract as `onClick`. */
    onMouseMove(handler: MapPointerHandler): () => void {
        this.moveHandlers.add(handler);
        return () => this.moveHandlers.delete(handler);
    }

    /**
     * Claim exclusive click/interaction handling for a tool. Returns the
     * release function. Full contract: see InteractionClaims (interaction.ts).
     */
    claimInteraction(mode: string): () => void {
        return this.claims.claim(mode);
    }

    // ── GeoJSON overlays for tools ────────────────────────────────────────

    /**
     * Add a GeoJSON source (`id`) plus one or more layers rendering it.
     * Layer ids must be unique across the map — prefix them with the
     * overlay id by convention (e.g. `measure-line`, `measure-points`).
     * Requires `ready` to be true (throws otherwise). Overlays do not
     * survive `destroy()`; re-add when `ready` turns true again.
     */
    addOverlayLayer(id: string, data: GeoJSON, layers: OverlayLayerSpec[]): void {
        const map = this.requireMap();
        map.addSource(id, { type: 'geojson', data });
        for (const layer of layers) {
            map.addLayer({ ...layer, source: id } as LayerSpecification);
        }
        this.overlays.set(id, layers.map(l => l.id));
    }

    /** Replace the GeoJSON data of an overlay added via `addOverlayLayer`. */
    updateOverlayData(id: string, data: GeoJSON): void {
        const map = this.requireMap();
        const source = map.getSource(id);
        if (source && source.type === 'geojson') {
            (source as maplibregl.GeoJSONSource).setData(data);
        }
    }

    /** Remove an overlay's layers and source. No-op if absent. */
    removeOverlayLayer(id: string): void {
        const map = this.map.get();
        if (!map) return;
        for (const layerId of this.overlays.get(id) ?? []) {
            if (map.getLayer(layerId)) map.removeLayer(layerId);
        }
        if (map.getSource(id)) map.removeSource(id);
        this.overlays.delete(id);
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private requireMap(): maplibregl.Map {
        const map = this.map.get();
        if (!map || !this.ready.get()) {
            throw new Error('MapService: map is not ready — gate overlay calls on the ready signal');
        }
        return map;
    }

    private dispatch(handlers: Set<MapPointerHandler>, e: MapMouseEvent): void {
        if (handlers.size === 0) return;
        const evt: MapPointerEvent = {
            lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
            point: { x: e.point.x, y: e.point.y },
            originalEvent: e.originalEvent,
        };
        for (const handler of [...handlers]) handler(evt);
    }
}
