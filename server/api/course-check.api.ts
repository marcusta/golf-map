import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { CourseCheckService } from '../services/course-check.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const RunInput = Type.Object({
    courseId: Type.String(),
    /** Only this hole's meshes (and 40 m round them). */
    hole: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    /** The ray grid's cell (m; default 0.5). */
    cellM: Type.Optional(Type.Number({ minimum: 0.1, maximum: 5 })),
    /** How far beyond the course boundary is checked (m; default 50) - only for a course without play lines. */
    marginM: Type.Optional(Type.Number({ minimum: 0 })),
    /** How far round the play-surface meshes the holes' play lines cross is checked (m; default 100). */
    bufferM: Type.Optional(Type.Number({ minimum: 0 })),
    /** False: Unity only. Default: the Blender layer too when the shaping worker holds the course. */
    blender: Type.Optional(Type.Boolean()),
});

const JobInput = Type.Object({
    jobId: Type.String(),
});

// --- API descriptor ---

/**
 * Is the built GSPro course whole (`server/services/course-check.service.ts`):
 * the Unity scene's course meshes through their colliders, and the shaped
 * course in the Blender worker, in the play area (the play-surface meshes the
 * holes' play lines cross + 100 m; the course boundary + 50 m without holes). The GSPro board's
 * Check row and `bun run course:check` use it. Builder-only (see routes.ts):
 * it drives the local Unity editor and the shaping worker.
 */
export function createCourseCheckApi(svc: CourseCheckService) {
    const mw = [requireAuth()];
    return {
        /** The last reports' summaries (Unity, Blender), whether the meshes changed since, and the running or last check. */
        status: {
            method: 'GET' as const,
            path: '/course-check/status',
            fn: (input: Static<typeof CourseInput>) => svc.status(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /** Start a check (play lines and boundary → Unity → Review window → Blender); returns the job at once, poll `job`. 409 while one runs. */
        run: {
            method: 'POST' as const,
            path: '/course-check/run',
            fn: (input: Static<typeof RunInput>) => svc.run(input.courseId, {
                hole: input.hole, cellM: input.cellM, marginM: input.marginM, bufferM: input.bufferM, blender: input.blender,
            }),
            schema: RunInput,
            middleware: mw,
        },
        job: {
            method: 'GET' as const,
            path: '/course-check/job',
            fn: (input: Static<typeof JobInput>) => svc.job(input.jobId),
            schema: JobInput,
            middleware: mw,
        },
    };
}
