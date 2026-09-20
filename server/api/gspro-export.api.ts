import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { GsproExportService } from '../services/gspro-export.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const SetDirInput = Type.Object({
    courseId: Type.String(),
    /** Absolute or cwd-relative folder; null/empty resets to the server default. */
    dir: Type.Union([Type.String(), Type.Null()]),
});

const TerrainInput = Type.Union([Type.Literal('inner'), Type.Literal('outer')]);

/** One export to start; the fields a kind needs are checked by the service (409). */
const StartInput = Type.Object({
    courseId: Type.String(),
    kind: Type.Union([
        Type.Literal('svg'), Type.Literal('ortho'), Type.Literal('outer-ortho'),
        Type.Literal('dem'), Type.Literal('hillshade'), Type.Literal('trees'), Type.Literal('buildings'),
    ]),
    /** `ortho`: a `source` file name from `orthoSources`. */
    source: Type.Optional(Type.String()),
    /** `outer-ortho`: Lantmäteriet collection to fetch the outer square from, e.g. `orto-l2-2025`. */
    collection: Type.Optional(Type.String()),
    /** `dem`, `hillshade`, `trees`, `buildings`: which GSPro terrain. */
    terrain: Type.Optional(TerrainInput),
    /** `ortho`, `outer-ortho`: light multiplier for the `-terrain` texture twin (linear light); omitted = the server default. */
    darken: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
    /** `ortho`, `outer-ortho`: also write the `-meshes` variant for the course meshes — the darkened twin with the grass surfaces tinted from the drawn features. */
    tint: Type.Optional(Type.Boolean()),
    /** With `tint`: the tint layer's opacity 0..1; omitted = the server default (0.3). */
    tintOpacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const JobInput = Type.Object({
    jobId: Type.String(),
});

// --- API descriptor ---

/**
 * GSPro SVG, orthophoto, DEM/heightmap, hillshade and tree exports for the inner and outer terrains,
 * run as jobs the panel polls. Builder-only (see routes.ts): it writes files to an
 * operator-chosen folder and shells out to the pipeline, neither of which exists on the serve box.
 */
export function createGsproExportApi(svc: GsproExportService) {
    const mw = [requireAuth()];
    return {
        settings: {
            method: 'GET' as const,
            path: '/gspro-export/settings',
            fn: (input: Static<typeof CourseInput>) => svc.settings(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        setDir: {
            method: 'POST' as const,
            path: '/gspro-export/dir',
            fn: (input: Static<typeof SetDirInput>) => svc.setDir(input.courseId, input.dir),
            schema: SetDirInput,
            middleware: mw,
        },
        terrain: {
            method: 'GET' as const,
            path: '/gspro-export/terrain',
            fn: (input: Static<typeof CourseInput>) => svc.terrain(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        orthoSources: {
            method: 'GET' as const,
            path: '/gspro-export/ortho-sources',
            fn: (input: Static<typeof CourseInput>) => svc.orthoSources(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /**
         * Start an export as a job (returns at once, `status: running`) — the
         * fetch-first exports run for minutes; poll `job` / `current`.
         */
        start: {
            method: 'POST' as const,
            path: '/gspro-export/start',
            fn: (input: Static<typeof StartInput>) => svc.start(input.courseId, input),
            schema: StartInput,
            middleware: mw,
        },
        job: {
            method: 'GET' as const,
            path: '/gspro-export/job',
            fn: (input: Static<typeof JobInput>) => svc.job(input.jobId),
            schema: JobInput,
            middleware: mw,
        },
        /** The course's running job, else its latest finished one, else null — what a reopened panel resumes. */
        current: {
            method: 'GET' as const,
            path: '/gspro-export/current',
            fn: (input: Static<typeof CourseInput>) => svc.current(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
    };
}
