import { Type, type Static } from '@sinclair/typebox';
import type { Context, MiddlewareHandler } from 'hono';
import { requireAuth } from '@basics/core/server/auth';
import { InvalidRecipeEditError, parseEditsGeojson, type TerrainEditsService } from '../services/terrain-edits.service';

// A refused recipe edit answers 400. mount() maps no error class to 400, so the
// handler catches InvalidRecipeEditError, records its message here, and the
// endpoint's middleware replaces the response once the handler is done.
const refusedRecipe = new WeakMap<Context, string>();
const recipeRefusalAs400: MiddlewareHandler = async (c, next) => {
    await next();
    const message = refusedRecipe.get(c);
    if (message !== undefined) c.res = c.json({ error: message }, 400);
};
async function recipeChecked<T>(c: Context, f: () => Promise<T>): Promise<T> {
    try {
        return await f();
    } catch (e) {
        if (!(e instanceof InvalidRecipeEditError)) throw e;
        refusedRecipe.set(c, e.message);
        return null as T;  // never sent: the middleware answers 400
    }
}

// --- Input schemas ---

const OpSchema = Type.Union([Type.Literal('plane'), Type.Literal('smooth'), Type.Literal('corridor'), Type.Literal('dig'), Type.Literal('delta'), Type.Literal('recipe')]);

// A straight-segment ring in the DEM CRS (EPSG:3006).
const RingSchema = Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }));
const RingsSchema = Type.Array(RingSchema);

const ParamsSchema = Type.Object({
    // Required for every op but `recipe` (checked by the service).
    featherM: Type.Optional(Type.Number()),
    radiusM: Type.Optional(Type.Number()),
    flat: Type.Optional(Type.Boolean()),
    // corridor (pipeline-generated road grading): the road's axis, along-road window, pavement width.
    centerline: Type.Optional(RingSchema),
    smoothM: Type.Optional(Type.Number()),
    widthM: Type.Optional(Type.Number()),
    // dig (generated bunker/water digs): depth profile below a level or a fitted plane.
    depthM: Type.Optional(Type.Number()),
    bankSlopeDeg: Type.Optional(Type.Number()),
    faceSlopeDeg: Type.Optional(Type.Number()),
    faceBearingDeg: Type.Optional(Type.Number()),
    shelfM: Type.Optional(Type.Number()),
    shelfDepthM: Type.Optional(Type.Number()),
    reference: Type.Optional(Type.Union([Type.Literal('level'), Type.Literal('plane'), Type.Literal('stream')])),
    rimM: Type.Optional(Type.Number()),
    variation: Type.Optional(Type.Number()),
    seed: Type.Optional(Type.Number()),
    // delta (a Unity sculpt layer, "Pull from Unity"): its GeoTIFF's name and what it holds.
    raster: Type.Optional(Type.String()),
    changedM2: Type.Optional(Type.Number()),
    maxRaiseM: Type.Optional(Type.Number()),
    maxLowerM: Type.Optional(Type.Number()),
    // recipe (a course feature's Blender shaping recipe): a recipe library id (`none` = no recipe, not even the default) and per-feature overrides.
    recipe: Type.Optional(Type.String()),
    overrides: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const ListTerrainEditsInput = Type.Object({
    siteId: Type.String(),
});

const CreateTerrainEditInput = Type.Object({
    siteId: Type.String(),
    op: OpSchema,
    params: ParamsSchema,
    // Every op but `recipe` (none: its feature is the shape).
    rings: Type.Optional(RingsSchema),
    enabled: Type.Optional(Type.Boolean()),
    // recipe: the course feature (bunker, water, water_creek, path) on a course of the site. One recipe edit per feature (409).
    featureId: Type.Optional(Type.String()),
});

const UpdateTerrainEditInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    op: Type.Optional(OpSchema),
    params: Type.Optional(ParamsSchema),
    rings: Type.Optional(RingsSchema),
    enabled: Type.Optional(Type.Boolean()),
});

const RemoveTerrainEditInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// A generated edits file (the pipeline's D-TE5 handoff, WGS84 polygons) to
// import under one origin, replacing that origin's previous generation.
const ImportTerrainEditsInput = Type.Object({
    siteId: Type.String(),
    origin: Type.String(),
    geojson: Type.Unknown(),
});

// --- API descriptor ---

export function createTerrainEditsApi(svc: TerrainEditsService) {
    const mw = [requireAuth()];
    const writeMw = [requireAuth(), recipeRefusalAs400];
    return {
        list:   { method: 'GET'  as const, path: '/terrain-edits',        fn: (input: Static<typeof ListTerrainEditsInput>)   => svc.listBySite(input.siteId),                                                        schema: ListTerrainEditsInput,   middleware: mw },
        create: { method: 'POST' as const, path: '/terrain-edits/create', fn: (input: Static<typeof CreateTerrainEditInput>, c: Context) => recipeChecked(c, () => svc.create(input)), schema: CreateTerrainEditInput, middleware: writeMw },
        update: { method: 'POST' as const, path: '/terrain-edits/update', fn: (input: Static<typeof UpdateTerrainEditInput>, c: Context) => recipeChecked(c, () => svc.update(input.id, input.version, { op: input.op, params: input.params, rings: input.rings, enabled: input.enabled })), schema: UpdateTerrainEditInput, middleware: writeMw },
        remove: { method: 'POST' as const, path: '/terrain-edits/remove', fn: (input: Static<typeof RemoveTerrainEditInput>)  => svc.remove(input.id, input.version),                                                   schema: RemoveTerrainEditInput,  middleware: mw },
        // Generated edits (building pads): replace one origin's previous generation from a D-TE5 file.
        import: { method: 'POST' as const, path: '/terrain-edits/import', fn: async (input: Static<typeof ImportTerrainEditsInput>) => {
            const { edits, skipped } = parseEditsGeojson(input.geojson);
            const imported = await svc.replaceByOrigin(input.siteId, input.origin, edits);
            return { imported, skipped };
        }, schema: ImportTerrainEditsInput, middleware: mw },
    };
}
