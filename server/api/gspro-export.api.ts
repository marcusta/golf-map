import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { GsproExportService } from '../services/gspro-export.service';
import { GKD_KEYWORDS } from '../../shared/gspro-course-meta';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const SetDirInput = Type.Object({
    courseId: Type.String(),
    /** Absolute or cwd-relative folder; null/empty resets to the server default. */
    dir: Type.Union([Type.String(), Type.Null()]),
});

/** The course details the .GKD export writes (`GsproCourseMeta`); null clears them. */
const SetMetaInput = Type.Object({
    courseId: Type.String(),
    meta: Type.Union([Type.Null(), Type.Object({
        courseName: Type.String({ maxLength: 200 }),
        city: Type.String({ maxLength: 200 }),
        state: Type.String({ maxLength: 200 }),
        country: Type.String({ maxLength: 200 }),
        designer: Type.String({ maxLength: 200 }),
        homage: Type.String({ maxLength: 200 }),
        description: Type.String({ maxLength: 4000 }),
        difficulty: Type.Number({ minimum: 0 }),
        keywords: Type.Array(Type.Union(GKD_KEYWORDS.map(k => Type.Literal(k))), { maxItems: GKD_KEYWORDS.length }),
    })]),
});

const TerrainInput =Type.Union([Type.Literal('inner'), Type.Literal('outer')]);

/** One export to start; the fields a kind needs are checked by the service (409). */
const StartInput = Type.Object({
    courseId: Type.String(),
    kind: Type.Union([
        Type.Literal('svg'), Type.Literal('ortho'), Type.Literal('outer-ortho'),
        Type.Literal('dem'), Type.Literal('unity-terrain'), Type.Literal('unity-sculpt'), Type.Literal('unity-ortho'), Type.Literal('hillshade'), Type.Literal('trees'), Type.Literal('buildings'),
        Type.Literal('zones'), Type.Literal('vegetation'), Type.Literal('vegetation-update'), Type.Literal('arborist'), Type.Literal('creeks'), Type.Literal('gkd'),
    ]),
    /** `ortho`: a `source` file name from `orthoSources`. */
    source: Type.Optional(Type.String()),
    /** `outer-ortho`: Lantmäteriet collection to fetch the outer square from, e.g. `orto-l2-2025`. */
    collection: Type.Optional(Type.String()),
    /** `dem`, `hillshade`, `trees`, `buildings`, `zones`, `vegetation`: which GSPro terrain. */
    terrain: Type.Optional(TerrainInput),
    /** `ortho`, `outer-ortho`: light multiplier for the `-terrain` texture twin (linear light); omitted = the server default. */
    darken: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
    /** `ortho`, `outer-ortho`: also write the `-meshes` variant for the course meshes — the darkened twin with the grass surfaces tinted from the drawn features. */
    tint: Type.Optional(Type.Boolean()),
    /** With `tint`: the tint layer's opacity 0..1; omitted = the server default (0.5). */
    tintOpacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    /** `ortho`, `outer-ortho`: paint the course's woodland_floor zones as forest floor on every file. */
    forestFloor: Type.Optional(Type.Boolean()),
    /** With `forestFloor`: palette floor colour `#rrggbb`; omitted = the pipeline default. */
    floorColor: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
    /** With `forestFloor`: share of each zone's photo-sampled colour, 0..1; omitted = 0.5. */
    floorMix: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    /** `ortho`, `outer-ortho`: fill the roofs (lidar roof heights + building survey) and their shadows from the ground round them. */
    removeBuildings: Type.Optional(Type.Boolean()),
    /** `svg`: feature ids to leave out (test variants for the Blender build); a road's kerb fillets go with it. */
    excludeFeatureIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 200000 })),
    /** `svg`: variant name; the file becomes `<course>-<variant>.svg` instead of overwriting `<course>.svg`. */
    variant: Type.Optional(Type.String({ maxLength: 60 })),
    /** `vegetation-update`: the vegetation_zone feature ids the command bar's "Update N zones" sends (re-rasterize their area, patch the masks, respawn there in Unity, rewrite the Arborist file's lower vegetation). */
    zoneIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 5000 })),
    /**
     * `vegetation-update`: run the whole planting when those zones cannot be patched (no zones export yet, or the zone
     * types' items moved since it). Omitted = no: the job succeeds with `needsPlanting` and its `reason`, writes nothing,
     * and the panel asks before spending the minutes.
     */
    plantIfNeeded: Type.Optional(Type.Boolean()),
    /** Render even when the output's input fingerprint says nothing it reads has changed (`dem`, `ortho`, `outer-ortho`, `unity-terrain`, `unity-ortho`, `trees`, `buildings`, `zones`, `creeks`, `vegetation`). */
    force: Type.Optional(Type.Boolean()),
});

const JobInput = Type.Object({
    jobId: Type.String(),
});

// --- API descriptor ---

/**
 * GSPro SVG, orthophoto, DEM/heightmap, hillshade and tree exports for the inner and outer terrains,
 * the vegetation planting (`vegetation`: generators, zones export, Unity, the Arborist file; `vegetation-update`
 * for some zones; `arborist` for the Arborist file alone), run as jobs the panel polls. Builder-only (see routes.ts): it writes files to an
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
        /** The course's folder under GSPro's Courses, where the GreenKeeper .GKD export writes (must exist). */
        setCourseDir: {
            method: 'POST' as const,
            path: '/gspro-export/course-dir',
            fn: (input: Static<typeof SetDirInput>) => svc.setCourseDir(input.courseId, input.dir),
            schema: SetDirInput,
            middleware: mw,
        },
        /** Keep the course details (name, location, designer, description, keywords) the .GKD export writes. */
        setMeta: {
            method: 'POST' as const,
            path: '/gspro-export/meta',
            fn: (input: Static<typeof SetMetaInput>) => svc.setMeta(input.courseId, input.meta),
            schema: SetMetaInput,
            middleware: mw,
        },
        /**
         * Take those details from the .GKD in the course's GSPro folder (what was typed in GreenKeeper), and
         * its ratings onto the course's tee sets.
         */
        readGkdMeta: {
            method: 'POST' as const,
            path: '/gspro-export/meta/read-gkd',
            fn: (input: Static<typeof CourseInput>) => svc.readGkdMeta(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /** Take only the tee sets' ratings from that .GKD; the course details stay. */
        readGkdRatings: {
            method: 'POST' as const,
            path: '/gspro-export/ratings/read-gkd',
            fn: (input: Static<typeof CourseInput>) => svc.readGkdRatings(input.courseId),
            schema: CourseInput,
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
