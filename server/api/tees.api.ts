import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TeesService } from '../services/tees.service';

// --- Input schemas ---

const ListByHoleInput = Type.Object({
    holeId: Type.String(),
});

const ListByCourseInput = Type.Object({
    courseId: Type.String(),
});

const CreateTeeInput = Type.Object({
    holeId: Type.String(),
    name: Type.String(),
    color: Type.Optional(Type.String()),
    lat: Type.Number(),
    lon: Type.Number(),
    elevation: Type.Optional(Type.Number()),
});

const UpdateTeeInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    name: Type.Optional(Type.String()),
    color: Type.Optional(Type.String()),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    elevation: Type.Optional(Type.Number()),
});

const RemoveTeeInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const ReorderTeesInput = Type.Object({
    holeId: Type.String(),
    orderedIds: Type.Array(Type.String()),
});

// --- API descriptor ---

export function createTeesApi(svc: TeesService) {
    const mw = [requireAuth()];
    return {
        listByHole:   { method: 'GET'  as const, path: '/tees',           fn: (input: Static<typeof ListByHoleInput>)   => svc.listByHole(input.holeId),                                                                                        schema: ListByHoleInput,   middleware: mw },
        listByCourse: { method: 'GET'  as const, path: '/tees/by-course', fn: (input: Static<typeof ListByCourseInput>) => svc.listByCourse(input.courseId),                                                                                    schema: ListByCourseInput, middleware: mw },
        create:       { method: 'POST' as const, path: '/tees/create',    fn: (input: Static<typeof CreateTeeInput>)    => svc.create(input),                                                                                                    schema: CreateTeeInput,    middleware: mw },
        update:       { method: 'POST' as const, path: '/tees/update',    fn: (input: Static<typeof UpdateTeeInput>)    => svc.update(input.id, input.version, { name: input.name, color: input.color, lat: input.lat, lon: input.lon, elevation: input.elevation }), schema: UpdateTeeInput, middleware: mw },
        remove:       { method: 'POST' as const, path: '/tees/remove',    fn: (input: Static<typeof RemoveTeeInput>)    => svc.remove(input.id, input.version),                                                                                  schema: RemoveTeeInput,    middleware: mw },
        reorder:      { method: 'POST' as const, path: '/tees/reorder',   fn: (input: Static<typeof ReorderTeesInput>)  => svc.reorder(input.holeId, input.orderedIds),                                                                          schema: ReorderTeesInput,  middleware: mw },
    };
}
