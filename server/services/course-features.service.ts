import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CourseFeaturesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { toGeoJson, type FeatureGeometry, type GeoJsonPolygon, type GeoJsonMultiPolygon } from './geo';
import { resolveSurfaceStack } from '../../shared/render/resolved-surface-stack';
import { ROUGHS_LAYER, isRoughsLayerType, stackKey, drawScopeRanks, type FeatureLayer } from '../../shared/render/stack-key';
import { PATH_SURFACE_ATTRIBUTE, PATH_SURFACES, isPathSurface } from '../../shared/features/path-surface';
import { centerlineError, centerlineGeometry } from '../../shared/features/centerline';
import { pathTransitionsError, type PathTransition } from '../../shared/features/path-transitions';
import { PATH_RENDER_ATTRIBUTE, pathRenderError } from '../../shared/features/path-render';
import { bankVegProblem, takesBankVeg } from '../../shared/features/creek-vegetation';
import { ZONE_BLENDS, ZONE_BLEND_ATTRIBUTE, ZONE_EXTRA_PALETTES_ATTRIBUTE, parseZonePalettes } from '../../shared/features/zone-layers';
import { zoneHeightProblem } from '../../shared/features/zone-height';
import { TREE_AREA_TYPE, treeAreaProblem } from '../../shared/features/tree-areas';
import { ROCK_SLAB_TYPE, rockSlabProblem } from '../../shared/features/rock-slab';
import { WATERFALL_TYPE, waterfallProblem } from '../../shared/features/waterfall';
import { KERB_FILLETS_ATTRIBUTE, ROAD_JUNCTIONS_SOURCE, junctionFillets, kerbFilletsOn } from '../../shared/features/road-junctions';
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
    // Lower-vegetation zone (docs/feature-vegetation-zones.md): an overlay
    // area, not a playing surface. Appended rather than slotted next to
    // `trees` so the web panel's digit shortcuts (first ten types) are
    // untouched; its draw order is set by TYPE_Z_ORDER below.
    'vegetation_zone',
    // Tree species area (shared/features/tree-areas.ts): an overlay area whose
    // species mix the Unity tree planter uses for the survey stems inside it.
    'tree_area',
    // Rock slab (shared/features/rock-slab.ts): a drawn surface that is no OPCD
    // shape; shaping-global turns it into a Blender cut-out.
    'rock_slab',
    // Power line (shared/features/power-line.ts): a centerline with a corridor;
    // no surface. The trees export leaves out the survey stems inside it.
    'power_line',
    // Waterfall (shared/features/waterfall.ts): a centerline along a fall's lip
    // between two waters; no surface. Unity builds the falling water along it.
    'waterfall',
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
    'rock_slab',
    'vegetation_zone',
    'tree_area',
    'trees',
    'bunker',
    'water',
    'water_creek',
    'penalty_yellow',
    'penalty_red',
    'oob',
    'path',
    'power_line',
    'waterfall',
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
    /**
     * `'roughs'` = the Roughs group, composed under every hole (D28); its
     * `holeId` is then null. Null = the hole's group, or course-level.
     */
    layer: FeatureLayer;
    type: string;
    geometry: FeatureGeometry;
    sortOrder: number;
    /** Import provenance (T49): producer id (e.g. 'osm'), null = hand-drawn. */
    source: string | null;
    /**
     * True only for features written by the pipeline bulk-replace route
     * (`PUT /features/generated?source=`), which owns its whole set and
     * would discard manual edits on its next run — the editor keeps those
     * read-only. Wizard-imported features carry `source` provenance but are
     * ordinary editable shapes, so this stays false for them.
     */
    generated: boolean;
    /** Source-local ref (e.g. 'way/123456'). */
    sourceRef: string | null;
    /** License short name (e.g. 'ODbL'). */
    license: string | null;
    /**
     * Flat scalar attributes set by generators (e.g. lidar canopy: heightMaxM,
     * heightP90M, heightMeanM, areaM2). Null for hand-drawn features.
     */
    attributes: FeatureAttributes | null;
    /**
     * Per-course number, never reused (migration 026). Shown in hex it is the
     * feature's GSPro SVG shape name, and so its mesh name in Blender and
     * Unity: `hole_2_1a` → `Spline_hole_2_1a_Bunker_-_Mesh`. Null for
     * generated features.
     */
    no: number | null;
    version: number;
}

export type FeatureAttributes = Record<string, number | string | boolean | PathTransition[]>;

/** One (source, type) group of a course's imported features. */
export interface ImportedFeatureCount {
    source: string;
    type: string;
    count: number;
}

/** Upper bound on `attributes` keys; keeps the column a small flat object. */
export const MAX_ATTRIBUTE_KEYS = 32;

export interface CourseFeatureGeoJsonFeature {
    type: 'Feature';
    id: string;
    properties: {
        courseId: string;
        holeId: string | null;
        layer: FeatureLayer;
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

/**
 * Every column except the materialized `geojson`, which only
 * `geojsonByCourse` reads (review item 1: it was ~25 MB of a 33 MB list).
 */
type FeatureRow = Omit<Selectable<CourseFeaturesTable>, 'geojson'>;

const FEATURE_COLUMNS = [
    'id',
    'course_id',
    'hole_id',
    'layer',
    'type',
    'geometry_json',
    'generated',
    'feature_no',
    'sort_order',
    'source',
    'source_ref',
    'license',
    'attributes_json',
    'version',
    'created_at',
    'updated_at',
] as const;

function toCourseFeature(row: FeatureRow): CourseFeature {
    return {
        id: row.id,
        courseId: row.course_id,
        holeId: row.hole_id,
        layer: toLayer(row.layer),
        type: row.type,
        geometry: JSON.parse(row.geometry_json) as FeatureGeometry,
        sortOrder: row.sort_order,
        source: row.source,
        generated: row.generated === 1,
        sourceRef: row.source_ref,
        license: row.license,
        attributes: parseAttributes(row.attributes_json),
        no: row.feature_no,
        version: row.version,
    };
}

/** Unknown stored values read as null, so a bad row degrades to course-level. */
function toLayer(raw: string | null): FeatureLayer {
    return raw === ROUGHS_LAYER ? ROUGHS_LAYER : null;
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

/**
 * D28: the Roughs group holds rough-type features only, and never belongs to
 * a hole.
 */
function assertValidLayer(layer: string | null, holeId: string | null, type: string): void {
    if (layer === null) return;
    if (layer !== ROUGHS_LAYER) throw new InvalidFeatureError(`Invalid layer: ${layer}`);
    if (holeId !== null) throw new InvalidFeatureError('A feature in the Roughs layer cannot belong to a hole');
    if (!isRoughsLayerType(type)) {
        throw new InvalidFeatureError(`The Roughs layer only holds rough types, not ${type}`);
    }
}

/**
 * A centerline geometry's rings are the corridor derived from it, never what
 * the caller sent: the line and the surface every ring consumer reads (the
 * GSPro SVG, the surface stack, iOS) cannot drift apart.
 */
function deriveCenterlineRings(geometry: FeatureGeometry): FeatureGeometry {
    if (!geometry || typeof geometry !== 'object' || geometry.centerline === undefined) return geometry;
    const error = centerlineError(geometry.centerline);
    if (error) throw new InvalidFeatureError(error);
    const derived = centerlineGeometry(geometry.crs, geometry.centerline);
    if (!derived) throw new InvalidFeatureError('Centerline buffers to no corridor');
    return derived;
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
        if (key === 'pathTransitions' && Array.isArray(value)) continue;
        if (!isScalar(value)) {
            throw new InvalidFeatureError(`attributes.${key} must be a finite number, string or boolean`);
        }
    }
}

/**
 * Defaults for the `vegetation_zone` attribute keys the rasterizer reads
 * (docs/feature-vegetation-zones.md §5). A missing numeric key means its
 * default, so a zone drawn before the panel existed still rasterizes; only
 * `zoneType` (the key into the course's zone-type table) is required.
 * `zoneVariant` (a variant key of that type) is optional: absent or `''`
 * means the type's Default item mix. `blend` absent means `replace`: a
 * drawn zone takes its weight of the ground from the generated zones under
 * it; `mix` plants over them instead (drawn zones always add up, D-VZ14). `extraPalettes` absent means none: more type/variant
 * mixes the zone plants on its footprint, each at the zone's weight times
 * its own weight (default 1). Both are shared/features/zone-layers.ts.
 */
export const VEGETATION_ZONE_DEFAULTS = { weight: 1, feather: 2, noise: 0 } as const;

/**
 * `vegetation_zone` attributes: `zoneType` a non-empty string, `weight` in
 * [0, 1], `feather` and `noise` metres >= 0. The numeric keys may be absent
 * (they then mean {@link VEGETATION_ZONE_DEFAULTS}); `zoneType` may not —
 * a zone with no type is a polygon nothing can rasterize. `zoneVariant`, when
 * present, is a string (`''` = Default); like `zoneType` it is not checked
 * against the zone-type table — the pipeline falls back to Default for a key
 * the type does not have. `blend`, when present, is one of ZONE_BLENDS;
 * `extraPalettes`, when present, is a string parseZonePalettes accepts (its
 * types and variants are not checked against the table either). `edgeBlend`,
 * when present, is metres >= 0: how wide the zone's mix fades into the
 * vegetation beside it (absent = the pipeline's default, 0 = no blend; D-VZ16).
 * `heightMin` and `heightMax`, both or neither, are the height in metres the
 * zone's bushes are scaled to (shared/features/zone-height.ts, D-VZ17).
 */
function assertValidVegetationZoneAttributes(attributes: FeatureAttributes | null | undefined): void {
    const zoneType = attributes?.zoneType;
    if (typeof zoneType !== 'string' || zoneType.trim().length === 0) {
        throw new InvalidFeatureError('A vegetation_zone needs a non-empty attributes.zoneType');
    }
    const zoneVariant = attributes?.zoneVariant;
    if (zoneVariant !== undefined && typeof zoneVariant !== 'string') {
        throw new InvalidFeatureError('attributes.zoneVariant must be a string (a variant key, or empty for Default)');
    }
    const blend = attributes?.[ZONE_BLEND_ATTRIBUTE];
    if (blend !== undefined && !(ZONE_BLENDS as readonly unknown[]).includes(blend)) {
        throw new InvalidFeatureError(`attributes.${ZONE_BLEND_ATTRIBUTE} must be one of ${ZONE_BLENDS.join(', ')}`);
    }
    const extras = attributes?.[ZONE_EXTRA_PALETTES_ATTRIBUTE];
    if (extras !== undefined) {
        const parsed = typeof extras === 'string' ? parseZonePalettes(extras) : { error: 'not a string' };
        if ('error' in parsed) {
            throw new InvalidFeatureError(`attributes.${ZONE_EXTRA_PALETTES_ATTRIBUTE}: ${parsed.error} (comma-separated <zoneType>[/<variant>][=<weight 0..1>])`);
        }
    }
    const ranges: Record<string, [number, number]> = {
        weight: [0, 1],
        feather: [0, Infinity],
        noise: [0, Infinity],
        edgeBlend: [0, Infinity],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
        const value = attributes![key];
        if (value === undefined) continue; // absent = the default
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
            const bound = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
            throw new InvalidFeatureError(`attributes.${key} must be a number ${bound}`);
        }
    }
    const height = zoneHeightProblem(attributes);
    if (height) throw new InvalidFeatureError(height);
}

/** `tree_area` attributes: a species mix string, optional ignoreKind and name (shared/features/tree-areas.ts). */
function assertValidTreeAreaAttributes(attributes: FeatureAttributes | null | undefined): void {
    const problem = treeAreaProblem(attributes);
    if (problem) throw new InvalidFeatureError(problem);
}

/**
 * `path` attributes: `surface`, when present, is one of PATH_SURFACES
 * (shared/features/path-surface.ts) — what the road or cart path is made of.
 * Absent means unknown; every other key is free, like any feature's.
 */
function assertValidPathAttributes(attributes: FeatureAttributes | null | undefined): void {
    const surface = attributes?.[PATH_SURFACE_ATTRIBUTE];
    if (surface !== undefined && !isPathSurface(surface)) {
        throw new InvalidFeatureError(`attributes.${PATH_SURFACE_ATTRIBUTE} must be one of ${PATH_SURFACES.join(', ')}`);
    }
    const fillets = attributes?.[KERB_FILLETS_ATTRIBUTE];
    if (fillets !== undefined && typeof fillets !== 'boolean') {
        throw new InvalidFeatureError(`attributes.${KERB_FILLETS_ATTRIBUTE} must be true or false`);
    }
}

/**
 * `water_creek` / `water` attributes: the bank vegetation keys, when present,
 * are valid (shared/features/creek-vegetation.ts) — the palette the banks are
 * planted with, its water cover and bank cap. Every other key is free.
 */
function assertValidBankVegAttributes(attributes: FeatureAttributes | null | undefined): void {
    const problem = bankVegProblem(attributes);
    if (problem) throw new InvalidFeatureError(problem);
}

/** `waterfall` attributes (shared/features/waterfall.ts): style, levels, flow bearing, sill, cascade width, fountain height, when present. */
function assertValidWaterfallAttributes(attributes: FeatureAttributes | null | undefined): void {
    const problem = waterfallProblem(attributes as Record<string, unknown> | null | undefined);
    if (problem) throw new InvalidFeatureError(problem);
}

/**
 * `rock_slab` attributes: `marginM` (0..5) and `uvM` (> 0), when present
 * (shared/features/rock-slab.ts). Every other key is free.
 */
function assertValidRockSlabAttributes(attributes: FeatureAttributes | null | undefined): void {
    const problem = rockSlabProblem(attributes);
    if (problem) throw new InvalidFeatureError(problem);
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
    // The lidar low-vegetation proposals (D-VZ7) come in through this route
    // with zoneType/weight/feather/noise (and optionally zoneVariant) as
    // ordinary GeoJSON properties.
    if (props.type === 'vegetation_zone' || props.type === TREE_AREA_TYPE) {
        try {
            if (props.type === TREE_AREA_TYPE) assertValidTreeAreaAttributes(attributes);
            else assertValidVegetationZoneAttributes(attributes);
        } catch (e) {
            throw new InvalidFeatureError(`${label}: ${(e as Error).message}`);
        }
    }
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
        layer: toLayer(row.layer),
        type: row.type,
        geometry,
        sortOrder: row.sort_order,
        source: row.source,
        generated: row.generated === 1,
        sourceRef: row.source_ref,
        license: row.license,
        attributes: parseAttributes(row.attributes_json),
        no: row.feature_no,
        version: row.version,
    };
}

export interface CreateFeatureInput {
    courseId: string;
    /** Explicit insertion slot within the group; omitted uses D26. */
    sortOrder?: number;
    holeId?: string | null;
    /** `'roughs'` puts it in the Roughs group (rough types, no hole). */
    layer?: string | null;
    type: string;
    geometry: FeatureGeometry;
    /** Import provenance (T49), omitted for hand-drawn features. */
    source?: string | null;
    sourceRef?: string | null;
    license?: string | null;
    /** Flat scalar attributes; omitted/null for hand-drawn features. */
    attributes?: FeatureAttributes | null;
}

export interface UpdateFeatureInput {
    holeId?: string | null;
    /**
     * `'roughs'` moves it into the Roughs group (and off its hole);
     * `null` moves it out, to `holeId` or course-level. Omitted: it
     * stays, unless the same update assigns a hole or a non-rough
     * type — both of those leave the Roughs group.
     */
    layer?: string | null;
    type?: string;
    geometry?: FeatureGeometry;
    /** `null` clears the attributes; omitted leaves them untouched. */
    attributes?: FeatureAttributes | null;
}

function assertValidCreate(input: CreateFeatureInput): void {
    if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) {
        throw new InvalidFeatureError('sortOrder must be a non-negative safe integer');
    }
    assertValidType(input.type);
    assertValidGeometry(deriveCenterlineRings(input.geometry));
    assertValidAttributes(input.attributes);
    const transitionProblem = pathTransitionsError(input.attributes?.pathTransitions, input.geometry.centerline, input.type, input.attributes?.surface);
    if (transitionProblem) throw new InvalidFeatureError(transitionProblem);
    if (Array.isArray(input.attributes?.pathTransitions) && input.attributes.pathTransitions.length && input.geometry.crs !== 'EPSG:3006') throw new InvalidFeatureError('pathTransitions requires EPSG:3006 geometry');
    const renderProblem = pathRenderError(input.attributes?.[PATH_RENDER_ATTRIBUTE], input.type, input.geometry.centerline, input.attributes?.surface);
    if (renderProblem) throw new InvalidFeatureError(renderProblem);
    if (input.type === 'vegetation_zone') assertValidVegetationZoneAttributes(input.attributes);
    if (input.type === TREE_AREA_TYPE) assertValidTreeAreaAttributes(input.attributes);
    if (input.type === 'path') assertValidPathAttributes(input.attributes);
    if (input.type === ROCK_SLAB_TYPE) assertValidRockSlabAttributes(input.attributes);
    if (input.type === WATERFALL_TYPE) assertValidWaterfallAttributes(input.attributes);
    if (takesBankVeg(input.type)) assertValidBankVegAttributes(input.attributes);
    assertValidLayer(input.layer ?? null, input.holeId ?? null, input.type);
}

/** The row-independent checks; updateIn does the ones that need the stored row. */
function assertValidUpdate(input: UpdateFeatureInput): void {
    if (input.type !== undefined) assertValidType(input.type);
    if (input.geometry !== undefined) assertValidGeometry(deriveCenterlineRings(input.geometry));
    if (input.attributes !== undefined) assertValidAttributes(input.attributes);
}

export class CourseFeaturesService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private byCourse(courseId: string) {
        return this.db
            .selectFrom('course_features')
            .select(FEATURE_COLUMNS)
            .where('course_id', '=', courseId)
            .orderBy('sort_order');
    }

    private byHole(holeId: string) {
        return this.db
            .selectFrom('course_features')
            .select(FEATURE_COLUMNS)
            .where('hole_id', '=', holeId)
            .orderBy('sort_order');
    }

    /** The stack for one group (course_id, hole_id|null, layer|null), bottom -> top. */
    private byGroup(courseId: string, holeId: string | null, layer: FeatureLayer, trx: Kysely<Database> = this.db) {
        let query = trx
            .selectFrom('course_features')
            .select(['id', 'type', 'sort_order'])
            .where('course_id', '=', courseId);
        query = holeId === null ? query.where('hole_id', 'is', null) : query.where('hole_id', '=', holeId);
        query = layer === null ? query.where('layer', 'is', null) : query.where('layer', '=', layer);
        return query.orderBy('sort_order');
    }

    private byId(id: string, trx: Kysely<Database> = this.db) {
        return trx.selectFrom('course_features').select(FEATURE_COLUMNS).where('id', '=', id);
    }

    // --- Queries (write) ---

    private insertFeature(
        values: {
            id: string;
            course_id: string;
            hole_id: string | null;
            layer?: string | null;
            type: string;
            geometry_json: string;
            geojson: string | null;
            sort_order: number;
            source: string | null;
            generated?: number;
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
     * D28 global composition order: the Roughs group at the bottom, then hole
     * groups ascending by hole number, then the course-level group on top,
     * each internally by sort_order. The key itself is `stackKey` in
     * shared/render/stack-key.ts.
     */
    async geojsonByCourse(
        courseId: string,
        opts: { resolved?: boolean } = {},
    ): Promise<CourseFeatureFeatureCollection> {
        const scopeRanks = drawScopeRanks(await this.db.selectFrom('holes')
            .select(['id', 'number', 'drawing_group_name as drawingGroupName', 'drawing_group_after as drawingGroupAfter', 'drawing_group_order as drawingGroupOrder', 'drawing_stack_order as drawingStackOrder'])
            .where('course_id', '=', courseId).execute());
        const rows = await this.db
            .selectFrom('course_features')
            .leftJoin('holes', 'holes.id', 'course_features.hole_id')
            .where('course_features.course_id', '=', courseId)
            .select([
                'course_features.id',
                'course_features.course_id',
                'course_features.hole_id',
                'course_features.layer',
                'course_features.type',
                'course_features.geometry_json',
                'course_features.geojson',
                'course_features.sort_order',
                'course_features.source',
                'course_features.generated',
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
            // Prefer the stored WGS84 polygon; the CourseFeature API type
            // omits it (review item 1), so read it off the row.
            const geojson = row.geojson
                ? (JSON.parse(row.geojson) as GeoJsonPolygon)
                : toGeoJson(feature.geometry);
            features.push({
                type: 'Feature',
                id: feature.id,
                properties: {
                    courseId: feature.courseId,
                    holeId: feature.holeId,
                    layer: feature.layer,
                    type: feature.type,
                    sortOrder: feature.sortOrder,
                    stackKey: stackKey(feature.layer, feature.holeId ? scopeRanks.get(feature.holeId) : null, feature.sortOrder, feature.type, feature.attributes),
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

    async create(input: CreateFeatureInput): Promise<CourseFeature> {
        assertValidCreate(input);
        const created = await this.db.transaction().execute((trx) => this.createIn(trx, input));
        if (created.type === 'path' && created.geometry.centerline) await this.refreshRoadJunctions(input.courseId);
        return created;
    }

    /**
     * Creates every item in one transaction, in input order (each lands at
     * its own D26 insertion position, as sequential create() calls would).
     * Any invalid item rejects the whole batch before anything is written.
     */
    async createMany(courseId: string, items: Omit<CreateFeatureInput, 'courseId'>[]): Promise<CourseFeature[]> {
        const inputs = items.map((item) => ({ ...item, courseId }));
        for (const input of inputs) assertValidCreate(input);
        const created = await this.db.transaction().execute(async (trx) => {
            const created: CourseFeature[] = [];
            for (const input of inputs) created.push(await this.createIn(trx, input));
            // A later insertion can shift a feature created earlier in this batch.
            const rows = await trx.selectFrom('course_features').select(['id', 'sort_order'])
                .where('id', 'in', created.map(f => f.id)).execute();
            const positions = new Map(rows.map(row => [row.id, row.sort_order]));
            for (const feature of created) feature.sortOrder = positions.get(feature.id)!;
            return created;
        });
        if (created.some((f) => f.type === 'path' && f.geometry.centerline)) await this.refreshRoadJunctions(courseId);
        return created;
    }

    private async createIn(trx: Kysely<Database>, input: CreateFeatureInput): Promise<CourseFeature> {
        const geometry = deriveCenterlineRings(input.geometry);
        const id = crypto.randomUUID();
        const holeId = input.holeId ?? null;
        const layer = toLayer(input.layer ?? null);
        const source = input.source ?? null;
        const sourceRef = input.sourceRef ?? null;
        const license = input.license ?? null;
        const attributes = input.attributes ?? null;
        const geojson = toGeoJson(geometry);

        const groupStack = await this.byGroup(input.courseId, holeId, layer, trx).execute();
        const sortOrder = input.sortOrder ?? insertionPosition(groupStack, input.type);

        for (const row of groupStack) {
            if (row.sort_order >= sortOrder) {
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
                layer,
                type: input.type,
                geometry_json: JSON.stringify(geometry),
                geojson: JSON.stringify(geojson),
                sort_order: sortOrder,
                source,
                source_ref: sourceRef,
                license,
                attributes_json: serializeAttributes(attributes),
            },
            trx,
        ).execute();
        // Numbered by the migration 026 trigger.
        const numbered = await trx.selectFrom('course_features').select('feature_no').where('id', '=', id).executeTakeFirstOrThrow();

        return {
            id,
            courseId: input.courseId,
            holeId,
            layer,
            type: input.type,
            geometry,
            sortOrder,
            source,
            generated: false,
            sourceRef,
            license,
            attributes,
            no: numbered.feature_no,
            version: 1,
        };
    }

    async update(id: string, version: number, input: UpdateFeatureInput): Promise<CourseFeature> {
        assertValidUpdate(input);
        const roads = new Set<string>();
        const updated = await this.db.transaction().execute((trx) => this.updateIn(trx, id, version, input, roads));
        for (const courseId of roads) await this.refreshRoadJunctions(courseId);
        return updated;
    }

    /**
     * Applies every update in one transaction, in input order. Each row is
     * version-checked like update(); one stale version (or a missing row)
     * throws VersionConflictError and rolls back the whole batch.
     */
    async updateMany(items: (UpdateFeatureInput & { id: string; version: number })[]): Promise<CourseFeature[]> {
        for (const item of items) assertValidUpdate(item);
        const roads = new Set<string>();
        const updated = await this.db.transaction().execute(async (trx) => {
            const updated: CourseFeature[] = [];
            for (const item of items) updated.push(await this.updateIn(trx, item.id, item.version, item, roads));
            return updated;
        });
        for (const courseId of roads) await this.refreshRoadJunctions(courseId);
        return updated;
    }

    /** `roads` collects the courses whose kerb fillets the caller re-derives after the commit. */
    private async updateIn(
        trx: Kysely<Database>,
        id: string,
        version: number,
        input: UpdateFeatureInput,
        roads: Set<string>,
    ): Promise<CourseFeature> {
        const row = await this.byId(id, trx).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('course_features', id);

        const geometry = input.geometry !== undefined ? deriveCenterlineRings(input.geometry) : undefined;

        const dbInput: Record<string, unknown> = {};
        const nextType = input.type ?? row.type;
        const nextAttributes = input.attributes === undefined ? parseAttributes(row.attributes_json) : input.attributes;
        const nextGeometry = geometry ?? JSON.parse(row.geometry_json);
        const transitionProblem = pathTransitionsError(nextAttributes?.pathTransitions, nextGeometry.centerline, nextType, nextAttributes?.surface);
        if (transitionProblem) throw new InvalidFeatureError(transitionProblem);
        if (Array.isArray(nextAttributes?.pathTransitions) && nextAttributes.pathTransitions.length && nextGeometry.crs !== 'EPSG:3006') throw new InvalidFeatureError('pathTransitions requires EPSG:3006 geometry');
        const renderProblem = pathRenderError(nextAttributes?.[PATH_RENDER_ATTRIBUTE], nextType, nextGeometry.centerline, nextAttributes?.surface);
        if (renderProblem) throw new InvalidFeatureError(renderProblem);
        const currentLayer = toLayer(row.layer);
        let nextLayer: FeatureLayer;
        let nextHoleId = input.holeId !== undefined ? input.holeId : row.hole_id;
        if (input.layer !== undefined) {
            // Entering Roughs drops the hole unless the caller named one too
            // (which assertValidLayer then rejects).
            if (input.layer === ROUGHS_LAYER && input.holeId === undefined) nextHoleId = null;
            assertValidLayer(input.layer, nextHoleId, nextType);
            nextLayer = toLayer(input.layer);
        } else {
            nextLayer = nextHoleId !== null || !isRoughsLayerType(nextType) ? null : currentLayer;
        }
        const movingGroups = nextHoleId !== row.hole_id || nextLayer !== currentLayer;
        // Only when attributes are being written: retyping a shape TO a
        // vegetation_zone without touching its attributes is left alone, the
        // same way every other type change is.
        if (nextType === 'vegetation_zone' && input.attributes !== undefined) {
            assertValidVegetationZoneAttributes(input.attributes);
        }
        if (nextType === TREE_AREA_TYPE && input.attributes !== undefined) assertValidTreeAreaAttributes(input.attributes);
        if (nextType === 'path' && input.attributes !== undefined) assertValidPathAttributes(input.attributes);
        if (nextType === ROCK_SLAB_TYPE && input.attributes !== undefined) assertValidRockSlabAttributes(input.attributes);
        if (nextType === WATERFALL_TYPE && input.attributes !== undefined) assertValidWaterfallAttributes(input.attributes);
        if (takesBankVeg(nextType) && input.attributes !== undefined) assertValidBankVegAttributes(input.attributes);
        if (movingGroups) {
            dbInput.hole_id = nextHoleId;
            dbInput.layer = nextLayer;
        }
        if (input.type !== undefined) dbInput.type = input.type;
        if (geometry !== undefined) {
            dbInput.geometry_json = JSON.stringify(geometry);
            dbInput.geojson = JSON.stringify(toGeoJson(geometry));
        }
        if (input.attributes !== undefined) dbInput.attributes_json = serializeAttributes(input.attributes);

        if (movingGroups) {
            const groupStack = await this.byGroup(row.course_id, nextHoleId, nextLayer, trx).execute();
            const pos = insertionPosition(groupStack, nextType);

            for (const targetRow of groupStack) {
                if (targetRow.sort_order >= pos) {
                    await this.updateById(targetRow.id, trx)
                        .set({ sort_order: targetRow.sort_order + 1, updated_at: sql`(datetime('now'))` })
                        .execute();
                }
            }
            dbInput.sort_order = pos;
        }

        await this.updateById(id, trx)
            .set({
                ...dbInput,
                version: version + 1,
                updated_at: sql`(datetime('now'))`,
            })
            .execute();

        const updated = await this.byId(id, trx).executeTakeFirstOrThrow();
        if ((row.type === 'path' || nextType === 'path')
            && (geometry !== undefined || input.type !== undefined || input.attributes !== undefined)) {
            roads.add(row.course_id);
        }
        return toCourseFeature(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const roads = new Set<string>();
        await this.db.transaction().execute((trx) => this.removeIn(trx, id, version, roads));
        for (const courseId of roads) await this.refreshRoadJunctions(courseId);
    }

    /**
     * Deletes every listed row in one transaction. Each row is
     * version-checked like remove(); one stale version (or a missing row)
     * throws VersionConflictError and nothing is deleted.
     */
    async removeMany(items: { id: string; version: number }[]): Promise<void> {
        const roads = new Set<string>();
        await this.db.transaction().execute(async (trx) => {
            for (const item of items) await this.removeIn(trx, item.id, item.version, roads);
        });
        for (const courseId of roads) await this.refreshRoadJunctions(courseId);
    }

    private async removeIn(trx: Kysely<Database>, id: string, version: number, roads: Set<string>): Promise<void> {
        const row = await this.byId(id, trx).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('course_features', id);
        await this.deleteById(id, trx).execute();
        if (row.type === 'path') roads.add(row.course_id);
    }

    /**
     * Re-derive the course's kerb fillets (shared/features/road-junctions.ts)
     * from its centerline paths, as generated `path` features of
     * ROAD_JUNCTIONS_SOURCE — what the GSPro SVG, iOS and the resolved stack
     * see. Runs after every write that can move, add or remove a road; a
     * course with no fillets before or after writes nothing. Queued per
     * course: the import wizard creates roads six at a time, and a refresh
     * that read the roads before another's create committed must not write
     * after the refresh that saw it.
     */
    refreshRoadJunctions(courseId: string): Promise<void> {
        const next = (this.junctionRefreshes.get(courseId) ?? Promise.resolve())
            .catch(() => {})
            .then(() => this.rederiveRoadJunctions(courseId));
        this.junctionRefreshes.set(courseId, next);
        void next.finally(() => {
            if (this.junctionRefreshes.get(courseId) === next) this.junctionRefreshes.delete(courseId);
        }).catch(() => {});
        return next;
    }
    private readonly junctionRefreshes = new Map<string, Promise<void>>();

    private async rederiveRoadJunctions(courseId: string): Promise<void> {
        const rows = await this.db
            .selectFrom('course_features')
            .select(['id', 'geometry_json', 'attributes_json', 'source', 'generated'])
            .where('course_id', '=', courseId)
            .where('type', '=', 'path')
            .execute();
        const roads: Array<{ id: string; centerline: NonNullable<FeatureGeometry['centerline']>; fillets: boolean }> = [];
        const surfaces = new Map<string, unknown>();
        let existing = 0;
        for (const r of rows) {
            if (r.generated === 1) {
                if (r.source === ROAD_JUNCTIONS_SOURCE) existing++;
                continue;
            }
            const geometry = parseGeometry(r.geometry_json);
            if (!geometry?.centerline) continue;
            const attributes = parseAttributes(r.attributes_json);
            roads.push({ id: r.id, centerline: geometry.centerline, fillets: kerbFilletsOn(attributes) });
            surfaces.set(r.id, attributes?.[PATH_SURFACE_ATTRIBUTE]);
        }
        const fillets = junctionFillets(roads);
        if (fillets.length === 0 && existing === 0) return;
        const features = fillets.map(f => {
            // The junction's surface when its roads agree on one.
            const kinds = new Set(f.roadIds.map(id => surfaces.get(id)));
            const surface = kinds.size === 1 ? [...kinds][0] : undefined;
            return {
                type: 'Feature' as const,
                properties: {
                    type: 'path',
                    source: ROAD_JUNCTIONS_SOURCE,
                    source_ref: f.roadIds.join(','),
                    ...(isPathSurface(surface) ? { [PATH_SURFACE_ATTRIBUTE]: surface } : {}),
                },
                geometry: {
                    type: 'Polygon' as const,
                    coordinates: f.rings.map(ring => {
                        const pts = ring.points.map(q => [q.x, q.y]);
                        return [...pts, pts[0]];
                    }),
                },
            };
        });
        await this.replaceGenerated(courseId, ROAD_JUNCTIONS_SOURCE, { type: 'FeatureCollection', features } as GeneratedFeatureCollection);
    }

    /**
     * What the import wizard has put on the course: counts of the features
     * carrying an import `source` (fetch-roads `osm`/`nvdb`, the Lantmäteriet
     * fetch, pipeline files), per source and type. Hand-drawn features
     * (source NULL) and generated ones (their own replace-by-source route)
     * are not imports and are left out. 404 for an unknown course.
     */
    async importedByCourse(courseId: string): Promise<ImportedFeatureCount[]> {
        await this.assertCourse(courseId);
        const rows = await this.db
            .selectFrom('course_features')
            .select(['source', 'type', (eb) => eb.fn.countAll<number>().as('count')])
            .where('course_id', '=', courseId)
            .where('source', 'is not', null)
            .where('generated', '=', 0)
            .groupBy(['source', 'type'])
            .orderBy('source')
            .orderBy('type')
            .execute();
        return rows.map((r) => ({ source: r.source as string, type: r.type, count: Number(r.count) }));
    }

    /**
     * Deletes the course's imported features from `sources`, only those of
     * `types` when given — e.g. the roads (`path`) from `osm`+`nvdb` without
     * the OSM fairways — so a fetch can be imported again from scratch.
     * Hand-drawn and generated features are never touched. Returns how many
     * were removed. 404 for an unknown course; an empty `sources` is refused.
     */
    async removeImported(courseId: string, sources: string[], types?: string[]): Promise<{ removed: number }> {
        if (sources.length === 0) throw new InvalidFeatureError('sources must name at least one import source');
        await this.assertCourse(courseId);
        return this.db.transaction().execute(async (trx) => {
            let match = trx
                .selectFrom('course_features')
                .select('id')
                .where('course_id', '=', courseId)
                .where('source', 'in', sources)
                .where('generated', '=', 0);
            if (types && types.length > 0) match = match.where('type', 'in', types);
            // Counted explicitly: the bun-sqlite dialect does not report numDeletedRows.
            const ids = (await match.execute()).map((r) => r.id);
            if (ids.length > 0) await trx.deleteFrom('course_features').where('id', 'in', ids).execute();
            return { removed: ids.length };
        }).then(async result => {
            if (result.removed > 0) await this.refreshRoadJunctions(courseId);
            return result;
        });
    }

    private async assertCourse(courseId: string): Promise<void> {
        const course = await this.db.selectFrom('courses').select('id').where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
    }

    /**
     * Replaces every feature of `courseId` whose `source` equals `source` with
     * the polygons in `collection`, in one transaction. Inserted features are
     * course-level (hole_id NULL) and land in the course group's stack where
     * create() would put a feature of their type (D26 insertion heuristic),
     * in input order. Only rows this route itself wrote are replaced: the
     * delete matches `source` AND `generated = 1`, so hand-drawn features
     * (source NULL) and wizard-imported ones that happen to share a source
     * id are never touched. An empty source is rejected before anything is
     * read.
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
                .where('generated', '=', 1)
                .executeTakeFirstOrThrow();
            const deleted = Number(existing.n);
            await trx
                .deleteFrom('course_features')
                .where('course_id', '=', courseId)
                .where('source', '=', source)
                .where('generated', '=', 1)
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
                const groupStack = await this.byGroup(courseId, null, null, trx).execute();
                const pos = insertionPosition(groupStack, type);
                // Room for the batch, WITHOUT touching `updated_at`: a generator run is not an
                // edit of the hand-drawn features it slides under. Bumping it marked every SVG
                // type stale on the GSPro board and invalidated every export fingerprint that
                // hashes the feature high-water mark (feature-history.service.ts `latestStamp`)
                // on each Update vegetation. The migration-025 `restack` trigger still records
                // the move, and the counting there ignores a sort-order-only row.
                await trx
                    .updateTable('course_features')
                    .set({ sort_order: sql`sort_order + ${batch.length}` })
                    .where('course_id', '=', courseId)
                    .where('hole_id', 'is', null)
                    .where('layer', 'is', null)
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
                    generated: 1,
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
     * Lift a generator's zones to where `replaceGenerated` would put them now
     * (the top of their type's run in the course-level stack), without
     * re-inserting them: a vegetation run that skipped an unchanged generator
     * keeps its zones above the earlier generators' new ones. Like
     * replaceGenerated it leaves `updated_at` alone. Returns the rows moved.
     */
    async raiseGenerated(courseId: string, source: string): Promise<number> {
        return this.db.transaction().execute(async (trx) => {
            const group = await this.byGroup(courseId, null, null, trx).execute();
            const own = new Set((await trx.selectFrom('course_features').select('id')
                .where('course_id', '=', courseId).where('source', '=', source).where('generated', '=', 1)
                .execute()).map((row) => row.id));
            const mine = group.filter((row) => own.has(row.id));
            if (mine.length === 0) return 0;
            const next = group.filter((row) => !own.has(row.id));
            for (const type of [...new Set(mine.map((row) => row.type))].sort((a, b) => typeRank(a) - typeRank(b))) {
                let at = 0;
                for (let i = next.length - 1; i >= 0; i--) {
                    if (typeRank(next[i]!.type) <= typeRank(type)) { at = i + 1; break; }
                }
                next.splice(at, 0, ...mine.filter((row) => row.type === type));
            }
            // The group's own sort_order values, handed out in the new order: only the rows
            // between the old and the new place change (each one a `restack` history row).
            const slots = group.map((row) => row.sort_order);
            let moved = 0;
            for (let i = 0; i < next.length; i++) {
                if (next[i]!.sort_order === slots[i]) continue;
                await this.updateById(next[i]!.id, trx).set({ sort_order: slots[i]! }).execute();
                if (own.has(next[i]!.id)) moved++;
            }
            return moved;
        });
    }

    /**
     * Lift a shape just above the ones painted over it (the SVG check's hidden
     * shape: OPCD makes no mesh for it): in the app's stack order, if the highest
     * of `coverIds` above it is in its own group it is raised to just above that
     * one; if that one is in a higher group (a later hole, the course level), the
     * shape moves into that group, just above it. Roads stay on top of everything,
     * so a road never counts. Nothing to do (nothing of `coverIds` above it) is
     * not an error: `moved` is false.
     */
    async raiseAbove(courseId: string, featureId: string, coverIds: readonly string[]): Promise<{ moved: boolean; holeId: string | null; layer: FeatureLayer }> {
        const scopeRanks = drawScopeRanks(await this.db.selectFrom('holes')
            .select(['id', 'number', 'drawing_group_name as drawingGroupName', 'drawing_group_after as drawingGroupAfter', 'drawing_group_order as drawingGroupOrder', 'drawing_stack_order as drawingStackOrder'])
            .where('course_id', '=', courseId).execute());
        const rows = await this.db.selectFrom('course_features')
            .select(['id', 'hole_id', 'layer', 'type', 'sort_order', 'version', 'attributes_json'])
            .where('course_id', '=', courseId).where('id', 'in', [featureId, ...coverIds]).execute();
        const target = rows.find((r) => r.id === featureId);
        if (!target) throw new NotFoundError(`Feature ${featureId} not found on course ${courseId}`);
        const key = (r: typeof target) => stackKey(r.layer, r.hole_id ? scopeRanks.get(r.hole_id) : null, r.sort_order, r.type, parseAttributes(r.attributes_json));
        const above = rows.filter((r) => r.id !== featureId && r.type !== 'path' && key(r) > key(target)).sort((a, b) => key(b) - key(a));
        const top = above[0];
        const where = { holeId: target.hole_id, layer: toLayer(target.layer) };
        if (!top) return { moved: false, ...where };
        const holeId = top.hole_id;
        const layer = toLayer(top.layer);
        if (holeId !== target.hole_id || layer !== toLayer(target.layer)) {
            await this.update(target.id, target.version, { holeId, layer });
        }
        let group = this.db.selectFrom('course_features').select(['id', 'source', 'generated']).where('course_id', '=', courseId);
        group = holeId === null ? group.where('hole_id', 'is', null) : group.where('hole_id', '=', holeId);
        group = layer === null ? group.where('layer', 'is', null) : group.where('layer', '=', layer);
        // Stored kerb fillets ride along behind their road (reorder).
        const members = (await group.orderBy('sort_order').orderBy('id').execute())
            .filter((r) => !(r.source === ROAD_JUNCTIONS_SOURCE && r.generated))
            .map((r) => r.id).filter((id) => id !== target.id);
        members.splice(members.indexOf(top.id) + 1, 0, target.id);
        await this.reorder(courseId, holeId, members, layer);
        return { moved: true, holeId, layer };
    }

    /**
     * Rewrites a group's (course_id, hole_id|null, layer|null) stack order in one shot
     * (house pattern — see tees.service.ts reorder / game-plans.service.ts
     * reorderShots). orderedIds must be exactly the group's current
     * members, bottom -> top.
     */
    async reorder(
        courseId: string,
        holeId: string | null,
        orderedIds: string[],
        layer: string | null = null,
    ): Promise<void> {
        if (layer !== null && (layer !== ROUGHS_LAYER || holeId !== null)) {
            throw new InvalidFeatureError(`Invalid layer scope: ${layer}`);
        }
        await this.db.transaction().execute(async (trx) => {
            const group = await this.byGroup(courseId, holeId, toLayer(layer), trx).execute();
            // Stored kerb fillets never reach the client (it draws its own),
            // so they are no part of orderedIds: each one rides along behind
            // the row it sat above.
            const junctionIds = new Set((await trx
                .selectFrom('course_features')
                .select('id')
                .where('course_id', '=', courseId)
                .where('source', '=', ROAD_JUNCTIONS_SOURCE)
                .where('generated', '=', 1)
                .execute()).map((row) => row.id));
            const existing = group.filter((row) => !junctionIds.has(row.id));

            const existingIds = new Set(existing.map((row) => row.id));
            const incomingIds = new Set(orderedIds);
            const sameSize = existingIds.size === incomingIds.size;
            const sameMembers = sameSize && orderedIds.every((id) => existingIds.has(id));
            if (!sameSize || !sameMembers) {
                throw new ConflictError(
                    `orderedIds must exactly match the features in scope (course ${courseId}, hole ${holeId ?? layer ?? 'course-level'})`,
                );
            }

            const bottom: string[] = [];
            const riders = new Map<string, string[]>();
            let anchor: string | null = null;
            for (const row of group) {
                if (!junctionIds.has(row.id)) { anchor = row.id; continue; }
                if (anchor === null) bottom.push(row.id);
                else riders.set(anchor, [...(riders.get(anchor) ?? []), row.id]);
            }
            const nextOrder = [...bottom, ...orderedIds.flatMap((id) => [id, ...(riders.get(id) ?? [])])];

            // A one-step move in a group of a thousand rows changes two of them.
            const current = new Map(group.map((row) => [row.id, row.sort_order]));
            for (let i = 0; i < nextOrder.length; i++) {
                if (current.get(nextOrder[i]) === i) continue;
                await this.updateById(nextOrder[i], trx)
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .execute();
            }
        });
    }
}
