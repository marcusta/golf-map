import {
    ElevationService,
    decodeTerrainRgb,
    bilinearElevation,
    type DecodedTile,
    type ElevationTileConfig,
    type LngLat,
    type TileFetcher,
} from './elevation.service';

// ─── CanopyService — lidar canopy height above ground ─────────────────────
//
// The `canopy` tile layer is a Terrain-RGB PNG whose decoded value is the
// canopy height above ground in metres (0 = no canopy), tiled by the
// pipeline for sites with lidar data. Sampling reuses ElevationService's
// tile addressing, LRU cache and Terrain-RGB decode against that layer.
//
// This is NOT an elevation source: distances and plays-like keep reading
// the ground DEM through ElevationService regardless of the visual terrain
// mode. Consumers so far: the flyover camera (fly over the trees) and
// strategy work (canopy along a shot corridor).

/** Canopy tile config — same shape as the terrain config, zoom = `canopy` layer maxzoom. */
export type CanopyTileConfig = ElevationTileConfig;

// ─── Pure helpers (exported for unit tests) ───────────────────────────────

/**
 * Canopy height (m above ground) from one Terrain-RGB pixel. The pipeline
 * encodes height with the standard formula, so 0 m is (1, 134, 160); nodata
 * pixels written as black decode to -10000 and clamp to 0 — "no canopy".
 */
export function decodeCanopyHeight(r: number, g: number, b: number): number {
    return Math.max(0, decodeTerrainRgb(r, g, b));
}

/**
 * Bilinear canopy height at fractional pixel (px, py) of a decoded `canopy`
 * tile, clamped at 0. Interpolation blends crown edges into the ground
 * (a 20 m crown next to bare ground reads 10 m half a pixel out), which is
 * the behaviour a camera path wants — no cliffs.
 */
export function bilinearCanopyHeight(tile: DecodedTile, px: number, py: number): number {
    return Math.max(0, bilinearElevation(tile, px, py));
}

// ─── Service ──────────────────────────────────────────────────────────────

/**
 * Client-side canopy height sampling from `canopy` Terrain-RGB tiles.
 *
 * Lifecycle mirrors ElevationService: the editor canvas calls
 * `configure(...)` when a manifest WITH a `canopy` layer loads and
 * `configure(null)` on teardown or for courses without lidar. Every
 * sampling method returns null while unconfigured, so callers can treat
 * null as "no canopy data here".
 *
 * DI singleton; the tile fetcher is a constructor parameter (default = real
 * network fetch) for mock-free tests with synthetic pixels.
 */
export class CanopyService {
    private sampler: ElevationService;
    private configured = false;

    constructor(fetchTile?: TileFetcher) {
        this.sampler = new ElevationService(fetchTile, 'canopy');
    }

    /** Point the service at a site's canopy tiles (null = teardown / no layer). Clears the cache. */
    configure(config: CanopyTileConfig | null): void {
        this.configured = config !== null;
        this.sampler.configure(config);
    }

    /** True when a `canopy` layer is configured for the current course. */
    get available(): boolean {
        return this.configured;
    }

    /**
     * Canopy height in metres above ground at a WGS84 position; 0 where
     * there are no trees, null when unconfigured or outside tile coverage.
     */
    async heightAt(lngLat: LngLat): Promise<number | null> {
        const h = await this.sampler.elevationAt(lngLat);
        return h === null ? null : Math.max(0, h);
    }

    /**
     * Synchronous read for already-cached tiles (per-frame consumers). Null
     * = "not yet known" — the tile fetch is kicked off in the background.
     */
    heightAtSync(lngLat: LngLat): number | null {
        const h = this.sampler.elevationAtSync(lngLat);
        return h === null ? null : Math.max(0, h);
    }

    /** Canopy height at `n` evenly spaced points along a→b (inclusive, n >= 2). */
    async sampleLine(
        a: LngLat,
        b: LngLat,
        n: number,
    ): Promise<Array<{ lng: number; lat: number; height: number | null }>> {
        const samples = await this.sampler.sampleLine(a, b, n);
        return samples.map(({ lng, lat, elevation }) => ({
            lng,
            lat,
            height: elevation === null ? null : Math.max(0, elevation),
        }));
    }
}
