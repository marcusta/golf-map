import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { MakeReadyService } from '../services/make-ready.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const RunInput = Type.Object({
    courseId: Type.String(),
    /** Let Unity add the missing colliders and physic materials, and save the scene. */
    fix: Type.Optional(Type.Boolean()),
    /** Near play = within this of the playing field (m; default 40). */
    marginM: Type.Optional(Type.Number({ minimum: 0, maximum: 500 })),
});

const JobInput = Type.Object({
    courseId: Type.String(),
    jobId: Type.String(),
});

// --- API descriptor ---

/**
 * Make ready (`server/services/make-ready.service.ts`): before a GSPro build,
 * the faults and the colliders of everything near play — the Unity scene
 * (`golfmap.course.ready`, fix adds what is missing), the trees and bushes
 * Arborist draws (report only) and the course check. The GSPro board's Ready
 * row and `bun run course:ready` use it. Builder-only (see routes.ts): it
 * drives the local Unity editor and the pipeline Python.
 */
export function createMakeReadyApi(svc: MakeReadyService) {
    const mw = [requireAuth()];
    return {
        /** The last run's outcome (ready, errors, warnings, fixed, per category, when) and the running or last run. */
        status: {
            method: 'GET' as const,
            path: '/courses/:courseId/make-ready/status',
            fn: (input: Static<typeof CourseInput>) => svc.status(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /** Start a run (Unity scene → Arborist file → course check); returns the job at once, poll `job`. 409 while one runs. */
        run: {
            method: 'POST' as const,
            path: '/courses/:courseId/make-ready/run',
            fn: (input: Static<typeof RunInput>) => svc.run(input.courseId, { fix: input.fix, marginM: input.marginM }),
            schema: RunInput,
            middleware: mw,
        },
        job: {
            method: 'GET' as const,
            path: '/courses/:courseId/make-ready/job',
            fn: (input: Static<typeof JobInput>) => svc.job(input.jobId),
            schema: JobInput,
            middleware: mw,
        },
    };
}
