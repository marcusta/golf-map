import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TerrainGeneratorsService } from '../services/terrain-generators.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const JobInput = Type.Object({
    jobId: Type.String(),
});

const GenerateInput = Type.Object({
    courseId: Type.String(),
    kind: Type.Union([Type.Literal('building-pads'), Type.Literal('road-grades'), Type.Literal('water-digs'), Type.Literal('bunker-digs'), Type.Literal('creek-digs')]),
});

// --- API descriptor ---

/**
 * One-click roads + buildings (T-roads). Builder-only (see routes.ts): both
 * shell out to the pipeline and write under `sources/<siteId>/`.
 */
export function createTerrainGeneratorsApi(svc: TerrainGeneratorsService) {
    const mw = [requireAuth()];
    return {
        /**
         * The road network (OSM + NVDB) as corridor polygons for the import
         * wizard, as a job (returns at once, `status: running`): Overpass is
         * retried while busy, so a fetch can take a minute. Poll
         * `roadsFetchJob` / `currentRoadsFetch`; the polygons are the
         * finished job's `result`.
         */
        startRoadsFetch: {
            method: 'POST' as const,
            path: '/course-features/fetch-roads/start',
            fn: (input: Static<typeof CourseInput>) => svc.startRoadsFetch(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        roadsFetchJob: {
            method: 'GET' as const,
            path: '/course-features/fetch-roads/job',
            fn: (input: Static<typeof JobInput>) => svc.roadsFetchJob(input.jobId),
            schema: JobInput,
            middleware: mw,
        },
        /** The course's running road fetch, else its latest finished one, else null — what a reopened wizard resumes. */
        currentRoadsFetch: {
            method: 'GET' as const,
            path: '/course-features/fetch-roads/current',
            fn: (input: Static<typeof CourseInput>) => svc.currentRoadsFetch(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        // Building pads / road grades into the site's terrain_edits under
        // their origin, replacing that origin's previous generation.
        generate: {
            method: 'POST' as const,
            path: '/terrain-edits/generate',
            fn: (input: Static<typeof GenerateInput>) => svc.generate(input.courseId, input.kind),
            schema: GenerateInput,
            middleware: mw,
        },
    };
}
