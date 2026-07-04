import { Signal, Computed, effect, untrack } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { createAnalysisClient, type AnalysisApi, type SampleGrid } from '../../../shared/api/analysis.gen';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import type { ToolContext } from '../editor/tool';
import type { MapService, MapPointerEvent } from '../map/map.service';
import { lngLatToSweref99tm } from '../geo/transform';
import { pointInGeometry, outerRingArea, type FeatureGeometry } from '../geo/bezier';
import {
    computeSlopeGrid,
    computeStats,
    type AnalysisMode,
    type AnalysisStats,
    type SlopeGrid,
} from './analysis-math';

/** Interaction-claim id AND overlay id prefix for the analysis tool. */
export const ANALYSIS_TOOL_ID = 'analysis';

export const BUFFER_MIN = 10;
export const BUFFER_MAX = 30;
export const DEFAULT_BUFFER = 20;
/** Requested grid cell size — the DEM's native 0.5 m. */
export const ANALYSIS_RESOLUTION_M = 0.5;

/** Everything a renderer needs to draw one analysis overlay state. */
export interface AnalysisView {
    grid: SampleGrid;
    mode: AnalysisMode;
    /** The analysed green's polygon (EPSG:3006) for the boundary outline. */
    geometry: FeatureGeometry;
    slope: SlopeGrid;
    stats: AnalysisStats;
}

/**
 * Map-rendering boundary for the tool. The real implementation
 * (analysis-overlay.ts) imports maplibre-gl, which cannot load under bun
 * test — so the service only talks to this interface and the descriptor
 * (analysis-tool.ts) injects the real renderer.
 */
export interface AnalysisRenderer {
    /** Draw/refresh the overlay for `view`, or remove it when null. Map is ready. */
    render(map: MapService, view: AnalysisView | null): void;
    /** The map was destroyed (ready → false): forget per-map state. */
    reset(): void;
    /** Remove everything from a still-live map (tool deactivation). */
    clear(map: MapService): void;
}

/**
 * Green + surrounds height/slope analysis (the `analysis` EditorTool).
 * Click a green → the server samples the course DEM over the green polygon
 * plus a surrounds buffer (POST /analysis/sample-grid) → three overlay
 * modes: slope% ramp, per-green-normalized height ramp, and height relative
 * to the green's mean (the hollows/"grop" view). AnalysisPanelComponent
 * shares this DI singleton.
 */
export class AnalysisToolService {
    /** Active overlay mode (panel toggle). */
    readonly mode = new Signal<AnalysisMode>('slope');
    /** Surrounds buffer in meters (panel slider, 10–30). */
    readonly bufferM = new Signal(DEFAULT_BUFFER);
    /** The green being analysed, or null. */
    readonly analyzedFeature = new Signal<CourseFeature | null>(null);
    /** Latest fetched grid for `analyzedFeature`, or null. */
    readonly grid = new Signal<SampleGrid | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);

    private ctx: ToolContext | null = null;
    private renderer: AnalysisRenderer | null = null;
    private fetchSeq = 0;
    /** Derived slope/stats cache — recomputed only when the grid object changes. */
    private derivedCache: { grid: SampleGrid; slope: SlopeGrid; stats: AnalysisStats } | null = null;

    constructor(private analysisApi: AnalysisApi = createAnalysisClient('/api')) {}

    /** Renderable state: grid + mode + boundary geometry + derived slope/stats. */
    readonly view = new Computed<AnalysisView | null>(() => {
        const grid = this.grid.get();
        const feature = this.analyzedFeature.get();
        const mode = this.mode.get();
        if (!grid || !feature) return null;
        if (!this.derivedCache || this.derivedCache.grid !== grid) {
            const slope = computeSlopeGrid(grid);
            this.derivedCache = { grid, slope, stats: computeStats(grid, slope) };
        }
        return {
            grid,
            mode,
            geometry: feature.geometry,
            slope: this.derivedCache.slope,
            stats: this.derivedCache.stats,
        };
    });

    /** Stats for the panel card, or null before the first analysis. */
    readonly stats = new Computed<AnalysisStats | null>(() => this.view.get()?.stats ?? null);

    // ── EditorTool lifecycle (called via analysis-tool.ts) ────────────────

    activate(ctx: ToolContext, renderer: AnalysisRenderer): void {
        this.ctx = ctx;
        this.renderer = renderer;

        ctx.track(ctx.map.onClick(e => this.onClick(e)));

        // Overlay rendering: re-runs on grid/mode changes and map re-creation.
        ctx.track(effect(() => {
            const ready = ctx.map.ready.get();
            const view = this.view.get();
            if (!ready) {
                renderer.reset();
                return;
            }
            untrack(() => renderer.render(ctx.map, view));
        }));
        ctx.track(() => {
            if (ctx.map.ready.peek()) renderer.clear(ctx.map);
            else renderer.reset();
        });

        // Pointer cursor: greens are clickable while the tool is active.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const canvas = ctx.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = 'pointer';
        }));
        ctx.track(() => {
            const canvas = ctx.map.map.peek()?.getCanvas();
            if (canvas) canvas.style.cursor = '';
        });
    }

    deactivate(): void {
        this.clear();
        this.ctx = null;
        this.renderer = null;
    }

    /** ESC: clear the current overlay first; unconsumed ESC deactivates the tool. */
    onEscape(): boolean {
        if (this.analyzedFeature.peek()) {
            this.clear();
            return true;
        }
        return false;
    }

    // ── Actions (used by clicks, the panel, and tests) ────────────────────

    /** Analyse a green feature: fetch its sample grid at the current buffer. */
    analyze(feature: CourseFeature): Promise<void> {
        this.analyzedFeature.set(feature);
        return this.refresh();
    }

    /** Change the surrounds buffer; re-fetches when a green is selected. */
    setBuffer(bufferM: number): Promise<void> {
        const clamped = Math.min(Math.max(Math.round(bufferM), BUFFER_MIN), BUFFER_MAX);
        if (this.bufferM.peek() === clamped) return Promise.resolve();
        this.bufferM.set(clamped);
        if (this.analyzedFeature.peek()) return this.refresh();
        return Promise.resolve();
    }

    setMode(mode: AnalysisMode): void {
        this.mode.set(mode);
    }

    /** Drop the analysis (ESC / panel button / click off a green). */
    clear(): void {
        this.fetchSeq++; // invalidate any in-flight fetch
        this.analyzedFeature.set(null);
        this.grid.set(null);
        this.error.set(null);
    }

    private async refresh(): Promise<void> {
        const feature = this.analyzedFeature.peek();
        if (!feature) return;
        const seq = ++this.fetchSeq;
        const result = await request(this.loading, this.error, () =>
            this.analysisApi.sampleGrid({
                courseId: feature.courseId,
                featureId: feature.id,
                bufferM: this.bufferM.peek(),
                resolutionM: ANALYSIS_RESOLUTION_M,
            }));
        if (seq !== this.fetchSeq) return; // superseded by a newer request / clear
        if (result) this.grid.set(result);
    }

    // ── Map click → green hit test ────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== ANALYSIS_TOOL_ID) return;
        const p = lngLatToSweref99tm(e.lngLat);

        const hit = this.hitGreen(p);
        if (hit) {
            void this.analyze(hit);
        } else if (this.analyzedFeature.peek()) {
            this.clear(); // click off a green hides the overlay (reference behavior)
        }
    }

    /** Topmost (smallest) GREEN feature containing the EPSG:3006 point. */
    private hitGreen(p: { x: number; y: number }): CourseFeature | null {
        const features = this.ctx?.features.store.items.peek() ?? [];
        let best: CourseFeature | null = null;
        let bestArea = Infinity;
        for (const feature of features) {
            if (feature.type !== 'green') continue;
            if (!pointInGeometry(p, feature.geometry)) continue;
            const area = outerRingArea(feature.geometry);
            if (area < bestArea) {
                bestArea = area;
                best = feature;
            }
        }
        return best;
    }
}
