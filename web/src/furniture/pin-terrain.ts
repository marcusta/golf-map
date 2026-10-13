// The green's slope or height, shaded on the map while pins are placed.
//
// A pin belongs on a spot a ball can stop on, and that is not visible in the
// photo. While Furniture's Pin placement is armed the selected hole's green
// is drawn the way Green analysis draws it: the same sample grid (the course
// DEM over the green polygon plus its surrounds), the same colour ramps, the
// same renderer (analysis/analysis-overlay.ts, handed in by furniture-tool.ts
// since it imports maplibre-gl and this file must run under bun test).

import { API_BASE } from '@basics/core/client/base';
import { Signal, Computed, effect, untrack } from '@basics/core/client/core';
import { createAnalysisClient, type AnalysisApi, type SampleGrid } from '../../../shared/api/analysis.gen';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import type { ToolContext } from '../editor/tool';
import type { FeatureCollection, Position } from 'geojson';
import { computeSlopeGrid, computeStats, sampleSlopeAt, type SlopeGrid } from '../analysis/analysis-math';
import { ANALYSIS_RESOLUTION_M, type AnalysisRenderer, type AnalysisView } from '../analysis/analysis-tool.service';
import { pointInGeometry } from '../geo/bezier';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../geo/transform';

/** What the green is shaded by while pins are placed. */
export type PinTerrainMode = 'slope' | 'height' | 'off';

/** Metres of surrounds sampled round the green: enough to read the run-offs. */
const PIN_TERRAIN_BUFFER_M = 10;
/** Radius of the ring drawn round each pin: the ground a putt near the hole runs over. */
export const PIN_RING_RADIUS_M = 2;

/** How steep the ground is at a pin, in percent. */
export interface PinSlope {
    /** At the hole itself. */
    atPin: number;
    /** The steepest spot within the ring round it. */
    maxInRing: number;
}

export class PinTerrain {
    /** The panel's pick; kept for the session. */
    readonly mode = new Signal<PinTerrainMode>('slope');
    readonly loading = new Signal(false);
    /** Why nothing is shaded (no drawn green, no height data), or ''. */
    readonly note = new Signal('');
    private readonly shown = new Signal<{ feature: CourseFeature; grid: SampleGrid; slope: SlopeGrid } | null>(null);
    /** Grids already fetched, per green feature and its version. */
    private readonly grids = new Map<string, SampleGrid>();
    private fetchSeq = 0;

    constructor(private api: AnalysisApi = createAnalysisClient(API_BASE)) {}

    /** What the renderer draws, or null. */
    readonly view = new Computed<AnalysisView | null>(() => {
        const shown = this.shown.get();
        const mode = this.mode.get();
        if (!shown || mode === 'off') return null;
        return {
            grid: shown.grid,
            mode,
            geometry: shown.feature.geometry,
            slope: shown.slope,
            stats: computeStats(shown.grid, shown.slope),
            showGrid: false,
            showContours: true,
            probe: null,
        };
    });

    /**
     * The slope at a point of the green being read, and the steepest within
     * `PIN_RING_RADIUS_M` of it; null off the sampled ground or before it is
     * read. Reads signals, so a caller in an effect follows a new green.
     */
    slopeAt(lat: number, lon: number): PinSlope | null {
        const shown = this.shown.get();
        if (!shown) return null;
        const { grid, slope } = shown;
        const p = wgs84ToSweref99tm(lat, lon);
        const at = sampleSlopeAt(grid, slope, p.x, p.y);
        if (!at) return null;
        let max = at.slopePct;
        const reach = Math.ceil(PIN_RING_RADIUS_M / grid.resolution);
        const col0 = Math.floor((p.x - grid.origin.e) / grid.resolution);
        const row0 = Math.floor((grid.origin.n - p.y) / grid.resolution);
        for (let row = Math.max(0, row0 - reach); row <= Math.min(grid.height - 1, row0 + reach); row++) {
            for (let col = Math.max(0, col0 - reach); col <= Math.min(grid.width - 1, col0 + reach); col++) {
                const e = grid.origin.e + (col + 0.5) * grid.resolution;
                const n = grid.origin.n - (row + 0.5) * grid.resolution;
                if (Math.hypot(e - p.x, n - p.y) > PIN_RING_RADIUS_M) continue;
                const pct = slope.slopePct[row * grid.width + col];
                if (pct > max) max = pct;
            }
        }
        return { atPin: at.slopePct, maxInRing: max };
    }

    /**
     * Read `green()`'s feature for as long as it returns one, and shade it
     * unless the mode is off. `green` reads signals: the armed placement, the
     * selected hole. Returns the disposer, which takes the shading off the map.
     */
    attach(ctx: ToolContext, renderer: AnalysisRenderer, green: () => CourseFeature | null | undefined): () => void {
        const follow = effect(() => {
            const feature = green();
            untrack(() => void this.show(feature ?? null, feature === undefined));
        });
        const draw = effect(() => {
            const ready = ctx.map.ready.get();
            const view = this.view.get();
            if (!ready) {
                renderer.reset();
                return;
            }
            untrack(() => renderer.render(ctx.map, view));
        });
        return () => {
            follow();
            draw();
            this.fetchSeq++;
            this.shown.set(null);
            this.note.set('');
            if (ctx.map.ready.peek()) renderer.clear(ctx.map);
            else renderer.reset();
        };
    }

    /** `missing`: pins are being placed but the hole has no drawn green to sample. */
    private async show(feature: CourseFeature | null, missing: boolean): Promise<void> {
        const seq = ++this.fetchSeq;
        this.note.set(missing ? 'No drawn green on this hole to read the slope from.' : '');
        if (!feature) {
            this.shown.set(null);
            return;
        }
        const key = `${feature.id}/${feature.version}`;
        let grid = this.grids.get(key);
        if (!grid) {
            this.loading.set(true);
            try {
                grid = await this.api.sampleGrid({
                    courseId: feature.courseId, featureId: feature.id,
                    bufferM: PIN_TERRAIN_BUFFER_M, resolutionM: ANALYSIS_RESOLUTION_M,
                });
                this.grids.set(key, grid);
            } catch {
                if (seq === this.fetchSeq) {
                    this.shown.set(null);
                    this.note.set('No height data for this green.');
                }
                return;
            } finally {
                if (seq === this.fetchSeq) this.loading.set(false);
            }
        }
        if (seq === this.fetchSeq) this.shown.set({ feature, grid, slope: computeSlopeGrid(grid) });
    }
}

/** A ring of `PIN_RING_RADIUS_M` round each point, as lines on the map. */
export function pinRingsGeojson(pins: { lat: number; lon: number }[]): FeatureCollection {
    const STEPS = 48;
    return {
        type: 'FeatureCollection',
        features: pins.map(pin => {
            const c = wgs84ToSweref99tm(pin.lat, pin.lon);
            const ring: Position[] = [];
            for (let i = 0; i <= STEPS; i++) {
                const a = (i / STEPS) * 2 * Math.PI;
                const { lat, lon } = sweref99tmToWgs84(c.x + PIN_RING_RADIUS_M * Math.cos(a), c.y + PIN_RING_RADIUS_M * Math.sin(a));
                ring.push([lon, lat]);
            }
            return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } };
        }),
    };
}

/**
 * The drawn green of a hole: the green feature on the hole, the one holding
 * the hole's green centre when it has several; undefined when it has none.
 */
export function holeGreenFeature(
    features: CourseFeature[],
    holeId: string,
    center: { lat: number; lon: number } | null,
): CourseFeature | undefined {
    const greens = features.filter(f => f.type === 'green');
    const p = center ? wgs84ToSweref99tm(center.lat, center.lon) : null;
    const holding = p ? greens.filter(f => pointInGeometry(p, f.geometry)) : [];
    return holding.find(f => f.holeId === holeId) ?? holding[0] ?? greens.find(f => f.holeId === holeId);
}
