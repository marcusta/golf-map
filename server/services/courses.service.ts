import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CoursesTable } from '../db/schema';
import type { Page } from '@basics/core/server/paginate';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface CourseSummary {
    id: string;
    name: string;
    status: string;
    revision: number;
    homeLat: number | null;
    homeLon: number | null;
    holeCount: number;
    updatedAt: string;
}

export interface Course {
    id: string;
    name: string;
    status: string;
    revision: number;
    crs: string;
    georeferenceJson: string | null;
    homeLat: number | null;
    homeLon: number | null;
    notes: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type CourseRow = Selectable<CoursesTable>;
type CourseSummaryRow = CourseRow & { hole_count: number | string | bigint };

function toCourse(row: CourseRow): Course {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        revision: row.revision,
        crs: row.crs,
        georeferenceJson: row.georeference_json,
        homeLat: row.home_lat,
        homeLon: row.home_lon,
        notes: row.notes,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toCourseSummary(row: CourseSummaryRow): CourseSummary {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        revision: row.revision,
        homeLat: row.home_lat,
        homeLon: row.home_lon,
        holeCount: Number(row.hole_count),
        updatedAt: row.updated_at,
    };
}

export class CoursesService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private courses() {
        return this.db.selectFrom('courses').selectAll();
    }

    private byId(id: string) {
        return this.courses().where('id', '=', id);
    }

    private summaries() {
        return this.db
            .selectFrom('courses')
            .leftJoin('holes', 'holes.course_id', 'courses.id')
            .select([
                'courses.id', 'courses.name', 'courses.status', 'courses.revision',
                'courses.crs', 'courses.georeference_json', 'courses.home_lat', 'courses.home_lon',
                'courses.notes', 'courses.version', 'courses.created_at', 'courses.updated_at',
                (eb) => eb.fn.count('holes.id').as('hole_count'),
            ])
            .groupBy([
                'courses.id', 'courses.name', 'courses.status', 'courses.revision',
                'courses.crs', 'courses.georeference_json', 'courses.home_lat', 'courses.home_lon',
                'courses.notes', 'courses.version', 'courses.created_at', 'courses.updated_at',
            ])
            .orderBy('courses.name');
    }

    private countAll() {
        return this.db.selectFrom('courses').select((eb) => eb.fn.countAll().as('count'));
    }

    // --- Queries (write) ---

    private insertCourse(values: {
        id: string; name: string; status: string; revision: number; crs: string;
        georeference_json: string | null; home_lat: number | null; home_lon: number | null;
        notes: string | null; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('courses').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('courses').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('courses').where('id', '=', id);
    }

    // --- Methods ---

    async list(offset = 0, limit = 20): Promise<Page<CourseSummary>> {
        const [rows, countRow] = await Promise.all([
            this.summaries().offset(offset).limit(limit).execute(),
            this.countAll().executeTakeFirstOrThrow(),
        ]);
        return { items: rows.map((r) => toCourseSummary(r as CourseSummaryRow)), total: Number(countRow.count) };
    }

    async get(id: string): Promise<Course> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${id} not found`);
        return toCourse(row);
    }

    async create(input: {
        name: string;
        crs?: string;
        georeferenceJson?: string;
        homeLat?: number;
        homeLon?: number;
        notes?: string;
    }): Promise<Course> {
        const id = crypto.randomUUID();
        const values = {
            id,
            name: input.name,
            status: 'draft',
            revision: 0,
            crs: input.crs ?? 'EPSG:3006',
            georeference_json: input.georeferenceJson ?? null,
            home_lat: input.homeLat ?? null,
            home_lon: input.homeLon ?? null,
            notes: input.notes ?? null,
        };
        await this.insertCourse(values).execute();
        return this.get(id);
    }

    async update(id: string, version: number, patch: {
        name?: string;
        crs?: string;
        georeferenceJson?: string;
        homeLat?: number;
        homeLon?: number;
        notes?: string;
    }): Promise<Course> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('courses', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.name !== undefined) dbInput.name = patch.name;
        if (patch.crs !== undefined) dbInput.crs = patch.crs;
        if (patch.georeferenceJson !== undefined) dbInput.georeference_json = patch.georeferenceJson;
        if (patch.homeLat !== undefined) dbInput.home_lat = patch.homeLat;
        if (patch.homeLon !== undefined) dbInput.home_lon = patch.homeLon;
        if (patch.notes !== undefined) dbInput.notes = patch.notes;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        return this.get(id);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('courses', id);
        await this.deleteById(id).execute();
    }

    async publish(id: string, version: number): Promise<Course> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('courses', id);

        await this.updateById(id).set({
            status: 'published',
            revision: row.revision + 1,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        return this.get(id);
    }
}
