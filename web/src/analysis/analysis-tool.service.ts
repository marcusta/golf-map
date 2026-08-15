import { API_BASE } from '@basics/core/client/base';
import { Signal, Computed, effect, untrack } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { createAnalysisClient, type AnalysisApi, type SampleGrid } from '../../../shared/api/analysis.gen';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import type { ToolContext } from '../editor/tool';
import type { MapService, MapPointerEvent } from '../map/map.service';
import { lngLatToSweref99tm } from '../geo/transform';
import { pointInGeometry, type FeatureGeometry } from '../geo/bezier';
import {
    computeSlopeGrid,
    computeStats,
    sampleSlopeAt,
    type AnalysisMode,
    type AnalysisStats,
    type SlopeGrid,
    type SlopeProbe,
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
    /** Draw the 1×1 m white reference grid. */
    showGrid: boolean;
    /** Draw 2 cm elevation contours. */
    showContours: boolean;
    /** Tapped-point slope readout (slope mode only), or null. */
    probe: SlopeProbe | null;
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
    /** 1×1 m white reference grid (panel toggle). */
    readonly gridVisible = new Signal(true);
    /** 2 cm elevation contours (panel toggle). */
    readonly contoursVisible = new Signal(true);
    /** Surrounds buffer in meters (panel slider, 10–30). */
    readonly bufferM = new Signal(DEFAULT_BUFFER);
    /** The green being analysed, or null. */
    readonly analyzedFeature = new Signal<CourseFeature | null>(null);
    /** Latest fetched grid for `analyzedFeature`, or null. */
    readonly grid = new Signal<SampleGrid | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** Clicked-point slope readout (slope mode; cleared with the grid). */
    readonly probe = new Signal<SlopeProbe | null>(null);

    private ctx: ToolContext | null = null;
    private renderer: AnalysisRenderer | null = null;
    private fetchSeq = 0;
    /** Derived slope/stats cache — recomputed only when the grid object changes. */
    private derivedCache: { grid: SampleGrid; slope: SlopeGrid; stats: AnalysisStats } | null = null;

    constructor(private analysisApi: AnalysisApi = createAnalysisClient(API_BASE)) {}

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
            showGrid: this.gridVisible.get(),
            showContours: this.contoursVisible.get(),
            probe: mode === 'slope' ? this.probe.get() : null,
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

    setGridVisible(visible: boolean): void {
        this.gridVisible.set(visible);
    }

    setContoursVisible(visible: boolean): void {
        this.contoursVisible.set(visible);
    }

    /** Drop the analysis (ESC / panel button / click off a green). */
    clear(): void {
        this.fetchSeq++; // invalidate any in-flight fetch
        this.analyzedFeature.set(null);
        this.grid.set(null);
        this.error.set(null);
        this.probe.set(null);
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
        if (result) {
            this.probe.set(null); // sampled against the old grid — stale
            this.grid.set(result);
        }
    }

    // ── Map click → green hit test ────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== ANALYSIS_TOOL_ID) return;
        const p = lngLatToSweref99tm(e.lngLat);

        const hit = this.hitGreen(p);
        const analyzed = this.analyzedFeature.peek();

        // Slope mode: a click inside the analysed grid (green OR surrounds)
        // reads the slope at that point instead of re-analysing/clearing.
        // A different green still switches the analysis.
        if ((!hit || hit.id === analyzed?.id) && this.mode.peek() === 'slope') {
            const view = this.view.peek();
            if (view) {
                const probe = sampleSlopeAt(view.grid, view.slope, p.x, p.y);
                if (probe) {
                    this.probe.set(probe);
                    return;
                }
            }
        }

        if (hit) {
            void this.analyze(hit);
        } else if (analyzed) {
            this.clear(); // click off a green hides the overlay (reference behavior)
        }
    }

    /**
     * Topmost-in-stack GREEN feature containing the EPSG:3006 point (D23):
     * the same stack rule the draw tool's `hitFeature` and lie classification
     * use. Greens rarely overlap, but consistency avoids a second rule.
     */
    private hitGreen(p: { x: number; y: number }): CourseFeature | null {
        const stack = this.ctx?.features.stackTopDown.peek() ?? [];
        return stack.find(f => f.type === 'green' && pointInGeometry(p, f.geometry)) ?? null;
    }
}
