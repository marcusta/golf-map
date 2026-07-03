import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, PinsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface Pin {
    id: string;
    greenId: string;
    name: string;
    lat: number;
    lon: number;
    difficulty: string | null;
    active: boolean;
    version: number;
}

// --- Row mapping ---

type PinRow = Selectable<PinsTable>;

function toPin(row: PinRow): Pin {
    return {
        id: row.id,
        greenId: row.green_id,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        difficulty: row.difficulty,
        active: row.active === 1,
        version: row.version,
    };
}

export class PinsService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private pins() {
        return this.db.selectFrom('pins').selectAll();
    }

    private byId(id: string) {
        return this.pins().where('id', '=', id);
    }

    private byGreen(greenId: string) {
        return this.pins().where('green_id', '=', greenId);
    }

    private byCourse(courseId: string) {
        return this.db
            .selectFrom('pins')
            .innerJoin('greens', 'greens.id', 'pins.green_id')
            .innerJoin('holes', 'holes.id', 'greens.hole_id')
            .where('holes.course_id', '=', courseId)
            .select([
                'pins.id', 'pins.green_id', 'pins.name', 'pins.lat', 'pins.lon',
                'pins.difficulty', 'pins.active', 'pins.version',
                'pins.created_at', 'pins.updated_at',
            ]);
    }

    // --- Queries (write) ---

    private insertPin(values: {
        id: string; green_id: string; name: string; lat: number; lon: number;
        difficulty: string | null; active: number; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('pins').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('pins').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('pins').where('id', '=', id);
    }

    // --- Methods ---

    async listByGreen(greenId: string): Promise<Pin[]> {
        const rows = await this.byGreen(greenId).orderBy('name').execute();
        return rows.map(toPin);
    }

    async listByCourse(courseId: string): Promise<Pin[]> {
        const rows = await this.byCourse(courseId).orderBy('pins.name').execute();
        return rows.map((r) => toPin(r as PinRow));
    }

    async create(input: {
        greenId: string; name: string; lat: number; lon: number; difficulty?: string;
    }): Promise<Pin> {
        const id = crypto.randomUUID();
        await this.insertPin({
            id,
            green_id: input.greenId,
            name: input.name,
            lat: input.lat,
            lon: input.lon,
            difficulty: input.difficulty ?? null,
            active: 0,
        }).execute();

        return {
            id,
            greenId: input.greenId,
            name: input.name,
            lat: input.lat,
            lon: input.lon,
            difficulty: input.difficulty ?? null,
            active: false,
            version: 1,
        };
    }

    async update(id: string, version: number, input: {
        name?: string; lat?: number; lon?: number; difficulty?: string;
    }): Promise<Pin> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Pin not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('pins', id);

        const dbInput: Record<string, unknown> = {};
        if (input.name !== undefined) dbInput.name = input.name;
        if (input.lat !== undefined) dbInput.lat = input.lat;
        if (input.lon !== undefined) dbInput.lon = input.lon;
        if (input.difficulty !== undefined) dbInput.difficulty = input.difficulty;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toPin(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Pin not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('pins', id);
        await this.deleteById(id).execute();
    }

    async setActive(id: string, version: number): Promise<Pin> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Pin not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('pins', id);

        await this.db.transaction().execute(async (trx) => {
            await this.updateById(id, trx)
                .set({ active: 1, version: version + 1, updated_at: sql`(datetime('now'))` })
                .execute();
            await trx.updateTable('pins')
                .where('green_id', '=', row.green_id)
                .where('id', '!=', id)
                .set({ active: 0, updated_at: sql`(datetime('now'))` })
                .execute();
        });

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toPin(updated);
    }
}
