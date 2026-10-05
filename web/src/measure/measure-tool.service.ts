import { Signal, Computed, effect, untrack } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { ToolContext } from '../editor/tool';
import { canvasCursor } from '../editor/canvas-cursor';
import { ownedOverlay } from '../editor/owned-overlay';
import { screenDistLngLat } from '../editor/screen-point';
import type { MapPointerEvent, OverlayLayerSpec } from '../map/map.service';
import { lngLatToSweref99tm } from '../geo/transform';
import { MeasureState, type MeasurePoint } from './measure-state';

/** Interaction-claim id AND overlay id prefix for the measure tool. */
export const MEASURE_TOOL_ID = 'measure';
/** Overlay id (points + line + helper triangle). */
export const MEASURE_OVERLAY_ID = 'measure';

/** Screen-px radius: clicking within this of the start point ends the path. */
const CLOSE_PATH_PX = 12;
/** Maximum elevation samples per segment for the profile sparkline. */
export const PROFILE_SAMPLES_PER_SEGMENT = 50;
/**
 * Minimum spacing between profile samples, meters. The terrain DEM is read
 * at z17 (about 0.6 m per pixel at Swedish latitudes), so samples closer
 * than this repeat the same bilinear neighbourhood.
 */
export const PROFILE_SAMPLE_SPACING_M = 1;

/**
 * Profile samples for a segment of `segLen` meters, endpoints included:
 * one per PROFILE_SAMPLE_SPACING_M, clamped to [2, PROFILE_SAMPLES_PER_SEGMENT].
 * A function of the endpoints only, so the endpoint-keyed sample cache
 * stays valid.
 */
export function profileSampleCount(segLen: number): number {
    const n = Math.ceil(segLen / PROFILE_SAMPLE_SPACING_M) + 1;
    return Math.max(2, Math.min(PROFILE_SAMPLES_PER_SEGMENT, n));
}

/** Point labels A, B, C, … (wraps past Z, which never happens for a path). */
export function pointLabel(index: number): string {
    return String.fromCharCode(65 + (index % 26));
}

/**
 * Async elevation sampler — the subset of ElevationService the service
 * depends on (injected for tests). Mirrors the furniture tool's approach.
 */
export interface MeasureElevationSampler {
    elevationAt(lngLat: { lng: number; lat: number }): Promise<number | null>;
    sampleLine(
        a: { lng: number; lat: number },
        b: { lng: number; lat: number },
        n: number,
    ): Promise<Array<{ lng: number; lat: number; elevation: number | null }>>;
}

const NULL_ELEVATION: MeasureElevationSampler = {
    elevationAt: async () => null,
    sampleLine: async (a, b, n) => {
        const count = Math.max(2, Math.floor(n));
        return Array.from({ length: count }, (_, i) => {
            const t = i / (count - 1);
            return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t, elevation: null };
        });
    },
};

/** One resolved elevation-profile sample along the whole path. */
export interface ProfileSample {
    /** Cumulative horizontal distance from the path start, meters. */
    distance: number;
    /** Elevation in meters, or null (missing coverage → gap in the sparkline). */
    elevation: number | null;
}

/**
 * Distance-measurement interactions (click-click, multi-segment). Registered
 * as the `measure` EditorTool (measure-tool.ts); MeasurePanelComponent shares
 * this DI singleton for its readout + profile sparkline.
 *
 * Interaction model (roadmap Phase 3 — extends the golf-map-2 prototype's
 * two-point click-click tool into a multi-segment path):
 *  - 1st click places A, 2nd places B, further clicks EXTEND the path (C, D …).
 *  - Double-click, or a click within CLOSE_PATH_PX of the start point, ENDS
 *    the path (keeps it visible). The next click starts a fresh path.
 *  - Escape clears the path; a second Escape (empty path) deactivates the tool.
 *  - Keys (match the draw tool): Backspace or Cmd/Ctrl+Z removes the last
 *    point while measuring, Enter finishes the path. A dashed rubber-band
 *    segment runs from the last point to the pointer while a path is open,
 *    and is hidden while a mouse button is held (map pan or drag).
 *
 * Elevation is sampled asynchronously per point through the injected sampler
 * (null → shown as '—' and excluded from elevation stats). Distances are
 * computed in EPSG:3006 projected meters (see measure-state.ts).
 *
 * Overlay simplification (documented): per-segment dashed helper lines would
 * clutter a long path, so the right-triangle helper (dashed vertical drop +
 * dashed horizontal reference) is drawn ONLY for the LAST segment of the path.
 * The main amber line still connects every point; point markers are labelled.
 */
export class MeasureToolService {
    readonly state = new MeasureState();

    /** Resolved elevation profile for the current path (sparkline source). */
    readonly profile = new Signal<ProfileSample[]>([]);
    /** True while a profile sample batch is in flight. */
    readonly profileLoading = new Signal(false);

    /** Profile min/max elevation for sparkline labels (null when no data). */
    readonly profileRange = new Computed<{ min: number; max: number } | null>(() => {
        const values = this.profile.get().map(s => s.elevation).filter((e): e is number => e !== null);
        if (values.length === 0) return null;
        return { min: Math.min(...values), max: Math.max(...values) };
    });

    /** Pointer position while a path is open; null when idle or a button is held. */
    readonly cursor = new Signal<{ lng: number; lat: number } | null>(null);

    private elevation: MeasureElevationSampler = NULL_ELEVATION;
    private ctx: ToolContext | null = null;
    /** Monotonic token so stale async elevation/profile results are dropped. */
    private seq = 0;
    /**
     * Per-segment sample requests keyed by the segment's endpoints. Holds the
     * promise, so concurrent refreshes share one request. Dropped on clear()
     * and on a sampler swap; a rejected request is evicted.
     */
    private segmentCache = new Map<string, Promise<Array<{ elevation: number | null }>>>();

    /** Bind the live elevation sampler (ElevationService) — called in attach. */
    useElevation(sampler: MeasureElevationSampler): void {
        if (sampler !== this.elevation) this.segmentCache.clear();
        this.elevation = sampler;
    }

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    attach(ctx: ToolContext): void {
        this.ctx = ctx;
        this.useElevation(ctx.elevation);
    }

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.useElevation(ctx.elevation);

        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

        // Raw dblclick to end the path (and suppress the map's zoom).
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const map = ctx.map.map.get();
            if (!map) return;
            untrack(() => this.bindRawHandlers(map, ctx));
        }));

        // Overlay: main line + point markers + last-segment helper triangle.
        // Re-added whenever the map becomes ready (overlays die with the map).
        ctx.track(ownedOverlay(ctx.map, MEASURE_OVERLAY_ID, () => this.overlayGeojson(), measureLayers));

        // Crosshair cursor while measuring.
        ctx.track(canvasCursor(ctx.map, () => 'crosshair'));

        // Recompute the elevation profile whenever the path geometry changes.
        ctx.track(effect(() => {
            this.state.points.get(); // dependency
            untrack(() => void this.refreshProfile());
        }));
    }

    deactivate(): void {
        this.ctx = null;
        this.cursor.set(null);
    }

    /** True while a path is open (placed points, not yet ended). */
    isBusy(): boolean {
        return this.state.count.peek() > 0 && !this.state.ended.peek();
    }

    /** ESC: clear a visible path → (unconsumed) deactivate. */
    onEscape(): boolean {
        if (this.state.count.peek() > 0) {
            this.clear();
            return true;
        }
        return false;
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /** Clear the path + profile (Escape / panel button). */
    clear(): void {
        this.seq++; // invalidate any in-flight elevation/profile work
        this.segmentCache.clear();
        this.cursor.set(null);
        this.state.clear();
        this.profile.set([]);
        this.profileLoading.set(false);
    }

    // ── Map event handling ──────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.ctx?.map.interactionMode.peek() === MEASURE_TOOL_ID;
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        // A held button means a pan or drag: no rubber band while it lasts.
        if (e.originalEvent.buttons !== 0 || !this.isBusy()) {
            if (this.cursor.peek()) this.cursor.set(null);
            return;
        }
        this.cursor.set({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    }

    /** Remove the last point of an open path. Returns false when nothing to undo. */
    undoPoint(): boolean {
        if (!this.isBusy()) return false;
        this.state.points.update(pts => pts.slice(0, -1));
        if (this.state.count.peek() === 0) this.cursor.set(null);
        return true;
    }

    /** Finish an open path (Enter). Needs two points. */
    finish(): boolean {
        if (!this.isBusy() || this.state.count.peek() < 2) return false;
        this.state.end();
        this.cursor.set(null);
        return true;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;

        // Click near the start point (while an active, un-ended path exists)
        // ends the path instead of extending it.
        const points = this.state.points.peek();
        if (points.length >= 2 && !this.state.ended.peek()) {
            if (this.screenDist(points[0], e.point) < CLOSE_PATH_PX) {
                this.state.end();
                this.cursor.set(null);
                return;
            }
        }

        const proj = lngLatToSweref99tm(e.lngLat);
        const point: MeasurePoint = {
            lng: e.lngLat.lng,
            lat: e.lngLat.lat,
            e: proj.x,
            n: proj.y,
            elevation: null,
        };
        this.state.place(point);

        // Resolve elevation asynchronously, then patch it into the point.
        // Guard against a clear()/restart between place and resolve: the
        // index must still hold this exact point (same lng/lat) when it lands.
        const index = this.state.points.peek().length - 1;
        void this.elevation.elevationAt({ lng: point.lng, lat: point.lat }).then(elevation => {
            const current = this.state.points.peek()[index];
            if (current && current.lng === point.lng && current.lat === point.lat) {
                this.state.setElevation(index, elevation);
            }
        });
    }

    private bindRawHandlers(map: MaplibreMap, ctx: ToolContext): void {
        const onDblClick = (e: MapMouseEvent) => this.onDblClick(e);
        map.on('dblclick', onDblClick);
        ctx.track(() => map.off('dblclick', onDblClick));
    }

    private onDblClick(e: MapMouseEvent): void {
        if (!this.isMyClaim()) return;
        if (this.state.points.peek().length < 2) return;
        e.preventDefault(); // no double-click zoom while ending a path
        // The dblclick's two clicks each placed a point; the second is a
        // duplicate of the intended final point — drop it, then end.
        const points = this.state.points.peek();
        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        if (points.length > 2 && last.lng === prev.lng && last.lat === prev.lat) {
            this.state.points.update(pts => pts.slice(0, -1));
        }
        this.state.end();
        this.cursor.set(null);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;
        // Escape is handled by the toolbar via onEscape(). Backspace, Cmd/Ctrl+Z
        // and Enter are not editor-wide keys (editor-keys.ts), so they reach
        // this listener.
        const meta = e.metaKey || e.ctrlKey;
        if (e.key === 'Backspace' && !meta && !e.altKey) {
            if (this.undoPoint()) e.preventDefault();
        } else if (meta && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
            if (this.undoPoint()) e.preventDefault();
        } else if (e.key === 'Enter' && !meta) {
            if (this.finish()) e.preventDefault();
        }
    }

    // ── Elevation profile (sparkline source) ────────────────────────────────

    /**
     * Rebuild the elevation profile across the whole path via the sampler's
     * sampleLine (profileSampleCount(segLen) per segment). Cumulative
     * distance uses the EPSG:3006 segment lengths already on the points.
     */
    private async refreshProfile(): Promise<void> {
        const points = this.state.points.peek();
        if (points.length < 2) {
            this.seq++; // a shorter path must not be overwritten by an older, longer one
            this.profile.set([]);
            this.profileLoading.set(false);
            return;
        }
        const token = ++this.seq;
        this.profileLoading.set(true);

        // Every segment is requested at once; unchanged segments hit the cache.
        const segments = points.slice(1).map((b, i) => {
            const a = points[i];
            const segLen = Math.hypot(b.e - a.e, b.n - a.n);
            return { segLen, line: this.segmentLine(a, b, profileSampleCount(segLen)) };
        });
        let lines: Array<Array<{ elevation: number | null }>>;
        try {
            lines = await Promise.all(segments.map(seg => seg.line));
        } catch {
            if (token === this.seq) this.profileLoading.set(false);
            return;
        }
        if (token !== this.seq) return; // superseded, drop

        const samples: ProfileSample[] = [];
        let cumulative = 0;
        segments.forEach((seg, i) => {
            const line = lines[i];
            // Skip the first sample of every segment after the first to avoid
            // duplicating the shared vertex.
            const start = i === 0 ? 0 : 1;
            for (let k = start; k < line.length; k++) {
                const t = k / (line.length - 1);
                samples.push({ distance: cumulative + seg.segLen * t, elevation: line[k].elevation });
            }
            cumulative += seg.segLen;
        });
        this.profile.set(samples);
        this.profileLoading.set(false);
    }

    /**
     * Cached sampleLine request for one segment, keyed by its endpoints.
     * `n` is derived from the endpoints, so the key needs nothing else.
     */
    private segmentLine(a: MeasurePoint, b: MeasurePoint, n: number): Promise<Array<{ elevation: number | null }>> {
        const key = `${a.lng},${a.lat}|${b.lng},${b.lat}`;
        let hit = this.segmentCache.get(key);
        if (!hit) {
            const cache = this.segmentCache;
            hit = this.elevation.sampleLine(
                { lng: a.lng, lat: a.lat },
                { lng: b.lng, lat: b.lat },
                n,
            );
            hit.catch(() => { if (cache.get(key) === hit) cache.delete(key); });
            cache.set(key, hit);
        }
        return hit;
    }

    // ── Overlay ─────────────────────────────────────────────────────────────

    /**
     * Path geometry as a WGS84 FeatureCollection:
     *  - `main-line`: amber polyline through every point.
     *  - `drop` / `reference`: dashed helper legs of the last segment's
     *    right-triangle (vertical drop at B, horizontal reference at A's
     *    height). Only drawn for the final segment to avoid clutter.
     *  - point markers, tagged `role` first/last/mid for A/B/… styling.
     *
     * The dashed drop/reference legs are drawn as straight lng/lat segments
     * (there is no vertical axis on a 2D map); they visually connect the last
     * two points, so on a top-down map the "reference" runs A→B and the
     * "drop" is a short marker at B. The right-triangle metaphor is fully
     * legible in the panel's stats + profile; on the map we keep it minimal.
     */
    private overlayGeojson(): FeatureCollection {
        const points = this.state.points.get();
        const features: Feature[] = [];
        const toLngLat = (p: MeasurePoint): Position => [p.lng, p.lat];

        if (points.length >= 2) {
            features.push({
                type: 'Feature',
                properties: { role: 'main-line' },
                geometry: { type: 'LineString', coordinates: points.map(toLngLat) },
            });

            // Last-segment helper: horizontal reference (A→B at ground) drawn
            // as a dashed gray casing under the amber main line, plus a small
            // cyan "drop" tick at B pointing back toward A (marks the segment
            // whose elevation Δ the readout emphasises).
            const b = points[points.length - 1];
            const a = points[points.length - 2];
            features.push({
                type: 'Feature',
                properties: { role: 'reference' },
                geometry: { type: 'LineString', coordinates: [toLngLat(a), toLngLat(b)] },
            });
            // Short cyan drop marker: 30% of the last segment, anchored at B.
            const dropLng = b.lng + (a.lng - b.lng) * 0.15;
            const dropLat = b.lat + (a.lat - b.lat) * 0.15;
            features.push({
                type: 'Feature',
                properties: { role: 'drop' },
                geometry: { type: 'LineString', coordinates: [toLngLat(b), [dropLng, dropLat]] },
            });
        }

        // Rubber band: last point to the pointer while the path is open.
        const cursor = this.cursor.get();
        if (cursor && points.length > 0 && !this.state.ended.get()) {
            features.push({
                type: 'Feature',
                properties: { role: 'cursor' },
                geometry: { type: 'LineString', coordinates: [toLngLat(points[points.length - 1]), [cursor.lng, cursor.lat]] },
            });
        }

        points.forEach((p, i) => {
            const role = i === 0 ? 'first' : i === points.length - 1 ? 'last' : 'mid';
            features.push({
                type: 'Feature',
                properties: { role: 'point', kind: role, label: pointLabel(i) },
                geometry: { type: 'Point', coordinates: toLngLat(p) },
            });
        });

        return { type: 'FeatureCollection', features };
    }

    /** Flat screen-pixel distance from a placed point to a screen position. */
    private screenDist(p: MeasurePoint, screen: { x: number; y: number }): number {
        const map = this.ctx?.map.map.peek();
        return map ? screenDistLngLat(map, p, screen) : Infinity;
    }
}

/** Colours (matching the golf-map-2 prototype). */
const COLOR_A = '#22c55e'; // point A — green
const COLOR_B = '#ef4444'; // point B / last — red
const COLOR_MID = '#fbbf24'; // intermediate points — amber
const COLOR_LINE = '#fbbf24'; // main line — amber
const COLOR_DROP = '#06b6d4'; // vertical drop — cyan
const COLOR_REFERENCE = '#9ca3af'; // horizontal reference — gray

/** Overlay layer specs (ids prefixed with the overlay id). */
function measureLayers(): OverlayLayerSpec[] {
    const role = (value: string) => ['==', ['get', 'role'], value] as never;
    return [
        {
            id: 'measure-reference',
            type: 'line',
            filter: role('reference'),
            paint: { 'line-color': COLOR_REFERENCE, 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 },
        },
        {
            id: 'measure-main-line',
            type: 'line',
            filter: role('main-line'),
            paint: { 'line-color': COLOR_LINE, 'line-width': 3 },
        },
        {
            id: 'measure-cursor',
            type: 'line',
            filter: role('cursor'),
            paint: { 'line-color': COLOR_LINE, 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
        },
        {
            id: 'measure-drop',
            type: 'line',
            filter: role('drop'),
            paint: { 'line-color': COLOR_DROP, 'line-width': 3, 'line-dasharray': [1, 1] },
        },
        {
            id: 'measure-points',
            type: 'circle',
            filter: role('point'),
            paint: {
                'circle-radius': 7,
                'circle-color': [
                    'match',
                    ['get', 'kind'],
                    'first', COLOR_A,
                    'last', COLOR_B,
                    COLOR_MID,
                ] as never,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        },
        {
            id: 'measure-labels',
            type: 'symbol',
            filter: role('point'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 11,
                'text-offset': [0, -1.4],
                'text-anchor': 'bottom',
                'text-allow-overlap': true,
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': '#14281c',
                'text-halo-width': 1.5,
            },
        },
    ];
}
