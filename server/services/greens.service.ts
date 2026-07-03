import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, GreensTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface Green {
    id: string;
    holeId: string;
    boundaryJson: string | null;
    centerLat: number;
    centerLon: number;
    frontLat: number | null;
    frontLon: number | null;
    backLat: number | null;
    backLon: number | null;
    elevation: number | null;
    version: number;
}

// --- Row mapping ---

type GreenRow = Selectable<GreensTable>;

function toGreen(row: GreenRow): Green {
    return {
        id: row.id,
        holeId: row.hole_id,
        boundaryJson: row.boundary_json,
        centerLat: row.center_lat,
        centerLon: row.center_lon,
        frontLat: row.front_lat,
        frontLon: row.front_lon,
        backLat: row.back_lat,
        backLon: row.back_lon,
        elevation: row.elevation,
        version: row.version,
    };
}

export class GreensService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private greens() {
        return this.db.selectFrom('greens').selectAll();
    }

    private byId(id: string) {
        return this.greens().where('id', '=', id);
    }

    private byHole(holeId: string) {
        return this.greens().where('hole_id', '=', holeId);
    }

    // --- Queries (write) ---

    private insertGreen(values: {
        id: string; hole_id: string; boundary_json: string | null;
        center_lat: number; center_lon: number;
        front_lat: number | null; front_lon: number | null;
        back_lat: number | null; back_lon: number | null;
        elevation: number | null; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('greens').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('greens').where('id', '=', id);
    }

    // --- Methods ---

    async getByHole(holeId: string): Promise<Green | null> {
        const row = await this.byHole(holeId).executeTakeFirst();
        return row ? toGreen(row) : null;
    }

    async create(input: {
        holeId: string;
        centerLat: number; centerLon: number;
        frontLat?: number; frontLon?: number;
        backLat?: number; backLon?: number;
        elevation?: number; boundaryJson?: string;
    }): Promise<Green> {
        const id = crypto.randomUUID();
        await this.insertGreen({
            id,
            hole_id: input.holeId,
            boundary_json: input.boundaryJson ?? null,
            center_lat: input.centerLat,
            center_lon: input.centerLon,
            front_lat: input.frontLat ?? null,
            front_lon: input.frontLon ?? null,
            back_lat: input.backLat ?? null,
            back_lon: input.backLon ?? null,
            elevation: input.elevation ?? null,
        }).execute();

        return {
            id,
            holeId: input.holeId,
            boundaryJson: input.boundaryJson ?? null,
            centerLat: input.centerLat,
            centerLon: input.centerLon,
            frontLat: input.frontLat ?? null,
            frontLon: input.frontLon ?? null,
            backLat: input.backLat ?? null,
            backLon: input.backLon ?? null,
            elevation: input.elevation ?? null,
            version: 1,
        };
    }

    async update(id: string, version: number, input: {
        centerLat?: number; centerLon?: number;
        frontLat?: number; frontLon?: number;
        backLat?: number; backLon?: number;
        elevation?: number; boundaryJson?: string;
    }): Promise<Green> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Green not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('greens', id);

        const dbInput: Record<string, unknown> = {};
        if (input.centerLat !== undefined) dbInput.center_lat = input.centerLat;
        if (input.centerLon !== undefined) dbInput.center_lon = input.centerLon;
        if (input.frontLat !== undefined) dbInput.front_lat = input.frontLat;
        if (input.frontLon !== undefined) dbInput.front_lon = input.frontLon;
        if (input.backLat !== undefined) dbInput.back_lat = input.backLat;
        if (input.backLon !== undefined) dbInput.back_lon = input.backLon;
        if (input.elevation !== undefined) dbInput.elevation = input.elevation;
        if (input.boundaryJson !== undefined) dbInput.boundary_json = input.boundaryJson;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toGreen(updated);
    }
}
