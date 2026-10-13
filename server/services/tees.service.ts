import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, TeesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface Tee {
    id: string;
    holeId: string;
    /** The course tee set it belongs to; null for one written without a set and not adopted yet. */
    teeSetId: string | null;
    name: string;
    color: string | null;
    /** Its set exists for GSPro alone: the course guide leaves the tee out. */
    gsproOnly: boolean;
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
        teeSetId: row.tee_set_id,
        name: row.name,
        color: row.color,
        gsproOnly: row.gspro_only === 1,
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
                'tees.id', 'tees.hole_id', 'tees.tee_set_id', 'tees.name', 'tees.color', 'tees.gspro_only',
                'tees.lat', 'tees.lon', 'tees.elevation', 'tees.sort_order',
                'tees.version', 'tees.created_at', 'tees.updated_at',
            ]);
    }

    // --- Queries (write) ---

    private insertTee(values: {
        id: string; hole_id: string; tee_set_id: string | null; name: string; color: string | null;
        gspro_only: number; lat: number; lon: number; elevation: number | null; sort_order: number;
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

    /**
     * A tee set of the hole's course, for a tee's name and colour. 409 when
     * the set is another course's.
     */
    private async teeSetFor(holeId: string, teeSetId: string): Promise<{ id: string; name: string; color: string | null; gspro_only: number }> {
        const set = await this.db.selectFrom('course_tee_sets')
            .innerJoin('holes', 'holes.course_id', 'course_tee_sets.course_id')
            .select(['course_tee_sets.id', 'course_tee_sets.name', 'course_tee_sets.color', 'course_tee_sets.gspro_only'])
            .where('course_tee_sets.id', '=', teeSetId).where('holes.id', '=', holeId).executeTakeFirst();
        if (!set) throw new ConflictError(`Tee set ${teeSetId} is not one of this course's`);
        return set;
    }

    /**
     * Add a tee to a hole. With `teeSetId` it takes that set's name and
     * colour; without, the given `name`/`color` (and TeeSetsService adopts
     * it into the set of that name later).
     */
    async create(input: {
        holeId: string; teeSetId?: string; name?: string; color?: string; lat: number; lon: number; elevation?: number;
    }): Promise<Tee> {
        const set = input.teeSetId ? await this.teeSetFor(input.holeId, input.teeSetId) : null;
        const name = set?.name ?? input.name?.trim();
        if (!name) throw new ConflictError('A tee needs a tee set or a name');
        const color = set ? set.color : input.color ?? null;
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
            tee_set_id: set?.id ?? null,
            name,
            color,
            gspro_only: set?.gspro_only ?? 0,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            sort_order: sortOrder,
        }).execute();

        return {
            id,
            holeId: input.holeId,
            teeSetId: set?.id ?? null,
            name,
            color,
            gsproOnly: set?.gspro_only === 1,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            sortOrder,
            version: 1,
        };
    }

    async update(id: string, version: number, input: {
        teeSetId?: string; name?: string; color?: string; lat?: number; lon?: number; elevation?: number;
    }): Promise<Tee> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Tee not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('tees', id);

        const dbInput: Record<string, unknown> = {};
        if (input.teeSetId !== undefined) {
            // Moved to another of the course's sets: it takes that set's name, colour and GSPro-only mark.
            const set = await this.teeSetFor(row.hole_id, input.teeSetId);
            input = { ...input, name: set.name, color: set.color ?? undefined };
            dbInput.tee_set_id = set.id;
            dbInput.color = set.color;
            dbInput.gspro_only = set.gspro_only;
        }
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
