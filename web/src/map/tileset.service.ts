import { Signal, Computed, batch } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { AssetsApi, CourseAsset } from '../../../shared/api/assets.gen';

/** WGS84 bounding box, as stored in the tile manifest. */
export interface TileBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** Per-layer zoom range from the tile manifest. */
export interface TileLayerConfig {
    minzoom: number;
    maxzoom: number;
}

/**
 * Parsed tile-set manifest — the `metaJson` of a course's `tile_manifest`
 * asset (written by the Phase 2 pipeline; see pipeline manifest emit).
 */
export interface TileManifest {
    bounds: TileBounds;
    layers: {
        ortho: TileLayerConfig;
        terrain: TileLayerConfig;
    };
    /** Course elevation range in meters (RH2000). */
    elevation: { min: number; max: number };
    /** ISO timestamp of tile generation — drives the `?v=` cache-buster. */
    generatedAt: string;
    attribution?: string;
}

/**
 * Parse a tile_manifest asset's metaJson. Returns null for missing/invalid
 * JSON or a manifest lacking the required fields — callers treat null as
 * "course has no tiles".
 */
export function parseTileManifest(metaJson: string | null | undefined): TileManifest | null {
    if (!metaJson) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(metaJson);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Record<string, any>;
    const b = m.bounds;
    const ortho = m.layers?.ortho;
    const terrain = m.layers?.terrain;
    if (
        typeof b?.west !== 'number' || typeof b?.south !== 'number' ||
        typeof b?.east !== 'number' || typeof b?.north !== 'number' ||
        typeof ortho?.minzoom !== 'number' || typeof ortho?.maxzoom !== 'number' ||
        typeof terrain?.minzoom !== 'number' || typeof terrain?.maxzoom !== 'number' ||
        typeof m.generatedAt !== 'string'
    ) return null;
    return {
        bounds: { west: b.west, south: b.south, east: b.east, north: b.north },
        layers: {
            ortho: { minzoom: ortho.minzoom, maxzoom: ortho.maxzoom },
            terrain: { minzoom: terrain.minzoom, maxzoom: terrain.maxzoom },
        },
        elevation: {
            min: typeof m.elevation?.min === 'number' ? m.elevation.min : 0,
            max: typeof m.elevation?.max === 'number' ? m.elevation.max : 0,
        },
        generatedAt: m.generatedAt,
        attribution: typeof m.attribution === 'string' ? m.attribution : undefined,
    };
}

/**
 * Derive the `?v=` tile-URL version param from the manifest's generatedAt.
 * The server sends immutable year-long cache headers on tile responses, so
 * every re-tile MUST change this value or browsers keep stale tiles.
 * Compacted to URL-safe chars: `2026-07-04T08:28:59Z` → `20260704T082859Z`.
 */
export function deriveTileVersion(generatedAt: string): string {
    return generatedAt.replace(/[^0-9TZ]/g, '');
}

/**
 * Resolves a course's tile configuration from the API: the course's
 * `tile_manifest` asset (assets.by-course) carries bounds, layer zoom
 * ranges, elevation range, and generatedAt in its metaJson.
 *
 * A course without a tile manifest is a normal state (imported courses that
 * haven't been through the tile pipeline yet): `load()` succeeds and
 * `hasTiles` stays false — the editor canvas shows an empty state instead
 * of a map.
 *
 * Cached per courseId like the other detail services — `load()` only
 * refetches when the id changes.
 */
export class TilesetService {
    /** Parsed manifest for `courseId`, or null (not loaded / course has no tiles). */
    readonly manifest = new Signal<TileManifest | null>(null);
    /** The courseId the current signals describe. Set after a successful load. */
    readonly courseId = new Signal<string | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);

    /** True once a manifest with tile layers is loaded for `courseId`. */
    readonly hasTiles = new Computed(() => this.manifest.get() !== null);

    /** WGS84 bounds from the manifest, or null without tiles. */
    readonly bounds = new Computed<TileBounds | null>(() => this.manifest.get()?.bounds ?? null);

    /** `?v=` cache-buster derived from the manifest's generatedAt, or null. */
    readonly tileVersion = new Computed<string | null>(() => {
        const m = this.manifest.get();
        return m ? deriveTileVersion(m.generatedAt) : null;
    });

    private loadedCourseId: string | null = null;

    constructor(private assetsApi: AssetsApi = api.assets) {}

    /** Load the tile manifest for a course. Cached per courseId. */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        const assets = await request(this.loading, this.error, () =>
            this.assetsApi.listByCourse({ courseId }));
        if (!assets) return; // request failed — error signal is set, cache untouched
        const manifestAsset: CourseAsset | undefined = assets.find(a => a.kind === 'tile_manifest');
        batch(() => {
            this.manifest.set(parseTileManifest(manifestAsset?.metaJson));
            this.courseId.set(courseId);
        });
        this.loadedCourseId = courseId;
    }
}
