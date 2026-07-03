import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { GreensService } from '../services/greens.service';

// --- Input schemas ---

const GetByHoleInput = Type.Object({
    holeId: Type.String(),
});

const CreateGreenInput = Type.Object({
    holeId: Type.String(),
    centerLat: Type.Number(),
    centerLon: Type.Number(),
    frontLat: Type.Optional(Type.Number()),
    frontLon: Type.Optional(Type.Number()),
    backLat: Type.Optional(Type.Number()),
    backLon: Type.Optional(Type.Number()),
    elevation: Type.Optional(Type.Number()),
    boundaryJson: Type.Optional(Type.String()),
});

const UpdateGreenInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    centerLat: Type.Optional(Type.Number()),
    centerLon: Type.Optional(Type.Number()),
    frontLat: Type.Optional(Type.Number()),
    frontLon: Type.Optional(Type.Number()),
    backLat: Type.Optional(Type.Number()),
    backLon: Type.Optional(Type.Number()),
    elevation: Type.Optional(Type.Number()),
    boundaryJson: Type.Optional(Type.String()),
});

// --- API descriptor ---

export function createGreensApi(svc: GreensService) {
    const mw = [requireAuth()];
    return {
        getByHole: { method: 'GET'  as const, path: '/greens',        fn: (input: Static<typeof GetByHoleInput>)  => svc.getByHole(input.holeId),                                                                                                                                                                                       schema: GetByHoleInput,  middleware: mw },
        create:    { method: 'POST' as const, path: '/greens/create', fn: (input: Static<typeof CreateGreenInput>) => svc.create(input),                                                                                                                                                                                                    schema: CreateGreenInput, middleware: mw },
        update:    { method: 'POST' as const, path: '/greens/update', fn: (input: Static<typeof UpdateGreenInput>) => svc.update(input.id, input.version, { centerLat: input.centerLat, centerLon: input.centerLon, frontLat: input.frontLat, frontLon: input.frontLon, backLat: input.backLat, backLon: input.backLon, elevation: input.elevation, boundaryJson: input.boundaryJson }), schema: UpdateGreenInput, middleware: mw },
    };
}
