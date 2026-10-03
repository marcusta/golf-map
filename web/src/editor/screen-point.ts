// Screen-pixel projection for editor hit tests.
//
// House rule: hit tests use the flat projection
// (`map.transform.locationToScreenPoint`), never terrain-aware `map.project`.
// With terrain on, `map.project` samples the DEM and costs about 40 us per
// call, which a per-mousemove loop over markers or vertices cannot pay. The
// flat projection differs from the rendered position by the terrain offset,
// a few pixels at most, which no hit radius here resolves.
//
// `map.project` stays as the fallback for a transform without
// `locationToScreenPoint` (MapLibre builds before 5, and test fakes).

import type { Map as MaplibreMap } from 'maplibre-gl';
import { sweref99tmToWgs84 } from '../geo/transform';

export interface ScreenXY { x: number; y: number }

/** Projects (lng, lat) to screen pixels with the flat transform. */
export type Projector = (lng: number, lat: number) => ScreenXY;

/**
 * A projector bound to the map's current camera. Bind once per hit-test
 * pass, then call it per point.
 */
export function flatProjector(map: MaplibreMap): Projector {
    const tr = map.transform as unknown as {
        locationToScreenPoint?: (l: { lng: number; lat: number }) => ScreenXY;
    };
    if (tr?.locationToScreenPoint) {
        const fn = tr.locationToScreenPoint.bind(tr);
        return (lng, lat) => fn({ lng, lat });
    }
    return (lng, lat) => map.project([lng, lat]);
}

/** Flat screen position of one WGS84 point. */
export function screenPointOf(map: MaplibreMap, lng: number, lat: number): ScreenXY {
    return flatProjector(map)(lng, lat);
}

/** Pixel distance between a WGS84 point and a screen position. */
export function screenDistLngLat(
    map: MaplibreMap,
    p: { lng: number; lat: number },
    screen: ScreenXY,
): number {
    const s = screenPointOf(map, p.lng, p.lat);
    return Math.hypot(s.x - screen.x, s.y - screen.y);
}

/** Pixel distance between an EPSG:3006 point and a screen position. */
export function screenDistSweref(
    map: MaplibreMap,
    p: { x: number; y: number },
    screen: ScreenXY,
): number {
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    return screenDistLngLat(map, { lng: lon, lat }, screen);
}
