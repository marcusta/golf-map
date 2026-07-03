import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { AimPointsService } from '../services/aim-points.service';

// --- Input schemas ---

const ListByHoleInput = Type.Object({
    holeId: Type.String(),
});

const CreateAimPointInput = Type.Object({
    holeId: Type.String(),
    lat: Type.Number(),
    lon: Type.Number(),
    elevation: Type.Optional(Type.Number()),
    label: Type.Optional(Type.String()),
});

const UpdateAimPointInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    elevation: Type.Optional(Type.Number()),
    label: Type.Optional(Type.String()),
});

const RemoveAimPointInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const ReorderAimPointsInput = Type.Object({
    holeId: Type.String(),
    orderedIds: Type.Array(Type.String()),
});

// --- API descriptor ---

export function createAimPointsApi(svc: AimPointsService) {
    const mw = [requireAuth()];
    return {
        listByHole: { method: 'GET'  as const, path: '/aim-points',          fn: (input: Static<typeof ListByHoleInput>)      => svc.listByHole(input.holeId),                                                                          schema: ListByHoleInput,      middleware: mw },
        create:     { method: 'POST' as const, path: '/aim-points/create',   fn: (input: Static<typeof CreateAimPointInput>)  => svc.create(input),                                                                                     schema: CreateAimPointInput,  middleware: mw },
        update:     { method: 'POST' as const, path: '/aim-points/update',   fn: (input: Static<typeof UpdateAimPointInput>)  => svc.update(input.id, input.version, { lat: input.lat, lon: input.lon, elevation: input.elevation, label: input.label }), schema: UpdateAimPointInput, middleware: mw },
        remove:     { method: 'POST' as const, path: '/aim-points/remove',   fn: (input: Static<typeof RemoveAimPointInput>)  => svc.remove(input.id, input.version),                                                                  schema: RemoveAimPointInput,  middleware: mw },
        reorder:    { method: 'POST' as const, path: '/aim-points/reorder',  fn: (input: Static<typeof ReorderAimPointsInput>) => svc.reorder(input.holeId, input.orderedIds),                                                          schema: ReorderAimPointsInput, middleware: mw },
    };
}
