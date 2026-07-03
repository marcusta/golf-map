import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { ClubsService } from '../services/clubs.service';

// --- Input schemas ---

const ListClubsInput = Type.Object({
    userId: Type.Optional(Type.String()),
});

const CreateClubInput = Type.Object({
    userId: Type.Optional(Type.String()),
    name: Type.String(),
    carryM: Type.Number(),
    dispersionM: Type.Number(),
});

const UpdateClubInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    name: Type.Optional(Type.String()),
    carryM: Type.Optional(Type.Number()),
    dispersionM: Type.Optional(Type.Number()),
});

const RemoveClubInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const ReorderClubsInput = Type.Object({
    orderedIds: Type.Array(Type.String()),
});

// --- API descriptor ---

export function createClubsApi(svc: ClubsService) {
    const mw = [requireAuth()];
    return {
        list:    { method: 'GET'  as const, path: '/clubs',         fn: (input: Static<typeof ListClubsInput>)    => svc.list(input.userId),                                                                          schema: ListClubsInput,    middleware: mw },
        create:  { method: 'POST' as const, path: '/clubs/create',  fn: (input: Static<typeof CreateClubInput>)   => svc.create(input),                                                                              schema: CreateClubInput,   middleware: mw },
        update:  { method: 'POST' as const, path: '/clubs/update',  fn: (input: Static<typeof UpdateClubInput>)   => svc.update(input.id, input.version, { name: input.name, carryM: input.carryM, dispersionM: input.dispersionM }), schema: UpdateClubInput, middleware: mw },
        remove:  { method: 'POST' as const, path: '/clubs/remove',  fn: (input: Static<typeof RemoveClubInput>)   => svc.remove(input.id, input.version),                                                            schema: RemoveClubInput,   middleware: mw },
        reorder: { method: 'POST' as const, path: '/clubs/reorder', fn: (input: Static<typeof ReorderClubsInput>) => svc.reorder(input.orderedIds),                                                                  schema: ReorderClubsInput, middleware: mw },
    };
}
