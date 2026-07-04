import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, HolesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';
import { UniqueViolationError, parseUniqueViolation } from '@basics/core/server/unique-violation';

// --- Output types ---

export interface Hole {
    id: string;
    courseId: string;
    number: number;
    par: number;
    strokeIndex: number | null;
    notes: string | null;
    savedRegionJson: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type HoleRow = Selectable<HolesTable>;

function toHole(row: HoleRow): Hole {
    return {
        id: row.id,
        courseId: row.course_id,
        number: row.number,
        par: row.par,
        strokeIndex: row.stroke_index,
        notes: row.notes,
        savedRegionJson: row.saved_region_json,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class HolesService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private holes() {
        return this.db.selectFrom('holes').selectAll();
    }

    private byId(id: string) {
        return this.holes().where('id', '=', id);
    }

    private byCourseOrderedByNumber(courseId: string) {
        return this.holes().where('course_id', '=', courseId).orderBy('number');
    }

    // --- Queries (write) ---

    private insertHole(values: {
        id: string; course_id: string; number: number; par: number;
        notes: string | null; saved_region_json: string | null; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('holes').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('holes').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('holes').where('id', '=', id);
    }

    // --- Methods ---

    async listByCourse(courseId: string): Promise<Hole[]> {
        const rows = await this.byCourseOrderedByNumber(courseId).execute();
        return rows.map(toHole);
    }

    async get(id: string): Promise<Hole> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Hole ${id} not found`);
        return toHole(row);
    }

    async create(input: {
        courseId: string;
        number: number;
        par: number;
        notes?: string;
        savedRegionJson?: string;
    }): Promise<Hole> {
        const id = crypto.randomUUID();
        try {
            await this.insertHole({
                id,
                course_id: input.courseId,
                number: input.number,
                par: input.par,
                notes: input.notes ?? null,
                saved_region_json: input.savedRegionJson ?? null,
            }).execute();
        } catch (err) {
            if (err instanceof UniqueViolationError) throw err;
            const uv = parseUniqueViolation(err);
            if (uv) throw uv;
            throw err;
        }
        return this.get(id);
    }

    async update(id: string, version: number, patch: {
        par?: number;
        strokeIndex?: number | null;
        notes?: string;
        savedRegionJson?: string;
    }): Promise<Hole> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Hole ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('holes', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.par !== undefined) dbInput.par = patch.par;
        if (patch.strokeIndex !== undefined) dbInput.stroke_index = patch.strokeIndex;
        if (patch.notes !== undefined) dbInput.notes = patch.notes;
        if (patch.savedRegionJson !== undefined) dbInput.saved_region_json = patch.savedRegionJson;

        try {
            await this.updateById(id).set({
                ...dbInput,
                version: version + 1,
                updated_at: sql`(datetime('now'))`,
            }).execute();
        } catch (err) {
            if (err instanceof UniqueViolationError) throw err;
            const uv = parseUniqueViolation(err);
            if (uv) throw uv;
            throw err;
        }

        return this.get(id);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Hole ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('holes', id);
        await this.deleteById(id).execute();
    }
}
