import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import * as path from 'node:path';
import type { Database, CourseAssetsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export type AssetKind = 'ortho_cog' | 'dem_cog' | 'svg_source' | 'tile_manifest';

/**
 * Raster tile layers under `data/tiles/<siteId>/<layer>/`. The lidar-derived
 * trio (`canopy`, `canopy-color`, `surface`) exists only for sites tiled with
 * lidar canopy data — clients treat them as optional per the manifest.
 *  - `canopy`: Terrain-RGB PNG, value = canopy height above ground (m, 0 = none)
 *  - `canopy-color`: RGBA PNG, pre-coloured canopy for display (transparent = none)
 *  - `surface`: Terrain-RGB PNG, DSM = ground + canopy
 */
export type TileLayer = 'ortho' | 'terrain' | 'hillshade' | 'canopy' | 'canopy-color' | 'surface';

export const TILE_LAYERS: readonly TileLayer[] = ['ortho', 'terrain', 'hillshade', 'canopy', 'canopy-color', 'surface'];

const TILE_EXTENSION_BY_LAYER: Record<TileLayer, 'jpg' | 'png' | 'webp'> = {
    ortho: 'jpg',
    terrain: 'png',
    hillshade: 'webp',
    canopy: 'png',
    'canopy-color': 'png',
    surface: 'png',
};

// Candidate extensions per layer, in resolution-preference order. Ortho tiles
// are migrating from JPEG to WebP: a WebP tile is preferred when present, with
// the legacy JPEG as fallback so existing on-disk trees keep serving. Terrain
// and the lidar layers are PNG only; hillshade is opaque WebP only (baked by
// the pipeline).
const TILE_EXTENSIONS_BY_LAYER: Record<TileLayer, readonly string[]> = {
    ortho: ['webp', 'jpg'],
    terrain: ['png'],
    hillshade: ['webp'],
    canopy: ['png'],
    'canopy-color': ['png'],
    surface: ['png'],
};

// A "safe id" — used to validate courseId before it touches the filesystem.
// Matches the shape of crypto.randomUUID() output as well as simple slugs.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

// Cache-key components (archive version + zoom key) that end up in a filename.
// No path separators, so no traversal is possible via these.
const SAFE_KEY_RE = /^[A-Za-z0-9._-]+$/;

export interface CourseAsset {
    id: string;
    courseId: string;
    siteId: string | null;
    kind: AssetKind;
    filename: string;
    metaJson: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type CourseAssetRow = Selectable<CourseAssetsTable>;

function toCourseAsset(row: CourseAssetRow): CourseAsset {
    return {
        id: row.id,
        courseId: row.course_id,
        siteId: row.site_id,
        kind: row.kind as AssetKind,
        filename: row.filename,
        metaJson: row.meta_json,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Ensures z/x/y are non-negative integers. Throws a plain Error (callers
 * treat this as a 400-equivalent "invalid params" case) if not.
 */
function assertTileCoordinate(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid tile coordinate: ${name} must be a non-negative integer`);
    }
}

export class AssetsService {
    constructor(private db: Kysely<Database>, private dataDir: string) {}

    // --- Queries (read) ---

    private assets() {
        return this.db.selectFrom('course_assets').selectAll();
    }

    private byId(id: string) {
        return this.assets().where('id', '=', id);
    }

    private byCourse(courseId: string) {
        return this.assets().where('course_id', '=', courseId).orderBy('created_at');
    }

    private bySite(siteId: string) {
        return this.assets().where('site_id', '=', siteId).orderBy('created_at');
    }

    // --- Queries (write) ---

    private insertAsset(values: {
        id: string; course_id: string; site_id: string | null; kind: string; filename: string;
        meta_json: string | null; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('course_assets').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('course_assets').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('course_assets').where('id', '=', id);
    }

    // --- Methods ---

    async listByCourse(courseId: string): Promise<CourseAsset[]> {
        const rows = await this.byCourse(courseId).execute();
        return rows.map(toCourseAsset);
    }

    /** Map assets for a site — the shared map is site-scoped. */
    async listBySite(siteId: string): Promise<CourseAsset[]> {
        const rows = await this.bySite(siteId).execute();
        return rows.map(toCourseAsset);
    }

    async get(id: string): Promise<CourseAsset> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Asset ${id} not found`);
        return toCourseAsset(row);
    }

    async register(input: {
        siteId: string;
        courseId?: string;
        kind: AssetKind;
        filename: string;
        metaJson?: string;
    }): Promise<CourseAsset> {
        const id = crypto.randomUUID();
        const values = {
            id,
            // course_id stays non-null in the DB (legacy column); map assets belong
            // to the site, so default it to the site id when no owner course is given.
            course_id: input.courseId ?? input.siteId,
            site_id: input.siteId,
            kind: input.kind,
            filename: input.filename,
            meta_json: input.metaJson ?? null,
        };
        await this.insertAsset(values).execute();
        const row = await this.byId(id).executeTakeFirstOrThrow();
        return toCourseAsset(row);
    }

    async update(id: string, version: number, patch: { metaJson?: string }): Promise<CourseAsset> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Asset ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('course_assets', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.metaJson !== undefined) dbInput.meta_json = patch.metaJson;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toCourseAsset(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Asset ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('course_assets', id);
        await this.deleteById(id).execute();
    }

    /**
     * Resolves the filesystem path for a tile, sanitizing every input so no
     * path traversal is possible:
     *  - courseId must match a safe-id pattern (no '/', '..', etc.)
     *  - layer must be one of the known literal tile layers
     *  - z/x/y must be non-negative integers (not strings, not floats)
     * Throws a plain Error on any invalid input — callers (e.g. the tile
     * route) map that to a 400 response.
     */
    resolveTilePath(courseId: string, layer: TileLayer, z: number, x: number, y: number): string {
        return this.tilePathForExt(courseId, layer, z, x, y, TILE_EXTENSION_BY_LAYER[layer]);
    }

    /**
     * Returns the candidate filesystem paths for a tile, in preference order,
     * with the same sanitization as `resolveTilePath`. The caller serves the
     * first candidate that exists on disk. Ortho prefers `.webp` and falls back
     * to the legacy `.jpg`; terrain has a single `.png` candidate.
     *
     * `collection` selects a specific ortho vintage tiled under
     * `<layer>/<collection>/…` (build-time active vintage lives in the flat
     * `<layer>/…` tree, the others in per-collection subdirs). Ignored for
     * non-ortho layers.
     */
    resolveTilePathCandidates(courseId: string, layer: TileLayer, z: number, x: number, y: number, collection?: string): string[] {
        return TILE_EXTENSIONS_BY_LAYER[layer].map((ext) =>
            this.tilePathForExt(courseId, layer, z, x, y, ext, collection),
        );
    }

    /**
     * Candidate paths for a SIM-overlay ortho tile (dual photo state: cleaned
     * imagery for golf-simulator export lives in a sparse copy-on-write
     * `ortho-sim/` tree holding only patch-affected tiles). Candidates are
     * the overlay tile first, then the pristine flat-tree tile — the caller
     * serves the first that exists, so an untouched coordinate transparently
     * falls back to the original photo. Same sanitization as resolveTilePath.
     */
    resolveSimTilePathCandidates(courseId: string, z: number, x: number, y: number): string[] {
        // Pristine candidates run the full sanitization; the sim overlay is
        // the sibling `ortho-sim/<z>/<x>/<y>.<ext>` dir with the same names.
        const pristine = this.resolveTilePathCandidates(courseId, 'ortho', z, x, y);
        const sim = TILE_EXTENSIONS_BY_LAYER.ortho.map((ext) =>
            path.join(this.dataDir, 'tiles', courseId, 'ortho-sim', String(z), String(x), `${y}.${ext}`),
        );
        return [...sim, ...pristine];
    }

    private tilePathForExt(courseId: string, layer: TileLayer, z: number, x: number, y: number, ext: string, collection?: string): string {
        if (!SAFE_ID_RE.test(courseId)) {
            throw new Error(`Invalid courseId: ${courseId}`);
        }
        if (!TILE_LAYERS.includes(layer)) {
            throw new Error(`Invalid tile layer: ${layer}`);
        }
        if (collection !== undefined && (layer !== 'ortho' || !SAFE_ID_RE.test(collection))) {
            throw new Error(`Invalid tile collection: ${collection}`);
        }
        assertTileCoordinate('z', z);
        assertTileCoordinate('x', x);
        assertTileCoordinate('y', y);

        const segments = collection === undefined
            ? [layer, String(z), String(x), `${y}.${ext}`]
            : [layer, collection, String(z), String(x), `${y}.${ext}`];
        const filePath = path.join(this.dataDir, 'tiles', courseId, ...segments);

        const tilesRoot = path.join(this.dataDir, 'tiles');
        if (!filePath.startsWith(tilesRoot + path.sep) && filePath !== tilesRoot) {
            // Defense in depth — should be unreachable given the checks above.
            throw new Error('Resolved tile path escapes tiles directory');
        }

        return filePath;
    }

    /**
     * Sanitized path to a site's tile directory for a layer:
     * `<dataDir>/tiles/<courseId>/<layer>`. Used by the archive endpoint to
     * enumerate every tile for a layer. Throws on any unsafe input.
     */
    resolveTileLayerDir(courseId: string, layer: TileLayer): string {
        if (!SAFE_ID_RE.test(courseId)) {
            throw new Error(`Invalid courseId: ${courseId}`);
        }
        if (!TILE_LAYERS.includes(layer)) {
            throw new Error(`Invalid tile layer: ${layer}`);
        }
        const dir = path.join(this.dataDir, 'tiles', courseId, layer);
        const tilesRoot = path.join(this.dataDir, 'tiles');
        if (!dir.startsWith(tilesRoot + path.sep)) {
            throw new Error('Resolved tile layer dir escapes tiles directory');
        }
        return dir;
    }

    /**
     * Sanitized path to the on-disk cache file for a per-layer tile archive:
     * `<dataDir>/tile-archives/<courseId>/<layer>-<versionKey>-z<zoomKey>.tar`.
     * `versionKey`/`zoomKey` are cache-key components only and must contain no
     * path separators. Throws on any unsafe input.
     */
    resolveTileArchivePath(courseId: string, layer: TileLayer, versionKey: string, zoomKey: string): string {
        if (!SAFE_ID_RE.test(courseId)) {
            throw new Error(`Invalid courseId: ${courseId}`);
        }
        if (!TILE_LAYERS.includes(layer)) {
            throw new Error(`Invalid tile layer: ${layer}`);
        }
        if (!SAFE_KEY_RE.test(versionKey)) {
            throw new Error(`Invalid archive version key: ${versionKey}`);
        }
        if (!SAFE_KEY_RE.test(zoomKey)) {
            throw new Error(`Invalid archive zoom key: ${zoomKey}`);
        }
        const file = `${layer}-${versionKey}-z${zoomKey}.tar`;
        const archivePath = path.join(this.dataDir, 'tile-archives', courseId, file);
        const archivesRoot = path.join(this.dataDir, 'tile-archives');
        if (!archivePath.startsWith(archivesRoot + path.sep)) {
            throw new Error('Resolved archive path escapes tile-archives directory');
        }
        return archivePath;
    }
}
