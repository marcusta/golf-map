import { flattenRing, type FeatureGeometry } from '../../geo/bezier';
import { sweref99tmToWgs84 } from '../../geo/transform';
import { envelope, type Bbox, type LngLatPoint } from '../course/hole-frame';

/** Flattening tolerance for the green outline, meters (green-scale detail). */
export const GREEN_FLATTEN_TOLERANCE_M = 0.25;

/**
 * The green polygon's rings flattened to WGS84 lng/lat, outer ring first and
 * each ring explicitly closed — the boundary outline the green screen draws,
 * and the source of its camera frame.
 *
 * This mirrors draw/features.service `geometryToWgs84Rings`, which the mobile
 * bundle may not import (it lives in a forbidden editor area and drags the
 * whole feature-editing service in). Same tolerance, same transform, so the
 * outline lands exactly where the desktop's does.
 */
export function greenRingsWgs84(geometry: FeatureGeometry): number[][][] {
    return geometry.rings.map(ring => {
        const coords = flattenRing(ring, GREEN_FLATTEN_TOLERANCE_M, geometry.curveType)
            .map(([x, y]) => {
                const { lat, lon } = sweref99tmToWgs84(x, y);
                return [lon, lat];
            });
        if (coords.length > 0) coords.push(coords[0]!);
        return coords;
    });
}

/**
 * WGS84 envelope of the green polygon, or null when it has no geometry —
 * the green screen fits this box (zoomed FAR closer than the tee→green hole
 * frame) so the read fills the phone screen.
 */
export function greenBounds(geometry: FeatureGeometry): Bbox | null {
    const points: LngLatPoint[] = [];
    for (const ring of greenRingsWgs84(geometry)) {
        for (const [lng, lat] of ring) points.push({ lng: lng!, lat: lat! });
    }
    return envelope(points);
}
