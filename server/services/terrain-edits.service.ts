import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, TerrainEditsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { wgs84ToSweref99tm } from './geo';
import { sqlStamp, type ChangeCount } from './feature-history.service';
import {
    FEATURE_RECIPE_SURFACE, NO_RECIPE, RECIPE_SEED, defaultRecipeLibraryPath, loadRecipeLibrary, type RecipeParam, type RecipeSurface,
} from './shaping-recipes';

// --- Constants ---

/**
 * The operations (D-TE3): the two hand-drawn v1 ops, and `corridor` — a
 * road graded smooth along its centerline and level across it — which only
 * the pipeline generates (`golfpipe road-grades`); the tool has no line
 * drawing, so the panel lists and toggles corridors but never arms one.
 * `dig` — a bunker or pond dug below a reference (a flat water `level`, or a
 * `plane` fitted to the ground around it) along a depth profile in from its
 * edge; generated from the course's bunkers and water (`bunker-digs`,
 * `water-digs`), listed and toggled like corridors.
 * `shore` — a lake's shore and bed dug into the DEM (Vättern at Omberg):
 * one polygon whose holes are the islands, the water at `levelM`, the ground
 * falling from the shoreline over an edge, a shelf and a slope down to a
 * rounded floor `depthM` below the level, with an optional channel along it.
 * Only the pipeline generates it (`golfpipe shore-edits`, imported under
 * origin `lake-shore`); listed and toggled like corridors, never drawn.
 * `recipe` — not a DEM edit: the Blender shaping recipe of ONE course feature
 * (blender/SHAPING-PLAN.md, "Terrain editor → Blender"): params
 * `{ recipe: <library id>, overrides? }`, origin `feature`, originRef
 * `feature:<id>`, no rings. At most one per feature. The DEM replay skips it
 * (`isDemEdit`); `gspro.py shaping-global` writes it as an `afrod.recipe` op.
 */
export const TERRAIN_EDIT_OPS = ['plane', 'smooth', 'corridor', 'dig', 'shore', 'delta', 'recipe'] as const;

/** The origin of every `recipe` edit (its originRef names the feature). */
export const RECIPE_ORIGIN = 'feature';
/** Most keys and serialized size of a recipe edit's `overrides`. */
export const RECIPE_OVERRIDES_MAX_KEYS = 32;
export const RECIPE_OVERRIDES_MAX_BYTES = 4096;

/** Whether an edit changes the DEM (every op but `recipe`, which shapes the Blender meshes). */
export function isDemEdit(edit: { op: string }): boolean {
    return edit.op !== 'recipe';
}

/**
 * Unity sculpt layers (`delta`): heights changed in Unity, captured and
 * carried back ("Pull from Unity"). One per terrain, each its own
 * origin so a new capture replaces only that terrain's layer; the GeoTIFF is
 * `sources/<siteId>/terrain-sculpt/<raster>`.
 */
export const SCULPT_ORIGINS = { inner: 'unity-sculpt-inner', outer: 'unity-sculpt-outer' } as const;
export const SCULPT_DIR = 'terrain-sculpt';
const SCULPT_RASTER = /^(inner|outer)-sculpt\.tif$/;

export const DIG_REFERENCES = ['level', 'plane', 'stream'] as const;
export type DigReference = (typeof DIG_REFERENCES)[number];
export type TerrainEditOp = (typeof TERRAIN_EDIT_OPS)[number];

// --- Output types ---

/** A straight-segment ring: EPSG:3006 (DEM CRS) coordinates in metres. */
export type TerrainEditRing = { x: number; y: number }[];

/**
 * Op parameters. `radiusM`/`flat` only meaningful for `smooth`/`plane`;
 * `centerline` (EPSG:3006, the road's axis), `smoothM` (along-road window)
 * and `widthM` (pavement width the profile is sampled over) for `corridor`.
 */
export interface TerrainEditParams {
    featherM: number;
    radiusM?: number;
    flat?: boolean;
    centerline?: TerrainEditRing;
    smoothM?: number;
    widthM?: number;
    /** dig: floor depth below the reference, bank angle, optional steeper face towards a compass bearing, shelf, reference, rim band, perimeter variation. */
    depthM?: number;
    bankSlopeDeg?: number;
    faceSlopeDeg?: number;
    faceBearingDeg?: number;
    shelfM?: number;
    shelfDepthM?: number;
    reference?: DigReference;
    rimM?: number;
    /** dig, reference level: the outline is the water's edge and the bank outside rises from it at this angle (degrees). */
    bankAboveDeg?: number;
    variation?: number;
    seed?: number;
    /**
     * shore: the water level (required), then the profile out from the
     * shoreline: the edge (slope, width, ease), the shelf (slope, where it
     * ends, ease), the slope beyond it, the floor (`depthM` below the level,
     * rounded over `floorRoundM`) and an optional channel (depth, ratio, full
     * from `channelFullM`, gone by `channelGoneM`). The pipeline's
     * dem_edit owns their meaning and defaults; the server only stores them.
     */
    levelM?: number;
    edgeSlope?: number;
    edgeM?: number;
    edgeEaseM?: number;
    shelfSlope?: number;
    shelfEndM?: number;
    shelfEaseM?: number;
    slope?: number;
    floorRoundM?: number;
    channelDepthM?: number;
    channelRatio?: number;
    channelFullM?: number;
    channelGoneM?: number;
    /** shore cliffs: the rise within cliffRunM that makes a cliff (low..high), its underwater slope and depth, held/faded out, smoothed along the shore. */
    cliffRunM?: number;
    cliffRiseLowM?: number;
    cliffRiseHighM?: number;
    cliffSlope?: number;
    cliffDepthM?: number;
    cliffHoldM?: number;
    cliffFadeM?: number;
    cliffSmoothM?: number;
    /** shore: the depth cap on the inner terrain, whose zero is its lowest point (deeper moves every mesh); the outer takes depthM. */
    innerDepthM?: number;
    /** delta: the sculpt GeoTIFF's file name in `sources/<siteId>/terrain-sculpt/`, and what it holds (for the panel). */
    raster?: string;
    changedM2?: number;
    maxRaiseM?: number;
    maxLowerM?: number;
    /** recipe: the shaping recipe library id (`none` = no recipe for this feature, not even the default) and per-feature overrides. */
    recipe?: string;
    overrides?: Record<string, unknown>;
}

/** Params as create/update take them: `featherM` may be left out for a `recipe` edit (it is stored as 0). */
export type TerrainEditParamsInput = Omit<TerrainEditParams, 'featherM'> & { featherM?: number };

/** The dig params, in the order they go into the pipeline handoff. */
export const DIG_PARAM_KEYS = [
    'depthM', 'bankSlopeDeg', 'faceSlopeDeg', 'faceBearingDeg', 'shelfM', 'shelfDepthM', 'reference', 'rimM', 'bankAboveDeg', 'variation', 'seed',
] as const;

/** The shore params (all numbers), in the order they go into the pipeline handoff; `depthM` is shared with dig. */
export const SHORE_PARAM_KEYS = [
    'levelM', 'edgeSlope', 'edgeM', 'edgeEaseM', 'shelfSlope', 'shelfEndM', 'shelfEaseM', 'slope', 'depthM', 'floorRoundM',
    'channelDepthM', 'channelRatio', 'channelFullM', 'channelGoneM',
    'cliffRunM', 'cliffRiseLowM', 'cliffRiseHighM', 'cliffSlope', 'cliffDepthM', 'cliffHoldM', 'cliffFadeM', 'cliffSmoothM',
    'innerDepthM',
] as const;

export interface TerrainEdit {
    id: string;
    siteId: string;
    op: TerrainEditOp;
    params: TerrainEditParams;
    rings: TerrainEditRing[];
    enabled: boolean;
    /** Generator that wrote the edit (`building-pads`); null = hand-drawn. */
    origin: string | null;
    /** What a generated edit is for (a building id); the key a regeneration matches on. */
    originRef: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

/** One edit in the pipeline's D-TE5 handoff / the generated-edits import. */
export interface TerrainEditInput {
    op: TerrainEditOp;
    params: TerrainEditParams;
    rings: TerrainEditRing[];
    originRef?: string | null;
    enabled?: boolean;
}

/**
 * `created_at` for generated edits: the epoch, the origin's slot in
 * GENERATED_ORDER as its second, and the edit's index in its generation as
 * the fraction — SQLite's own `datetime('now')` spelling, so it sorts as a
 * plain string against real timestamps, before every one of them. Edits
 * replay in `created_at` order and a later one wins where they overlap, so
 * the slot decides which generator wins: without it every generation
 * started at the same instant and pads, digs and road grades interleaved by
 * index (a pad beside a road could overwrite the graded road).
 */
export const GENERATED_EPOCH = '2000-01-01 00:00';
/**
 * Replay order of the generators, first to last (last wins). The lake shore
 * first: a pad, a pond or a road beside the lake is graded on top of it.
 * Roads last: a creek or a pad never cuts a graded road.
 */
export const GENERATED_ORDER = ['lake-shore', 'building-pads', 'water-digs', 'bunker-digs', 'creek-digs', 'road-grades'] as const;
export function generatedCreatedAt(index: number, origin?: string): string {
    // A Unity sculpt was made on top of everything, hand-drawn edits included: it replays last of all.
    const sculpt = Object.values(SCULPT_ORIGINS).indexOf(origin as (typeof SCULPT_ORIGINS)[keyof typeof SCULPT_ORIGINS]);
    if (sculpt >= 0) return `2999-01-01 00:00:${String(sculpt * 2 + 1).padStart(2, '0')}.${String(index).padStart(6, '0')}`;
    const slot = GENERATED_ORDER.indexOf(origin as (typeof GENERATED_ORDER)[number]);
    // The lake shore takes second 00, the rest the odd seconds from 01 they had before it came: stored
    // stamps keep their order without a regeneration. Unknown origins go in the middle second, between
    // the known ones and never past them.
    const second = slot === 0 ? 0 : slot > 0 ? slot * 2 - 1 : GENERATED_ORDER.length - 1;
    return `${GENERATED_EPOCH}:${String(second).padStart(2, '0')}.${String(index).padStart(6, '0')}`;
}

/**
 * The `originRef` prefix of an edit generated from one course feature
 * (`feature:<featureId>`: the digs, a road graded from the course's own
 * path) — what ties a generated edit on a shared site to its course.
 */
export const FEATURE_ORIGIN_REF = 'feature:';

/** Ids per `IN (...)` list, well under SQLite's bound-parameter limit. */
const SQL_IN_CHUNK = 500;

/** A generated edit's index in its origin (the `created_at` fraction, generatedCreatedAt); -1 for a real timestamp. */
function generatedIndexOf(createdAt: string): number {
    const m = /\.(\d+)$/.exec(createdAt);
    return m ? Number(m[1]) : -1;
}

/** The `feature:<id>` refs among `rows` whose feature belongs to another course on the site. */
async function otherCoursesFeatureRefs(
    db: Kysely<Database>, siteId: string, courseId: string, rows: Array<{ origin_ref: string | null }>,
): Promise<Set<string>> {
    const featureIds = [...new Set(rows.flatMap(r =>
        r.origin_ref?.startsWith(FEATURE_ORIGIN_REF) ? [r.origin_ref.slice(FEATURE_ORIGIN_REF.length)] : []))];
    const refs = new Set<string>();
    for (let i = 0; i < featureIds.length; i += SQL_IN_CHUNK) {
        const owned = await db.selectFrom('course_features')
            .innerJoin('courses', 'courses.id', 'course_features.course_id')
            .select('course_features.id')
            .where('course_features.id', 'in', featureIds.slice(i, i + SQL_IN_CHUNK))
            .where('courses.site_id', '=', siteId)
            .where('courses.id', '!=', courseId)
            .execute();
        for (const f of owned) refs.add(FEATURE_ORIGIN_REF + f.id);
    }
    return refs;
}

// --- Row mapping ---

type TerrainEditRow = Selectable<TerrainEditsTable>;

function toTerrainEdit(row: TerrainEditRow): TerrainEdit {
    return {
        id: row.id,
        siteId: row.site_id,
        op: row.op as TerrainEditOp,
        params: JSON.parse(row.params_json) as TerrainEditParams,
        rings: JSON.parse(row.rings_json) as TerrainEditRing[],
        enabled: row.enabled !== 0,
        origin: row.origin ?? null,
        originRef: row.origin_ref ?? null,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// --- D-TE5 GeoJSON (the pipeline's edits handoff) → edit inputs ---

/**
 * Parses a D-TE5 edits FeatureCollection (WGS84 polygons, per-feature
 * `op`/`featherM`/`radiusM`/`flat`, optional `originRef`) — what
 * `golfpipe building-pads` writes — into inputs in the DEM CRS. Malformed
 * features are skipped and reported, never fatal, mirroring the pipeline's
 * own loader.
 */
export function parseEditsGeojson(doc: unknown): { edits: TerrainEditInput[]; skipped: string[] } {
    const edits: TerrainEditInput[] = [];
    const skipped: string[] = [];
    const collection = doc as { type?: unknown; features?: unknown };
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new InvalidTerrainEditError('Edits must be a GeoJSON FeatureCollection (D-TE5)');
    }
    collection.features.forEach((feature: any, i: number) => {
        const props = feature?.properties ?? {};
        const geometry = feature?.geometry;
        if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
            skipped.push(`feature ${i}: geometry is not a Polygon`);
            return;
        }
        if (!(TERRAIN_EDIT_OPS as readonly string[]).includes(props.op) || props.op === 'recipe') {
            skipped.push(`feature ${i}: unknown op ${JSON.stringify(props.op)}`);
            return;
        }
        // A shore has no feather band (its profile is the transition).
        const params: TerrainEditParams = { featherM: Number(props.featherM ?? (props.op === 'shore' ? 0 : 2)) };
        if (props.radiusM !== undefined) params.radiusM = Number(props.radiusM);
        if (props.flat) params.flat = true;
        if (props.smoothM !== undefined) params.smoothM = Number(props.smoothM);
        if (props.widthM !== undefined && props.widthM !== null) params.widthM = Number(props.widthM);
        for (const key of DIG_PARAM_KEYS) {
            if (props[key] === undefined || props[key] === null) continue;
            (params as unknown as Record<string, unknown>)[key] = key === 'reference' ? String(props[key]) : Number(props[key]);
        }
        for (const key of SHORE_PARAM_KEYS) {
            if (props[key] === undefined || props[key] === null) continue;
            params[key] = Number(props[key]);
        }
        if (Array.isArray(props.centerline)) {
            params.centerline = props.centerline.map((p: unknown) =>
                Array.isArray(p) && p.length >= 2 ? wgs84ToSweref99tm(Number(p[1]), Number(p[0])) : { x: NaN, y: NaN });
        }
        const rings: TerrainEditRing[] = geometry.coordinates.map((ring: [number, number][]) => {
            const pts = ring.map(([lon, lat]) => wgs84ToSweref99tm(lat, lon));
            const first = pts[0], last = pts[pts.length - 1];
            // GeoJSON rings repeat the first point; stored rings don't.
            if (pts.length > 1 && first && last && first.x === last.x && first.y === last.y) pts.pop();
            return pts;
        });
        try {
            assertValidParams(params);
            assertOpParams(props.op, params);
            assertValidRings(rings);
        } catch (e) {
            skipped.push(`feature ${i}: ${(e as Error).message}`);
            return;
        }
        edits.push({
            op: props.op,
            params,
            rings,
            originRef: typeof props.originRef === 'string' ? props.originRef : null,
        });
    });
    return { edits, skipped };
}

// --- Validation ---

export class InvalidTerrainEditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidTerrainEditError';
    }
}

/** A `recipe` edit the service refuses (the API answers 400: terrain-edits.api.ts). */
export class InvalidRecipeEditError extends InvalidTerrainEditError {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidRecipeEditError';
    }
}

function assertValidOp(op: string): asserts op is TerrainEditOp {
    if (!(TERRAIN_EDIT_OPS as readonly string[]).includes(op)) {
        throw new InvalidTerrainEditError(`Invalid terrain-edit op: ${op}`);
    }
}

function assertValidParams(params: TerrainEditParamsInput): asserts params is TerrainEditParams {
    if (!params || typeof params !== 'object') {
        throw new InvalidTerrainEditError('Params must be an object');
    }
    if (typeof params.featherM !== 'number' || !Number.isFinite(params.featherM) || params.featherM < 0) {
        throw new InvalidTerrainEditError('featherM must be a finite number >= 0');
    }
    if (params.radiusM !== undefined && (!Number.isFinite(params.radiusM) || params.radiusM <= 0)) {
        throw new InvalidTerrainEditError('radiusM must be a finite number > 0');
    }
    if (params.smoothM !== undefined && (!Number.isFinite(params.smoothM) || params.smoothM <= 0)) {
        throw new InvalidTerrainEditError('smoothM must be a finite number > 0');
    }
    if (params.widthM !== undefined && (!Number.isFinite(params.widthM) || params.widthM <= 0)) {
        throw new InvalidTerrainEditError('widthM must be a finite number > 0');
    }
    if (params.centerline !== undefined) {
        if (!Array.isArray(params.centerline) || params.centerline.length < 2
            || params.centerline.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
            throw new InvalidTerrainEditError('centerline must have at least 2 points with finite x/y');
        }
    }
}

function assertOpParams(op: TerrainEditOp, params: TerrainEditParams): void {
    if (op === 'corridor' && !params.centerline) {
        throw new InvalidTerrainEditError('A corridor edit needs a centerline');
    }
    if (op === 'dig') assertDigParams(params);
    if (op === 'shore') assertShoreParams(params);
    if (op === 'delta' && (typeof params.raster !== 'string' || !SCULPT_RASTER.test(params.raster))) {
        throw new InvalidTerrainEditError('A delta edit needs raster: inner-sculpt.tif or outer-sculpt.tif');
    }
}

// Mirrors the pipeline's dem_edit._dig_params, so a stored dig never gets skipped at replay.
function assertDigParams(p: TerrainEditParams): void {
    const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!finite(p.depthM) || p.depthM! <= 0) throw new InvalidTerrainEditError('A dig edit needs depthM > 0');
    for (const key of ['bankSlopeDeg', 'faceSlopeDeg', 'bankAboveDeg'] as const) {
        const v = p[key];
        if (v !== undefined && (!finite(v) || v <= 0 || v >= 90)) throw new InvalidTerrainEditError(`${key} must be between 0 and 90 degrees`);
    }
    if ((p.faceSlopeDeg === undefined) !== (p.faceBearingDeg === undefined)) {
        throw new InvalidTerrainEditError('faceSlopeDeg and faceBearingDeg go together');
    }
    if (p.faceBearingDeg !== undefined && !finite(p.faceBearingDeg)) throw new InvalidTerrainEditError('faceBearingDeg must be a finite number');
    if (p.shelfM !== undefined && (!finite(p.shelfM) || p.shelfM < 0)) throw new InvalidTerrainEditError('shelfM must be >= 0');
    if (p.shelfDepthM !== undefined && (!finite(p.shelfDepthM) || p.shelfDepthM < 0 || p.shelfDepthM >= p.depthM!)) {
        throw new InvalidTerrainEditError('shelfDepthM must be in [0, depthM)');
    }
    if (p.reference !== undefined && !(DIG_REFERENCES as readonly string[]).includes(p.reference)) {
        throw new InvalidTerrainEditError(`reference must be one of ${DIG_REFERENCES.join(', ')}`);
    }
    if (p.rimM !== undefined && (!finite(p.rimM) || p.rimM <= 0)) throw new InvalidTerrainEditError('rimM must be > 0');
    if (p.bankAboveDeg !== undefined && (p.reference ?? 'level') !== 'level') {
        throw new InvalidTerrainEditError("bankAboveDeg is for reference 'level' (a pond's water's edge)");
    }
    if (p.variation !== undefined && (!finite(p.variation) || p.variation < 0 || p.variation > 1)) {
        throw new InvalidTerrainEditError('variation must be in [0, 1]');
    }
    if (p.seed !== undefined && !Number.isInteger(p.seed)) throw new InvalidTerrainEditError('seed must be an integer');
}

/**
 * A shore needs its water level; every other shore param is optional, a
 * finite number >= 0 (`depthM` > 0), and the channel fades out past where it
 * is full. The rings are the lake (rings[0]) and its islands (the holes).
 */
function assertShoreParams(p: TerrainEditParams): void {
    const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!finite(p.levelM)) throw new InvalidTerrainEditError('A shore edit needs levelM (the water level)');
    for (const key of SHORE_PARAM_KEYS) {
        if (key === 'levelM' || p[key] === undefined) continue;
        if (!finite(p[key]) || p[key]! < 0) throw new InvalidTerrainEditError(`${key} must be a finite number >= 0`);
    }
    if (p.depthM !== undefined && p.depthM <= 0) throw new InvalidTerrainEditError('depthM must be > 0');
    if (p.channelFullM !== undefined && p.channelGoneM !== undefined && p.channelGoneM <= p.channelFullM) {
        throw new InvalidTerrainEditError('channelGoneM must be past channelFullM');
    }
}

/**
 * A recipe edit's params, normalized to what is stored (`{ featherM: 0,
 * recipe, overrides? }`). The recipe must be in the library and made for the
 * feature's surface when there is a library (without one — it is being built —
 * any plain id goes, and shaping-global reports ids it cannot resolve).
 * `overrides` (blender/SHAPING-PLAN.md, "Composite and parameterised recipes")
 * holds values for the recipe's declared params, each a number within the
 * param's min..max, and `seed`, an integer; any other key is refused (with no
 * library the param ids cannot be checked, only that values are numbers).
 */
async function recipeParams(params: TerrainEditParamsInput, surface: RecipeSurface, libraryFile: string): Promise<TerrainEditParams> {
    if (!params || typeof params !== 'object') throw new InvalidRecipeEditError('Params must be an object');
    const extra = Object.keys(params).filter(k => !['featherM', 'recipe', 'overrides'].includes(k));
    if (extra.length) throw new InvalidRecipeEditError(`A recipe edit takes only recipe and overrides (not ${extra.join(', ')})`);
    const { recipe, overrides } = params;
    if (typeof recipe !== 'string' || !/^[\w.-]+$/.test(recipe)) {
        throw new InvalidRecipeEditError('A recipe edit needs recipe: a recipe library id (or "none")');
    }
    const library = await loadRecipeLibrary(libraryFile);
    /** The params overrides may set; null = unknown (no library). */
    let known: RecipeParam[] | null = null;
    if (recipe === NO_RECIPE) {
        known = [];
    } else if (library) {
        const entry = library.find(e => e.id === recipe);
        if (!entry) throw new InvalidRecipeEditError(`Unknown recipe '${recipe}' (not in ${libraryFile})`);
        if (!entry.surfaces.includes(surface)) {
            throw new InvalidRecipeEditError(`Recipe '${recipe}' is for ${entry.surfaces.join(', ') || 'no surface'}, not ${surface}`);
        }
        known = entry.params;
    }
    const out: TerrainEditParams = { featherM: 0, recipe };
    if (overrides !== undefined) {
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
            throw new InvalidRecipeEditError('overrides must be an object');
        }
        const keys = Object.keys(overrides);
        if (keys.length > RECIPE_OVERRIDES_MAX_KEYS) throw new InvalidRecipeEditError(`overrides takes at most ${RECIPE_OVERRIDES_MAX_KEYS} keys`);
        if (keys.some(k => !k.trim())) throw new InvalidRecipeEditError('overrides keys must be non-empty');
        for (const key of keys) assertValidOverride(recipe, key, overrides[key], known);
        const json = JSON.stringify(overrides);
        if (json.length > RECIPE_OVERRIDES_MAX_BYTES) throw new InvalidRecipeEditError(`overrides must be under ${RECIPE_OVERRIDES_MAX_BYTES} bytes as JSON`);
        if (keys.length) out.overrides = JSON.parse(json) as Record<string, unknown>;
    }
    return out;
}

/** One `overrides` entry: `seed` an integer, else a param the recipe declares, within its range (`known` null: any finite number). */
function assertValidOverride(recipe: string, key: string, value: unknown, known: RecipeParam[] | null): void {
    if (key === RECIPE_SEED) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new InvalidRecipeEditError(`overrides.seed must be an integer (got ${JSON.stringify(value)})`);
        return;
    }
    const param = known ? known.find(p => p.id === key) : null;
    if (known && !param) {
        const ids = [...known.map(p => p.id), RECIPE_SEED].join(', ');
        throw new InvalidRecipeEditError(`Recipe '${recipe}' has no param '${key}' (overrides takes ${ids})`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidRecipeEditError(`overrides.${key} must be a number (got ${JSON.stringify(value)})`);
    }
    if (param && (value < param.min || value > param.max)) {
        throw new InvalidRecipeEditError(`overrides.${key} must be within ${param.min}..${param.max} (got ${value})`);
    }
}

/** rings[0] is the outline, any further ring a hole (a shore's islands); no bound on the points (a lake shore has tens of thousands). */
function assertValidRings(rings: TerrainEditRing[]): void {
    if (!Array.isArray(rings) || rings.length === 0) {
        throw new InvalidTerrainEditError('rings must have at least one ring');
    }
    for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 3) {
            throw new InvalidTerrainEditError('Each ring must have at least 3 points');
        }
        for (const p of ring) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                throw new InvalidTerrainEditError('Ring points must have finite x/y coordinates');
            }
        }
    }
}

/**
 * Site-scoped DEM edits (smooth/flatten). Stored as vector features — straight-
 * segment rings in the DEM CRS (EPSG:3006) plus an op + params — and replayed
 * onto the raw DEM at build time (T54/T56), never baked into `sources/dem.tif`.
 * Edits apply in `created_at` order (D-TE4) — generated ones (`origin` set,
 * e.g. the building pads) first, so a hand-drawn edit wins where they
 * overlap — and `listBySite` returns them so.
 */
export class TerrainEditsService {
    private readonly recipeLibrary: string;

    /** `recipeLibrary`: the shaping recipe library a `recipe` edit is checked against (default `defaultRecipeLibraryPath()`). */
    constructor(private db: Kysely<Database>, opts: { recipeLibrary?: string } = {}) {
        this.recipeLibrary = opts.recipeLibrary ?? defaultRecipeLibraryPath();
    }

    private edits() {
        return this.db.selectFrom('terrain_edits').selectAll();
    }

    private byId(id: string) {
        return this.edits().where('id', '=', id);
    }

    /** All edits for a site, oldest first (the deterministic apply order, D-TE4). */
    async listBySite(siteId: string): Promise<TerrainEdit[]> {
        const rows = await this.edits()
            .where('site_id', '=', siteId)
            .orderBy('created_at')
            .orderBy('id')
            .execute();
        return rows.map(toTerrainEdit);
    }

    /** The site's enabled edits that change the DEM (not `recipe`), in apply order: what every DEM replay takes. */
    async listDemEdits(siteId: string): Promise<TerrainEdit[]> {
        return (await this.listBySite(siteId)).filter(e => e.enabled && isDemEdit(e));
    }

    /**
     * How many of the site's terrain edits changed since `since` (an ISO
     * timestamp; null = unknown, which counts as nothing), and of which ops —
     * what the GSPro status board puts in the Terrain and Meshes rows'
     * "changed since". `ops` keeps only those ops, `exceptOps` drops them
     * (the Terrain row takes every op but `recipe`, the Meshes row only
     * `recipe`), `origins` only edits a given generator wrote.
     *
     * Two sources, deduplicated by edit id: a row whose `updated_at` moved
     * (created, edited or toggled since — a generated edit is dated at the
     * epoch in `created_at` to fix its replay slot, so only `updated_at` can
     * tell a fresh generation) and the migration-025 history, the only trace
     * a DELETED edit leaves.
     */
    async countChangesSince(
        siteId: string, since: string | null,
        filter: { ops?: readonly TerrainEditOp[]; exceptOps?: readonly TerrainEditOp[]; origins?: readonly string[] } = {},
    ): Promise<ChangeCount> {
        if (since === null) return { count: 0, kinds: [] };
        const at = sqlStamp(since);
        const keep = (op: string | null, origin: string | null) => {
            if (op === null) return false;
            if (filter.ops && !filter.ops.includes(op as TerrainEditOp)) return false;
            if (filter.exceptOps?.includes(op as TerrainEditOp)) return false;
            if (filter.origins && !filter.origins.includes(origin ?? '')) return false;
            return true;
        };
        const opOf = new Map<string, string>();
        const touched = await this.db.selectFrom('terrain_edits').select(['id', 'op', 'origin'])
            .where('site_id', '=', siteId).where('updated_at', '>', at).execute();
        for (const row of touched) if (keep(row.op, row.origin)) opOf.set(row.id, row.op);

        const history = await this.db.selectFrom('terrain_edit_history')
            .select([
                'edit_id',
                sql<string | null>`json_extract(row_json, '$.op')`.as('op'),
                sql<string | null>`json_extract(row_json, '$.origin')`.as('origin'),
            ])
            .where('site_id', '=', siteId).where('changed_at', '>', at)
            .execute();
        for (const row of history) {
            if (!keep(row.op, row.origin) || opOf.has(row.edit_id)) continue;
            opOf.set(row.edit_id, row.op!);
        }
        return { count: opOf.size, kinds: [...new Set(opOf.values())].sort() };
    }

    /**
     * Replaces the site's edits of one `origin` with a fresh generation
     * (`golfpipe building-pads` output), in one transaction: the previous
     * generation's rows go, the new ones come in, and a building the user
     * had disabled stays disabled (matched by `originRef`). Hand-drawn edits
     * and other origins are untouched.
     *
     * With `scope.courseId` the generation is one course's, not the site's:
     * a row whose `originRef` is `feature:<id>` of another course on the
     * same site belongs to that course and stays (several courses share a
     * site, and each generates the digs of its own features). Every other
     * row of the origin — the course's own, orphans of deleted features,
     * site-wide refs — is replaced.
     */
    async replaceByOrigin(
        siteId: string, origin: string, inputs: TerrainEditInput[], scope: { courseId?: string } = {},
    ): Promise<TerrainEdit[]> {
        if (!origin) throw new InvalidTerrainEditError('origin is required');
        if (origin === RECIPE_ORIGIN) throw new InvalidTerrainEditError(`origin '${RECIPE_ORIGIN}' belongs to the recipe edits, made one per feature`);
        for (const input of inputs) {
            assertValidOp(input.op);
            if (input.op === 'recipe') throw new InvalidTerrainEditError('recipe edits are made one per feature (create), not generated');
            assertValidParams(input.params);
            assertOpParams(input.op, input.params);
            assertValidRings(input.rings);
        }
        return this.db.transaction().execute(async (trx) => {
            const previous = await trx.selectFrom('terrain_edits')
                .select(['id', 'origin_ref', 'enabled', 'created_at'])
                .where('site_id', '=', siteId)
                .where('origin', '=', origin)
                .execute();
            const disabled = new Set(previous.filter(r => r.enabled === 0 && r.origin_ref).map(r => r.origin_ref));
            const othersRefs = scope.courseId ? await otherCoursesFeatureRefs(trx, siteId, scope.courseId, previous) : new Set<string>();
            const kept = previous.filter(r => r.origin_ref != null && othersRefs.has(r.origin_ref));
            if (kept.length === 0) {
                await trx.deleteFrom('terrain_edits')
                    .where('site_id', '=', siteId)
                    .where('origin', '=', origin)
                    .execute();
            } else {
                const keptIds = new Set(kept.map(r => r.id));
                const replaced = previous.filter(r => !keptIds.has(r.id)).map(r => r.id);
                for (let i = 0; i < replaced.length; i += SQL_IN_CHUNK) {
                    await trx.deleteFrom('terrain_edits').where('id', 'in', replaced.slice(i, i + SQL_IN_CHUNK)).execute();
                }
            }
            // Kept rows hold their slots in the origin's createdAt order; the new ones take the free ones.
            const taken = new Set(kept.map(r => generatedIndexOf(r.created_at)));
            let next = 0;
            const ids: string[] = [];
            for (const input of inputs) {
                while (taken.has(next)) next++;
                const index = next++;
                const id = crypto.randomUUID();
                ids.push(id);
                const keepDisabled = input.originRef != null && disabled.has(input.originRef);
                await trx.insertInto('terrain_edits').values({
                    id,
                    site_id: siteId,
                    op: input.op,
                    params_json: JSON.stringify(input.params),
                    rings_json: JSON.stringify(input.rings),
                    enabled: input.enabled === false || keepDisabled ? 0 : 1,
                    origin,
                    origin_ref: input.originRef ?? null,
                    version: 1,
                    // Dated at the epoch (+ the origin's slot + file order) so the one apply rule —
                    // createdAt order, D-TE4 — puts every generated edit before
                    // any hand-drawn one, here and in the pipeline's replay.
                    created_at: generatedCreatedAt(index, origin),
                }).execute();
            }
            if (ids.length === 0) return [];
            const rows = await trx.selectFrom('terrain_edits').selectAll()
                .where('id', 'in', ids)
                .orderBy('created_at').orderBy('id')
                .execute();
            return rows.map(toTerrainEdit);
        });
    }

    async get(id: string): Promise<TerrainEdit> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Terrain edit ${id} not found`);
        return toTerrainEdit(row);
    }

    async create(input: {
        id?: string;
        siteId: string;
        op: TerrainEditOp;
        params: TerrainEditParamsInput;
        /** Required for every op but `recipe` (which has none). */
        rings?: TerrainEditRing[];
        enabled?: boolean;
        origin?: string | null;
        originRef?: string | null;
        /** `recipe`: the course feature it shapes (on a course of `siteId`). */
        featureId?: string;
    }): Promise<TerrainEdit> {
        assertValidOp(input.op);
        if (input.op === 'recipe') return this.createRecipe({ ...input, op: 'recipe' });
        assertValidParams(input.params);
        assertOpParams(input.op, input.params);
        assertValidRings(input.rings!);

        const id = input.id ?? crypto.randomUUID();
        await this.db.insertInto('terrain_edits').values({
            id,
            site_id: input.siteId,
            op: input.op,
            params_json: JSON.stringify(input.params),
            rings_json: JSON.stringify(input.rings),
            enabled: input.enabled === false ? 0 : 1,
            origin: input.origin ?? null,
            origin_ref: input.originRef ?? null,
            version: 1,
        }).execute();
        return this.get(id);
    }

    /** The site's recipe edit of a feature, or null. */
    async recipeOf(siteId: string, featureId: string): Promise<TerrainEdit | null> {
        const row = await this.edits()
            .where('site_id', '=', siteId).where('op', '=', 'recipe')
            .where('origin_ref', '=', FEATURE_ORIGIN_REF + featureId)
            .orderBy('created_at').orderBy('id')
            .executeTakeFirst();
        return row ? toTerrainEdit(row) : null;
    }

    /**
     * A feature's recipe edit: origin `feature`, originRef `feature:<id>`, no
     * rings. The feature must be a bunker/water/creek/path of a course on the
     * site (course-scoped like the digs: another course on a shared site
     * never picks it up); a second one for the same feature is a 409 naming
     * the first - update that one instead.
     */
    private async createRecipe(input: {
        id?: string; siteId: string; op: 'recipe'; params: TerrainEditParamsInput; rings?: TerrainEditRing[];
        enabled?: boolean; featureId?: string;
    }): Promise<TerrainEdit> {
        if (input.rings !== undefined && (!Array.isArray(input.rings) || input.rings.length > 0)) {
            throw new InvalidRecipeEditError('A recipe edit has no rings (its feature is the shape)');
        }
        if (typeof input.featureId !== 'string' || !input.featureId) throw new InvalidRecipeEditError('A recipe edit needs featureId');
        const surface = await this.recipeSurfaceOf(input.siteId, input.featureId);
        const params = await recipeParams(input.params, surface, this.recipeLibrary);
        const id = input.id ?? crypto.randomUUID();
        const ref = FEATURE_ORIGIN_REF + input.featureId;
        await this.db.transaction().execute(async (trx) => {
            const existing = await trx.selectFrom('terrain_edits').select('id')
                .where('site_id', '=', input.siteId).where('op', '=', 'recipe').where('origin_ref', '=', ref)
                .executeTakeFirst();
            if (existing) throw new ConflictError(`Feature ${input.featureId} already has a recipe edit (${existing.id}): update that one`);
            await trx.insertInto('terrain_edits').values({
                id,
                site_id: input.siteId,
                op: 'recipe',
                params_json: JSON.stringify(params),
                rings_json: '[]',
                enabled: input.enabled === false ? 0 : 1,
                origin: RECIPE_ORIGIN,
                origin_ref: ref,
                version: 1,
            }).execute();
        });
        return this.get(id);
    }

    /** The recipe surface of a feature on a course of the site: 404 for no such feature; another site's, or a type without one, is invalid. */
    private async recipeSurfaceOf(siteId: string, featureId: string): Promise<RecipeSurface> {
        const row = await this.db.selectFrom('course_features')
            .innerJoin('courses', 'courses.id', 'course_features.course_id')
            .select(['course_features.type', 'courses.site_id'])
            .where('course_features.id', '=', featureId)
            .executeTakeFirst();
        if (!row) throw new NotFoundError(`Feature ${featureId} not found`);
        if (row.site_id !== siteId) throw new InvalidRecipeEditError(`Feature ${featureId} is not on a course of site ${siteId}`);
        const surface = FEATURE_RECIPE_SURFACE[row.type];
        if (!surface) throw new InvalidRecipeEditError(`A ${row.type} feature takes no shaping recipe (only ${Object.keys(FEATURE_RECIPE_SURFACE).join(', ')})`);
        return surface;
    }

    async update(
        id: string,
        version: number,
        patch: { op?: TerrainEditOp; params?: TerrainEditParamsInput; rings?: TerrainEditRing[]; enabled?: boolean },
    ): Promise<TerrainEdit> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Terrain edit ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('terrain_edits', id);

        if (patch.op !== undefined) assertValidOp(patch.op);
        if ((row.op === 'recipe') !== ((patch.op ?? row.op) === 'recipe')) {
            throw new InvalidRecipeEditError('An edit cannot become or stop being a recipe edit (create or remove one instead)');
        }
        let params: TerrainEditParams | undefined;
        let rings = patch.rings;
        if (row.op === 'recipe') {
            if (rings !== undefined && rings.length > 0) throw new InvalidRecipeEditError('A recipe edit has no rings (its feature is the shape)');
            rings = undefined;
            if (patch.params !== undefined) {
                const featureId = (row.origin_ref ?? '').slice(FEATURE_ORIGIN_REF.length);
                params = await recipeParams(patch.params, await this.recipeSurfaceOf(row.site_id, featureId), this.recipeLibrary);
            }
        } else if (patch.params !== undefined) {
            const p = patch.params;
            assertValidParams(p);
            params = p;
        }
        if (rings !== undefined) assertValidRings(rings);

        const dbInput: Record<string, unknown> = {};
        if (patch.op !== undefined) dbInput.op = patch.op;
        if (params !== undefined) dbInput.params_json = JSON.stringify(params);
        if (rings !== undefined) dbInput.rings_json = JSON.stringify(rings);
        if (patch.enabled !== undefined) dbInput.enabled = patch.enabled ? 1 : 0;

        await this.db.updateTable('terrain_edits').where('id', '=', id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        return this.get(id);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Terrain edit ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('terrain_edits', id);
        await this.db.deleteFrom('terrain_edits').where('id', '=', id).execute();
    }
}
