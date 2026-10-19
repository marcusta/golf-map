import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { Context, MiddlewareHandler } from 'hono';
import { InvalidPhotoCleanupError, type PhotoCleanupService } from '../services/photo-cleanup.service';

// mount() does not map domain validation errors to 400 (same pattern as cleanup areas).
const refusals = new WeakMap<Context, string>();
const validationResponse: MiddlewareHandler = async (c, next) => {
    await next();
    const message = refusals.get(c);
    if (message !== undefined) c.res = c.json({ error: message }, 400);
};
async function checked<T>(c: Context, run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (e) {
        if (!(e instanceof InvalidPhotoCleanupError)) throw e;
        refusals.set(c, e.message);
        return null as T;
    }
}

const Course = Type.Object({ courseId: Type.String() });
const Start = Type.Object({
    courseId: Type.String(),
    /** Hole numbers; omitted or empty = every hole of the course. */
    holes: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 99 }), { maxItems: 99 })),
});
const Job = Type.Object({ courseId: Type.String(), jobId: Type.String() });
const Apply = Type.Object({
    courseId: Type.String(),
    jobId: Type.String(),
    holes: Type.Array(Type.Integer({ minimum: 1, maximum: 99 }), { minItems: 1, maxItems: 99 }),
});

// --- API descriptor ---
//
// The review images are a raw Hono route in `photo-cleanup.routes.ts`.

export function createPhotoCleanupApi(svc: PhotoCleanupService) {
    const middleware = [requireAuth(), validationResponse];
    return {
        // Clean the holes on a copy of the photo; poll the job, look, then apply.
        startPhotoCleanup: { method: 'POST' as const, path: '/photo-cleanup', schema: Start, middleware,
            fn: (input: Static<typeof Start>, c: Context) => checked(c, () => svc.start(input.courseId, input.holes)) },
        photoCleanupJob: { method: 'GET' as const, path: '/photo-cleanup/job', schema: Job, middleware,
            fn: (input: Static<typeof Job>) => svc.job(input.courseId, input.jobId) },
        // Wrapped: a bare null answer would reach the client as `{ ok: true }`.
        currentPhotoCleanup: { method: 'GET' as const, path: '/photo-cleanup/current', schema: Course, middleware,
            fn: async (input: Static<typeof Course>) => ({ job: await svc.current(input.courseId) }) },
        // The accepted holes into the cleaned photo, as one undo step.
        applyPhotoCleanup: { method: 'POST' as const, path: '/photo-cleanup/apply', schema: Apply, middleware,
            fn: (input: Static<typeof Apply>, c: Context) => checked(c, () => svc.apply(input.courseId, input.jobId, input.holes)) },
    };
}
