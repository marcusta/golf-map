import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { CourseFeaturesService } from '../services/course-features.service';

// --- Input schemas ---

const PointSchema = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
});

const AnchorPointSchema = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
    hIn: Type.Optional(PointSchema),
    hOut: Type.Optional(PointSchema),
    corner: Type.Optional(Type.Boolean()),
});

const PathRingSchema = Type.Object({
    points: Type.Array(AnchorPointSchema),
});

const FeatureGeometrySchema = Type.Object({
    crs: Type.String(),
    curveType: Type.Optional(Type.Union([Type.Literal('bezier'), Type.Literal('bspline')])),
    rings: Type.Array(PathRingSchema),
});

const ListFeaturesInput = Type.Object({
    courseId: Type.String(),
});

const ListFeaturesByHoleInput = Type.Object({
    holeId: Type.String(),
});

const GeojsonByCourseInput = Type.Object({
    courseId: Type.String(),
});

const CreateFeatureInput = Type.Object({
    courseId: Type.String(),
    holeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    type: Type.String(),
    geometry: FeatureGeometrySchema,
});

const UpdateFeatureInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    holeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    type: Type.Optional(Type.String()),
    geometry: Type.Optional(FeatureGeometrySchema),
});

const RemoveFeatureInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createCourseFeaturesApi(svc: CourseFeaturesService) {
    const mw = [requireAuth()];
    return {
        listByCourse: {
            method: 'GET' as const,
            path: '/features',
            fn: (input: Static<typeof ListFeaturesInput>) => svc.listByCourse(input.courseId),
            schema: ListFeaturesInput,
            middleware: mw,
        },
        listByHole: {
            method: 'GET' as const,
            path: '/features/by-hole',
            fn: (input: Static<typeof ListFeaturesByHoleInput>) => svc.listByHole(input.holeId),
            schema: ListFeaturesByHoleInput,
            middleware: mw,
        },
        geojsonByCourse: {
            method: 'GET' as const,
            path: '/features.geojson',
            fn: (input: Static<typeof GeojsonByCourseInput>) => svc.geojsonByCourse(input.courseId),
            schema: GeojsonByCourseInput,
            middleware: mw,
        },
        create: {
            method: 'POST' as const,
            path: '/features/create',
            fn: (input: Static<typeof CreateFeatureInput>) =>
                svc.create({
                    courseId: input.courseId,
                    holeId: input.holeId,
                    type: input.type,
                    geometry: input.geometry,
                }),
            schema: CreateFeatureInput,
            middleware: mw,
        },
        update: {
            method: 'POST' as const,
            path: '/features/update',
            fn: (input: Static<typeof UpdateFeatureInput>) =>
                svc.update(input.id, input.version, {
                    holeId: input.holeId,
                    type: input.type,
                    geometry: input.geometry,
                }),
            schema: UpdateFeatureInput,
            middleware: mw,
        },
        remove: {
            method: 'POST' as const,
            path: '/features/remove',
            fn: (input: Static<typeof RemoveFeatureInput>) => svc.remove(input.id, input.version),
            schema: RemoveFeatureInput,
            middleware: mw,
        },
    };
}
