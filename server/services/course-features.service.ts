import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CourseFeaturesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { toGeoJson, type FeatureGeometry, type GeoJsonPolygon, type GeoJsonMultiPolygon } from './geo';
import { resolveSurfaceStack } from '../../shared/render/resolved-surface-stack';
import type { FeatureCollection } from 'geojson';

// --- Constants ---

export const FEATURE_TYPES = [
    'tee',
    'fairway',
    'green',
    'bunker',
    'semi_rough',
    'rough',
    'deep_rough',
    'trees',
    'water',
    'water_creek',
    'penalty_yellow',
    'penalty_red',
    'oob',
    'path',
    'outside',
] as const;

export type FeatureType = (typeof FEATURE_TYPES)[number];

/**
 * T49 course-level ODbL posture: a course containing ANY feature with
 * `license === 'ODbL'` (OSM-derived imports) is ODbL for its map data —
 * surfaced course-by-course with this attribution, never a publish blocker.
 */
export const ODBL_LICENSE = 'ODbL';
export const ODBL_ATTRIBUTION = '© OpenStreetMap contributors, ODbL';

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
    'trees',
    'bunker',
    'water',
    'water_creek',
    'penalty_yellow',
    'penalty_red',
    'oob',
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
 * above it (its sort_order + 1 — NOT its array index: remove() leaves
 * sort_order gaps, so index and sort_order can diverge). If none qualifies,
 * insert at the bottom (sort_order 0).
 */
function insertionPosition(groupStack: readonly { type: string; sort_order: number }[], newType: string): number {
    const newRank = typeRank(newType);
    for (let i = groupStack.length - 1; i >= 0; i--) {
        if (typeRank(groupStack[i].type) <= newRank) return groupStack[i].sort_order + 1;
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
    /** Import provenance (T49): producer id (e.g. 'osm'), null = hand-drawn. */
    source: string | null;
    /** Source-local ref (e.g. 'way/123456'). */
    sourceRef: string | null;
    /** License short name (e.g. 'ODbL'). */
    license: string | null;
    /**
     * Flat scalar attributes set by generators (e.g. lidar canopy: heightMaxM,
     * heightP90M, heightMeanM, areaM2). Null for hand-drawn features.
     */
    attributes: FeatureAttributes | null;
    version: number;
}

export type FeatureAttributes = Record<string, number | string | boolean>;

/** Upper bound on `attributes` keys; keeps the column a small flat object. */
export const MAX_ATTRIBUTE_KEYS = 32;

export interface CourseFeatureGeoJsonFeature {
    type: 'Feature';
    id: string;
    properties: {
        courseId: string;
        holeId: string | null;
        type: string;
        sortOrder: number;
        stackKey: number;
        source: string | null;
        sourceRef: string | null;
        license: string | null;
        attributes: FeatureAttributes | null;
    };
    /** MultiPolygon only in `resolved` output (clipping can split a polygon). */
    geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
}

export interface CourseFeatureFeatureCollection {
    type: 'FeatureCollection';
    features: CourseFeatureGeoJsonFeature[];
    /**
     * Present when any feature is ODbL-licensed (OSM-derived) so course
     * bundles carry the required attribution (T49). GeoJSON allows foreign
     * top-level members.
     */
    attribution?: string;
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
        source: row.source,
        sourceRef: row.source_ref,
        license: row.license,
        attributes: parseAttributes(row.attributes_json),
        version: row.version,
    };
}

function parseAttributes(raw: string | null): FeatureAttributes | null {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FeatureAttributes) : null;
    } catch {
        return null;
    }
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

function isScalar(v: unknown): v is number | string | boolean {
    return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * `attributes` must be a flat object of finite numbers, strings and booleans
 * with at most MAX_ATTRIBUTE_KEYS keys. `null`/`undefined` mean "none".
 */
function assertValidAttributes(attributes: unknown): void {
    if (attributes === null || attributes === undefined) return;
    if (typeof attributes !== 'object' || Array.isArray(attributes)) {
        throw new InvalidFeatureError('attributes must be a flat object or null');
    }
    const entries = Object.entries(attributes as Record<string, unknown>);
    if (entries.length > MAX_ATTRIBUTE_KEYS) {
        throw new InvalidFeatureError(`attributes may have at most ${MAX_ATTRIBUTE_KEYS} keys (got ${entries.length})`);
    }
    for (const [key, value] of entries) {
        if (!isScalar(value)) {
            throw new InvalidFeatureError(`attributes.${key} must be a finite number, string or boolean`);
        }
    }
}

function serializeAttributes(attributes: FeatureAttributes | null | undefined): string | null {
    if (attributes === null || attributes === undefined) return null;
    return JSON.stringify(attributes);
}

// --- Generated-feature GeoJSON input (EPSG:3006 FeatureCollection) ---

/**
 * Body of `PUT /api/courses/:courseId/features/generated?source=`. Coordinates
 * are [x, y] in EPSG:3006 metres. `crs` is optional; when present it must name
 * EPSG:3006 (`{type:'name', properties:{name:'EPSG:3006' | 'urn:ogc:def:crs:EPSG::3006'}}`
 * or `{type:'EPSG', properties:{code:3006}}`). Anything else is rejected.
 */
export interface GeneratedFeatureCollection {
    type: 'FeatureCollection';
    crs?: unknown;
    features: GeneratedFeature[];
}

export interface GeneratedFeature {
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: number[][][] };
    /**
     * `type` (feature type), `source` (must equal the query source),
     * optional `source_ref` and `license`; every other scalar property
     * becomes an `attributes` entry (nulls are dropped).
     */
    properties: Record<string, unknown>;
}

const GENERATED_CRS = 'EPSG:3006';
const RESERVED_PROPERTY_KEYS = new Set(['type', 'source', 'source_ref', 'license']);

function assertAcceptedCrs(crs: unknown): void {
    if (crs === undefined || crs === null) return;
    if (typeof crs !== 'object') throw new InvalidFeatureError('crs must be an object');
    const c = crs as { type?: unknown; properties?: Record<string, unknown> };
    const props = c.properties ?? {};
    if (c.type === 'name') {
        const name = typeof props.name === 'string' ? props.name : '';
        if (/^(EPSG:3006|urn:ogc:def:crs:EPSG::3006)$/i.test(name)) return;
        throw new InvalidFeatureError(`Unsupported crs ${name || '(missing name)'}; only ${GENERATED_CRS} is accepted`);
    }
    if (c.type === 'EPSG' && (props.code === 3006 || props.code === '3006')) return;
    throw new InvalidFeatureError(`Unsupported crs; only ${GENERATED_CRS} is accepted`);
}

/**
 * GeoJSON Polygon rings -> internal FeatureGeometry. Every edge is straight
 * (no hIn/hOut handles), ring 0 is the exterior and later rings are holes,
 * matching how the editor stores hand-drawn holes. The GeoJSON closing point
 * is dropped; winding is normalised later by toGeoJson().
 */
function polygonToGeometry(coordinates: unknown, label: string): FeatureGeometry {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new InvalidFeatureError(`${label}: Polygon must have at least one ring`);
    }
    const rings = coordinates.map((ring, ringIdx) => {
        if (!Array.isArray(ring)) throw new InvalidFeatureError(`${label}: ring ${ringIdx} is not an array`);
        const points = ring.map((pos, i) => {
            if (!Array.isArray(pos) || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) {
                throw new InvalidFeatureError(`${label}: ring ${ringIdx} position ${i} is not a finite [x, y]`);
            }
            return { x: pos[0] as number, y: pos[1] as number };
        });
        if (points.length > 1) {
            const first = points[0];
            const last = points[points.length - 1];
            if (first.x === last.x && first.y === last.y) points.pop();
        }
        if (points.length < 3) throw new InvalidFeatureError(`${label}: ring ${ringIdx} needs at least 3 distinct points`);
        return { points };
    });
    return { crs: GENERATED_CRS, rings };
}

interface ParsedGeneratedFeature {
    type: string;
    geometry: FeatureGeometry;
    sourceRef: string | null;
    license: string | null;
    attributes: FeatureAttributes | null;
}

function parseGeneratedFeature(feature: unknown, index: number, source: string): ParsedGeneratedFeature {
    const label = `features[${index}]`;
    if (!feature || typeof feature !== 'object') throw new InvalidFeatureError(`${label}: not an object`);
    const f = feature as Partial<GeneratedFeature>;
    if (f.type !== 'Feature') throw new InvalidFeatureError(`${label}: type must be 'Feature'`);
    if (!f.geometry || f.geometry.type !== 'Polygon') {
        throw new InvalidFeatureError(`${label}: geometry.type must be 'Polygon'`);
    }
    const props = f.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        throw new InvalidFeatureError(`${label}: properties must be an object`);
    }
    if (typeof props.type !== 'string') throw new InvalidFeatureError(`${label}: properties.type is required`);
    assertValidType(props.type);
    if (props.source !== source) {
        throw new InvalidFeatureError(
            `${label}: properties.source (${String(props.source)}) must equal the requested source (${source})`,
        );
    }
    for (const key of ['source_ref', 'license'] as const) {
        const v = props[key];
        if (v !== undefined && v !== null && typeof v !== 'string') {
            throw new InvalidFeatureError(`${label}: properties.${key} must be a string or null`);
        }
    }
    const attributes: FeatureAttributes = {};
    for (const [key, value] of Object.entries(props)) {
        if (RESERVED_PROPERTY_KEYS.has(key) || value === null || value === undefined) continue;
        if (!isScalar(value)) throw new InvalidFeatureError(`${label}: properties.${key} must be a scalar`);
        attributes[key] = value;
    }
    assertValidAttributes(attributes);
    const geometry = polygonToGeometry(f.geometry.coordinates, label);
    assertValidGeometry(geometry);
    return {
        type: props.type,
        geometry,
        sourceRef: (props.source_ref as string | undefined) ?? null,
        license: (props.license as string | undefined) ?? null,
        attributes: Object.keys(attributes).length > 0 ? attributes : null,
    };
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
        source: row.source,
        sourceRef: row.source_ref,
        license: row.license,
        attributes: parseAttributes(row.attributes_json),
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
            source: string | null;
            source_ref: string | null;
            license: string | null;
            attributes_json?: string | null;
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
    async geojsonByCourse(
        courseId: string,
        opts: { resolved?: boolean } = {},
    ): Promise<CourseFeatureFeatureCollection> {
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
                'course_features.source',
                'course_features.source_ref',
                'course_features.license',
                'course_features.attributes_json',
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
                    source: feature.source,
                    sourceRef: feature.sourceRef,
                    license: feature.license,
                    attributes: feature.attributes,
                },
                geometry: geojson,
            });
        }
        let collection: CourseFeatureFeatureCollection = { type: 'FeatureCollection', features };
        if (opts.resolved) {
            // Render-only variant: clip lower surfaces out from under higher
            // ones so semi-transparent fills blend with the ortho exactly
            // once. NOT for analysis consumers — a green overlapped by a
            // higher feature comes back clipped.
            collection = resolveSurfaceStack(
                collection as unknown as FeatureCollection,
            ) as unknown as CourseFeatureFeatureCollection;
        }
        // T49: any ODbL feature makes the course's map data ODbL — the
        // collection (and thus every course bundle) carries the attribution.
        if (features.some((f) => f.properties.license === ODBL_LICENSE)) {
            collection.attribution = ODBL_ATTRIBUTION;
        }
        return collection;
    }

    async create(input: {
        courseId: string;
        holeId?: string | null;
        type: string;
        geometry: FeatureGeometry;
        /** Import provenance (T49) — omitted for hand-drawn features. */
        source?: string | null;
        sourceRef?: string | null;
        license?: string | null;
        /** Flat scalar attributes; omitted/null for hand-drawn features. */
        attributes?: FeatureAttributes | null;
    }): Promise<CourseFeature> {
        assertValidType(input.type);
        assertValidGeometry(input.geometry);
        assertValidAttributes(input.attributes);

        const id = crypto.randomUUID();
        const holeId = input.holeId ?? null;
        const source = input.source ?? null;
        const sourceRef = input.sourceRef ?? null;
        const license = input.license ?? null;
        const attributes = input.attributes ?? null;
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
                    source,
                    source_ref: sourceRef,
                    license,
                    attributes_json: serializeAttributes(attributes),
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
            source,
            sourceRef,
            license,
            attributes,
            version: 1,
        };
    }

    async update(
        id: string,
        version: number,
        input: {
            holeId?: string | null;
            type?: string;
            geometry?: FeatureGeometry;
            /** `null` clears the attributes; omitted leaves them untouched. */
            attributes?: FeatureAttributes | null;
        },
    ): Promise<CourseFeature> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('course_features', id);

        if (input.type !== undefined) assertValidType(input.type);
        if (input.geometry !== undefined) assertValidGeometry(input.geometry);
        if (input.attributes !== undefined) assertValidAttributes(input.attributes);

        const dbInput: Record<string, unknown> = {};
        const movingGroups = input.holeId !== undefined && input.holeId !== row.hole_id;
        const nextHoleId = input.holeId !== undefined ? input.holeId : row.hole_id;
        const nextType = input.type ?? row.type;
        if (input.holeId !== undefined) dbInput.hole_id = input.holeId;
        if (input.type !== undefined) dbInput.type = input.type;
        if (input.geometry !== undefined) {
            dbInput.geometry_json = JSON.stringify(input.geometry);
            dbInput.geojson = JSON.stringify(toGeoJson(input.geometry));
        }
        if (input.attributes !== undefined) dbInput.attributes_json = serializeAttributes(input.attributes);

        if (movingGroups) {
            await this.db.transaction().execute(async (trx) => {
                const groupStack = await this.byGroup(row.course_id, nextHoleId, trx).execute();
                const pos = insertionPosition(groupStack, nextType);

                for (const targetRow of groupStack) {
                    if (targetRow.sort_order >= pos) {
                        await this.updateById(targetRow.id, trx)
                            .set({ sort_order: targetRow.sort_order + 1, updated_at: sql`(datetime('now'))` })
                            .execute();
                    }
                }

                await this.updateById(id, trx)
                    .set({
                        ...dbInput,
                        sort_order: pos,
                        version: version + 1,
                        updated_at: sql`(datetime('now'))`,
                    })
                    .execute();
            });
        } else {
            await this.updateById(id)
                .set({
                    ...dbInput,
                    version: version + 1,
                    updated_at: sql`(datetime('now'))`,
                })
                .execute();
        }

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toCourseFeature(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('course_features', id);
        await this.deleteById(id).execute();
    }

    /**
     * Replaces every feature of `courseId` whose `source` equals `source` with
     * the polygons in `collection`, in one transaction. Inserted features are
     * course-level (hole_id NULL) and land in the course group's stack where
     * create() would put a feature of their type (D26 insertion heuristic),
     * in input order. Hand-drawn features (source NULL) are never touched:
     * an empty source is rejected before anything is read.
     *
     * Throws InvalidFeatureError for a bad body (wrong CRS, non-Polygon
     * geometry, source mismatch, bad attributes) and NotFoundError when the
     * course does not exist. Nothing is written in either case.
     */
    async replaceGenerated(
        courseId: string,
        source: string,
        collection: GeneratedFeatureCollection,
    ): Promise<{ deleted: number; inserted: number }> {
        if (typeof source !== 'string' || source.trim().length === 0) {
            throw new InvalidFeatureError('source is required and must be non-empty (hand-drawn features are never replaced)');
        }
        if (!collection || typeof collection !== 'object' || collection.type !== 'FeatureCollection') {
            throw new InvalidFeatureError("Body must be a GeoJSON FeatureCollection (type: 'FeatureCollection')");
        }
        assertAcceptedCrs(collection.crs);
        if (!Array.isArray(collection.features)) throw new InvalidFeatureError('features must be an array');
        const parsed = collection.features.map((f, i) => parseGeneratedFeature(f, i, source));

        return this.db.transaction().execute(async (trx) => {
            const course = await trx.selectFrom('courses').select('id').where('id', '=', courseId).executeTakeFirst();
            if (!course) throw new NotFoundError(`Course ${courseId} not found`);

            // Counted explicitly: the bun-sqlite dialect does not report
            // numDeletedRows.
            const existing = await trx
                .selectFrom('course_features')
                .select((eb) => eb.fn.countAll<number>().as('n'))
                .where('course_id', '=', courseId)
                .where('source', '=', source)
                .executeTakeFirstOrThrow();
            const deleted = Number(existing.n);
            await trx
                .deleteFrom('course_features')
                .where('course_id', '=', courseId)
                .where('source', '=', source)
                .execute();

            // Group by type so each type slots into the stack at its own
            // z-order position; within a type, input order is preserved.
            const byType = new Map<string, ParsedGeneratedFeature[]>();
            for (const f of parsed) {
                const list = byType.get(f.type) ?? [];
                list.push(f);
                byType.set(f.type, list);
            }
            const types = [...byType.keys()].sort((a, b) => typeRank(a) - typeRank(b));

            let inserted = 0;
            for (const type of types) {
                const batch = byType.get(type)!;
                const groupStack = await this.byGroup(courseId, null, trx).execute();
                const pos = insertionPosition(groupStack, type);
                await trx
                    .updateTable('course_features')
                    .set({ sort_order: sql`sort_order + ${batch.length}`, updated_at: sql`(datetime('now'))` })
                    .where('course_id', '=', courseId)
                    .where('hole_id', 'is', null)
                    .where('sort_order', '>=', pos)
                    .execute();

                const rows = batch.map((f, i) => ({
                    id: crypto.randomUUID(),
                    course_id: courseId,
                    hole_id: null,
                    type: f.type,
                    geometry_json: JSON.stringify(f.geometry),
                    geojson: JSON.stringify(toGeoJson(f.geometry)),
                    sort_order: pos + i,
                    source,
                    source_ref: f.sourceRef,
                    license: f.license,
                    attributes_json: serializeAttributes(f.attributes),
                    version: 1,
                }));
                const CHUNK = 200;
                for (let i = 0; i < rows.length; i += CHUNK) {
                    await trx.insertInto('course_features').values(rows.slice(i, i + CHUNK)).execute();
                }
                inserted += rows.length;
            }

            return { deleted, inserted };
        });
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
