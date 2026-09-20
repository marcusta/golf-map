import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, TerrainEditsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';
import { wgs84ToSweref99tm } from './geo';

// --- Constants ---

/**
 * The operations (D-TE3): the two hand-drawn v1 ops, and `corridor` — a
 * road graded smooth along its centerline and level across it — which only
 * the pipeline generates (`golfpipe road-grades`); the tool has no line
 * drawing, so the panel lists and toggles corridors but never arms one.
 */
export const TERRAIN_EDIT_OPS = ['plane', 'smooth', 'corridor'] as const;
export type TerrainEditOp = (typeof TERRAIN_EDIT_OPS)[number];

// --- Output types ---

/** A straight-segment ring: EPSG:3006 (DEM CRS) coordinates in metres. */
export type TerrainEditRing = { x: number; y: number }[];

/**
 * Op parameters. `radiusM`/`flat` only meaningful for `smooth`/`plane`;
 * `centerline` (EPSG:3006, the road's axis), `smoothM` (along-road window)
 * and `widthM` (pavement width the profile is sampled over) for `corridor`.
 */
export interface TerrainEditParams {
    featherM: number;
    radiusM?: number;
    flat?: boolean;
    centerline?: TerrainEditRing;
    smoothM?: number;
    widthM?: number;
}

export interface TerrainEdit {
    id: string;
    siteId: string;
    op: TerrainEditOp;
    params: TerrainEditParams;
    rings: TerrainEditRing[];
    enabled: boolean;
    /** Generator that wrote the edit (`building-pads`); null = hand-drawn. */
    origin: string | null;
    /** What a generated edit is for (a building id); the key a regeneration matches on. */
    originRef: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

/** One edit in the pipeline's D-TE5 handoff / the generated-edits import. */
export interface TerrainEditInput {
    op: TerrainEditOp;
    params: TerrainEditParams;
    rings: TerrainEditRing[];
    originRef?: string | null;
    enabled?: boolean;
}

/**
 * `created_at` for generated edits: the epoch plus the edit's index in its
 * generation, in SQLite's own `datetime('now')` spelling so it sorts as a
 * plain string against real timestamps — before every one of them.
 */
export const GENERATED_EPOCH = '2000-01-01 00:00:00';
export function generatedCreatedAt(index: number): string {
    return `${GENERATED_EPOCH}.${String(index).padStart(6, '0')}`;
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
        origin: row.origin ?? null,
        originRef: row.origin_ref ?? null,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// --- D-TE5 GeoJSON (the pipeline's edits handoff) → edit inputs ---

/**
 * Parses a D-TE5 edits FeatureCollection (WGS84 polygons, per-feature
 * `op`/`featherM`/`radiusM`/`flat`, optional `originRef`) — what
 * `golfpipe building-pads` writes — into inputs in the DEM CRS. Malformed
 * features are skipped and reported, never fatal, mirroring the pipeline's
 * own loader.
 */
export function parseEditsGeojson(doc: unknown): { edits: TerrainEditInput[]; skipped: string[] } {
    const edits: TerrainEditInput[] = [];
    const skipped: string[] = [];
    const collection = doc as { type?: unknown; features?: unknown };
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new InvalidTerrainEditError('Edits must be a GeoJSON FeatureCollection (D-TE5)');
    }
    collection.features.forEach((feature: any, i: number) => {
        const props = feature?.properties ?? {};
        const geometry = feature?.geometry;
        if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
            skipped.push(`feature ${i}: geometry is not a Polygon`);
            return;
        }
        if (!(TERRAIN_EDIT_OPS as readonly string[]).includes(props.op)) {
            skipped.push(`feature ${i}: unknown op ${JSON.stringify(props.op)}`);
            return;
        }
        const params: TerrainEditParams = { featherM: Number(props.featherM ?? 2) };
        if (props.radiusM !== undefined) params.radiusM = Number(props.radiusM);
        if (props.flat) params.flat = true;
        if (props.smoothM !== undefined) params.smoothM = Number(props.smoothM);
        if (props.widthM !== undefined && props.widthM !== null) params.widthM = Number(props.widthM);
        if (Array.isArray(props.centerline)) {
            params.centerline = props.centerline.map((p: unknown) =>
                Array.isArray(p) && p.length >= 2 ? wgs84ToSweref99tm(Number(p[1]), Number(p[0])) : { x: NaN, y: NaN });
        }
        const rings: TerrainEditRing[] = geometry.coordinates.map((ring: [number, number][]) => {
            const pts = ring.map(([lon, lat]) => wgs84ToSweref99tm(lat, lon));
            const first = pts[0], last = pts[pts.length - 1];
            // GeoJSON rings repeat the first point; stored rings don't.
            if (pts.length > 1 && first && last && first.x === last.x && first.y === last.y) pts.pop();
            return pts;
        });
        try {
            assertValidParams(params);
            assertOpParams(props.op, params);
            assertValidRings(rings);
        } catch (e) {
            skipped.push(`feature ${i}: ${(e as Error).message}`);
            return;
        }
        edits.push({
            op: props.op,
            params,
            rings,
            originRef: typeof props.originRef === 'string' ? props.originRef : null,
        });
    });
    return { edits, skipped };
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
    if (params.smoothM !== undefined && (!Number.isFinite(params.smoothM) || params.smoothM <= 0)) {
        throw new InvalidTerrainEditError('smoothM must be a finite number > 0');
    }
    if (params.widthM !== undefined && (!Number.isFinite(params.widthM) || params.widthM <= 0)) {
        throw new InvalidTerrainEditError('widthM must be a finite number > 0');
    }
    if (params.centerline !== undefined) {
        if (!Array.isArray(params.centerline) || params.centerline.length < 2
            || params.centerline.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
            throw new InvalidTerrainEditError('centerline must have at least 2 points with finite x/y');
        }
    }
}

function assertOpParams(op: TerrainEditOp, params: TerrainEditParams): void {
    if (op === 'corridor' && !params.centerline) {
        throw new InvalidTerrainEditError('A corridor edit needs a centerline');
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
 * Edits apply in `created_at` order (D-TE4) — generated ones (`origin` set,
 * e.g. the building pads) first, so a hand-drawn edit wins where they
 * overlap — and `listBySite` returns them so.
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

    /**
     * Replaces the site's edits of one `origin` with a fresh generation
     * (`golfpipe building-pads` output), in one transaction: the previous
     * generation's rows go, the new ones come in, and a building the user
     * had disabled stays disabled (matched by `originRef`). Hand-drawn edits
     * and other origins are untouched.
     */
    async replaceByOrigin(siteId: string, origin: string, inputs: TerrainEditInput[]): Promise<TerrainEdit[]> {
        if (!origin) throw new InvalidTerrainEditError('origin is required');
        for (const input of inputs) {
            assertValidOp(input.op);
            assertValidParams(input.params);
            assertOpParams(input.op, input.params);
            assertValidRings(input.rings);
        }
        return this.db.transaction().execute(async (trx) => {
            const previous = await trx.selectFrom('terrain_edits')
                .select(['origin_ref', 'enabled'])
                .where('site_id', '=', siteId)
                .where('origin', '=', origin)
                .execute();
            const disabled = new Set(previous.filter(r => r.enabled === 0 && r.origin_ref).map(r => r.origin_ref));
            await trx.deleteFrom('terrain_edits')
                .where('site_id', '=', siteId)
                .where('origin', '=', origin)
                .execute();
            const ids: string[] = [];
            for (const [index, input] of inputs.entries()) {
                const id = crypto.randomUUID();
                ids.push(id);
                const keepDisabled = input.originRef != null && disabled.has(input.originRef);
                await trx.insertInto('terrain_edits').values({
                    id,
                    site_id: siteId,
                    op: input.op,
                    params_json: JSON.stringify(input.params),
                    rings_json: JSON.stringify(input.rings),
                    enabled: input.enabled === false || keepDisabled ? 0 : 1,
                    origin,
                    origin_ref: input.originRef ?? null,
                    version: 1,
                    // Dated at the epoch (+ file order) so the one apply rule —
                    // createdAt order, D-TE4 — puts every generated edit before
                    // any hand-drawn one, here and in the pipeline's replay.
                    created_at: generatedCreatedAt(index),
                }).execute();
            }
            if (ids.length === 0) return [];
            const rows = await trx.selectFrom('terrain_edits').selectAll()
                .where('id', 'in', ids)
                .orderBy('created_at').orderBy('id')
                .execute();
            return rows.map(toTerrainEdit);
        });
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
        origin?: string | null;
        originRef?: string | null;
    }): Promise<TerrainEdit> {
        assertValidOp(input.op);
        assertValidParams(input.params);
        assertOpParams(input.op, input.params);
        assertValidRings(input.rings);

        const id = input.id ?? crypto.randomUUID();
        await this.db.insertInto('terrain_edits').values({
            id,
            site_id: input.siteId,
            op: input.op,
            params_json: JSON.stringify(input.params),
            rings_json: JSON.stringify(input.rings),
            enabled: input.enabled === false ? 0 : 1,
            origin: input.origin ?? null,
            origin_ref: input.originRef ?? null,
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
