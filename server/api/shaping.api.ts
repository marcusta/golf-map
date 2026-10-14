import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { ShapingService } from '../services/shaping.service';

// --- Input schemas ---

const RecipesInput = Type.Object({
    /** Only the recipes made for this surface (and `default` for it); all of them without one. */
    surface: Type.Optional(Type.Union([Type.Literal('bunker'), Type.Literal('lake'), Type.Literal('creek'), Type.Literal('path')])),
});

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const ApplyInput = Type.Object({
    courseId: Type.String(),
    /** The worker's and Unity's dry runs: plan only, nothing written. */
    dryRun: Type.Optional(Type.Boolean()),
    /** Stop after Blender (no Unity refresh). */
    skipUnity: Type.Optional(Type.Boolean()),
    /** The Draw mode's "Update paths": the paths' surfaces too (surfaces file before, path materials after). */
    paths: Type.Optional(Type.Boolean()),
});

const JobInput = Type.Object({
    jobId: Type.String(),
});

// --- API descriptor ---

/**
 * Blender shaping from the Terrain editor (blender/SHAPING-PLAN.md): the recipe
 * library, and the apply job (layers → shaping worker → Unity refresh) the panel
 * polls. Builder-only (routes.ts): it runs the pipeline, Blender and the Unity bridge.
 * A feature's recipe itself is a terrain edit (`op: recipe`, terrain-edits.api.ts).
 */
export function createShapingApi(svc: ShapingService) {
    const mw = [requireAuth()];
    return {
        recipes: {
            method: 'GET' as const,
            path: '/shaping/recipes',
            fn: (input: Static<typeof RecipesInput>) => svc.recipes(input.surface),
            schema: RecipesInput,
            middleware: mw,
        },
        /** Start an apply job (returns at once, `status: running`); 409 while one runs. Poll `status` or `job`. */
        apply: {
            method: 'POST' as const,
            path: '/courses/:courseId/shaping/apply',
            fn: (input: Static<typeof ApplyInput>) => svc.apply(input.courseId, { dryRun: input.dryRun, skipUnity: input.skipUnity, paths: input.paths }),
            schema: ApplyInput,
            middleware: mw,
        },
        /** The shaping worker's status and the course's running or last apply job. */
        status: {
            method: 'GET' as const,
            path: '/courses/:courseId/shaping/status',
            fn: (input: Static<typeof CourseInput>) => svc.status(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        job: {
            method: 'GET' as const,
            path: '/shaping/job',
            fn: (input: Static<typeof JobInput>) => svc.job(input.jobId),
            schema: JobInput,
            middleware: mw,
        },
    };
}
