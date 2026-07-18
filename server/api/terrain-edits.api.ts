import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TerrainEditsService } from '../services/terrain-edits.service';

// --- Input schemas ---

const OpSchema = Type.Union([Type.Literal('plane'), Type.Literal('smooth')]);

const ParamsSchema = Type.Object({
    featherM: Type.Number(),
    radiusM: Type.Optional(Type.Number()),
    flat: Type.Optional(Type.Boolean()),
});

// A straight-segment ring in the DEM CRS (EPSG:3006).
const RingSchema = Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }));
const RingsSchema = Type.Array(RingSchema);

const ListTerrainEditsInput = Type.Object({
    siteId: Type.String(),
});

const CreateTerrainEditInput = Type.Object({
    siteId: Type.String(),
    op: OpSchema,
    params: ParamsSchema,
    rings: RingsSchema,
    enabled: Type.Optional(Type.Boolean()),
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

// --- API descriptor ---

export function createTerrainEditsApi(svc: TerrainEditsService) {
    const mw = [requireAuth()];
    return {
        list:   { method: 'GET'  as const, path: '/terrain-edits',        fn: (input: Static<typeof ListTerrainEditsInput>)   => svc.listBySite(input.siteId),                                                        schema: ListTerrainEditsInput,   middleware: mw },
        create: { method: 'POST' as const, path: '/terrain-edits/create', fn: (input: Static<typeof CreateTerrainEditInput>)  => svc.create(input),                                                                    schema: CreateTerrainEditInput,  middleware: mw },
        update: { method: 'POST' as const, path: '/terrain-edits/update', fn: (input: Static<typeof UpdateTerrainEditInput>)  => svc.update(input.id, input.version, { op: input.op, params: input.params, rings: input.rings, enabled: input.enabled }), schema: UpdateTerrainEditInput, middleware: mw },
        remove: { method: 'POST' as const, path: '/terrain-edits/remove', fn: (input: Static<typeof RemoveTerrainEditInput>)  => svc.remove(input.id, input.version),                                                   schema: RemoveTerrainEditInput,  middleware: mw },
    };
}
