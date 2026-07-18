// Pure geometry for the SAM click-to-feature assist (T45): plan a 512 px
// ortho crop centered on a map click (which XYZ tiles compose it, and
// where), and georeference the sidecar's mask-contour pixels back to
// EPSG:3006 meters. The MapLibre canvas is NEVER read — tiles are fetched
// straight from the tile server at the manifest's ortho maxzoom, so the
// pixel↔world mapping is exact slippy math (geo/webmercator-tiles, the
// mirror of ios/GolfMap/Geo/WebMercatorTiles.swift) with none of the map
// view's rotation/pitch/overzoom in the way.
//
// No DOM/canvas/network here — the actual tile fetching + compositing lives
// behind the SamToolService's crop-source seam.

import { fractionalTile, fractionalTileToLonLat } from '../geo/webmercator-tiles';
import { lngLatToSweref99tm } from '../geo/transform';
import type { Point } from '../geo/bezier';
import { SAM_CROP_SIZE } from './sam-client';

/** One tile of a crop plan: XYZ address + draw offset within the crop. */
export interface CropTilePlacement {
    x: number;
    y: number;
    /** Where the tile's top-left lands in crop pixels (may be negative). */
    dx: number;
    dy: number;
}

/**
 * A planned ortho crop: the crop's top-left in GLOBAL pixel space at `zoom`
 * (integer — the origin is snapped so tiles composite pixel-aligned; the
 * click stays within half a pixel of the crop center) plus the tiles that
 * cover it.
 */
export interface CropPlan {
    zoom: number;
    tileSize: number;
    size: number;
    originX: number;
    originY: number;
    tiles: CropTilePlacement[];
}

/**
 * Plan a `size`-px crop centered on a WGS84 click at `zoom`. Returns null
 * when the click is outside the Web-Mercator domain or no pyramid tile
 * overlaps the crop (off-map click) — callers surface a notice.
 */
export function planCrop(
    lon: number,
    lat: number,
    zoom: number,
    size = SAM_CROP_SIZE,
    tileSize = 256,
): CropPlan | null {
    const f = fractionalTile(lon, lat, zoom);
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) return null;

    // Snap the origin to whole pixels: tiles then draw at integer offsets
    // (no resampling blur) and the pixel↔world mapping below stays exact.
    const originX = Math.round(f.x * tileSize - size / 2);
    const originY = Math.round(f.y * tileSize - size / 2);

    const n = Math.pow(2, zoom);
    const tx0 = Math.floor(originX / tileSize);
    const tx1 = Math.floor((originX + size - 1) / tileSize);
    const ty0 = Math.floor(originY / tileSize);
    const ty1 = Math.floor((originY + size - 1) / tileSize);

    const tiles: CropTilePlacement[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            // Addresses outside the pyramid (clicks near the antimeridian /
            // poles) are simply absent — the crop keeps its background there,
            // exactly like the tile server 404ing an out-of-coverage tile.
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
            tiles.push({ x: tx, y: ty, dx: tx * tileSize - originX, dy: ty * tileSize - originY });
        }
    }
    if (tiles.length === 0) return null;
    return { zoom, tileSize, size, originX, originY, tiles };
}

/** A crop-pixel position → WGS84 (exact inverse slippy math). */
export function cropPixelToLngLat(plan: CropPlan, px: number, py: number): { lng: number; lat: number } {
    const { lon, lat } = fractionalTileToLonLat(
        (plan.originX + px) / plan.tileSize,
        (plan.originY + py) / plan.tileSize,
        plan.zoom,
    );
    return { lng: lon, lat };
}

/** A crop-pixel position → EPSG:3006 meters. */
export function cropPixelToSweref(plan: CropPlan, px: number, py: number): Point {
    return lngLatToSweref99tm(cropPixelToLngLat(plan, px, py));
}

/**
 * Georeference a sidecar mask polygon (integer crop-pixel vertices, from
 * cv2.findContours) to an EPSG:3006 ring. The +0.5 addresses pixel CENTERS
 * — contour indices name pixels, not the grid lines between them.
 */
export function cropPolygonToSweref(plan: CropPlan, polygon: number[][]): Point[] {
    return polygon.map(([px, py]) => cropPixelToSweref(plan, px + 0.5, py + 0.5));
}

/** Fill an XYZ url template (map-style's tileUrlTemplate output) for one tile. */
export function fillTileUrl(template: string, z: number, x: number, y: number): string {
    return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
