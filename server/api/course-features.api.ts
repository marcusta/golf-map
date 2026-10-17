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

// The shape of one end of a centerline road (shared/features/centerline.ts
// CenterlineCap); the service checks the sizes (capError).
const CenterlineCapSchema = Type.Object({
    shape: Type.Union([Type.Literal('rounded'), Type.Literal('turning'), Type.Literal('taper')]),
    rounding: Type.Optional(Type.Number()),
    diameterM: Type.Optional(Type.Number()),
    lengthM: Type.Optional(Type.Number()),
    endWidthM: Type.Optional(Type.Number()),
});

// A road/path as its middle line plus a width; the server derives `rings`
// (the corridor) from it, so a client sending one may send any rings.
const CenterlineSchema = Type.Object({
    points: Type.Array(Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        corner: Type.Optional(Type.Boolean()),
    })),
    widthM: Type.Number(),
    startCap: Type.Optional(CenterlineCapSchema),
    endCap: Type.Optional(CenterlineCapSchema),
});

const FeatureGeometrySchema = Type.Object({
    crs: Type.String(),
    curveType: Type.Optional(Type.Union([Type.Literal('bezier'), Type.Literal('bspline')])),
    rings: Type.Array(PathRingSchema),
    centerline: Type.Optional(CenterlineSchema),
});

// Flat scalar attributes (e.g. lidar tree heights); null clears on update.
// Key-count and value checks live in the service (InvalidFeatureError).
const PathTransitionSchema = Type.Object({
    id: Type.String(), pattern: Type.Union([Type.Literal('soft-fade'), Type.Literal('overgrown-gravel'), Type.Literal('wheel-tracks')]),
    placement: Type.Union([Type.Literal('start'), Type.Literal('end'), Type.Literal('section')]),
    startM: Type.Number(), direction: Type.Union([Type.Literal(1), Type.Literal(-1)]),
    transitionLengthM: Type.Number(), holdLengthM: Type.Number(), fadeLengthM: Type.Number(),
    ending: Type.Union([Type.Literal('grass'), Type.Literal('continue')]),
    edgeIrregularity: Type.Number(), dirtAmount: Type.Number(), centerGrassReachM: Type.Number(),
    trackWidthM: Type.Number(), trackSpacingM: Type.Number(), variation: Type.Number(), seed: Type.Number(),
});
const FeatureAttributesSchema = Type.Union([
    Type.Null(),
    Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Array(PathTransitionSchema)])),
]);

// D28: 'roughs' = the Roughs group under every hole; null = hole / course-level.
const FeatureLayerSchema = Type.Union([Type.Literal('roughs'), Type.Null()]);

const ListFeaturesInput = Type.Object({
    courseId: Type.String(),
});

const ListFeaturesByHoleInput = Type.Object({
    holeId: Type.String(),
});

const GeojsonByCourseInput = Type.Object({
    courseId: Type.String(),
    // Resolve the surface stack server-side (clip lower surfaces out from
    // under higher ones) — for render-only consumers like the iOS bundle
    // whose semi-transparent fills would otherwise compound at overlaps.
    resolved: Type.Optional(Type.Boolean()),
});

const CreateFeatureInput = Type.Object({
    courseId: Type.String(),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
    holeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    layer: Type.Optional(FeatureLayerSchema),
    type: Type.String(),
    geometry: FeatureGeometrySchema,
    // Import provenance (T49) — set by the GeoJSON draft-import wizard for
    // pipeline output (e.g. fetch-osm: source 'osm', license 'ODbL').
    source: Type.Optional(Type.String()),
    sourceRef: Type.Optional(Type.String()),
    license: Type.Optional(Type.String()),
    attributes: Type.Optional(FeatureAttributesSchema),
});

const UpdateFeatureInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    holeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    layer: Type.Optional(FeatureLayerSchema),
    type: Type.Optional(Type.String()),
    geometry: Type.Optional(FeatureGeometrySchema),
    attributes: Type.Optional(FeatureAttributesSchema),
});

const RemoveFeatureInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const RemoveImportedInput = Type.Object({
    courseId: Type.String(),
    sources: Type.Array(Type.String()),
    types: Type.Optional(Type.Array(Type.String())),
});

// Batch inputs: one SQLite transaction per call. A version conflict on any
// row rejects the whole batch (409) and writes nothing.
const CreateManyFeaturesInput = Type.Object({
    courseId: Type.String(),
    items: Type.Array(Type.Omit(CreateFeatureInput, ['courseId'])),
});

const UpdateManyFeaturesInput = Type.Object({
    items: Type.Array(UpdateFeatureInput),
});

const RemoveManyFeaturesInput = Type.Object({
    items: Type.Array(RemoveFeatureInput),
});

const ReorderFeaturesInput = Type.Object({
    courseId: Type.String(),
    holeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    layer: Type.Optional(FeatureLayerSchema),
    orderedIds: Type.Array(Type.String()),
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
            fn: (input: Static<typeof GeojsonByCourseInput>) =>
                svc.geojsonByCourse(input.courseId, { resolved: input.resolved ?? false }),
            schema: GeojsonByCourseInput,
            middleware: mw,
        },
        create: {
            method: 'POST' as const,
            path: '/features/create',
            fn: (input: Static<typeof CreateFeatureInput>) =>
                svc.create({
                    courseId: input.courseId,
                    sortOrder: input.sortOrder,
                    holeId: input.holeId,
                    layer: input.layer,
                    type: input.type,
                    geometry: input.geometry,
                    source: input.source,
                    sourceRef: input.sourceRef,
                    license: input.license,
                    attributes: input.attributes,
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
                    layer: input.layer,
                    type: input.type,
                    geometry: input.geometry,
                    attributes: input.attributes,
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
        /** The course's imported features per (source, type) — what the import wizard offers to clear. */
        imported: {
            method: 'GET' as const,
            path: '/course-features/imported',
            fn: (input: Static<typeof CourseInput>) => svc.importedByCourse(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /** Delete imported features by source (and type), so a fetch can be re-imported clean. */
        removeImported: {
            method: 'POST' as const,
            path: '/course-features/remove-imported',
            fn: (input: Static<typeof RemoveImportedInput>) => svc.removeImported(input.courseId, input.sources, input.types),
            schema: RemoveImportedInput,
            middleware: mw,
        },
        createMany: {
            method: 'POST' as const,
            path: '/features/create-many',
            fn: (input: Static<typeof CreateManyFeaturesInput>) => svc.createMany(input.courseId, input.items),
            schema: CreateManyFeaturesInput,
            middleware: mw,
        },
        updateMany: {
            method: 'POST' as const,
            path: '/features/update-many',
            fn: (input: Static<typeof UpdateManyFeaturesInput>) => svc.updateMany(input.items),
            schema: UpdateManyFeaturesInput,
            middleware: mw,
        },
        removeMany: {
            method: 'POST' as const,
            path: '/features/remove-many',
            fn: (input: Static<typeof RemoveManyFeaturesInput>) => svc.removeMany(input.items),
            schema: RemoveManyFeaturesInput,
            middleware: mw,
        },
        reorder: {
            method: 'POST' as const,
            path: '/course-features/reorder',
            fn: (input: Static<typeof ReorderFeaturesInput>) =>
                svc.reorder(input.courseId, input.holeId ?? null, input.orderedIds, input.layer ?? null),
            schema: ReorderFeaturesInput,
            middleware: mw,
        },
    };
}
