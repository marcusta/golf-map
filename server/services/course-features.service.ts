import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CourseFeaturesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
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

// --- Output types ---

export interface CourseFeature {
    id: string;
    courseId: string;
    holeId: string | null;
    type: string;
    geometry: FeatureGeometry;
    geojson: GeoJsonPolygon | null;
    version: number;
}

export interface CourseFeatureGeoJsonFeature {
    type: 'Feature';
    id: string;
    properties: { courseId: string; holeId: string | null; type: string };
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
            .orderBy('created_at');
    }

    private byHole(holeId: string) {
        return this.db
            .selectFrom('course_features')
            .selectAll()
            .where('hole_id', '=', holeId)
            .orderBy('created_at');
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

    async geojsonByCourse(courseId: string): Promise<CourseFeatureFeatureCollection> {
        const rows = await this.byCourse(courseId).execute();
        const features: CourseFeatureGeoJsonFeature[] = [];
        for (const row of rows) {
            const feature = toCourseFeatureSafe(row);
            if (!feature) continue;
            const geojson = feature.geojson ?? toGeoJson(feature.geometry);
            features.push({
                type: 'Feature',
                id: feature.id,
                properties: { courseId: feature.courseId, holeId: feature.holeId, type: feature.type },
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
        const geojson = toGeoJson(input.geometry);

        await this.insertFeature({
            id,
            course_id: input.courseId,
            hole_id: input.holeId ?? null,
            type: input.type,
            geometry_json: JSON.stringify(input.geometry),
            geojson: JSON.stringify(geojson),
        }).execute();

        return {
            id,
            courseId: input.courseId,
            holeId: input.holeId ?? null,
            type: input.type,
            geometry: input.geometry,
            geojson,
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
}
