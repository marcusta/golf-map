import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CourseFeaturesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError } from '@basics/core/server/auth';
import { toGeoJson, type FeatureGeometry, type GeoJsonPolygon } from './geo';

// --- Constants ---

export const FEATURE_TYPES = [
    'tee',
    'fairway',
    'green',
    'bunker',
    'semi_rough',
    'rough',
    'deep_rough',
    'water',
    'water_creek',
    'path',
    'outside',
] as const;

export type FeatureType = (typeof FEATURE_TYPES)[number];

/**
 * Fixed golf z-ordering, bottom -> top (duplicated from web's
 * draw/feature-palette.ts — server and web keep independent copies, same as
 * FEATURE_TYPES above). Per D26 this survives ONLY as the insertion
 * heuristic for create(): where a brand-new feature lands in its group's
 * stack. It is no longer consulted at render/hit/lie time — sort_order is
 * truth there (D23).
 */
const TYPE_Z_ORDER: readonly string[] = [
    'outside',
    'deep_rough',
    'rough',
    'semi_rough',
    'fairway',
    'tee',
    'green',
    'bunker',
    'water',
    'water_creek',
    'path',
];

function typeRank(type: string): number {
    const idx = TYPE_Z_ORDER.indexOf(type);
    return idx === -1 ? 0 : idx;
}

/**
 * D26 insertion default: scan the group's stack (bottom -> top, i.e.
 * ascending sort_order) top -> bottom looking for the first existing
 * feature whose type rank is <= the new feature's rank, and insert directly
 * above it (one past its index). If none qualifies, insert at the bottom
 * (index 0).
 */
function insertionPosition(groupStack: readonly { type: string }[], newType: string): number {
    const newRank = typeRank(newType);
    for (let i = groupStack.length - 1; i >= 0; i--) {
        if (typeRank(groupStack[i].type) <= newRank) return i + 1;
    }
    return 0;
}

// --- Output types ---

export interface CourseFeature {
    id: string;
    courseId: string;
    holeId: string | null;
    type: string;
    geometry: FeatureGeometry;
    geojson: GeoJsonPolygon | null;
    sortOrder: number;
    version: number;
}

export interface CourseFeatureGeoJsonFeature {
    type: 'Feature';
    id: string;
    properties: { courseId: string; holeId: string | null; type: string; sortOrder: number; stackKey: number };
    geometry: GeoJsonPolygon;
}

export interface CourseFeatureFeatureCollection {
    type: 'FeatureCollection';
    features: CourseFeatureGeoJsonFeature[];
}

// --- Row mapping ---

type FeatureRow = Selectable<CourseFeaturesTable>;

function toCourseFeature(row: FeatureRow): CourseFeature {
    return {
        id: row.id,
        courseId: row.course_id,
        holeId: row.hole_id,
        type: row.type,
        geometry: JSON.parse(row.geometry_json) as FeatureGeometry,
        geojson: row.geojson ? (JSON.parse(row.geojson) as GeoJsonPolygon) : null,
        sortOrder: row.sort_order,
        version: row.version,
    };
}

// --- Validation ---

export class InvalidFeatureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidFeatureError';
    }
}

function assertValidType(type: string): void {
    if (!(FEATURE_TYPES as readonly string[]).includes(type)) {
        throw new InvalidFeatureError(`Invalid feature type: ${type}`);
    }
}

function assertValidGeometry(geometry: FeatureGeometry): void {
    if (!geometry || typeof geometry !== 'object') {
        throw new InvalidFeatureError('Geometry must be an object');
    }
    if (typeof geometry.crs !== 'string' || geometry.crs.length === 0) {
        throw new InvalidFeatureError('Geometry must specify a crs');
    }
    if (geometry.curveType !== undefined && geometry.curveType !== 'bezier' && geometry.curveType !== 'bspline') {
        throw new InvalidFeatureError(`Invalid curveType: ${String(geometry.curveType)}`);
    }
    if (!Array.isArray(geometry.rings) || geometry.rings.length === 0) {
        throw new InvalidFeatureError('Geometry must have at least one ring');
    }
    for (const ring of geometry.rings) {
        if (!ring || !Array.isArray(ring.points)) {
            throw new InvalidFeatureError('Each ring must have a points array');
        }
        if (ring.points.length < 3) {
            throw new InvalidFeatureError('Each ring must have at least 3 points');
        }
        for (const p of ring.points) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                throw new InvalidFeatureError('Ring points must have finite x/y coordinates');
            }
            for (const handle of [p.hIn, p.hOut]) {
                if (handle && (!Number.isFinite(handle.x) || !Number.isFinite(handle.y))) {
                    throw new InvalidFeatureError('Bezier handles must have finite x/y coordinates');
                }
            }
        }
    }
}

// --- Geometry parsing (defensive: tolerates legacy/malformed rows) ---

function parseGeometry(raw: string): FeatureGeometry | null {
    try {
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.crs === 'string' &&
            Array.isArray(parsed.rings)
        ) {
            return parsed as FeatureGeometry;
        }
        return null;
    } catch {
        return null;
    }
}

function toCourseFeatureSafe(row: FeatureRow): CourseFeature | null {
    const geometry = parseGeometry(row.geometry_json);
    if (!geometry) return null;
    return {
        id: row.id,
        courseId: row.course_id,
        holeId: row.hole_id,
        type: row.type,
        geometry,
        geojson: row.geojson ? (JSON.parse(row.geojson) as GeoJsonPolygon) : null,
        sortOrder: row.sort_order,
        version: row.version,
    };
}

export class CourseFeaturesService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private byCourse(courseId: string) {
        return this.db
            .selectFrom('course_features')
            .selectAll()
            .where('course_id', '=', courseId)
            .orderBy('sort_order');
    }

    private byHole(holeId: string) {
        return this.db
            .selectFrom('course_features')
            .selectAll()
            .where('hole_id', '=', holeId)
            .orderBy('sort_order');
    }

    /** The stack for one group (course_id, hole_id|null), bottom -> top. */
    private byGroup(courseId: string, holeId: string | null, trx: Kysely<Database> = this.db) {
        let query = trx
            .selectFrom('course_features')
            .select(['id', 'type', 'sort_order'])
            .where('course_id', '=', courseId);
        query = holeId === null ? query.where('hole_id', 'is', null) : query.where('hole_id', '=', holeId);
        return query.orderBy('sort_order');
    }

    private byId(id: string) {
        return this.db.selectFrom('course_features').selectAll().where('id', '=', id);
    }

    // --- Queries (write) ---

    private insertFeature(
        values: {
            id: string;
            course_id: string;
            hole_id: string | null;
            type: string;
            geometry_json: string;
            geojson: string | null;
            sort_order: number;
            version?: number;
        },
        trx: Kysely<Database> = this.db,
    ) {
        return trx.insertInto('course_features').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('course_features').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('course_features').where('id', '=', id);
    }

    // --- Methods ---

    /**
     * Lists all features for a course. Rows whose geometry_json doesn't
     * match the current FeatureGeometry shape (e.g. legacy/pre-migration
     * data) are skipped rather than throwing, since listing must not break
     * because of one malformed row.
     */
    async listByCourse(courseId: string): Promise<CourseFeature[]> {
        const rows = await this.byCourse(courseId).execute();
        return rows.map(toCourseFeatureSafe).filter((f): f is CourseFeature => f !== null);
    }

    async listByHole(holeId: string): Promise<CourseFeature[]> {
        const rows = await this.byHole(holeId).execute();
        return rows.map(toCourseFeatureSafe).filter((f): f is CourseFeature => f !== null);
    }

    async findById(id: string): Promise<CourseFeature> {
        const row = await this.byId(id).executeTakeFirstOrThrow();
        return toCourseFeature(row);
    }

    /**
     * D24 global composition order: course-level group at the bottom, then
     * hole groups ascending by hole number, each internally by sort_order.
     * `stackKey = groupRank * 4096 + sortOrder`, groupRank 0 = course-level.
     */
    async geojsonByCourse(courseId: string): Promise<CourseFeatureFeatureCollection> {
        const rows = await this.db
            .selectFrom('course_features')
            .leftJoin('holes', 'holes.id', 'course_features.hole_id')
            .where('course_features.course_id', '=', courseId)
            .select([
                'course_features.id',
                'course_features.course_id',
                'course_features.hole_id',
                'course_features.type',
                'course_features.geometry_json',
                'course_features.geojson',
                'course_features.sort_order',
                'course_features.version',
                'holes.number as hole_number',
            ])
            .orderBy('course_features.sort_order')
            .execute();

        const features: CourseFeatureGeoJsonFeature[] = [];
        for (const row of rows) {
            const feature = toCourseFeatureSafe(row as unknown as FeatureRow);
            if (!feature) continue;
            const geojson = feature.geojson ?? toGeoJson(feature.geometry);
            const groupRank = row.hole_number ?? 0;
            const stackKey = groupRank * 4096 + feature.sortOrder;
            features.push({
                type: 'Feature',
                id: feature.id,
                properties: {
                    courseId: feature.courseId,
                    holeId: feature.holeId,
                    type: feature.type,
                    sortOrder: feature.sortOrder,
                    stackKey,
                },
                geometry: geojson,
            });
        }
        return { type: 'FeatureCollection', features };
    }

    async create(input: {
        courseId: string;
        holeId?: string | null;
        type: string;
        geometry: FeatureGeometry;
    }): Promise<CourseFeature> {
        assertValidType(input.type);
        assertValidGeometry(input.geometry);

        const id = crypto.randomUUID();
        const holeId = input.holeId ?? null;
        const geojson = toGeoJson(input.geometry);

        const sortOrder = await this.db.transaction().execute(async (trx) => {
            const groupStack = await this.byGroup(input.courseId, holeId, trx).execute();
            const pos = insertionPosition(groupStack, input.type);

            for (const row of groupStack) {
                if (row.sort_order >= pos) {
                    await this.updateById(row.id, trx)
                        .set({ sort_order: row.sort_order + 1, updated_at: sql`(datetime('now'))` })
                        .execute();
                }
            }

            await this.insertFeature(
                {
                    id,
                    course_id: input.courseId,
                    hole_id: holeId,
                    type: input.type,
                    geometry_json: JSON.stringify(input.geometry),
                    geojson: JSON.stringify(geojson),
                    sort_order: pos,
                },
                trx,
            ).execute();

            return pos;
        });

        return {
            id,
            courseId: input.courseId,
            holeId,
            type: input.type,
            geometry: input.geometry,
            geojson,
            sortOrder,
            version: 1,
        };
    }

    async update(
        id: string,
        version: number,
        input: { holeId?: string | null; type?: string; geometry?: FeatureGeometry },
    ): Promise<CourseFeature> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('course_features', id);

        if (input.type !== undefined) assertValidType(input.type);
        if (input.geometry !== undefined) assertValidGeometry(input.geometry);

        const dbInput: Record<string, unknown> = {};
        if (input.holeId !== undefined) dbInput.hole_id = input.holeId;
        if (input.type !== undefined) dbInput.type = input.type;
        if (input.geometry !== undefined) {
            dbInput.geometry_json = JSON.stringify(input.geometry);
            dbInput.geojson = JSON.stringify(toGeoJson(input.geometry));
        }

        await this.updateById(id)
            .set({
                ...dbInput,
                version: version + 1,
                updated_at: sql`(datetime('now'))`,
            })
            .execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toCourseFeature(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('course_features', id);
        await this.deleteById(id).execute();
    }

    /**
     * Rewrites a group's (course_id, hole_id|null) stack order in one shot
     * (house pattern — see tees.service.ts reorder / game-plans.service.ts
     * reorderShots). orderedIds must be exactly the group's current
     * members, bottom -> top.
     */
    async reorder(courseId: string, holeId: string | null, orderedIds: string[]): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            const existing = await this.byGroup(courseId, holeId, trx).execute();

            const existingIds = new Set(existing.map((row) => row.id));
            const incomingIds = new Set(orderedIds);
            const sameSize = existingIds.size === incomingIds.size;
            const sameMembers = sameSize && orderedIds.every((id) => existingIds.has(id));
            if (!sameSize || !sameMembers) {
                throw new ConflictError(
                    `orderedIds must exactly match the features in scope (course ${courseId}, hole ${holeId ?? 'course-level'})`,
                );
            }

            for (let i = 0; i < orderedIds.length; i++) {
                await this.updateById(orderedIds[i], trx)
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .execute();
            }
        });
    }
}
