// The GKD hazard lines in Furniture mode, client side: what `GET /courses/:id/gspro/gkd-lines` says the course file
// gets (GsproExportService.gkdLines → `gspro.py gkd-lines`, 6-8 s when its inputs changed). Furniture draws the
// automatic water lines (`kind: 'water'`, staked round the water no drawn penalty line holds) as a dashed line and
// lets one be selected; the drawn penalty lines are features the rules engine already renders and selects.
//
// DI singleton; the constructor takes the API client so it is testable headlessly.

import { Signal, Computed } from '@basics/core/client/core';
import type { Feature, FeatureCollection } from 'geojson';
import { api } from '../api';
import type { GkdHazardLine, GsproExportApi } from '../../../shared/api/gspro-export.gen';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { OverlayLayerSpec } from '../map/map.service';
import { MARKER_FILL, OVERLAY_TEXT } from '../map/map-palette';
import { FURNITURE_TOOL_ID } from './furniture.service';
import { SELECTION_COLOR } from './furniture-overlay';

export type HazardLinesClient = Pick<GsproExportApi, 'gkdLines'>;

/** Overlay/source id of the automatic water lines. */
export const HAZARD_LINES_OVERLAY_ID = `${FURNITURE_TOOL_ID}-gkd-lines`;
/** Screen px within which a click picks an automatic line. */
export const HAZARD_LINE_HIT_PX = 6;

/** An automatic water line: its key (the waters it holds), the line as the GKD gets it and its ring in WGS84. */
export interface WaterLine {
    key: string;
    line: GkdHazardLine;
    /** [lon, lat] per point, the ring not closed. */
    lngLat: [number, number][];
}

/** One key per automatic line: the waters it holds, sorted (a reload keeps the selection on the same line). */
export function waterLineKey(waterIds: readonly string[]): string {
    return [...waterIds].sort().join(',');
}

export class HazardLinesService {
    /** Every hazard line of the last load, in the order the GKD gets them. */
    readonly lines = new Signal<GkdHazardLine[]>([]);
    /** A load in flight (the pipeline can take seconds). */
    readonly loading = new Signal(false);
    /** An action on a line in flight (fitting and saving Edit line, saving Play as it lies). */
    readonly working = new Signal(false);
    /** Why the last load failed (no built map, no heightmap yet…); null when it went through. */
    readonly error = new Signal<string | null>(null);
    /** The selected automatic line's key, or null. */
    readonly selectedKey = new Signal<string | null>(null);
    private loadSeq = 0;

    constructor(private readonly client: HazardLinesClient = api.gsproExport) {}

    /** The automatic water lines, with their rings in WGS84. */
    readonly waterLines = new Computed<WaterLine[]>(() => this.lines.get()
        .filter(l => l.kind === 'water' && l.waterIds && l.waterIds.length > 0)
        .map(line => ({
            key: waterLineKey(line.waterIds!),
            line,
            lngLat: line.points.map(([x, y]) => {
                const p = sweref99tmToWgs84(x, y);
                return [p.lon, p.lat] as [number, number];
            }),
        })));

    readonly selected = new Computed<WaterLine | null>(() => {
        const key = this.selectedKey.get();
        return key === null ? null : this.waterLines.get().find(l => l.key === key) ?? null;
    });

    /** The overlay's data: each automatic line as a closed LineString, the selected one flagged. */
    readonly geojson = new Computed<FeatureCollection>(() => {
        const selected = this.selectedKey.get();
        const features: Feature[] = this.waterLines.get().map(w => ({
            type: 'Feature',
            properties: { key: w.key, selected: w.key === selected },
            geometry: { type: 'LineString', coordinates: [...w.lngLat, w.lngLat[0]!] },
        }));
        return { type: 'FeatureCollection', features };
    });

    /**
     * Ask for the course's lines. A later call wins over one still in flight. On failure the lines are emptied and
     * `error` says why. True when they loaded.
     */
    async load(courseId: string): Promise<boolean> {
        const seq = ++this.loadSeq;
        this.loading.set(true);
        try {
            const doc = await this.client.gkdLines({ courseId });
            if (seq !== this.loadSeq) return false;
            this.lines.set(doc.lines);
            this.error.set(null);
            if (this.selectedKey.peek() !== null && !this.selected.peek()) this.selectedKey.set(null);
            return true;
        } catch (e) {
            if (seq !== this.loadSeq) return false;
            this.lines.set([]);
            this.selectedKey.set(null);
            this.error.set(e instanceof Error && e.message ? e.message : 'The hazard lines could not be read');
            return false;
        } finally {
            if (seq === this.loadSeq) this.loading.set(false);
        }
    }

    select(key: string | null): void {
        if (this.selectedKey.peek() !== key) this.selectedKey.set(key);
    }

    /** Forget the lines (Furniture left): the next activation loads them again. */
    reset(): void {
        this.loadSeq++;
        this.lines.set([]);
        this.selectedKey.set(null);
        this.error.set(null);
        this.loading.set(false);
        this.working.set(false);
    }

    /** The automatic line within `radiusPx` of the screen point (the nearest), or null. `project` is lon/lat → screen. */
    hit(screen: { x: number; y: number }, project: (lon: number, lat: number) => { x: number; y: number },
        radiusPx = HAZARD_LINE_HIT_PX): WaterLine | null {
        let best: WaterLine | null = null;
        let bestD = radiusPx;
        for (const w of this.waterLines.peek()) {
            const pts = w.lngLat.map(([lon, lat]) => project(lon, lat));
            for (let i = 0; i < pts.length; i++) {
                const d = segmentDistance(screen, pts[i]!, pts[(i + 1) % pts.length]!);
                if (d <= bestD) { bestD = d; best = w; }
            }
        }
        return best;
    }
}

function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The automatic lines' layers: a neutral dashed stroke over a dark casing, so it reads on the photo and is not
 * mistaken for a drawn red or yellow penalty line; the selected one in the selection colour, wider.
 */
export function hazardLineLayers(): OverlayLayerSpec[] {
    const selected = ['==', ['get', 'selected'], true];
    return [
        {
            id: `${HAZARD_LINES_OVERLAY_ID}-casing`,
            type: 'line',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': MARKER_FILL, 'line-width': ['case', selected, 6, 4] as never, 'line-opacity': 0.55 },
        },
        {
            id: `${HAZARD_LINES_OVERLAY_ID}-line`,
            type: 'line',
            layout: { 'line-join': 'round' },
            paint: {
                'line-color': ['case', selected, SELECTION_COLOR, OVERLAY_TEXT] as never,
                'line-width': ['case', selected, 3, 1.8] as never,
                'line-dasharray': [2.5, 1.5],
            },
        },
    ];
}
