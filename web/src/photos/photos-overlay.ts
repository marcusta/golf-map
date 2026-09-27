// Map overlay for the Photos sub-mode: one marker per photo with its view
// wedge (camera azimuth ± half the horizontal field of view), plus the circle
// of the "near position" filter. Built in SWEREF 99 TM metres, drawn in WGS84.

import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { OverlayLayerSpec } from '../map/map.service';
import { sweref99tmToLngLat } from '../geo/transform';
import { photoYawDeg, type Photo, type PhotoFilter } from './photo-filter';

export const PHOTOS_OVERLAY_ID = 'photos';

/** Wedge length for every photo, and the longer one for the selected photo (m). */
export const WEDGE_M = 35;
export const WEDGE_SELECTED_M = 150;

// MapLibre paint can't read CSS variables, so the overlay colours are literals
// (the same exception measure-tool.service.ts makes).
const COLOR_PHOTO = '#38bdf8';
const COLOR_SELECTED = '#f97316';
const COLOR_NEAR = '#facc15';

function ring(points: Array<{ x: number; y: number }>): number[][] {
    const coords = points.map(p => {
        const ll = sweref99tmToLngLat(p.x, p.y);
        return [ll.lng, ll.lat];
    });
    coords.push(coords[0]!);
    return coords;
}

/** The camera's view wedge: apex at the photo, arc `lengthM` away. */
export function wedgePolygon(photo: Photo, lengthM: number): Polygon {
    const yaw = photoYawDeg(photo);
    const half = photo.hfovDeg / 2;
    const pts = [{ x: photo.x3006, y: photo.y3006 }];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
        // Compass azimuth: clockwise from north, so x = sin, y = cos.
        const a = ((yaw - half + (2 * half * i) / steps) * Math.PI) / 180;
        pts.push({ x: photo.x3006 + lengthM * Math.sin(a), y: photo.y3006 + lengthM * Math.cos(a) });
    }
    return { type: 'Polygon', coordinates: [ring(pts)] };
}

function circlePolygon(near: NonNullable<PhotoFilter['near']>, toXY: (ll: { lng: number; lat: number }) => { x: number; y: number }): Polygon {
    const c = toXY(near);
    const pts = Array.from({ length: 64 }, (_, i) => {
        const a = (i / 64) * 2 * Math.PI;
        return { x: c.x + near.radiusM * Math.cos(a), y: c.y + near.radiusM * Math.sin(a) };
    });
    return { type: 'Polygon', coordinates: [ring(pts)] };
}

/**
 * Overlay data. The selected photo is drawn last so its wedge and marker sit
 * on top. `sensor` marks a photo whose heading has not been refined yet
 * (its wedge outline is dashed, §7).
 */
export function photosGeojson(
    photos: readonly Photo[],
    selectedId: string | null,
    near: PhotoFilter['near'],
    toXY: (ll: { lng: number; lat: number }) => { x: number; y: number },
): FeatureCollection {
    const features: Feature[] = [];
    if (near) {
        features.push({ type: 'Feature', geometry: circlePolygon(near, toXY), properties: { role: 'near' } });
    }
    const ordered = [...photos].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
    for (const p of ordered) {
        const selected = p.id === selectedId;
        const props = { id: p.id, selected, sensor: p.refineMethod === null };
        features.push({
            type: 'Feature',
            geometry: wedgePolygon(p, selected ? WEDGE_SELECTED_M : WEDGE_M),
            properties: { ...props, role: 'wedge' },
        });
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
            properties: { ...props, role: 'marker' },
        });
    }
    return { type: 'FeatureCollection', features };
}

export function photosLayers(): OverlayLayerSpec[] {
    const role = (value: string) => ['==', ['get', 'role'], value];
    const color = ['case', ['get', 'selected'], COLOR_SELECTED, COLOR_PHOTO] as never;
    return [
        {
            id: 'photos-near-fill',
            type: 'fill',
            filter: role('near') as never,
            paint: { 'fill-color': COLOR_NEAR, 'fill-opacity': 0.08 },
        },
        {
            id: 'photos-near-line',
            type: 'line',
            filter: role('near') as never,
            paint: { 'line-color': COLOR_NEAR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        {
            id: 'photos-wedge-fill',
            type: 'fill',
            filter: role('wedge') as never,
            paint: { 'fill-color': color, 'fill-opacity': ['case', ['get', 'selected'], 0.22, 0.12] as never },
        },
        {
            id: 'photos-wedge-line-refined',
            type: 'line',
            filter: ['all', role('wedge'), ['!', ['get', 'sensor']]] as never,
            paint: { 'line-color': color, 'line-width': 1.25, 'line-opacity': 0.9 },
        },
        {
            id: 'photos-wedge-line-sensor',
            type: 'line',
            filter: ['all', role('wedge'), ['get', 'sensor']] as never,
            paint: { 'line-color': color, 'line-width': 1.25, 'line-opacity': 0.9, 'line-dasharray': [2, 2] },
        },
        {
            id: 'photos-marker',
            type: 'circle',
            filter: role('marker') as never,
            paint: {
                'circle-radius': ['case', ['get', 'selected'], 8, 6] as never,
                'circle-color': color,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        },
    ];
}
