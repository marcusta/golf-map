import { tileUrlTemplate } from './map-style';

// ─── ElevationService — THE single elevation source of truth ─────────────
//
// All editor tools (measurement, green analysis, feature elevation
// auto-sampling, plays-like) read heights through this service. It decodes
// Terrain-RGB tiles itself instead of using MapLibre's
// `map.queryTerrainElevation()`, deliberately:
//
//   - queryTerrainElevation is affected by the current terrain exaggeration
//     and returns values scaled/offset by it in some MapLibre versions —
//     the Phase 2 demo showed inconsistent readings when exaggeration != 1.
//   - it only answers for tiles the *renderer* has loaded at the current
//     view, so answers change with zoom and are unavailable while tiles
//     stream in; analysis tools need deterministic full-resolution reads.
//
// Decoding tiles directly at a fixed query zoom (the terrain layer's
// maxzoom, 17 for the Lantmäteriet pipeline output) gives stable,
// exaggeration-independent, best-resolution heights everywhere in the
// course bounds.

/** Decoded RGBA pixel data for one terrain tile. */
export interface DecodedTile {
    width: number;
    height: number;
    /** RGBA, row-major, 4 bytes/pixel (ImageData layout). */
    data: Uint8ClampedArray;
}

/** Fetches + decodes one terrain tile; null for missing tiles (404 / out of coverage). */
export type TileFetcher = (url: string) => Promise<DecodedTile | null>;

export interface LngLat {
    lng: number;
    lat: number;
}

/** Configuration for a site's terrain tile set. */
export interface ElevationTileConfig {
    mapKey: string;
    /** Fixed query zoom — use the terrain layer's maxzoom from the manifest. */
    zoom: number;
    /** `?v=` cache-buster (TilesetService.tileVersion). */
    version: string;
}

// ─── Pure helpers (exported for unit tests) ───────────────────────────────

/** Mapbox/MapLibre Terrain-RGB decode: height in meters from one pixel. */
export function decodeTerrainRgb(r: number, g: number, b: number): number {
    return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/**
 * WGS84 → XYZ tile + fractional pixel position (Web Mercator).
 * `px`/`py` are fractional pixel coordinates within the tile ([0, tileSize)).
 */
export function lngLatToTilePixel(
    lng: number,
    lat: number,
    zoom: number,
    tileSize = 256,
): { tileX: number; tileY: number; px: number; py: number } {
    const n = 2 ** zoom;
    const x = ((lng + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    return {
        tileX,
        tileY,
        px: (x - tileX) * tileSize,
        py: (y - tileY) * tileSize,
    };
}

/**
 * Bilinearly interpolated height at fractional pixel (px, py) of a decoded
 * Terrain-RGB tile. Pixel values are treated as samples at pixel centers;
 * coordinates are clamped to the tile edge (samples within half a pixel of
 * a tile border skip cross-tile interpolation — at z17/0.5 m DEM that error
 * is negligible for golf distances).
 */
export function bilinearElevation(tile: DecodedTile, px: number, py: number): number {
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
    const x = clamp(px - 0.5, tile.width - 1);
    const y = clamp(py - 0.5, tile.height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, tile.width - 1);
    const y1 = Math.min(y0 + 1, tile.height - 1);
    const fx = x - x0;
    const fy = y - y0;

    const at = (xi: number, yi: number): number => {
        const i = (yi * tile.width + xi) * 4;
        return decodeTerrainRgb(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
    };

    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    return top * (1 - fy) + bottom * fy;
}

/** Tiny LRU: `get` refreshes recency, inserting past `capacity` evicts the oldest. */
export class LruCache<K, V> {
    private map = new Map<K, V>();

    constructor(readonly capacity: number) {}

    get(key: K): V | undefined {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key)!;
        this.map.delete(key);
        this.map.set(key, value); // re-insert → most recent
        return value;
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    set(key: K, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.capacity) {
            const oldest = this.map.keys().next().value as K;
            this.map.delete(oldest);
        }
    }

    clear(): void {
        this.map.clear();
    }

    get size(): number {
        return this.map.size;
    }
}

// ─── Default network fetcher ──────────────────────────────────────────────

/** Fetch a terrain tile through the same-origin /tiles proxy and decode its pixels. */
async function fetchTerrainTile(url: string): Promise<DecodedTile | null> {
    const res = await fetch(url);
    if (!res.ok) return null; // 404 = outside coverage; other errors → treat as no data
    const bitmap = await createImageBitmap(await res.blob());
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        return { width: img.width, height: img.height, data: img.data };
    } finally {
        bitmap.close();
    }
}

// ─── Service ──────────────────────────────────────────────────────────────

/** Decoded tiles are ~256KB each; 32 covers a full course at z17 comfortably. */
const TILE_CACHE_CAPACITY = 32;

/**
 * Client-side elevation sampling from Terrain-RGB tiles (see the header
 * comment for why this exists instead of `map.queryTerrainElevation`).
 *
 * Lifecycle: the editor canvas calls `configure(...)` when a course's tile
 * manifest loads and `configure(null)` on teardown. All sampling methods
 * return null while unconfigured.
 *
 * DI singleton; constructor takes the tile fetcher as a parameter
 * (default = real network fetch) for mock-free tests with synthetic pixels.
 */
export class ElevationService {
    private config: ElevationTileConfig | null = null;
    private cache = new LruCache<string, DecodedTile | null>(TILE_CACHE_CAPACITY);
    private inflight = new Map<string, Promise<DecodedTile | null>>();

    constructor(private fetchTile: TileFetcher = fetchTerrainTile) {}

    /** Point the service at a course's terrain tiles (null = teardown). Clears the cache. */
    configure(config: ElevationTileConfig | null): void {
        this.config = config;
        this.cache.clear();
        this.inflight.clear();
    }

    /**
     * Elevation in meters at a WGS84 position, or null when unconfigured /
     * outside tile coverage. Fetches + caches the containing terrain tile
     * on demand; cached samples resolve without network.
     */
    async elevationAt(lngLat: LngLat): Promise<number | null> {
        if (!this.config) return null;
        const { tileX, tileY, px, py } = lngLatToTilePixel(lngLat.lng, lngLat.lat, this.config.zoom);
        const tile = await this.loadTile(tileX, tileY);
        return tile ? bilinearElevation(tile, px, py) : null;
    }

    /**
     * Synchronous read for already-cached tiles — for mousemove HUDs and
     * other per-frame consumers. Returns null on a cache miss and kicks off
     * a background fetch of the tile, so a subsequent call (or an
     * `elevationAt` await) will have data. Null is therefore "not YET
     * known", not "no data" — callers wanting a definite answer use
     * `elevationAt`.
     */
    elevationAtSync(lngLat: LngLat): number | null {
        if (!this.config) return null;
        const { tileX, tileY, px, py } = lngLatToTilePixel(lngLat.lng, lngLat.lat, this.config.zoom);
        const key = this.tileKey(tileX, tileY);
        if (this.cache.has(key)) {
            const tile = this.cache.get(key);
            return tile ? bilinearElevation(tile, px, py) : null;
        }
        void this.loadTile(tileX, tileY); // background fill for the next read
        return null;
    }

    /**
     * Sample `n` evenly spaced points (inclusive of both endpoints, n >= 2)
     * along the straight lng/lat segment a→b — for elevation profiles and
     * draped/along-terrain distance sums.
     */
    async sampleLine(
        a: LngLat,
        b: LngLat,
        n: number,
    ): Promise<Array<{ lng: number; lat: number; elevation: number | null }>> {
        const count = Math.max(2, Math.floor(n));
        const points = Array.from({ length: count }, (_, i) => {
            const t = i / (count - 1);
            return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
        });
        const elevations = await Promise.all(points.map(p => this.elevationAt(p)));
        return points.map((p, i) => ({ ...p, elevation: elevations[i] }));
    }

    private tileKey(x: number, y: number): string {
        return `${this.config!.mapKey}/${this.config!.zoom}/${x}/${y}`;
    }

    private loadTile(x: number, y: number): Promise<DecodedTile | null> {
        const config = this.config!;
        const key = this.tileKey(x, y);
        if (this.cache.has(key)) return Promise.resolve(this.cache.get(key)!);
        const pending = this.inflight.get(key);
        if (pending) return pending;

        const url = tileUrlTemplate(config.mapKey, 'terrain', 'png', config.version)
            .replace('{z}', String(config.zoom))
            .replace('{x}', String(x))
            .replace('{y}', String(y));

        const promise = this.fetchTile(url).then(
            tile => {
                this.inflight.delete(key);
                // Only cache when this config is still current (guards a
                // course switch racing an in-flight fetch). Missing tiles
                // (404 → fetcher returns null) ARE cached as null —
                // out-of-coverage is permanent for this tile version.
                if (this.config === config) this.cache.set(key, tile);
                return tile;
            },
            () => {
                // Transient network failure — NOT cached, so a later
                // sample retries the fetch.
                this.inflight.delete(key);
                return null;
            },
        );
        this.inflight.set(key, promise);
        return promise;
    }
}
