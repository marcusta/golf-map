import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PhotosService } from '../services/photos.service';

// --- Input schemas ---
//
// Ranges follow docs/feature-reference-photos.md §4.2. The service checks the
// same ranges, so a direct service call cannot store an out-of-range pose.

const Id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' });
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const Hole = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
const Tags = Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 });
const Note = Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]);

const AttitudeQuat = Type.Object({
    w: Type.Number(),
    x: Type.Number(),
    y: Type.Number(),
    z: Type.Number(),
});

const CreatePhotoInput = Type.Object({
    id: Id,
    siteId: Id,
    courseId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    hole: Type.Optional(Hole),
    // ISO 8601 with a zone, e.g. 2026-10-02T09:14:31Z.
    capturedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$' }),
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lon: Type.Number({ minimum: -180, maximum: 180 }),
    hAccM: Type.Number({ minimum: 0 }),
    gpsAltM: Type.Optional(NullableNumber),
    vAccM: Type.Optional(NullableNumber),
    attitudeQuat: Type.Optional(Type.Union([AttitudeQuat, Type.Null()])),
    yawDeg: Type.Number({ minimum: 0, exclusiveMaximum: 360 }),
    pitchDeg: Type.Number({ minimum: -90, maximum: 90 }),
    rollDeg: Type.Number({ exclusiveMinimum: -180, maximum: 180 }),
    headingAccDeg: Type.Optional(NullableNumber),
    magCalibration: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    hfovDeg: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 180 }),
    vfovDeg: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 180 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    eyeHeightM: Type.Optional(Type.Number({ minimum: 0 })),
    deviceModel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    lens: Type.Optional(Type.String()),
    tags: Type.Optional(Tags),
    note: Type.Optional(Note),
});

const ListPhotosInput = Type.Object({
    siteId: Type.String(),
});

const GetPhotoInput = Type.Object({
    id: Type.String(),
});

const UpdatePhotoInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    tags: Type.Optional(Tags),
    note: Type.Optional(Note),
    hole: Type.Optional(Hole),
});

const RemovePhotoInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---
//
// The file upload/download (`PUT`/`GET /api/photos/file/:id`) and the builder
// pull routes are raw Hono routes in `photos.routes.ts`.

export function createPhotosApi(svc: PhotosService) {
    const mw = [requireAuth()];
    return {
        create: { method: 'POST' as const, path: '/photos/create', fn: (input: Static<typeof CreatePhotoInput>) => svc.create(input), schema: CreatePhotoInput, middleware: mw },
        list:   { method: 'GET'  as const, path: '/photos/list',   fn: (input: Static<typeof ListPhotosInput>)  => svc.listBySite(input.siteId), schema: ListPhotosInput, middleware: mw },
        get:    { method: 'GET'  as const, path: '/photos/get',    fn: (input: Static<typeof GetPhotoInput>)    => svc.get(input.id), schema: GetPhotoInput, middleware: mw },
        update: { method: 'POST' as const, path: '/photos/update', fn: (input: Static<typeof UpdatePhotoInput>) => svc.update(input.id, input.version, { tags: input.tags, note: input.note, hole: input.hole }), schema: UpdatePhotoInput, middleware: mw },
        remove: { method: 'POST' as const, path: '/photos/remove', fn: (input: Static<typeof RemovePhotoInput>) => svc.remove(input.id, input.version), schema: RemovePhotoInput, middleware: mw },
    };
}
