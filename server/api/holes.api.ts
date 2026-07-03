import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { HolesService } from '../services/holes.service';

// --- Input schemas ---

const ListHolesByCourseInput = Type.Object({
    courseId: Type.String(),
});

const GetHoleInput = Type.Object({
    id: Type.String(),
});

const CreateHoleInput = Type.Object({
    courseId: Type.String(),
    number: Type.Number(),
    par: Type.Number(),
    notes: Type.Optional(Type.String()),
    savedRegionJson: Type.Optional(Type.String()),
});

const UpdateHoleInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    par: Type.Optional(Type.Number()),
    notes: Type.Optional(Type.String()),
    savedRegionJson: Type.Optional(Type.String()),
});

const RemoveHoleInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createHolesApi(svc: HolesService) {
    const mw = [requireAuth()];
    return {
        listByCourse: { method: 'GET'  as const, path: '/holes',                   fn: (input: Static<typeof ListHolesByCourseInput>) => svc.listByCourse(input.courseId),                                                                          schema: ListHolesByCourseInput, middleware: mw },
        get:          { method: 'GET'  as const, path: '/holes/get',               fn: (input: Static<typeof GetHoleInput>)           => svc.get(input.id),                                                                                          schema: GetHoleInput,           middleware: mw },
        create:       { method: 'POST' as const, path: '/holes/create',            fn: (input: Static<typeof CreateHoleInput>)        => svc.create(input),                                                                                          schema: CreateHoleInput,        middleware: mw },
        update:       { method: 'POST' as const, path: '/holes/update',            fn: (input: Static<typeof UpdateHoleInput>)        => svc.update(input.id, input.version, { par: input.par, notes: input.notes, savedRegionJson: input.savedRegionJson }), schema: UpdateHoleInput,        middleware: mw },
        remove:       { method: 'POST' as const, path: '/holes/remove',            fn: (input: Static<typeof RemoveHoleInput>)        => svc.remove(input.id, input.version),                                                                        schema: RemoveHoleInput,        middleware: mw },
    };
}
