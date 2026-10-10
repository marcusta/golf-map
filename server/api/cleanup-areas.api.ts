import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { Context, MiddlewareHandler } from 'hono';
import { InvalidCleanupAreasError, type CleanupAreasService } from '../services/cleanup-areas.service';

// mount() does not map domain validation errors to 400 (same pattern as terrain edits).
const refusals = new WeakMap<Context, string>();
const validationResponse: MiddlewareHandler = async (c, next) => {
    await next();
    const message = refusals.get(c);
    if (message !== undefined) c.res = c.json({ error: message }, 400);
};
async function checked<T>(c: Context, run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (e) {
        if (!(e instanceof InvalidCleanupAreasError)) throw e;
        refusals.set(c, e.message);
        return null as T;
    }
}

const Course = Type.Object({ courseId: Type.String() });
const Save = Type.Object({
    courseId: Type.String(),
    version: Type.Integer({ minimum: 0 }),
    areas: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 100 }),
        name: Type.String({ minLength: 1, maxLength: 100 }),
        kind: Type.Union([Type.Literal('include'), Type.Literal('force'), Type.Literal('exclude')]),
        ring: Type.Array(Type.Tuple([Type.Number({ minimum: -180, maximum: 180 }), Type.Number({ minimum: -90, maximum: 90 })]), { minItems: 4, maxItems: 1000 }),
    }), { maxItems: 200 }),
});

export function createCleanupAreasApi(svc: CleanupAreasService) {
    const middleware = [requireAuth(), validationResponse];
    return {
        cleanupAreas: { method: 'GET' as const, path: '/cleanup-areas', schema: Course, middleware,
            fn: (input: Static<typeof Course>, c: Context) => checked(c, () => svc.get(input.courseId)) },
        saveCleanupAreas: { method: 'POST' as const, path: '/cleanup-areas', schema: Save, middleware,
            fn: (input: Static<typeof Save>, c: Context) => checked(c, () => svc.save(input.courseId, input.version, input.areas)) },
        exportCleanupArea: { method: 'GET' as const, path: '/cleanup-areas/export', schema: Course, middleware,
            fn: (input: Static<typeof Course>, c: Context) => checked(c, () => svc.export(input.courseId)) },
    };
}
