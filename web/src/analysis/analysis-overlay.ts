// Map rendering for the analysis tool: heat-map image source (one pixel
// per grid cell), bold double green-boundary outline, fall-line arrows and
// slope labels. This module imports maplibre-gl (Marker) and therefore
// cannot load under bun test — the tool service only knows the
// AnalysisRenderer interface; analysis-tool.ts wires this implementation in.

import maplibregl from 'maplibre-gl';
import type { ImageSource, RasterLayerSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { MapService } from '../map/map.service';
import { sweref99tmToWgs84 } from '../geo/transform';
import { geometryToWgs84Rings } from '../draw/features.service';
import {
    buildMeterGridLines,
    buildOverlayRgba,
    computeContours,
    sampleFallLines,
    type ContourLevel,
    type FallLineArrow,
    type Seg3006,
} from './analysis-math';
import type { AnalysisRenderer, AnalysisView } from './analysis-tool.service';
import type { SampleGrid } from '../../../shared/api/analysis.gen';
import { probeArrowLengthM, probeGeojson, probeLayers } from './probe-overlay';

const HEAT_SOURCE_ID = 'analysis-heat';
const HEAT_LAYER_ID = 'analysis-heat';
const BOUNDARY_OVERLAY_ID = 'analysis-boundary';
const ARROWS_OVERLAY_ID = 'analysis-arrows';
const GRID_OVERLAY_ID = 'analysis-meter-grid';
const CONTOURS_OVERLAY_ID = 'analysis-contours';
const PROBE_OVERLAY_ID = 'analysis-probe';

type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** The grid's four WGS84 corner coordinates (TL, TR, BR, BL) for the image source. */
export function gridCornerCoordinates(grid: SampleGrid): Quad {
    const { origin, resolution, width, height } = grid;
    const corner = (e: number, n: number): [number, number] => {
        const { lat, lon } = sweref99tmToWgs84(e, n);
        return [lon, lat];
    };
    const east = origin.e + width * resolution;
    const south = origin.n - height * resolution;
    return [
        corner(origin.e, origin.n),
        corner(east, origin.n),
        corner(east, south),
        corner(origin.e, south),
    ];
}

/** 1 m grid segments as one WGS84 MultiLineString feature. */
export function gridLinesToGeojson(lines: Seg3006[]): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'MultiLineString', coordinates: lines.map(seg => seg.map(segToLngLat)) },
        }],
    };
}

/** Contour levels as WGS84 features — one MultiLineString per elevation level. */
export function contoursToGeojson(levels: ContourLevel[]): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: levels.map(l => ({
            type: 'Feature',
            properties: { level: l.level, index: l.index },
            geometry: { type: 'MultiLineString', coordinates: l.segments.map(seg => seg.map(segToLngLat)) },
        })),
    };
}

const segToLngLat = ([e, n]: [number, number]): Position => {
    const { lat, lon } = sweref99tmToWgs84(e, n);
    return [lon, lat];
};

/** Fall-line arrows as WGS84 line features (shaft + head strokes). */
export function arrowsToGeojson(arrows: FallLineArrow[], lengthM: number): FeatureCollection {
    const features: Feature[] = [];
    const headLen = lengthM * 0.35;
    const toLngLat = (e: number, n: number): Position => {
        const { lat, lon } = sweref99tmToWgs84(e, n);
        return [lon, lat];
    };

    for (const a of arrows) {
        const tipE = a.e + a.dirE * lengthM * 0.5;
        const tipN = a.n + a.dirN * lengthM * 0.5;
        const tailE = a.e - a.dirE * lengthM * 0.5;
        const tailN = a.n - a.dirN * lengthM * 0.5;

        // Head strokes: back from the tip, rotated ±150° from the downhill direction.
        const strokes: Position[][] = [[toLngLat(tailE, tailN), toLngLat(tipE, tipN)]];
        for (const sign of [1, -1]) {
            const angle = (sign * 150 * Math.PI) / 180;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const hx = a.dirE * cos - a.dirN * sin;
            const hy = a.dirE * sin + a.dirN * cos;
            strokes.push([toLngLat(tipE, tipN), toLngLat(tipE + hx * headLen, tipN + hy * headLen)]);
        }
        for (const coordinates of strokes) {
            features.push({
                type: 'Feature',
                properties: { slope: a.slopePct },
                geometry: { type: 'LineString', coordinates },
            });
        }
    }
    return { type: 'FeatureCollection', features };
}

/** Renders one AnalysisView onto the editor map. See AnalysisRenderer. */
export class AnalysisOverlayRenderer implements AnalysisRenderer {
    private heatAdded = false;
    private boundaryAdded = false;
    private arrowsAdded = false;
    private gridAdded = false;
    private contoursAdded = false;
    private probeAdded = false;
    private labelMarkers: maplibregl.Marker[] = [];
    private probeMarker: maplibregl.Marker | null = null;
    /** The grid/mode the current heat image was rendered from (skip redundant redraws). */
    private renderedFor: { grid: SampleGrid; mode: string } | null = null;
    /** Grid-derived decoration GeoJSON, cached per grid object (toggles re-render cheaply). */
    private decorCache: { grid: SampleGrid; gridLines: FeatureCollection; contours: FeatureCollection } | null = null;

    render(map: MapService, view: AnalysisView | null): void {
        if (!view) {
            this.clear(map);
            return;
        }
        const raw = map.map.peek();
        if (!raw) return;

        // 1. Heat image (under the boundary/arrows).
        if (!this.renderedFor || this.renderedFor.grid !== view.grid || this.renderedFor.mode !== view.mode) {
            const url = this.renderHeatImage(view);
            const coordinates = gridCornerCoordinates(view.grid);
            const existing = this.heatAdded ? (raw.getSource(HEAT_SOURCE_ID) as ImageSource | undefined) : undefined;
            if (existing) {
                existing.updateImage({ url, coordinates });
            } else {
                raw.addSource(HEAT_SOURCE_ID, { type: 'image', url, coordinates });
                raw.addLayer({
                    id: HEAT_LAYER_ID,
                    type: 'raster',
                    source: HEAT_SOURCE_ID,
                    paint: { 'raster-fade-duration': 0 },
                } satisfies RasterLayerSpecification);
                this.heatAdded = true;
            }
            this.renderedFor = { grid: view.grid, mode: view.mode };
        }

        // 2. Decoration stack — rebuilt every render in a fixed order so the
        // z-order is always heat < contours < 1 m grid < boundary < arrows
        // < probe, whichever of grid/mode/toggles changed.
        this.removeProbe(map);
        this.removeArrows(map);
        this.removeDecorations(map);

        if (!this.decorCache || this.decorCache.grid !== view.grid) {
            this.decorCache = {
                grid: view.grid,
                gridLines: gridLinesToGeojson(buildMeterGridLines(view.grid)),
                contours: contoursToGeojson(computeContours(view.grid)),
            };
        }

        // 2a. Elevation contours (2 cm interval, index lines every 10 cm).
        if (view.showContours) {
            map.addOverlayLayer(CONTOURS_OVERLAY_ID, this.decorCache.contours, [
                {
                    id: 'analysis-contours-line',
                    type: 'line',
                    paint: {
                        'line-color': '#14281c',
                        'line-width': ['case', ['get', 'index'], 1.5, 0.7],
                        'line-opacity': ['case', ['get', 'index'], 0.7, 0.45],
                    },
                },
            ]);
            this.contoursAdded = true;
        }

        // 2b. 1×1 m white reference grid.
        if (view.showGrid) {
            map.addOverlayLayer(GRID_OVERLAY_ID, this.decorCache.gridLines, [
                {
                    id: 'analysis-meter-grid-line',
                    type: 'line',
                    paint: { 'line-color': '#ffffff', 'line-width': 0.8, 'line-opacity': 0.65 },
                },
            ]);
            this.gridAdded = true;
        }

        // 2c. Boundary: bold double outline (white casing + dark core) —
        // the unmistakable inside/outside line.
        map.addOverlayLayer(BOUNDARY_OVERLAY_ID, this.boundaryGeojson(view), [
            {
                id: 'analysis-boundary-casing',
                type: 'line',
                paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.95 },
            },
            {
                id: 'analysis-boundary-core',
                type: 'line',
                paint: { 'line-color': '#14281c', 'line-width': 1.8 },
            },
        ]);
        this.boundaryAdded = true;

        // 3. Fall-line arrows + labels (slope mode only).
        if (view.mode === 'slope') {
            const arrows = sampleFallLines(view.grid, view.slope);
            const widthM = view.grid.width * view.grid.resolution;
            const heightM = view.grid.height * view.grid.resolution;
            // Mirrors sampleFallLines' spacing; arrows sized to ~45% of it so
            // the denser field stays readable (smaller than the reference's
            // 50%-of-8×8 sizing).
            const spacing = Math.max(1.5, Math.min(widthM, heightM) / 10);
            const lengthM = Math.min(3.5, Math.max(1.2, spacing * 0.45));

            map.addOverlayLayer(ARROWS_OVERLAY_ID, arrowsToGeojson(arrows, lengthM), [
                {
                    id: 'analysis-arrows-casing',
                    type: 'line',
                    layout: { 'line-cap': 'round' },
                    paint: { 'line-color': '#14281c', 'line-width': 3.5, 'line-opacity': 0.5 },
                },
                {
                    id: 'analysis-arrows-line',
                    type: 'line',
                    layout: { 'line-cap': 'round' },
                    paint: { 'line-color': '#ffffff', 'line-width': 1.6 },
                },
            ]);
            this.arrowsAdded = true;

            // Slope% labels: DOM markers (the editor style has no glyphs
            // endpoint, so symbol text layers cannot render text).
            for (const a of arrows) {
                if (!a.labeled) continue;
                const el = document.createElement('div');
                el.textContent = a.slopePct.toFixed(1);
                el.style.cssText =
                    'background: rgba(10, 20, 14, 0.75); color: #fff; font: 600 10px/1.4 system-ui, sans-serif;' +
                    'padding: 0 4px; border-radius: 4px; pointer-events: none; white-space: nowrap;';
                const offE = a.e + a.dirE * lengthM;
                const offN = a.n + a.dirN * lengthM;
                const { lat, lon } = sweref99tmToWgs84(offE, offN);
                this.labelMarkers.push(
                    new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(raw),
                );
            }
        }

        // 4. Slope probe: the clicked point's dot + downhill arrow + a slope%
        // chip (a DOM marker, like the arrow labels — no glyphs endpoint).
        if (view.mode === 'slope' && view.probe) {
            const probe = view.probe;
            map.addOverlayLayer(
                PROBE_OVERLAY_ID,
                probeGeojson(probe, probeArrowLengthM(view.grid)),
                probeLayers(PROBE_OVERLAY_ID),
            );
            this.probeAdded = true;

            const el = document.createElement('div');
            el.dataset.testid = 'analysis-probe-label';
            el.textContent = `${probe.slopePct.toFixed(1)}%`;
            el.style.cssText =
                'background: rgba(10, 20, 14, 0.85); color: #ffd23f; font: 700 12px/1.5 system-ui, sans-serif;' +
                'padding: 1px 6px; border-radius: 5px; pointer-events: none; white-space: nowrap;';
            const { lat, lon } = sweref99tmToWgs84(probe.e, probe.n);
            this.probeMarker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -10] })
                .setLngLat([lon, lat])
                .addTo(raw);
        }
    }

    reset(): void {
        // Map destroyed — sources/layers died with it; markers are detached
        // DOM nodes at this point but remove() is safe and drops references.
        for (const m of this.labelMarkers) m.remove();
        this.labelMarkers = [];
        this.probeMarker?.remove();
        this.probeMarker = null;
        this.heatAdded = false;
        this.boundaryAdded = false;
        this.arrowsAdded = false;
        this.gridAdded = false;
        this.contoursAdded = false;
        this.probeAdded = false;
        this.renderedFor = null;
        this.decorCache = null;
    }

    clear(map: MapService): void {
        const raw = map.map.peek();
        if (raw) {
            if (this.probeAdded) map.removeOverlayLayer(PROBE_OVERLAY_ID);
            if (this.arrowsAdded) map.removeOverlayLayer(ARROWS_OVERLAY_ID);
            this.removeDecorations(map);
            if (this.heatAdded) {
                if (raw.getLayer(HEAT_LAYER_ID)) raw.removeLayer(HEAT_LAYER_ID);
                if (raw.getSource(HEAT_SOURCE_ID)) raw.removeSource(HEAT_SOURCE_ID);
            }
        }
        for (const m of this.labelMarkers) m.remove();
        this.labelMarkers = [];
        this.probeMarker?.remove();
        this.probeMarker = null;
        this.heatAdded = false;
        this.arrowsAdded = false;
        this.probeAdded = false;
        this.renderedFor = null;
        this.decorCache = null;
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private renderHeatImage(view: AnalysisView): string {
        const { grid } = view;
        const rgba = buildOverlayRgba(grid, view.mode, view.slope, view.stats);
        const canvas = document.createElement('canvas');
        canvas.width = grid.width;
        canvas.height = grid.height;
        const ctx = canvas.getContext('2d')!;
        ctx.putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
        return canvas.toDataURL('image/png');
    }

    private boundaryGeojson(view: AnalysisView): FeatureCollection {
        const rings = geometryToWgs84Rings(view.geometry);
        return {
            type: 'FeatureCollection',
            features: rings.map(ring => ({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: ring },
            })),
        };
    }

    /** Remove boundary + 1 m grid + contours (the layers above the heat image). */
    private removeDecorations(map: MapService): void {
        if (this.boundaryAdded) {
            map.removeOverlayLayer(BOUNDARY_OVERLAY_ID);
            this.boundaryAdded = false;
        }
        if (this.gridAdded) {
            map.removeOverlayLayer(GRID_OVERLAY_ID);
            this.gridAdded = false;
        }
        if (this.contoursAdded) {
            map.removeOverlayLayer(CONTOURS_OVERLAY_ID);
            this.contoursAdded = false;
        }
    }

    private removeArrows(map: MapService): void {
        if (this.arrowsAdded) {
            map.removeOverlayLayer(ARROWS_OVERLAY_ID);
            this.arrowsAdded = false;
        }
        for (const m of this.labelMarkers) m.remove();
        this.labelMarkers = [];
    }

    private removeProbe(map: MapService): void {
        if (this.probeAdded) {
            map.removeOverlayLayer(PROBE_OVERLAY_ID);
            this.probeAdded = false;
        }
        this.probeMarker?.remove();
        this.probeMarker = null;
    }
}
