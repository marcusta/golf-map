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
    ORTHO_SOURCE_ID,
    TERRAIN_SOURCE_ID,
    orthoLayerId,
    orthoSourceId,
    tileUrlTemplate,
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
    /**
     * The tile `?v=` version the LIVE map is currently showing — set on
     * `init()` and updated by `refreshOrthoTiles()`. The editor canvas reads
     * this to decide whether a manifest version change needs a full re-init
     * (structural rebuild) or was already applied in place (ortho patch).
     */
    readonly displayedVersion = new Signal<string | null>(null);
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
    /**
     * Ortho raster SOURCES, in manifest order — the in-place refresh target.
     * `collection` is set only for non-active vintages (served from
     * `ortho/<collection>/` via `?c=`); the active/flat source has none.
     */
    private orthoSources: Array<{ sourceId: string; collection?: string }> = [];
    /** The site id (tile-URL key) the live map was built for. */
    private mapKey: string | null = null;

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
        const active = manifest.activeOrtho ?? vintages[0]?.collection;
        this.orthoLayers = vintages.length > 1
            ? vintages.map(v => ({ collection: v.collection, layerId: orthoLayerId(v.collection) }))
            : [{ collection: active ?? '', layerId: ORTHO_LAYER_ID }];
        this.orthoSources = vintages.length > 1
            ? vintages.map(v => ({
                sourceId: orthoSourceId(v.collection),
                ...(v.collection === active ? {} : { collection: v.collection }),
            }))
            : [{ sourceId: ORTHO_SOURCE_ID }];
        this.mapKey = mapKey;
        this.activeOrtho.set(active ?? null);

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
        this.displayedVersion.set(version);
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
        this.orthoSources = [];
        this.mapKey = null;
        const map = this.map.get();
        if (!map) return;
        batch(() => {
            this.ready.set(false);
            this.map.set(null);
            this.displayedVersion.set(null);
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

    /**
     * Re-fetch the ortho raster tiles at a new `?v=` version IN PLACE — the
     * seam-free path after an ortho-only change (Clean-tool bake/revert). The
     * live map keeps rendering: no re-init, no camera move. Each ortho source
     * is pointed at the new versioned URL and MapLibre streams the new tiles
     * over the current ones. Terrain and hillshade sources are deliberately
     * untouched — ortho patches never change elevation. Updates
     * `displayedVersion` so the editor canvas knows the live map already shows
     * this version and skips a full re-init. No-op before `init()`.
     */
    refreshOrthoTiles(version: string): void {
        if (!this.map.get() || !this.mapKey) return;
        for (const { sourceId, collection } of this.orthoSources) {
            this.setRasterTileUrl(sourceId, tileUrlTemplate(this.mapKey, 'ortho', 'jpg', version, collection));
        }
        this.displayedVersion.set(version);
    }

    /**
     * Dual photo state: point the FLAT ortho source at the pristine tree
     * (`ortho`) or the cleaned copy-on-write overlay (`ortho-sim`, served
     * with per-tile pristine fallback). A presentation toggle for the Clean
     * tool — `displayedVersion` (the pristine build-version guard the editor
     * canvas re-init keys on) is deliberately NOT touched, and per-vintage
     * collection sources always keep showing pristine imagery. `version` is
     * the ?v= for the chosen layer (the sim layer has its own stamp).
     */
    setOrthoPhotoState(layer: 'ortho' | 'ortho-sim', version: string): void {
        if (!this.map.get() || !this.mapKey) return;
        for (const { sourceId, collection } of this.orthoSources) {
            if (collection) continue;
            this.setRasterTileUrl(sourceId, tileUrlTemplate(this.mapKey, layer, 'jpg', version));
        }
    }

    /**
     * Point a live raster tile source at a new URL template in place. Prefers
     * `RasterTileSource.setTiles` (MapLibre re-fetches tiles and re-renders,
     * layer/camera untouched); falls back to swapping the source and re-adding
     * its layers at the same document positions on runtimes without setTiles.
     * No-op when the source is absent (map mid-teardown / not built yet).
     */
    setRasterTileUrl(sourceId: string, template: string): void {
        const map = this.map.get();
        if (!map) return;
        const source = map.getSource(sourceId) as maplibregl.RasterTileSource | undefined;
        if (!source) return;
        if (typeof source.setTiles === 'function') {
            source.setTiles([template]);
            return;
        }
        this.swapRasterSource(map, sourceId, template);
    }

    /**
     * Fallback for `setRasterTileUrl` on older MapLibre without setTiles:
     * remove the source's layers, re-create the source at the new template,
     * and re-add the layers at their original positions (each before the first
     * following layer that is NOT part of the swapped group, so stacking is
     * preserved). Still no map re-init — the camera is never touched.
     */
    private swapRasterSource(map: maplibregl.Map, sourceId: string, template: string): void {
        const style = map.getStyle();
        const sourceSpec = style.sources[sourceId];
        if (!sourceSpec) return;
        const layers = style.layers;
        const isDependent = (l: LayerSpecification) => 'source' in l && l.source === sourceId;
        const dependents = layers
            .map((layer, i) => ({
                layer,
                // The first following layer not itself being swapped — survives
                // the removal and marks where this layer must be re-inserted.
                beforeId: layers.slice(i + 1).find(next => !isDependent(next))?.id,
            }))
            .filter(x => isDependent(x.layer));
        for (const { layer } of dependents) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
        map.addSource(sourceId, { ...sourceSpec, tiles: [template] } as typeof sourceSpec);
        for (const { layer, beforeId } of dependents) {
            map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
        }
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
    addOverlayLayer(
        id: string,
        data: GeoJSON,
        layers: OverlayLayerSpec[],
        opts: { beforeId?: string } = {},
    ): void {
        const map = this.requireMap();
        map.addSource(id, { type: 'geojson', data });
        // `beforeId` slots the overlay UNDER an existing layer (e.g. the vector
        // feature fills) for derived clouds that must not hide the course.
        // Unknown ids are ignored rather than thrown: style layer sets differ
        // between the editor and viewer styles, and a missing anchor should
        // degrade to "on top", not break the tool.
        const beforeId = opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined;
        for (const layer of layers) {
            map.addLayer({ ...layer, source: id } as LayerSpecification, beforeId);
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

    /**
     * Add a georeferenced IMAGE overlay (e.g. the Clean tool's inpaint
     * preview): a data-URL/URL drawn at four WGS84 corners, ordered
     * top-left, top-right, bottom-right, bottom-left. Same lifecycle rules
     * as addOverlayLayer (requires `ready`; gone after destroy). Remove via
     * removeOverlayLayer(id).
     */
    addImageOverlay(
        id: string,
        url: string,
        coordinates: [[number, number], [number, number], [number, number], [number, number]],
        opts: { opacity?: number; beforeId?: string } = {},
    ): void {
        const map = this.requireMap();
        map.addSource(id, { type: 'image', url, coordinates });
        // beforeId slots the raster below an existing layer (e.g. the Clean
        // preview goes under the vector feature fills so water/bunker tints
        // stay visible across it). Silently topmost when that layer is absent.
        const before = opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined;
        map.addLayer({
            id,
            type: 'raster',
            source: id,
            paint: {
                'raster-fade-duration': 0,
                ...(opts.opacity !== undefined ? { 'raster-opacity': opts.opacity } : {}),
            },
        }, before);
        this.overlays.set(id, [id]);
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
