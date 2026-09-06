import { Signal, Computed, batch } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { AssetsApi, CourseAsset } from '../../../shared/api/assets.gen';
import type { CoursesApi } from '../../../shared/api/courses.gen';

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
        /** Baked opaque hillshade raster (present once a course is (re)built with it). */
        hillshade?: TileLayerConfig;
        /**
         * Lidar canopy trio — only on sites tiled with lidar canopy data.
         * `canopy`: Terrain-RGB, value = canopy height above ground (m).
         * `canopy-color`: RGBA display raster, transparent where no canopy.
         * `surface`: Terrain-RGB DSM = ground + canopy.
         */
        canopy?: TileLayerConfig;
        'canopy-color'?: TileLayerConfig;
        surface?: TileLayerConfig;
    };
    /** Course elevation range in meters (RH2000). */
    elevation: { min: number; max: number };
    /** ISO timestamp of tile generation — drives the `?v=` cache-buster. */
    generatedAt: string;
    attribution?: string;
    /** Orthophoto vintages persisted for this course (newest first), if any. */
    orthoVintages?: OrthoVintage[];
    /** Which vintage is currently tiled/served. */
    activeOrtho?: string;
    assets?: { 'tree-stems'?: { path: string; format: 'tree-stems-v1'; count: number } };
}

/** One orthophoto vintage (flight) available to switch to. */
export interface OrthoVintage {
    collection: string;
    dates: string[];
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
    const optionalLayer = (name: string): { [k: string]: TileLayerConfig } => {
        const l = m.layers?.[name];
        return typeof l?.minzoom === 'number' && typeof l?.maxzoom === 'number'
            ? { [name]: { minzoom: l.minzoom, maxzoom: l.maxzoom } }
            : {};
    };
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
            ...optionalLayer('hillshade'),
            ...optionalLayer('canopy'),
            ...optionalLayer('canopy-color'),
            ...optionalLayer('surface'),
        },
        elevation: {
            min: typeof m.elevation?.min === 'number' ? m.elevation.min : 0,
            max: typeof m.elevation?.max === 'number' ? m.elevation.max : 0,
        },
        generatedAt: m.generatedAt,
        attribution: typeof m.attribution === 'string' ? m.attribution : undefined,
        orthoVintages: Array.isArray(m.orthoVintages)
            ? m.orthoVintages
                .filter((v: any) => typeof v?.collection === 'string')
                .map((v: any) => ({ collection: v.collection, dates: Array.isArray(v.dates) ? v.dates : [] }))
            : undefined,
        assets: m.assets?.['tree-stems']?.path === 'tree-stems.json' && m.assets['tree-stems'].format === 'tree-stems-v1'
            ? { 'tree-stems': { path: 'tree-stems.json', format: 'tree-stems-v1', count: m.assets['tree-stems'].count } } : undefined,
        activeOrtho: typeof m.activeOrtho === 'string' ? m.activeOrtho : undefined,
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
    /** Parsed manifest for `courseId`, or null (not loaded / no map). */
    readonly manifest = new Signal<TileManifest | null>(null);
    /** The courseId the current signals describe. Set after a successful load. */
    readonly courseId = new Signal<string | null>(null);
    /**
     * The map key (the course's site id) — the on-disk/tile-URL key for the
     * shared map. Null when the course has no site (no map). Editor-canvas
     * passes this to MapService.init / ElevationService.configure.
     */
    readonly mapKey = new Signal<string | null>(null);
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

    constructor(
        private assetsApi: AssetsApi = api.assets,
        private coursesApi: CoursesApi = api.courses,
    ) {}

    /**
     * Force a refetch of a course's manifest, bypassing the per-courseId cache.
     * Used after a map build/vintage switch so the map refreshes without a full
     * navigation (the course may also have just been assigned a site).
     */
    async reload(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) this.loadedCourseId = null;
        await this.load(courseId);
    }

    /**
     * Re-fetch the manifest after an ortho-ONLY change (Clean-tool bake/revert)
     * so `tileVersion` tracks the server's bumped `generatedAt`. Behaves like
     * `reload` (bypasses the per-courseId cache), but callers pair it with
     * `MapService.refreshOrthoTiles()` for a seam-free in-place tile swap
     * instead of the full map re-init `reload` drives via the editor canvas —
     * the manifest is structurally unchanged, only the ortho pixels moved.
     */
    async refreshTiles(courseId: string): Promise<void> {
        await this.reload(courseId);
    }

    /**
     * Resolve a course's map: course → site → tile_manifest asset. A course with
     * no site (`siteId == null`) has no map — `hasTiles` stays false and the
     * editor shows the empty "Set map area" state. Cached per courseId.
     */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        const course = await request(this.loading, this.error, () => this.coursesApi.get({ id: courseId }));
        if (!course) return; // request failed — error set, cache untouched
        const siteId = course.siteId;

        let manifestAsset: CourseAsset | undefined;
        if (siteId) {
            const assets = await request(this.loading, this.error, () => this.assetsApi.listBySite({ siteId }));
            if (!assets) return;
            manifestAsset = assets.find(a => a.kind === 'tile_manifest');
        }
        batch(() => {
            this.manifest.set(parseTileManifest(manifestAsset?.metaJson));
            this.courseId.set(courseId);
            this.mapKey.set(siteId ?? null);
        });
        this.loadedCourseId = courseId;
    }
}
