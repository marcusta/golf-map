import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import * as path from 'node:path';
import type { Database, CourseAssetsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export type AssetKind = 'ortho_cog' | 'dem_cog' | 'svg_source' | 'tile_manifest';

export type TileLayer = 'ortho' | 'terrain';

const TILE_LAYERS: readonly TileLayer[] = ['ortho', 'terrain'];

const TILE_EXTENSION_BY_LAYER: Record<TileLayer, 'jpg' | 'png'> = {
    ortho: 'jpg',
    terrain: 'png',
};

// A "safe id" — used to validate courseId before it touches the filesystem.
// Matches the shape of crypto.randomUUID() output as well as simple slugs.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface CourseAsset {
    id: string;
    courseId: string;
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

    // --- Queries (write) ---

    private insertAsset(values: {
        id: string; course_id: string; kind: string; filename: string;
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

    async get(id: string): Promise<CourseAsset> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Asset ${id} not found`);
        return toCourseAsset(row);
    }

    async register(input: {
        courseId: string;
        kind: AssetKind;
        filename: string;
        metaJson?: string;
    }): Promise<CourseAsset> {
        const id = crypto.randomUUID();
        const values = {
            id,
            course_id: input.courseId,
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
        if (!SAFE_ID_RE.test(courseId)) {
            throw new Error(`Invalid courseId: ${courseId}`);
        }
        if (!TILE_LAYERS.includes(layer)) {
            throw new Error(`Invalid tile layer: ${layer}`);
        }
        assertTileCoordinate('z', z);
        assertTileCoordinate('x', x);
        assertTileCoordinate('y', y);

        const ext = TILE_EXTENSION_BY_LAYER[layer];
        const filePath = path.join(this.dataDir, 'tiles', courseId, layer, String(z), String(x), `${y}.${ext}`);

        const tilesRoot = path.join(this.dataDir, 'tiles');
        if (!filePath.startsWith(tilesRoot + path.sep) && filePath !== tilesRoot) {
            // Defense in depth — should be unreachable given the checks above.
            throw new Error('Resolved tile path escapes tiles directory');
        }

        return filePath;
    }
}
