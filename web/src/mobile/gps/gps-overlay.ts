import type { FeatureCollection, Feature } from 'geojson';
import type { OverlayLayerSpec } from '../../map/map.service';
import type { GpsFix } from './geolocation.service';

export const GPS_OVERLAY_ID = 'm-gps';

const RING_SEGMENTS = 48;
const EARTH_M_PER_DEG_LAT = 111_320;

/** A closed circle polygon of `radiusM` around a WGS84 point (equirectangular). */
function circlePolygon(lng: number, lat: number, radiusM: number): number[][] {
    const latRad = lat * Math.PI / 180;
    const mPerDegLng = EARTH_M_PER_DEG_LAT * Math.max(Math.cos(latRad), 1e-6);
    const ring: number[][] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * 2 * Math.PI;
        const dLat = (radiusM * Math.cos(a)) / EARTH_M_PER_DEG_LAT;
        const dLng = (radiusM * Math.sin(a)) / mPerDegLng;
        ring.push([lng + dLng, lat + dLat]);
    }
    return ring;
}

/**
 * GeoJSON for the live position: a translucent accuracy-ring polygon plus a
 * centre point. Returns an empty collection when there is no fix so the
 * overlay clears cleanly (updateOverlayData with []).
 */
export function buildGpsGeojson(fix: GpsFix | null): FeatureCollection {
    if (!fix) return { type: 'FeatureCollection', features: [] };
    const features: Feature[] = [
        {
            type: 'Feature',
            properties: { role: 'accuracy' },
            geometry: { type: 'Polygon', coordinates: [circlePolygon(fix.lng, fix.lat, Math.max(fix.accuracyM, 1))] },
        },
        {
            type: 'Feature',
            properties: { role: 'dot' },
            geometry: { type: 'Point', coordinates: [fix.lng, fix.lat] },
        },
    ];
    return { type: 'FeatureCollection', features };
}

/**
 * Overlay layers for the GPS position. Colours are literal hexes (MapLibre
 * paint can't read CSS vars): a blue accuracy disc under a white-ringed blue
 * dot — the platform-conventional "you are here" so it never reads as a plan
 * marker.
 */
export function gpsLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${GPS_OVERLAY_ID}-accuracy-fill`,
            type: 'fill',
            filter: ['==', ['get', 'role'], 'accuracy'],
            paint: { 'fill-color': '#2E7BE4', 'fill-opacity': 0.12 },
        },
        {
            id: `${GPS_OVERLAY_ID}-accuracy-line`,
            type: 'line',
            filter: ['==', ['get', 'role'], 'accuracy'],
            paint: { 'line-color': '#2E7BE4', 'line-opacity': 0.4, 'line-width': 1 },
        },
        {
            id: `${GPS_OVERLAY_ID}-dot`,
            type: 'circle',
            filter: ['==', ['get', 'role'], 'dot'],
            paint: {
                'circle-radius': 7,
                'circle-color': '#2E7BE4',
                'circle-stroke-color': '#FFFFFF',
                'circle-stroke-width': 3,
            },
        },
    ];
}
