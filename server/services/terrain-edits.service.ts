import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, TerrainEditsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Constants ---

/** The two v1 operations (D-TE3). */
export const TERRAIN_EDIT_OPS = ['plane', 'smooth'] as const;
export type TerrainEditOp = (typeof TERRAIN_EDIT_OPS)[number];

// --- Output types ---

/** Op parameters. `radiusM`/`flat` only meaningful for `smooth`/`plane` resp. */
export interface TerrainEditParams {
    featherM: number;
    radiusM?: number;
    flat?: boolean;
}

/** A straight-segment ring: EPSG:3006 (DEM CRS) coordinates in metres. */
export type TerrainEditRing = { x: number; y: number }[];

export interface TerrainEdit {
    id: string;
    siteId: string;
    op: TerrainEditOp;
    params: TerrainEditParams;
    rings: TerrainEditRing[];
    enabled: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type TerrainEditRow = Selectable<TerrainEditsTable>;

function toTerrainEdit(row: TerrainEditRow): TerrainEdit {
    return {
        id: row.id,
        siteId: row.site_id,
        op: row.op as TerrainEditOp,
        params: JSON.parse(row.params_json) as TerrainEditParams,
        rings: JSON.parse(row.rings_json) as TerrainEditRing[],
        enabled: row.enabled !== 0,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// --- Validation ---

export class InvalidTerrainEditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidTerrainEditError';
    }
}

function assertValidOp(op: string): asserts op is TerrainEditOp {
    if (!(TERRAIN_EDIT_OPS as readonly string[]).includes(op)) {
        throw new InvalidTerrainEditError(`Invalid terrain-edit op: ${op}`);
    }
}

function assertValidParams(params: TerrainEditParams): void {
    if (!params || typeof params !== 'object') {
        throw new InvalidTerrainEditError('Params must be an object');
    }
    if (!Number.isFinite(params.featherM) || params.featherM < 0) {
        throw new InvalidTerrainEditError('featherM must be a finite number >= 0');
    }
    if (params.radiusM !== undefined && (!Number.isFinite(params.radiusM) || params.radiusM <= 0)) {
        throw new InvalidTerrainEditError('radiusM must be a finite number > 0');
    }
}

function assertValidRings(rings: TerrainEditRing[]): void {
    if (!Array.isArray(rings) || rings.length === 0) {
        throw new InvalidTerrainEditError('rings must have at least one ring');
    }
    for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 3) {
            throw new InvalidTerrainEditError('Each ring must have at least 3 points');
        }
        for (const p of ring) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                throw new InvalidTerrainEditError('Ring points must have finite x/y coordinates');
            }
        }
    }
}

/**
 * Site-scoped DEM edits (smooth/flatten). Stored as vector features — straight-
 * segment rings in the DEM CRS (EPSG:3006) plus an op + params — and replayed
 * onto the raw DEM at build time (T54/T56), never baked into `sources/dem.tif`.
 * Edits apply in `created_at` order (D-TE4), so `listBySite` returns them so.
 */
export class TerrainEditsService {
    constructor(private db: Kysely<Database>) {}

    private edits() {
        return this.db.selectFrom('terrain_edits').selectAll();
    }

    private byId(id: string) {
        return this.edits().where('id', '=', id);
    }

    /** All edits for a site, oldest first (the deterministic apply order, D-TE4). */
    async listBySite(siteId: string): Promise<TerrainEdit[]> {
        const rows = await this.edits()
            .where('site_id', '=', siteId)
            .orderBy('created_at')
            .orderBy('id')
            .execute();
        return rows.map(toTerrainEdit);
    }

    async get(id: string): Promise<TerrainEdit> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Terrain edit ${id} not found`);
        return toTerrainEdit(row);
    }

    async create(input: {
        id?: string;
        siteId: string;
        op: TerrainEditOp;
        params: TerrainEditParams;
        rings: TerrainEditRing[];
        enabled?: boolean;
    }): Promise<TerrainEdit> {
        assertValidOp(input.op);
        assertValidParams(input.params);
        assertValidRings(input.rings);

        const id = input.id ?? crypto.randomUUID();
        await this.db.insertInto('terrain_edits').values({
            id,
            site_id: input.siteId,
            op: input.op,
            params_json: JSON.stringify(input.params),
            rings_json: JSON.stringify(input.rings),
            enabled: input.enabled === false ? 0 : 1,
            version: 1,
        }).execute();
        return this.get(id);
    }

    async update(
        id: string,
        version: number,
        patch: { op?: TerrainEditOp; params?: TerrainEditParams; rings?: TerrainEditRing[]; enabled?: boolean },
    ): Promise<TerrainEdit> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Terrain edit ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('terrain_edits', id);

        if (patch.op !== undefined) assertValidOp(patch.op);
        if (patch.params !== undefined) assertValidParams(patch.params);
        if (patch.rings !== undefined) assertValidRings(patch.rings);

        const dbInput: Record<string, unknown> = {};
        if (patch.op !== undefined) dbInput.op = patch.op;
        if (patch.params !== undefined) dbInput.params_json = JSON.stringify(patch.params);
        if (patch.rings !== undefined) dbInput.rings_json = JSON.stringify(patch.rings);
        if (patch.enabled !== undefined) dbInput.enabled = patch.enabled ? 1 : 0;

        await this.db.updateTable('terrain_edits').where('id', '=', id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        return this.get(id);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Terrain edit ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('terrain_edits', id);
        await this.db.deleteFrom('terrain_edits').where('id', '=', id).execute();
    }
}
