import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, TeesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface Tee {
    id: string;
    holeId: string;
    name: string;
    color: string | null;
    lat: number;
    lon: number;
    elevation: number | null;
    sortOrder: number;
    version: number;
}

// --- Row mapping ---

type TeeRow = Selectable<TeesTable>;

function toTee(row: TeeRow): Tee {
    return {
        id: row.id,
        holeId: row.hole_id,
        name: row.name,
        color: row.color,
        lat: row.lat,
        lon: row.lon,
        elevation: row.elevation,
        sortOrder: row.sort_order,
        version: row.version,
    };
}

export class TeesService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private tees() {
        return this.db.selectFrom('tees').selectAll();
    }

    private byId(id: string) {
        return this.tees().where('id', '=', id);
    }

    private byHole(holeId: string) {
        return this.tees().where('hole_id', '=', holeId);
    }

    private byCourse(courseId: string) {
        return this.db
            .selectFrom('tees')
            .innerJoin('holes', 'holes.id', 'tees.hole_id')
            .where('holes.course_id', '=', courseId)
            .select([
                'tees.id', 'tees.hole_id', 'tees.name', 'tees.color',
                'tees.lat', 'tees.lon', 'tees.elevation', 'tees.sort_order',
                'tees.version', 'tees.created_at', 'tees.updated_at',
            ]);
    }

    // --- Queries (write) ---

    private insertTee(values: {
        id: string; hole_id: string; name: string; color: string | null;
        lat: number; lon: number; elevation: number | null; sort_order: number;
        version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('tees').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('tees').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('tees').where('id', '=', id);
    }

    // --- Methods ---

    async listByHole(holeId: string): Promise<Tee[]> {
        const rows = await this.byHole(holeId).orderBy('sort_order').execute();
        return rows.map(toTee);
    }

    async listByCourse(courseId: string): Promise<Tee[]> {
        const rows = await this.byCourse(courseId).orderBy('tees.sort_order').execute();
        return rows.map((r) => toTee(r as TeeRow));
    }

    async create(input: {
        holeId: string; name: string; color?: string; lat: number; lon: number; elevation?: number;
    }): Promise<Tee> {
        const id = crypto.randomUUID();
        const maxRow = await this.db
            .selectFrom('tees')
            .select((eb) => eb.fn.max('sort_order').as('max_order'))
            .where('hole_id', '=', input.holeId)
            .executeTakeFirst();
        const sortOrder = maxRow?.max_order != null ? Number(maxRow.max_order) + 1 : 0;

        await this.insertTee({
            id,
            hole_id: input.holeId,
            name: input.name,
            color: input.color ?? null,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            sort_order: sortOrder,
        }).execute();

        return {
            id,
            holeId: input.holeId,
            name: input.name,
            color: input.color ?? null,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            sortOrder,
            version: 1,
        };
    }

    async update(id: string, version: number, input: {
        name?: string; color?: string; lat?: number; lon?: number; elevation?: number;
    }): Promise<Tee> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Tee not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('tees', id);

        const dbInput: Record<string, unknown> = {};
        if (input.name !== undefined) dbInput.name = input.name;
        if (input.color !== undefined) dbInput.color = input.color;
        if (input.lat !== undefined) dbInput.lat = input.lat;
        if (input.lon !== undefined) dbInput.lon = input.lon;
        if (input.elevation !== undefined) dbInput.elevation = input.elevation;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toTee(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Tee not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('tees', id);
        await this.deleteById(id).execute();
    }

    async reorder(holeId: string, orderedIds: string[]): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            for (let i = 0; i < orderedIds.length; i++) {
                await this.updateById(orderedIds[i], trx)
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .where('hole_id', '=', holeId)
                    .execute();
            }
        });
    }
}
