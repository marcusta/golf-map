import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CoursesTable } from '../db/schema';
import type { Page } from '@basics/core/server/paginate';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';
import { haversineMeters } from './geo';

// --- Output types ---

/** One hole's routing (tee -> green) for a schematic mini-map thumbnail. */
export interface RoutingHole {
    hole: number;
    tee: [number, number]; // [lat, lon]
    green: [number, number]; // [lat, lon]
}

export interface CourseSummary {
    id: string;
    name: string;
    status: string;
    revision: number;
    siteId: string | null;
    homeLat: number | null;
    homeLon: number | null;
    holeCount: number;
    updatedAt: string;
    parTotal: number;
    lengthM: number;
    mappedHoleCount: number;
    siteName: string | null;
    routing: RoutingHole[];
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
    siteId: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type CourseRow = Selectable<CoursesTable>;
type CourseSummaryRow = CourseRow & {
    hole_count: number | string | bigint;
    par_total: number | string | bigint;
    mapped_hole_count: number | string | bigint;
    site_name: string | null;
};

/** Per-hole primary tee / green center, keyed by hole id, for length + routing assembly. */
interface HoleGeometry {
    lengthM: number;
    routing: RoutingHole[];
}

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
        siteId: row.site_id,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toCourseSummary(row: CourseSummaryRow, geometry: HoleGeometry): CourseSummary {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        revision: row.revision,
        siteId: row.site_id,
        homeLat: row.home_lat,
        homeLon: row.home_lon,
        holeCount: Number(row.hole_count),
        updatedAt: row.updated_at,
        parTotal: Number(row.par_total),
        lengthM: geometry.lengthM,
        mappedHoleCount: Number(row.mapped_hole_count),
        siteName: row.site_name,
        routing: geometry.routing,
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
            .leftJoin('sites', 'sites.id', 'courses.site_id')
            .select([
                'courses.id', 'courses.name', 'courses.status', 'courses.revision',
                'courses.crs', 'courses.georeference_json', 'courses.home_lat', 'courses.home_lon',
                'courses.notes', 'courses.site_id', 'courses.version', 'courses.created_at', 'courses.updated_at',
                'sites.name as site_name',
                (eb) => eb
                    .selectFrom('holes')
                    .select((eb2) => eb2.fn.countAll().as('count'))
                    .whereRef('holes.course_id', '=', 'courses.id')
                    .as('hole_count'),
                (eb) => eb
                    .selectFrom('holes')
                    .select((eb2) => eb2.fn.coalesce(eb2.fn.sum('holes.par'), eb2.val(0)).as('sum'))
                    .whereRef('holes.course_id', '=', 'courses.id')
                    .as('par_total'),
                (eb) => eb
                    .selectFrom('course_features')
                    .select((eb2) => eb2.fn.count('course_features.hole_id').distinct().as('count'))
                    .whereRef('course_features.course_id', '=', 'courses.id')
                    .where('course_features.hole_id', 'is not', null)
                    .as('mapped_hole_count'),
            ])
            .orderBy('courses.name');
    }

    private countAll() {
        return this.db.selectFrom('courses').select((eb) => eb.fn.countAll().as('count'));
    }

    /**
     * Batch-loads, per course, the total tee->green length and per-hole
     * routing (primary tee = lowest sort_order, tie-broken by id; primary
     * green = first by id) for a page of course ids. Holes missing a tee
     * or green contribute 0 to length and are omitted from routing.
     */
    private async loadHoleGeometry(courseIds: string[]): Promise<Map<string, HoleGeometry>> {
        const result = new Map<string, HoleGeometry>();
        for (const courseId of courseIds) result.set(courseId, { lengthM: 0, routing: [] });
        if (courseIds.length === 0) return result;

        const holes = await this.db
            .selectFrom('holes')
            .select(['id', 'course_id', 'number'])
            .where('course_id', 'in', courseIds)
            .orderBy('course_id')
            .orderBy('number')
            .execute();
        if (holes.length === 0) return result;

        const holeIds = holes.map((h) => h.id);
        const [tees, greens] = await Promise.all([
            this.db
                .selectFrom('tees')
                .select(['hole_id', 'lat', 'lon'])
                .where('hole_id', 'in', holeIds)
                .orderBy('hole_id')
                .orderBy('sort_order')
                .orderBy('id')
                .execute(),
            this.db
                .selectFrom('greens')
                .select(['hole_id', 'center_lat', 'center_lon'])
                .where('hole_id', 'in', holeIds)
                .orderBy('hole_id')
                .orderBy('id')
                .execute(),
        ]);

        const primaryTeeByHole = new Map<string, { lat: number; lon: number }>();
        for (const t of tees) if (!primaryTeeByHole.has(t.hole_id)) primaryTeeByHole.set(t.hole_id, { lat: t.lat, lon: t.lon });

        const primaryGreenByHole = new Map<string, { lat: number; lon: number }>();
        for (const g of greens) if (!primaryGreenByHole.has(g.hole_id)) primaryGreenByHole.set(g.hole_id, { lat: g.center_lat, lon: g.center_lon });

        for (const hole of holes) {
            const tee = primaryTeeByHole.get(hole.id);
            const green = primaryGreenByHole.get(hole.id);
            if (!tee || !green) continue;
            const entry = result.get(hole.course_id);
            if (!entry) continue;
            entry.lengthM += haversineMeters(tee, green);
            entry.routing.push({ hole: hole.number, tee: [tee.lat, tee.lon], green: [green.lat, green.lon] });
        }

        return result;
    }

    // --- Queries (write) ---

    private insertCourse(values: {
        id: string; name: string; status: string; revision: number; crs: string;
        georeference_json: string | null; home_lat: number | null; home_lon: number | null;
        notes: string | null; site_id: string | null; version?: number;
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
        const geometryByCourse = await this.loadHoleGeometry(rows.map((r) => r.id));
        const items = rows.map((r) => {
            const row = r as CourseSummaryRow;
            return toCourseSummary(row, geometryByCourse.get(row.id) ?? { lengthM: 0, routing: [] });
        });
        return { items, total: Number(countRow.count) };
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
        siteId?: string;
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
            site_id: input.siteId ?? null,
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
        siteId?: string | null;
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
        if (patch.siteId !== undefined) dbInput.site_id = patch.siteId;
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
