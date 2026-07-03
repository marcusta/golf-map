import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import { PaginationSchema } from '@basics/core/server/paginate';
import type { CoursesService } from '../services/courses.service';

// --- Input schemas ---

const ListCoursesInput = Type.Intersect([PaginationSchema]);

const GetCourseInput = Type.Object({
    id: Type.String(),
});

const CreateCourseInput = Type.Object({
    name: Type.String(),
    crs: Type.Optional(Type.String()),
    georeferenceJson: Type.Optional(Type.String()),
    homeLat: Type.Optional(Type.Number()),
    homeLon: Type.Optional(Type.Number()),
    notes: Type.Optional(Type.String()),
});

const UpdateCourseInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    name: Type.Optional(Type.String()),
    crs: Type.Optional(Type.String()),
    georeferenceJson: Type.Optional(Type.String()),
    homeLat: Type.Optional(Type.Number()),
    homeLon: Type.Optional(Type.Number()),
    notes: Type.Optional(Type.String()),
});

const RemoveCourseInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const PublishCourseInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createCoursesApi(svc: CoursesService) {
    const mw = [requireAuth()];
    return {
        list:    { method: 'GET'  as const, path: '/courses',         fn: (input: Static<typeof ListCoursesInput>)   => svc.list(input.offset, input.limit),                                                                                                                     schema: ListCoursesInput,   middleware: mw },
        get:     { method: 'GET'  as const, path: '/courses/get',     fn: (input: Static<typeof GetCourseInput>)     => svc.get(input.id),                                                                                                                                        schema: GetCourseInput,     middleware: mw },
        create:  { method: 'POST' as const, path: '/courses/create',  fn: (input: Static<typeof CreateCourseInput>)  => svc.create(input),                                                                                                                                        schema: CreateCourseInput,  middleware: mw },
        update:  { method: 'POST' as const, path: '/courses/update',  fn: (input: Static<typeof UpdateCourseInput>)  => svc.update(input.id, input.version, { name: input.name, crs: input.crs, georeferenceJson: input.georeferenceJson, homeLat: input.homeLat, homeLon: input.homeLon, notes: input.notes }), schema: UpdateCourseInput,  middleware: mw },
        remove:  { method: 'POST' as const, path: '/courses/remove',  fn: (input: Static<typeof RemoveCourseInput>)  => svc.remove(input.id, input.version),                                                                                                                      schema: RemoveCourseInput,  middleware: mw },
        publish: { method: 'POST' as const, path: '/courses/publish', fn: (input: Static<typeof PublishCourseInput>) => svc.publish(input.id, input.version),                                                                                                                     schema: PublishCourseInput, middleware: mw },
    };
}
