// Map geometry for the mobile green screen's analysis layer: the Slope/Height
// heat image, the green boundary outline and the fall-line arrows.
//
// The MATH is the Green-analysis engine, reused verbatim (analysis-math:
// computeSlopeGrid / computeStats / buildOverlayRgba / sampleFallLines) — this
// module only turns its output into map geometry. The desktop's renderer
// (analysis/analysis-overlay.ts) does the same job but imports maplibre-gl
// (DOM label markers) and draw/features.service, both of which the mobile
// bundle must not pull in; the phone also deliberately drops the slope% text
// labels and the 1 m grid/contours as clutter at phone widths. Pure geometry,
// so it tests under bun.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { SampleGrid } from '../../../../shared/api/analysis.gen';
import type { OverlayLayerSpec } from '../../map/map.service';
import type { FeatureGeometry } from '../../geo/bezier';
import { sweref99tmToWgs84 } from '../../geo/transform';
import { buildOverlayRgba, type AnalysisMode, type AnalysisStats, type FallLineArrow, type SlopeGrid } from '../../analysis/analysis-math';
import { greenRingsWgs84 } from './green-frame';

/** Overlay ids for the green screen (own namespace, never the desktop's). */
export const GREEN_HEAT_ID = 'm-green-heat';
export const GREEN_BOUNDARY_ID = 'm-green-boundary';
export const GREEN_ARROWS_ID = 'm-green-arrows';

/** Image-source corner quad: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

const toLngLat = (e: number, n: number): Position => {
    const { lat, lon } = sweref99tmToWgs84(e, n);
    return [lon, lat];
};

/** The grid's four WGS84 corners (TL, TR, BR, BL) for the image overlay. */
export function gridCorners(grid: SampleGrid): Quad {
    const { origin, resolution, width, height } = grid;
    const east = origin.e + width * resolution;
    const south = origin.n - height * resolution;
    return [
        toLngLat(origin.e, origin.n) as [number, number],
        toLngLat(east, origin.n) as [number, number],
        toLngLat(east, south) as [number, number],
        toLngLat(origin.e, south) as [number, number],
    ];
}

/** The green polygon outline as WGS84 line features. */
export function boundaryGeojson(geometry: FeatureGeometry): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: greenRingsWgs84(geometry).map(ring => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: ring },
        })),
    };
}

/**
 * Fall-line arrows as WGS84 line features (shaft + two head strokes), the same
 * construction the desktop analysis overlay uses so the arrow field reads
 * identically on both.
 */
export function arrowsGeojson(arrows: readonly FallLineArrow[], lengthM: number): FeatureCollection {
    const features: Feature[] = [];
    const headLen = lengthM * 0.35;
    for (const a of arrows) {
        const tipE = a.e + a.dirE * lengthM * 0.5;
        const tipN = a.n + a.dirN * lengthM * 0.5;
        const tailE = a.e - a.dirE * lengthM * 0.5;
        const tailN = a.n - a.dirN * lengthM * 0.5;
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

/**
 * Arrow length in meters for a grid — mirrors the desktop sizing (≈45 % of the
 * fall-line sampling spacing) so the field stays legible rather than a hedge.
 */
export function arrowLengthM(grid: SampleGrid): number {
    const widthM = grid.width * grid.resolution;
    const heightM = grid.height * grid.resolution;
    const spacing = Math.max(1.5, Math.min(widthM, heightM) / 10);
    return Math.min(3.5, Math.max(1.2, spacing * 0.45));
}

/**
 * The heat image as a data URL (one pixel per grid cell), or null when the
 * canvas 2D context is unavailable (headless test environments) — callers just
 * skip the image layer then.
 */
export function heatImageUrl(
    grid: SampleGrid,
    mode: AnalysisMode,
    slope: SlopeGrid,
    stats: AnalysisStats,
): string | null {
    const rgba = buildOverlayRgba(grid, mode, slope, stats);
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
    return canvas.toDataURL('image/png');
}

/** Boundary outline: white casing + dark core, the unmistakable edge. */
export function boundaryLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${GREEN_BOUNDARY_ID}-casing`,
            type: 'line',
            paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.95 },
        },
        {
            id: `${GREEN_BOUNDARY_ID}-core`,
            type: 'line',
            paint: { 'line-color': '#14281c', 'line-width': 1.6 },
        },
    ];
}

/** Fall-line arrows: dark casing + white stroke (legible over any ramp). */
export function arrowLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${GREEN_ARROWS_ID}-casing`,
            type: 'line',
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#14281c', 'line-width': 3.5, 'line-opacity': 0.5 },
        },
        {
            id: `${GREEN_ARROWS_ID}-line`,
            type: 'line',
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': 1.6 },
        },
    ];
}
