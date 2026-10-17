import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { HolesService } from '../services/holes.service';

// --- Input schemas ---

const ListHolesByCourseInput = Type.Object({
    courseId: Type.String(),
    includeDrawingGroups: Type.Optional(Type.Boolean()),
});

const GetHoleInput = Type.Object({
    id: Type.String(),
});

const CreateHoleInput = Type.Object({
    courseId: Type.String(),
    number: Type.Number(),
    par: Type.Number(),
    drawingGroupName: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    savedRegionJson: Type.Optional(Type.String()),
});

const UpdateHoleInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    drawingGroupName: Type.Optional(Type.String()),
    drawingGroupAfter: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 98 }), Type.Null()])),
    drawingGroupBeforeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    layerBeforeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    par: Type.Optional(Type.Number()),
    strokeIndex: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
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
        listByCourse: { method: 'GET'  as const, path: '/holes',                   fn: (input: Static<typeof ListHolesByCourseInput>) => svc.listByCourse(input.courseId, input.includeDrawingGroups),                                              schema: ListHolesByCourseInput, middleware: mw },
        get:          { method: 'GET'  as const, path: '/holes/get',               fn: (input: Static<typeof GetHoleInput>)           => svc.get(input.id),                                                                                          schema: GetHoleInput,           middleware: mw },
        create:       { method: 'POST' as const, path: '/holes/create',            fn: (input: Static<typeof CreateHoleInput>)        => svc.create(input),                                                                                          schema: CreateHoleInput,        middleware: mw },
        update:       { method: 'POST' as const, path: '/holes/update',            fn: (input: Static<typeof UpdateHoleInput>)        => svc.update(input.id, input.version, input),                                                                 schema: UpdateHoleInput,        middleware: mw },
        remove:       { method: 'POST' as const, path: '/holes/remove',            fn: (input: Static<typeof RemoveHoleInput>)        => svc.remove(input.id, input.version),                                                                        schema: RemoveHoleInput,        middleware: mw },
    };
}
