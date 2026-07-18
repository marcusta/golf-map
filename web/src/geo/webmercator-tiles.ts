// Web-Mercator (EPSG:3857) XYZ tile math — the addressing scheme used by
// the Terrain-RGB and orthophoto tile sets. Pure module mirroring the iOS
// port (ios/GolfMap/Geo/WebMercatorTiles.swift) so the two stay
// semantically identical: fractional tile coordinates, integer tile
// addressing with the trap-free out-of-domain guard, tile-pixel resolution,
// and tile bounding boxes. Adds the general fractional inverse
// (`fractionalTileToLonLat`) the SAM click-to-feature assist needs to
// georeference ortho-crop pixels (T45).
//
// No map/DOM/network dependencies — unit-testable under bun test.

/** An integer XYZ tile address. */
export interface TileAddress {
    z: number;
    x: number;
    y: number;
}

/**
 * A WGS84 → tile-pixel resolution: the containing tile plus the fractional
 * pixel position within it. `px`/`py` are in `[0, tileSize)`.
 */
export interface TilePixel {
    tileX: number;
    tileY: number;
    px: number;
    py: number;
}

/** A WGS84 bounding box (tile extent). */
export interface TileBoundingBox {
    west: number;
    south: number;
    east: number;
    north: number;
}

/**
 * Fractional tile coordinates (X, Y) for a lon/lat at `zoom`. Floor these
 * for the integer tile address; the fractional remainder gives sub-tile
 * position.
 */
export function fractionalTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    return { x, y };
}

/**
 * Inverse of `fractionalTile`: fractional tile coordinates at `zoom` back
 * to WGS84 lon/lat. Integer inputs give a tile's NW corner; add fractional
 * parts (e.g. `tileX + px / tileSize`) for sub-tile positions.
 */
export function fractionalTileToLonLat(x: number, y: number, zoom: number): { lon: number; lat: number } {
    const n = Math.pow(2, zoom);
    const lon = (x / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    return { lon, lat };
}

/**
 * `Math.floor` with the iOS port's trap-free out-of-domain guard: a WGS84
 * input outside the Web-Mercator projection domain (|lat| ≥ 90 makes the
 * mercator Y non-finite) must degrade to an address no pyramid contains — a
 * missing tile — never NaN. The clamp also covers finite values beyond any
 * real pyramid; it cannot engage for an on-globe coordinate at a real zoom.
 */
function flooredTileIndex(v: number): number {
    if (!Number.isFinite(v)) return -1;
    return Math.min(Math.max(Math.floor(v), -1e15), 1e15);
}

/**
 * Integer XYZ tile containing a WGS84 position at `zoom`. Positions outside
 * the Web-Mercator domain resolve to an off-pyramid address (see
 * `flooredTileIndex`) rather than propagating NaN.
 */
export function tileAt(lon: number, lat: number, zoom: number): TileAddress {
    const f = fractionalTile(lon, lat, zoom);
    return { z: zoom, x: flooredTileIndex(f.x), y: flooredTileIndex(f.y) };
}

/**
 * WGS84 → containing tile + fractional pixel position. `px`/`py` are
 * fractional pixel coordinates within the tile (`[0, tileSize)`). Positions
 * outside the Web-Mercator domain resolve to an off-pyramid tile with a
 * zero pixel offset, matching the iOS port.
 */
export function tilePixelAt(lon: number, lat: number, zoom: number, tileSize = 256): TilePixel {
    const f = fractionalTile(lon, lat, zoom);
    const tileX = flooredTileIndex(f.x);
    const tileY = flooredTileIndex(f.y);
    return {
        tileX,
        tileY,
        px: Number.isFinite(f.x) ? (f.x - tileX) * tileSize : 0,
        py: Number.isFinite(f.y) ? (f.y - tileY) * tileSize : 0,
    };
}

/** WGS84 bounding box of a tile address (its NW and SE corners in lon/lat). */
export function tileBoundingBox(z: number, x: number, y: number): TileBoundingBox {
    const nw = fractionalTileToLonLat(x, y, z);
    const se = fractionalTileToLonLat(x + 1, y + 1, z);
    return { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat };
}
