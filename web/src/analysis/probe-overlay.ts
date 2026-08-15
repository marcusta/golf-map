// Map geometry for the slope probe: tap/click a point while the slope map is
// visible → a marker dot + a downhill arrow at that point (the slope% figure
// is a DOM label on desktop and a sheet row on mobile). Pure geometry — no
// maplibre-gl import, so the mobile bundle and bun tests can load it.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { SampleGrid } from '../../../shared/api/analysis.gen';
import type { OverlayLayerSpec } from '../map/map.service';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { SlopeProbe } from './analysis-math';

const toLngLat = (e: number, n: number): Position => {
    const { lat, lon } = sweref99tmToWgs84(e, n);
    return [lon, lat];
};

/**
 * Probe arrow length: 1.6× the fall-line arrow sizing for the same grid, so
 * the probed direction stands out of the ambient arrow field.
 */
export function probeArrowLengthM(grid: SampleGrid): number {
    const widthM = grid.width * grid.resolution;
    const heightM = grid.height * grid.resolution;
    const spacing = Math.max(1.5, Math.min(widthM, heightM) / 10);
    return Math.min(3.5, Math.max(1.2, spacing * 0.45)) * 1.6;
}

/**
 * The probe as GeoJSON: a point feature at the probed spot plus (when the
 * point isn't locally flat) an arrow from the point downhill — shaft + two
 * ±150° head strokes, the analysis arrows' construction, but anchored AT the
 * probe rather than centered on it.
 */
export function probeGeojson(probe: SlopeProbe, lengthM: number): FeatureCollection {
    const features: Feature[] = [{
        type: 'Feature',
        properties: { slope: probe.slopePct },
        geometry: { type: 'Point', coordinates: toLngLat(probe.e, probe.n) },
    }];

    if (probe.dirE !== 0 || probe.dirN !== 0) {
        const tipE = probe.e + probe.dirE * lengthM;
        const tipN = probe.n + probe.dirN * lengthM;
        const headLen = lengthM * 0.35;
        const strokes: Position[][] = [[toLngLat(probe.e, probe.n), toLngLat(tipE, tipN)]];
        for (const sign of [1, -1]) {
            const angle = (sign * 150 * Math.PI) / 180;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const hx = probe.dirE * cos - probe.dirN * sin;
            const hy = probe.dirE * sin + probe.dirN * cos;
            strokes.push([toLngLat(tipE, tipN), toLngLat(tipE + hx * headLen, tipN + hy * headLen)]);
        }
        for (const coordinates of strokes) {
            features.push({
                type: 'Feature',
                properties: { slope: probe.slopePct },
                geometry: { type: 'LineString', coordinates },
            });
        }
    }
    return { type: 'FeatureCollection', features };
}

/**
 * Probe styling: a gold arrow over a dark casing (distinct from the white
 * ambient fall-line arrows) and a gold-ringed dot at the probed point.
 */
export function probeLayers(idPrefix: string): OverlayLayerSpec[] {
    return [
        {
            id: `${idPrefix}-arrow-casing`,
            type: 'line',
            filter: ['==', '$type', 'LineString'],
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#14281c', 'line-width': 4.5, 'line-opacity': 0.6 },
        },
        {
            id: `${idPrefix}-arrow`,
            type: 'line',
            filter: ['==', '$type', 'LineString'],
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#ffd23f', 'line-width': 2.2 },
        },
        {
            id: `${idPrefix}-dot`,
            type: 'circle',
            filter: ['==', '$type', 'Point'],
            paint: {
                'circle-radius': 4.5,
                'circle-color': '#14281c',
                'circle-stroke-color': '#ffd23f',
                'circle-stroke-width': 2,
            },
        },
    ];
}
