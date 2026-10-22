// Blender shaping from the Terrain editor (blender/SHAPING-PLAN.md, "Terrain
// editor → Blender"; builder only). The site's terrain edits stay the one
// source: the course's recipe edits (`op: recipe`, terrain-edits.service.ts),
// its features and its area edits are turned into shaping layers by
// `gspro.py shaping-global` (00-global.gen.json + 10-features.gen.json in
// `docs/gspro/<course>/shaping/`), a long-running headless Blender — the
// shaping worker, `blender/tools/shape_worker.py` — replays what changed and
// exports the changed meshes' FBX into the Unity project, and the course's
// Unity editor re-imports just those objects (`golfmap.course.refresh
// only=<objects>`).
//
//   - `recipes(surface)`  the recipe library (shaping-recipes.ts) for the editor.
//   - `apply(courseId)`   a JOB (like the GSPro exports: in memory, polled):
//                         layers → worker (started on demand, `/load`ed when it
//                         holds another .blend or layer folder) → `/sync` →
//                         Unity refresh of the changed objects.
//   - `status(courseId)`  the worker's `/status` and the course's last job.
//
// `apply(courseId, { paths: true })` is the Draw mode's "Update paths in
// Unity" (a path changed surface): before the layers it rewrites the road
// surfaces file of the exported SVG (`gspro.py svg --paths-only`,
// `<stem>-paths.json`: what the worker's `golfmap.split_surfaces` cuts a
// mixed road along and Unity's `golfmap.paths.materials` gives each path
// mesh its material from), and after the refresh of the changed objects it
// runs `golfmap.paths.materials` over the course's path meshes, also when
// Blender changed nothing (a whole road given another surface).
//
// A rock slab among the changed objects (`Spline_<name>_Rock_-_Mesh`, the
// Blender op `golfmap.cut_out`) adds the `vegetation` phase after the refresh:
// the surface map is exported in Unity (`golfmap.surfaces.export` inner, unless
// the refresh's own `surfaces.export` step already did) and the lower
// vegetation is planted again (GsproExportService.plantVegetation, what
// `bun run grass:zones` and the web "Update vegetation" button run; the Arborist file's lower vegetation with it, its trees left), so the tall
// grass leaves the rock. Skipped when no slab changed, on a dry run and when
// Unity was not refreshed; a failure there fails the job. The CLI:
// scripts/shaping-apply.ts (`bun run shaping`).
//
// The worker speaks JSON over HTTP on GOLFMAP_SHAPING_URL (default
// http://127.0.0.1:8766): `GET /status`, `GET /job/<id>`, `POST /load {blend?,
// layersDir?, fbxFolder?}`, `POST /sync {dryRun?, allowGaps?}` (contract in
// blender/README.md, "Shaping worker"). The sync GATES what it exports: a seam
// gap, T-junction step, upside-down top face or NaN it made fails its job (the
// worker puts the objects back and exports nothing), so the blender phase fails
// with the worker's message and Unity is not refreshed; GOLFMAP_SHAPING_ALLOW_GAPS=1
// (deps.allowGaps) sends `allowGaps` and makes them warnings. The two POSTs are JOBS: they answer
// `{job, kind, state: 'running'}` at once (409 while one is going) and this
// service polls `/status` — `job: {id, kind, state, phase, startedAt, seconds,
// result | error}` — for the outcome, so a sync that runs for an hour holds no
// connection. A worker that answers with the run itself (`?wait=1`, or an older
// one) is still read as before.
//
// The worker may be on another machine: GOLFMAP_SHAPING_URL points at it,
// GOLFMAP_SHAPING_TOKEN is the shared secret both sides use (`X-Golfmap-Token`
// on every request), and the paths it is given (blend, layersDir, fbxFolder)
// must be ones it can open: GOLFMAP_SHAPING_PATH_MAP moves each prefix to the
// worker's (a local copy of the export folder, SMB mounts for the layers and
// the FBX folder) and the paths it reports back; with a map set the worker is
// never started from here (docs/mac-blender-machine.md).
// One worker for the machine, so one apply at a time across courses. Paths,
// all overridable (env, or deps in tests):
//   - blend:      GOLFMAP_SHAPING_BLEND (absolute, or a name in the export
//                 folder), else the newest source `.blend` in the course's
//                 export folder (the worker prepares its conformed cache), else
//                 the newest `*.conformed.blend` there (the worker
//                 prepares the conformed cache itself);
//   - layers:     `<repo>/docs/gspro/<course slug>/shaping` (GOLFMAP_SHAPING_LAYERS_ROOT
//                 replaces `<repo>/docs/gspro`);
//   - FBX folder: GOLFMAP_SHAPING_FBX_FOLDER, else `<Unity project>/Assets/fbx`
//                 of the editor whose active course exports to the folder;
//   - Blender:    GOLFMAP_BLENDER, else Blender 4.5's default install path on
//                 Windows, else `blender` on PATH; one log per spawn in
//                 `<data>/shaping-worker/` (both streams), the current one
//                 named by `latest.json`, older than 14 days pruned.
import * as path from 'node:path';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { CoursesService } from './courses.service';
import {
    courseSlug, defaultRunner, ensureDir, failure, reportLines, venvPython,
    type ExportRunner, type GsproExportService,
} from './gspro-export.service';
import { defaultUnityBridge, editorForExportDir, type UnityBridge, type UnityEditor } from './unity-bridge';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { spawnDetached, type DetachedProcess } from './detached-process';
import {
    defaultRecipeLibraryPath, loadRecipeLibrary, recipesFor, type RecipeSurface, type ShapingRecipe,
} from './shaping-recipes';
import { JobPhases, secs, type JobPhase, type JobPhaseStatus } from './job-phases';
import {
    ShapingQueue, batchFlags, sliceFor, type QueueLease, type QueueRequest, type QueueRun, type Region3006, type RequestSlice,
} from './shaping-queue';

export const DEFAULT_SHAPING_URL = 'http://127.0.0.1:8766';
/** The pointer file in `<data>/shaping-worker/` naming the log of the worker running now. */
export const LATEST_LOG = 'latest.json';
/** How long a worker log is kept (pruned on the next spawn). */
export const LOG_KEEP_DAYS = 14;
/** Finished requests per course a process keeps in memory for `job(id)`. */
const KEEP_DONE = 20;
const REPO_DIR = path.resolve(import.meta.dir, '..', '..');
/** Blender 4.5 LTS's default install (blender/AGENTS.md). */
const WINDOWS_BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe';

// --- Public types ---

/**
 * The worker's current (else last) job as `/status` carries it — a `/load` or
 * a `/sync`, which the worker now runs as a job instead of holding the
 * connection. Null for a worker that reports none.
 */
export interface ShapingWorkerJob {
    id: string;
    /** `load` | `sync` (the worker's own word). */
    kind: string | null;
    /** `running` | `succeeded` | `failed`. */
    state: string;
    /** What it is doing now (`sync: export`), null once done. */
    phase: string | null;
    startedAt: string | null;
    seconds: number | null;
    /** The answer the job produced (a `/sync`'s run), null while it goes and when it failed. */
    result: unknown;
    error: string | null;
}

/** The worker as the status endpoint reports it. */
export interface ShapingWorkerStatus {
    url: string;
    /** False when nothing answers on `url` (not started, or it died). */
    reachable: boolean;
    /** `starting` | `ready` | `busy` | `error` (the worker's own word), null when unreachable. */
    state: string | null;
    /** What the worker is doing (its own words, e.g. `apply 12/63 recipe-1d`, `sync: export`), null when idle or unknown. */
    phase: string | null;
    blend: string | null;
    conformed: string | null;
    layersDir: string | null;
    appliedOps: unknown;
    lastRun: unknown;
    /** Its running (else last) job; null for a worker that reports none. */
    job: ShapingWorkerJob | null;
    /** Why it is unreachable or in error, when known. */
    error: string | null;
    /** The worker process this server started (null: started elsewhere, or not running). */
    spawnedPid: number | null;
    /** The log of the worker this server started (`<data>/shaping-worker/<when>-<pid>.log`); null for someone else's. */
    log: string | null;
}

/** One Unity refresh step as its report gives it (golfmap.course.refresh `steps`). */
export interface ShapingUnityStep {
    id: string;
    status: string;
    /** Null when the report gives none. */
    seconds: number | null;
}

/** A seam pair with a gap after the sync (the worker's `shape_apply.seam_summary`). */
export interface ShapingSeamGap {
    /** The two objects whose shared border vertices differ in height. */
    objects: string[];
    /** Shared border vertices, and those more than `gapDz` apart. */
    vertices: number;
    gaps: number;
    /** Metres. */
    maxAbsDz: number;
    /** Blend x, y of the worst one. */
    at?: number[];
    /** The pair had no gap this wide before the sync. */
    new: boolean;
    gapsBefore: number;
}

/**
 * The T-junction check after a sync that ran a cut (`shape_apply.tjunction_check`): per object, its border
 * vertices on a neighbour's edge (`onEdge`) and how far off it in height they are.
 */
export interface ShapingTJunctionCheck {
    toleranceXY: number;
    objects: Record<string, { vertices: number; onEdge: number; gaps: number; maxAbsDz: number; at?: number[] }>;
    gaps: number;
    maxAbsDz: number;
}

/** The worker's seam check of a sync (`report.seams`). */
export interface ShapingSeams {
    toleranceXY: number;
    gapDz: number;
    pairsChecked: number;
    gaps: ShapingSeamGap[];
    newGaps: number;
    unmatchedBoundaryChanged: Record<string, { before: number; after: number }>;
    /** Only when the sync ran a cut (a cart path cut, a weld, a road split, a rock cut-out). */
    tJunctions?: ShapingTJunctionCheck;
}

/** One finding of the sync's gates (blender/README.md, "Shaping worker"). */
export interface ShapingGateFinding {
    /** A seam gap, a T-junction step, upside-down faces on top, vertices without a position. */
    type: 'seamGap' | 'tJunction' | 'flipped' | 'nan';
    objects: string[];
    /** Metres (seamGap, tJunction). */
    maxAbsDz?: number;
    /** Vertices off (seamGap, tJunction). */
    points?: number;
    /** Upside-down triangles (flipped). */
    faces?: number | null;
    note?: string;
    /** Where: blend x, y and EPSG:3006 east, north. */
    blend?: number[];
    epsg3006?: number[];
}

/**
 * The gates a `/sync` runs before it exports: a gap the sync made fails it
 * (the job fails, nothing is exported) unless `allowGaps`, which turns the
 * failures into warnings; what was there before the sync is only a warning.
 */
export interface ShapingGates {
    ok: boolean;
    allowGaps: boolean;
    limits: { gapM: number; tJunctionM: number };
    failures: ShapingGateFinding[];
    preExisting: ShapingGateFinding[];
    /** One line per allowed failure and per pre-existing finding (also in the result's `warnings`). */
    warnings: string[];
}

/** What an apply job produces. */
export interface ShapingApplyResult {
    /** Objects the worker re-shaped (Unity re-imports them; with `removed`'s objects they are the refresh's only=). */
    changedObjects: string[];
    /** FBX files written, and removed (e.g. blends a permanent-join recipe merged away), in the FBX folder. */
    exported: string[];
    removed: string[];
    /** The worker's warnings plus this job's own (e.g. Unity not open). */
    warnings: string[];
    /** The changed places (object, hole, centre, bounds) the Review window reads. */
    places: unknown[];
    /** The worker's seam check; null when it did none (nothing changed, a dry run, a full reload). */
    seams: ShapingSeams | null;
    /** The sync's gates (passed, or failed and allowed by `allowGaps`); null when it ran none. */
    gates: ShapingGates | null;
    /** `golfmap.course.refresh`'s report; null when Unity was not refreshed (see warnings / unityError). */
    unityReport: unknown;
    /** `paths`: the report lines of the surfaces file's rewrite (what changed surface); [] otherwise. */
    pathSurfaces: string[];
    /** `paths`: `golfmap.paths.materials`' result (surfaces per mesh, materials, problems); null when it did not run. */
    pathMaterials: unknown;
    /** The refresh's steps with their seconds (from `unityReport`); [] when Unity was not refreshed. */
    unitySteps: ShapingUnityStep[];
    unityError: string | null;
    /** A rock slab changed: the report lines of the vegetation planting that followed; [] otherwise. */
    vegetation: string[];
    /** shaping-global's report lines. */
    layers: string[];
    blend: string;
    layersDir: string;
    fbxFolder: string | null;
    dryRun: boolean;
    seconds: number;
}

export type ShapingJobStatus = 'running' | 'succeeded' | 'failed';

/** The job's phases, in order. */
export type ShapingPhaseId = 'layers' | 'worker' | 'blender' | 'unity' | 'vegetation';
export type ShapingPhaseStatus = JobPhaseStatus;

/** "Generating layers", "Starting the shaping worker", "Blender sync", "Unity refresh", "Surface map and grass". */
export type ShapingPhase = JobPhase<ShapingPhaseId>;

export interface ShapingJob {
    /** The request's id (what `apply` returned; `job` follows it), else the run's. */
    id: string;
    courseId: string;
    /** The run that serves the request; null while it waits in the queue. */
    runId: string | null;
    /** Waiting in the queue for the worker (`status` is `running` meanwhile, `phase` null). */
    queued: boolean;
    /** The request's note, when it gave one. */
    note: string | null;
    /** The request's part of the run's result (docs/shaping-queue.md); null until the run is done. */
    slice: RequestSlice | null;
    status: ShapingJobStatus;
    /** The running phase (the failed one when failed); null before the first and once done. */
    phase: ShapingPhaseId | null;
    /** One line: what the job is doing now (with the phase's elapsed seconds), or did last. */
    step: string;
    /** Every phase with its status, detail and seconds. */
    phases: ShapingPhase[];
    dryRun: boolean;
    /** ISO timestamps. */
    startedAt: string;
    finishedAt: string | null;
    /** Seconds since the start (to the end once finished). */
    seconds: number;
    result: ShapingApplyResult | null;
    error: string | null;
}

export interface ShapingStatus {
    worker: ShapingWorkerStatus;
    /** The course's running job, else its last one, else null. */
    job: ShapingJob | null;
}

export interface ShapingApplyOptions {
    /** The worker's and Unity's dry runs: plan only, write nothing. */
    dryRun?: boolean;
    /** Stop after the worker (no Unity refresh). */
    skipUnity?: boolean;
    /** Take the paths' surfaces through as well (see the header): surfaces file first, path materials last. */
    paths?: boolean;
    /**
     * Save in Unity what the refresh changed (`golfmap.course.refresh
     * save=true`: the dirty scenes and the changed assets, once the refresh
     * succeeded) and in the vegetation phase's planting. Default false — the
     * scene is left dirty for the operator, as before.
     */
    save?: boolean;
    /** One line: what the caller changed (a bead id, "hole 7 tee"). Shown to the other requests of the run. */
    note?: string;
    /** Where the caller changed something (EPSG:3006 box): its slice of the result is what lies there. */
    region?: Region3006;
    /** The features the caller changed: their places are in its slice too. */
    featureIds?: string[];
}

export interface ShapingTimeouts {
    /** Until a started worker answers `/status`. */
    startMs: number;
    /** A `/load` (preparing the conformed cache takes minutes the first time). */
    loadMs: number;
    /** A `/sync`. */
    syncMs: number;
    /** The Unity refresh. */
    unitySec: number;
    /** `/status` polling interval. */
    pollMs: number;
    /**
     * How long `/status` may go on telling us nothing about the run we are
     * waiting for — unreachable, or an error answer with no job — before the
     * wait gives up. Blender holds the GIL in long ops, so the 5 s `/status`
     * timeout is hit now and then (and a worker on another machine has a
     * network under it): a blip must not end a sync that is still going.
     */
    unreachableMs: number;
    /** How often the queue's lease holder writes its heartbeat and its run's progress. */
    heartbeatMs: number;
}

export const DEFAULT_SHAPING_TIMEOUTS: ShapingTimeouts = {
    startMs: 120_000, loadMs: 60 * 60_000, syncMs: 30 * 60_000, unitySec: 1800, pollMs: 1000,
    unreachableMs: 60_000, heartbeatMs: 1000,
};

export interface ShapingDeps {
    courses: Pick<CoursesService, 'get'>;
    /** The course's export folder (where its .blend lives). */
    exportSettings: Pick<GsproExportService, 'settings' | 'svgCommand' | 'plantVegetation'>;
    /** Where the worker's logs go (`<dataDir>/shaping-worker/<when>-<pid>.log`, one per spawn). */
    dataDir: string;
    pipelineDir?: string;
    python?: string;
    runner?: ExportRunner;
    unityBridge?: UnityBridge;
    /** The app database shaping-global reads (default DB_PATH; unset = gspro.py's own default). */
    dbPath?: string;
    workerUrl?: string;
    /** The shared secret the worker wants as `X-Golfmap-Token` (default GOLFMAP_SHAPING_TOKEN; unset = no header). */
    token?: string;
    /**
     * A worker on another machine: `<local prefix>=<worker prefix>;...` (default GOLFMAP_SHAPING_PATH_MAP), applied to
     * every path sent to the worker and back to every path it reports; the longest matching prefix wins. Set = the
     * worker is never started from here.
     */
    pathMap?: string;
    /**
     * Every `/sync` with `{allowGaps: true}`: a gap, T-junction step, upside-down top face or NaN the sync made is a
     * warning instead of a failed job, and the FBX are exported anyway — the escape hatch, not the way to work
     * (default GOLFMAP_SHAPING_ALLOW_GAPS=1; unset = the gates fail the job).
     */
    allowGaps?: boolean;
    /** The command before the worker's own arguments (default `[blender, -b, --python, <repo>/blender/tools/shape_worker.py]`). */
    workerLauncher?: string[];
    /** Replaces `<repo>/docs/gspro`: the course's layers are `<root>/<course slug>/shaping`. */
    layersRoot?: string;
    recipeLibrary?: string;
    /** The .blend to shape (absolute, or a name in the export folder). */
    blend?: string;
    fbxFolder?: string;
    timeouts?: Partial<ShapingTimeouts>;
    /** The queue's folder, shared with every process that shapes on this machine (default `<dataDir>/shaping-queue`). */
    queueDir?: string;
    /** A queue lease with no heartbeat for this long is taken over (default 2 min). */
    queueStaleMs?: number;
}

interface WorkerTarget {
    blend: string;
    layersDir: string;
    fbxFolder: string | null;
}

/** A worker `/sync` answer (the plan's contract; every field optional to a lenient reader). */
interface SyncAnswer {
    changedObjects?: unknown;
    exported?: unknown;
    removed?: unknown;
    seconds?: unknown;
    /** Ops that failed in this sync (`{op, error}`): their objects are as the op left them, which may be as before. */
    errors?: unknown;
    report?: { warnings?: unknown; seams?: unknown; gates?: unknown; changedPlaces?: unknown };
}

// --- Service ---

export class ShapingService {
    private readonly courses: Pick<CoursesService, 'get'>;
    private readonly exportSettings: Pick<GsproExportService, 'settings' | 'svgCommand' | 'plantVegetation'>;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    private readonly unityBridge: UnityBridge;
    private readonly dbPath: string | undefined;
    private readonly workerUrl: string;
    private readonly token: string | undefined;
    private readonly pathMap: PathMapEntry[];
    private readonly allowGaps: boolean;
    private readonly workerLauncher: string[];
    private readonly layersRoot: string;
    private readonly recipeLibrary: string;
    private readonly blend: string | undefined;
    private readonly fbxFolder: string | undefined;
    private readonly timeouts: ShapingTimeouts;
    /** The runs this process ran, by run id. */
    private readonly jobs = new Map<string, JobRecord>();
    /** The run this process is running now. */
    private running: { rec: JobRecord } | null = null;
    private readonly queue: ShapingQueue;
    /** The requests made in this process, by request id, with what is known of the run that serves them. */
    private readonly local = new Map<string, LocalRequest>();
    /** The loop that waits for this process's requests: runs batches while it holds the lease, else follows the files. */
    private driving: Promise<void> | null = null;
    private worker: { proc: DetachedProcess; log: string } | null = null;

    constructor(deps: ShapingDeps) {
        this.courses = deps.courses;
        this.exportSettings = deps.exportSettings;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
        this.unityBridge = deps.unityBridge ?? defaultUnityBridge();
        this.dbPath = deps.dbPath ?? process.env.DB_PATH;
        this.workerUrl = (deps.workerUrl ?? process.env.GOLFMAP_SHAPING_URL ?? DEFAULT_SHAPING_URL).replace(/\/+$/, '');
        this.token = deps.token ?? process.env.GOLFMAP_SHAPING_TOKEN ?? undefined;
        this.pathMap = parsePathMap(deps.pathMap ?? process.env.GOLFMAP_SHAPING_PATH_MAP ?? '');
        this.allowGaps = deps.allowGaps ?? process.env.GOLFMAP_SHAPING_ALLOW_GAPS === '1';
        this.workerLauncher = deps.workerLauncher ?? [
            blenderExecutable(), '-b', '--python', path.join(REPO_DIR, 'blender', 'tools', 'shape_worker.py'),
        ];
        this.layersRoot = deps.layersRoot ?? process.env.GOLFMAP_SHAPING_LAYERS_ROOT ?? path.join(REPO_DIR, 'docs', 'gspro');
        this.recipeLibrary = deps.recipeLibrary ?? defaultRecipeLibraryPath();
        this.blend = deps.blend ?? process.env.GOLFMAP_SHAPING_BLEND;
        this.fbxFolder = deps.fbxFolder ?? process.env.GOLFMAP_SHAPING_FBX_FOLDER;
        this.timeouts = { ...DEFAULT_SHAPING_TIMEOUTS, ...deps.timeouts };
        this.queue = new ShapingQueue(deps.queueDir ?? path.join(this.dataDir, 'shaping-queue'), { staleMs: deps.queueStaleMs });
    }

    /** The recipe library for one surface (all without one); [] while there is no library file. */
    async recipes(surface?: RecipeSurface): Promise<ShapingRecipe[]> {
        const entries = await loadRecipeLibrary(this.recipeLibrary);
        return entries ? recipesFor(entries, surface) : [];
    }

    /** The course's shaping layer folder. */
    async layersDir(courseId: string): Promise<string> {
        const course = await this.courses.get(courseId);
        return path.join(this.layersRoot, courseSlug(course.name), 'shaping');
    }

    /**
     * Ask for an apply and return its job at once (`status: running`; `queued`
     * while it waits). Requests QUEUE (docs/shaping-queue.md): the files are
     * shared with every process that shapes on this machine, and one run
     * serves every request of a course that came in before it started, since
     * the run regenerates the layers from the database. A dry run is served
     * apart from real ones. Whichever process holds the queue's lease runs the
     * batches; the others follow their request's file. 404 for an unknown
     * course. Poll `job(id)` or `status(courseId)`.
     */
    async apply(courseId: string, opts: ShapingApplyOptions = {}): Promise<ShapingJob> {
        await this.courses.get(courseId);
        this.forgetDone(courseId);
        const req = await this.queue.submit({
            courseId,
            note: opts.note?.trim() || null,
            region: opts.region ?? null,
            featureIds: opts.featureIds ?? [],
            flags: { dryRun: opts.dryRun === true, paths: opts.paths === true, save: opts.save === true, skipUnity: opts.skipUnity === true },
        });
        let settled!: () => void;
        const ready = new Promise<void>(r => { settled = r; });
        const l: LocalRequest = { req, run: null, foreign: null, slice: null, t0: Date.now(), settled };
        this.local.set(req.id, l);
        // This process's loop is going already (running a batch, or waiting for the lease): the request waits.
        if (this.driving) settled();
        this.kick();
        // Until its run has begun, or it is clear that it waits: a free worker shows the run going at once.
        await ready;
        return this.view(l);
    }

    /** A request (or a run) by id; 404 when this process never made it. */
    job(jobId: string): ShapingJob {
        const local = this.local.get(jobId);
        if (local) return this.view(local);
        const rec = this.jobs.get(jobId);
        if (!rec) throw new NotFoundError(`No shaping job ${jobId} (the server may have restarted)`);
        return snapshot(rec);
    }

    /**
     * The run this process is running, whatever course it belongs to, else
     * null. One worker per machine means one run at a time across courses, so
     * a caller that has to wait for it — the GSPro status board's `meshes`
     * chain — needs to see another course's run, not only its own.
     */
    runningAnywhere(): ShapingJob | null {
        return this.running ? snapshot(this.running.rec) : null;
    }

    /** The timeouts this service runs with: what a caller bounds its own wait for an apply by. */
    get waits(): ShapingTimeouts {
        return { ...this.timeouts };
    }

    /**
     * The course's request whose run is going, else its newest request, else
     * its newest run in this process, else null.
     */
    current(courseId: string): ShapingJob | null {
        const mine = [...this.local.values()].filter(l => l.req.courseId === courseId).sort((a, b) => a.t0 - b.t0);
        const going = mine.find(l => l.run?.job.status === 'running' || (l.foreign !== null && l.foreign.finishedAt === null));
        const latest = going ?? mine.at(-1);
        if (latest) return this.view(latest);
        let last: JobRecord | null = null;
        for (const rec of this.jobs.values()) {
            if (rec.job.courseId !== courseId) continue;
            if (rec.job.status === 'running') return snapshot(rec);
            if (!last || rec.t0 > last.t0) last = rec;
        }
        return last ? snapshot(last) : null;
    }

    /** The worker and the course's last job. */
    async status(courseId: string): Promise<ShapingStatus> {
        await this.courses.get(courseId);
        return { worker: await this.workerStatus(), job: this.current(courseId) };
    }

    /** Resolves when every request made in this process is done (tests, shutdown, the CLI). */
    async whenIdle(): Promise<void> {
        while (this.driving) await this.driving;
    }

    // --- The queue ---

    /** Start the loop that waits for this process's requests, unless it runs already. */
    private kick(): void {
        if (this.driving) return;
        this.driving = this.drive().finally(() => {
            this.driving = null;
            this.settleAll();
            // A request made just as the loop ended: go on for it.
            if (this.pending()) this.kick();
        });
    }

    /** Every request made here stops waiting to be shown (its run began, or it is queued behind another). */
    private settleAll(): void {
        for (const l of this.local.values()) l.settled();
    }

    private pending(): boolean {
        return [...this.local.values()].some(l => l.req.state !== 'done');
    }

    /**
     * Until every request made here is done: take the lease and run batches
     * (anyone's, ours among them), or, while another process holds it, follow
     * our requests' files. The lease is tried on every round, so a holder that
     * dies is taken over.
     */
    private async drive(): Promise<void> {
        for (;;) {
            await this.follow();
            if (!this.pending()) return;
            const lease = await this.queue.tryLease();
            if (lease) {
                await this.runBatches(lease);
                continue;
            }
            this.settleAll();
            await Bun.sleep(this.timeouts.pollMs);
        }
    }

    /** Our requests as their files have them, and the run another process serves them with. */
    private async follow(): Promise<void> {
        for (const l of this.local.values()) {
            if (l.req.state === 'done' && (l.run || l.foreign?.finishedAt)) continue;
            const req = await this.queue.get(l.req.id);
            if (req) l.req = req;
            if (l.req.runId && l.run?.job.id !== l.req.runId) {
                l.foreign = await this.queue.readRun<ShapingJob, ShapingApplyResult>(l.req.runId) ?? l.foreign;
            }
        }
    }

    private async runBatches(lease: QueueLease): Promise<void> {
        let lost = false;
        // The beat in flight: awaited before the release, which it would otherwise undo.
        let beating: Promise<void> = Promise.resolve();
        const beat = setInterval(() => {
            beating = this.queue.beat(lease).then(ok => { if (!ok) lost = true; }, () => undefined);
        }, this.timeouts.heartbeatMs);
        let prefer: string | null = null;
        try {
            while (!lost) {
                const batch = await this.queue.takeBatch(lease, prefer);
                if (!batch) break;
                prefer = batch.requests[0]!.courseId;
                await this.runBatch(batch.runId, batch.requests);
            }
        } finally {
            clearInterval(beat);
            await beating;
            await this.queue.release(lease);
        }
    }

    /** One run for a batch: `perform` with the batch's flags, then each request's slice, all into the files. */
    private async runBatch(runId: string, requests: QueueRequest[]): Promise<void> {
        const courseId = requests[0]!.courseId;
        const flags = batchFlags(requests);
        const rec: JobRecord = {
            job: {
                id: runId, courseId, status: 'running', runId, queued: false, note: null, slice: null,
                dryRun: flags.dryRun, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
            },
            phases: new JobPhases(SHAPING_PHASES),
            t0: Date.now(),
            t1: null,
        };
        this.jobs.set(runId, rec);
        this.running = { rec };
        for (const r of requests) {
            const l = this.local.get(r.id);
            if (l) Object.assign(l, { req: r, run: rec, foreign: null });
        }
        const run: QueueRun<ShapingJob, ShapingApplyResult> = {
            id: runId, courseId, requestIds: requests.map(r => r.id), startedAt: rec.job.startedAt,
            finishedAt: null, job: snapshot(rec), result: null, error: null, slices: {},
        };
        await this.queue.writeRun(run);
        // The progress write in flight: awaited before the final one, which it would otherwise overwrite.
        let writing: Promise<void> = Promise.resolve();
        const progress = setInterval(() => {
            writing = this.queue.writeRun({ ...run, job: snapshot(rec) }).catch(() => undefined);
        }, this.timeouts.heartbeatMs);
        try {
            const performing = this.perform(rec, flags);
            this.settleAll();
            const result = await performing;
            rec.job.status = 'succeeded';
            rec.job.result = result;
            rec.phases.current = null;
            run.result = result;
            run.slices = Object.fromEntries(requests.map(r => [r.id, sliceFor(r, result, requests)]));
        } catch (err) {
            rec.job.status = 'failed';
            rec.job.error = err instanceof Error ? err.message : String(err);
            rec.phases.failCurrent(rec.job.error);
            run.error = rec.job.error;
        } finally {
            clearInterval(progress);
            rec.t1 = Date.now();
            rec.job.finishedAt = new Date().toISOString();
        }
        await writing;
        run.finishedAt = rec.job.finishedAt;
        run.job = snapshot(rec);
        const ok = rec.job.status === 'succeeded';
        try {
            await this.queue.writeRun(run);
            await this.queue.finish(requests, ok, rec.job.error);
        } finally {
            for (const r of requests) {
                const l = this.local.get(r.id);
                if (l) {
                    l.req = { ...r, state: 'done', ok, error: rec.job.error };
                    l.slice = run.slices[r.id] ?? null;
                }
            }
            if (this.running?.rec === rec) this.running = null;
        }
    }

    /** A request as a job: its run's (ours, or another process's as its file has it), or a queued one. */
    private view(l: LocalRequest): ShapingJob {
        const own = { id: l.req.id, courseId: l.req.courseId, note: l.req.note };
        if (l.run) {
            return { ...snapshot(l.run), ...own, runId: l.run.job.id, queued: false, slice: l.slice };
        }
        const run = l.foreign;
        if (run) {
            const done = run.finishedAt !== null;
            return {
                ...run.job, ...own, runId: run.id, queued: false,
                // The file's job is a snapshot: done only once the run is.
                status: done ? (run.error ? 'failed' : 'succeeded') : 'running',
                result: done ? run.result : null, error: done ? run.error : null,
                slice: run.slices[l.req.id] ?? null,
            };
        }
        const others = [...this.local.values()].filter(o => o !== l && o.req.state === 'queued').length;
        return {
            ...own, runId: null, queued: true, status: 'running', phase: null,
            phases: new JobPhases(SHAPING_PHASES).snapshot(),
            step: this.running ? `queued behind the run for ${this.running.rec.job.courseId} (${snapshot(this.running.rec).step})`
                : others ? `queued with ${others} other request(s)` : 'queued: waiting for the Blender worker',
            dryRun: l.req.flags.dryRun, startedAt: l.req.createdAt, finishedAt: null,
            seconds: secs(Date.now() - l.t0), result: null, error: null, slice: null,
        };
    }

    /** Stop the worker this server started, if any (tests; the worker otherwise outlives the server on purpose). */
    async stopWorker(): Promise<void> {
        const w = this.worker;
        if (!w) return;
        await w.proc.kill();
        this.worker = null;
    }

    /**
     * Keep the course's newest KEEP_DONE finished requests in memory (the files
     * keep the rest), and only the runs those, or a running request, still show.
     */
    private forgetDone(courseId: string): void {
        const done = [...this.local.entries()].filter(([, l]) => l.req.courseId === courseId && l.req.state === 'done')
            .sort(([, a], [, b]) => b.t0 - a.t0);
        for (const [id] of done.slice(KEEP_DONE)) this.local.delete(id);
        const shown = new Set([...this.local.values()].map(l => l.run?.job.id).filter(Boolean));
        for (const [id, rec] of this.jobs) {
            if (rec.job.courseId === courseId && rec.job.status !== 'running' && !shown.has(id)) this.jobs.delete(id);
        }
    }

    // --- The job ---

    private async perform(rec: JobRecord, opts: Pick<ShapingApplyOptions, 'dryRun' | 'skipUnity' | 'paths' | 'save'>): Promise<ShapingApplyResult> {
        const t0 = Date.now();
        const warnings: string[] = [];
        const dryRun = opts.dryRun === true;

        beginPhase(rec, 'layers', opts.paths ? 'path surfaces (gspro.py svg --paths-only)' : 'gspro.py shaping-global');
        const { dir: exportDir } = await this.exportSettings.settings(rec.job.courseId);
        // First: shaping-global emits the split of the mixed roads, which the worker cuts along this file.
        const pathSurfaces = opts.paths ? await this.writePathSurfaces(rec.job.courseId) : [];
        warnings.push(...pathSurfaces.filter(l => l.startsWith('warning:')));
        if (opts.paths) notePhase(rec, 'gspro.py shaping-global');
        const layersDir = await this.layersDir(rec.job.courseId);
        const layers = await this.writeLayers(rec.job.courseId, layersDir, exportDir);
        endPhase(rec, 'layers', 'done', layers.find(l => /\bops?\b|op\(s\)/.test(l))?.trim() ?? `${layers.length} report line(s)`);

        beginPhase(rec, 'worker', 'finding the .blend and the Unity project');
        const blend = await this.resolveBlend(exportDir, warnings);
        const { editor, seen } = opts.skipUnity && this.fbxFolder
            ? { editor: null, seen: [] as string[] }
            : await editorForExportDir(this.unityBridge, exportDir);
        const fbxFolder = this.fbxFolder ?? (editor ? path.join(editor.projectPath, 'Assets', 'fbx') : null);
        const how = await this.ensureWorker({ blend, layersDir, fbxFolder }, rec, seen);
        endPhase(rec, 'worker', 'done', how);

        beginPhase(rec, 'blender', dryRun ? 'planning what changed (dry run)' : 're-shaping what changed');
        const sync = await this.sync(dryRun, rec);
        const changedObjects = strings(sync.changedObjects);
        const removed = strings(sync.removed);
        const exported = strings(sync.exported);
        // Unity's only=: the re-shaped objects plus those whose FBX is gone (meshes.sync prunes a named object without one).
        const unityObjects = [...new Set([...changedObjects, ...removed.map(objectName)])];
        const gates = gatesOf(sync.report?.gates);
        warnings.push(...strings(sync.report?.warnings), ...(gates?.warnings ?? []), ...opErrors(sync.errors));
        endPhase(rec, 'blender', 'done', `${changedObjects.length} object(s) re-shaped, ${exported.length} FBX exported`
            + (removed.length ? `, ${removed.length} removed` : ''));

        let unityReport: unknown = null;
        let pathMaterials: unknown = null;
        let unityError: string | null = null;
        const skip = (why: string) => {
            warnings.push(why);
            skipPhase(rec, 'unity', why);
        };
        if (opts.skipUnity) {
            skip('Unity refresh skipped (skipUnity)');
        } else if (!editor) {
            skip(`Unity not refreshed: no open Unity editor imports from ${exportDir}${seen.length ? ` (${seen.join('; ')})` : ''}`);
        } else if (unityObjects.length === 0 && !opts.paths) {
            // also on a dry run: `only=` with no name is an error in Unity ("only= names no object")
            skip('Unity not refreshed: no object changed');
        } else {
            const refresh = unityObjects.length > 0;
            beginPhase(rec, 'unity', refresh ? `refreshing ${unityObjects.length} object(s) in ${editor.projectName}` : `path materials in ${editor.projectName}`);
            try {
                // With `paths` the look goes on every path mesh afterwards, so the refresh leaves its own (named meshes only) out.
                const more = {
                    ...(opts.save && !dryRun ? { save: true } : {}),
                    ...(opts.paths ? { skip: 'paths.materials' } : {}),
                };
                if (refresh) unityReport = await this.refreshUnity(editor, unityObjects, dryRun, warnings, more);
                if (opts.paths) {
                    notePhase(rec, `path materials in ${editor.projectName}`);
                    pathMaterials = await editor.run('golfmap.paths.materials', dryRun ? { dryRun: true } : {}, this.timeouts.unitySec);
                    warnings.push(...strings((pathMaterials as { problems?: unknown } | null)?.problems).map(q => `path materials: ${q}`));
                }
                endPhase(rec, 'unity', 'done', (refresh ? `${unityObjects.length} object(s) refreshed` : 'no object changed')
                    + (opts.paths ? ', path materials applied' : '') + ` in ${editor.projectName}`);
            } catch (e) {
                unityError = (e as Error).message.split('\n')[0] ?? String(e);
                warnings.push(`Unity refresh failed: ${unityError}`);
                endPhase(rec, 'unity', 'failed', unityError);
            }
        }
        const vegetation = await this.vegetationPhase(rec, {
            editor, unityObjects, unityReport, dryRun, warnings, save: opts.save === true,
        });
        return {
            changedObjects,
            exported,
            removed,
            warnings,
            places: Array.isArray(sync.report?.changedPlaces) ? sync.report!.changedPlaces as unknown[] : [],
            seams: seamsOf(sync.report?.seams),
            gates,
            unityReport,
            pathSurfaces,
            pathMaterials,
            unitySteps: unitySteps(unityReport),
            unityError,
            vegetation,
            layers,
            blend,
            layersDir,
            fbxFolder,
            dryRun,
            seconds: Math.round((Date.now() - t0) / 100) / 10,
        };
    }

    /**
     * A rock slab changed: the surface map out of Unity (unless the refresh
     * just did it), then the lower vegetation planted again so the grass leaves
     * the rock. Skipped (with the reason) when none changed, on a dry run (the
     * export and the planting write files) and when Unity was not refreshed.
     * A failure ends the phase as failed and fails the job. Returns the
     * planting's report lines.
     */
    private async vegetationPhase(rec: JobRecord, c: {
        editor: UnityEditor | null; unityObjects: string[]; unityReport: unknown; dryRun: boolean;
        warnings: string[]; save: boolean;
    }): Promise<string[]> {
        const slabs = c.unityObjects.filter(isRockSlab);
        if (slabs.length === 0) {
            skipPhase(rec, 'vegetation', 'no rock slab changed');
            return [];
        }
        const names = `${slabs.length} rock slab(s): ${slabs.join(', ')}`;
        if (c.dryRun) {
            skipPhase(rec, 'vegetation', `dry run: the surface map and the grass would be redone for ${names}`);
            return [];
        }
        if (!c.editor || c.unityReport === null) {
            const why = `Surface map and grass not updated for ${names}: Unity was not refreshed`;
            c.warnings.push(why);
            skipPhase(rec, 'vegetation', why);
            return [];
        }
        const editor = c.editor;
        // The refresh re-exports the surface map itself when a slab is among its objects; its step says so.
        const exported = unitySteps(c.unityReport).some(s => s.id === 'surfaces.export' && s.status === 'done');
        let what = 'surface map export in Unity (golfmap.surfaces.export)';
        beginPhase(rec, 'vegetation', exported ? `planting vegetation for ${names}` : `exporting the surface map for ${names}`);
        try {
            if (!exported) await editor.run('golfmap.surfaces.export', { terrain: 'inner' }, this.timeouts.unitySec);
            what = 'vegetation planting';
            notePhase(rec, `planting vegetation for ${names}`);
            const planted = await this.exportSettings.plantVegetation(rec.job.courseId, 'inner',
                { dbPath: this.dbPath, arborist: 'lower', save: c.save });
            endPhase(rec, 'vegetation', 'done', `${slabs.length} rock slab(s): surface map ${exported ? 'from the refresh' : 'exported'}, grass planted in ${editor.projectName}`);
            return planted.report;
        } catch (e) {
            const message = `Rock slab(s) changed (${slabs.join(', ')}) but the ${what} failed: ${(e as Error).message.split('\n')[0]}`;
            endPhase(rec, 'vegetation', 'failed', message);
            throw new ConflictError(message);
        }
    }

    /**
     * `gspro.py svg --paths-only`: the road surfaces file of the course's
     * exported SVG rewritten from the course as it is now; its report lines.
     * 409 when the SVG was never exported (the file describes its shapes).
     */
    private async writePathSurfaces(courseId: string): Promise<string[]> {
        const { args } = await this.exportSettings.svgCommand(courseId, { dbPath: this.dbPath });
        const { code, stdout, stderr } = await this.runner([...args, '--paths-only'], this.pipelineDir);
        if (code !== 0) throw failure('Path surfaces (gspro.py svg --paths-only)', code, stdout, stderr);
        return reportLines(stdout);
    }

    /**
     * The course's generated layers into its layer folder; their report lines: `gspro.py shaping-global` (00-global,
     * 10-features from the database), `shaping-creek-beds` (22-creek-beds: the creek beds the meshes cannot carry,
     * from the site's edited DEM and the export's inner heightmap sidecar), then from the course's docs folder
     * `shaping-walls` (80-walls: the ground under the stone walls, stone-walls.json) and `shaping-paint` (90-paint:
     * the vertex paint, paint.json).
     */
    private async writeLayers(courseId: string, layersDir: string, exportDir: string): Promise<string[]> {
        await ensureDir(layersDir);
        const gspro = path.join(this.pipelineDir, 'gspro.py');
        const courseDir = path.dirname(layersDir);
        const db = this.dbPath ? ['--db', this.dbPath] : [];
        const global = [gspro, 'shaping-global', '--course', courseId, '--out-dir', layersDir, '--library', this.recipeLibrary, ...db];
        const beds = [gspro, 'shaping-creek-beds', '--course', courseId, '--out-dir', layersDir, '--export-dir', exportDir,
            '--sources-dir', path.join(this.dataDir, 'sources'), ...db];
        const lines: string[] = [];
        for (const [name, args] of [
            ['shaping-global', global],
            ['shaping-creek-beds', beds],
            ['shaping-walls', [gspro, 'shaping-walls', '--course-dir', courseDir, '--out-dir', layersDir]],
            ['shaping-paint', [gspro, 'shaping-paint', '--course-dir', courseDir, '--out-dir', layersDir]],
        ] as const) {
            const { code, stdout, stderr } = await this.runner([...args], this.pipelineDir);
            if (code !== 0) throw failure(`Shaping layers (gspro.py ${name})`, code, stdout, stderr);
            lines.push(...reportLines(stdout));
        }
        return lines;
    }

    /**
     * The .blend to shape: the configured one, else the newest source .blend
     * in the export folder (the worker prepares or reuses its conformed
     * cache), else the newest conformed cache when no source is there.
     */
    private async resolveBlend(exportDir: string, warnings: string[]): Promise<string> {
        if (this.blend) {
            const file = path.resolve(exportDir, this.blend);
            if (!existsSync(file)) throw new ConflictError(`GOLFMAP_SHAPING_BLEND names ${file}, which does not exist`);
            return file;
        }
        let names: string[] = [];
        try {
            names = await readdir(exportDir);
        } catch {
            throw new ConflictError(`The export folder ${exportDir} does not exist`);
        }
        const blends = await Promise.all(names.filter(n => n.toLowerCase().endsWith('.blend')).map(async n => {
            const file = path.join(exportDir, n);
            return { file, name: n, mtime: (await stat(file)).mtimeMs, conformed: n.toLowerCase().endsWith('.conformed.blend') };
        }));
        const newest = (list: typeof blends) => list.sort(newerBlendFirst)[0] ?? null;
        const conformed = newest(blends.filter(b => b.conformed));
        const source = newest(blends.filter(b => !b.conformed));
        // The newest SOURCE .blend is the course as OPCD last built it; the worker makes or reuses
        // its `<name>.conformed.blend` itself (and notices a changed terrain.obj). Picking the newest
        // conformed cache first, as this did until 2026-10-14, kept shaping an old build after a
        // new one had been downloaded.
        if (source) {
            const cache = blends.find(b => b.conformed && b.name.toLowerCase() === source.name.toLowerCase().replace(/\.blend$/, '.conformed.blend'));
            if (!cache) warnings.push(`${source.name} has no conformed cache yet: the worker prepares it on load (a minute or two)`);
            return source.file;
        }
        if (conformed) return conformed.file;
        throw new ConflictError(`No .blend in the export folder ${exportDir}: build the course's .blend with OPCD first (or set GOLFMAP_SHAPING_BLEND)`);
    }

    // --- The worker ---

    /** `GET /status`, never throwing: unreachable is a status. */
    async workerStatus(): Promise<ShapingWorkerStatus> {
        const spawnedPid = this.worker?.proc.alive() ? this.worker.proc.pid : null;
        const base = { url: this.workerUrl, spawnedPid, log: this.worker?.log ?? null };
        try {
            const res = await fetch(`${this.workerUrl}/status`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
            // An error answer often has no body at all (a bare 503 while it is loaded down):
            // that is an answer, so still `reachable` — `HTTP <code>` is what it said.
            const body = (await res.json().catch(() => null) as Record<string, unknown> | null) ?? {};
            const str = (v: unknown) => typeof v === 'string' && v ? v : null;
            return {
                ...base,
                reachable: true,
                state: str(body.state) ?? (res.ok ? null : 'error'),
                phase: str(body.phase),
                blend: this.fromWorker(str(body.blend)),
                conformed: this.fromWorker(str(body.conformed)),
                layersDir: this.fromWorker(str(body.layersDir)),
                appliedOps: body.appliedOps ?? null,
                lastRun: body.lastRun ?? null,
                job: workerJob(body.job),
                error: str(body.error) ?? (res.ok ? null : `HTTP ${res.status}`),
            };
        } catch (e) {
            return {
                ...base, reachable: false, state: null, phase: null, blend: null, conformed: null, layersDir: null,
                appliedOps: null, lastRun: null, job: null, error: (e as Error).message,
            };
        }
    }

    /**
     * A worker that answers, holds `target`'s .blend and layer folder, and is
     * not busy; says how it got there (the worker phase's detail).
     */
    private async ensureWorker(target: WorkerTarget, rec: JobRecord, seenEditors: string[]): Promise<string> {
        const name = path.basename(target.blend);
        /** The worker's own phase after `what` while polling (`apply 12/63 recipe-1d`). */
        const follow = (what: string) => (st: ShapingWorkerStatus) => notePhase(rec, st.phase ? `${what}: ${st.phase}` : what);
        let st = await this.workerStatus();
        let cold = false;
        if (!st.reachable) {
            if (this.pathMap.length) {
                throw new ConflictError(`The shaping worker at ${this.workerUrl} does not answer (${st.error}): it runs on another machine`
                    + ' (GOLFMAP_SHAPING_PATH_MAP is set), so start it there with `bun run shaping:worker`');
            }
            cold = true;
            notePhase(rec, 'cold start: starting Blender');
            await this.spawnWorker(target);
            st = await this.waitFor(s => s.reachable, this.timeouts.startMs, 'the shaping worker to answer');
        }
        // Someone else's worker on the port, holding another course: wait for it to finish
        // rather than take it over mid-run (a `/load` would throw its work away).
        const foreign = !cold && st.spawnedPid === null && st.blend !== null && !holds(st, target);
        if (!idle(st)) {
            const what = cold ? `cold start: Blender loading ${name}`
                : foreign ? `another course's worker is busy on ${st.blend} — waiting`
                    : `waiting for the worker (${st.job?.state === 'running' ? `${st.job.kind ?? 'job'} running` : st.state})`;
            notePhase(rec, st.phase ? `${what}: ${st.phase}` : what);
            st = await this.waitFor(idle, this.timeouts.loadMs, 'the shaping worker to be ready', follow(what));
        }
        if (holds(st, target) && st.state !== 'error') return cold ? `cold start: Blender started and loaded ${name}` : `already loaded (${name})`;
        if (!target.fbxFolder) {
            throw new ConflictError('The shaping worker has to load the course, but there is no FBX folder to export into: open the course\'s Unity project'
                + ` (${seenEditors.length ? seenEditors.join('; ') : 'no editor open'}) or set GOLFMAP_SHAPING_FBX_FOLDER`);
        }
        notePhase(rec, `loading ${name}`);
        try {
            // A job: it answers at once and the load goes on (minutes, when the conformed cache has to be made).
            await this.post('/load', {
                blend: this.toWorker(target.blend), layersDir: this.toWorker(target.layersDir), fbxFolder: this.toWorker(target.fbxFolder),
            }, this.timeouts.startMs);
        } catch (e) {
            // An older worker holds the connection for the whole load, and a long one can outlast the
            // request: its own status says how it went. A refusal leaves it idle and untouched, so that stands.
            const after = await this.workerStatus();
            if (!after.reachable || (idle(after) && !holds(after, target))) throw e;
        }
        st = await this.waitFor(idle, this.timeouts.loadMs, 'the shaping worker to load the course', follow(`loading ${name}`));
        if (st.state === 'error' || st.job?.state === 'failed') {
            throw new ConflictError(`The shaping worker failed to load ${target.blend}: `
                + (st.job?.error ?? st.error ?? describeRun(st.lastRun) ?? 'see its log'));
        }
        if (!holds(st, target)) throw new ConflictError(`The shaping worker loaded ${st.blend ?? st.conformed ?? 'nothing'} / ${st.layersDir ?? '?'}, not ${target.blend} / ${target.layersDir}`);
        return `loaded ${name}`;
    }

    /**
     * Start the worker for `target`, its two streams into one log of its own
     * (`<data>/shaping-worker/<when>-<pid>.log`, nothing truncated; the current
     * one named in `latest.json`, logs older than `LOG_KEEP_DAYS` pruned). The
     * token, when there is one, goes through the environment rather than the
     * command line, where every process list would show it.
     */
    private async spawnWorker(target: WorkerTarget): Promise<void> {
        const dir = path.join(this.dataDir, 'shaping-worker');
        await ensureDir(dir);
        await pruneLogs(dir);
        const port = new URL(this.workerUrl).port || '8766';
        const args = ['--', '--port', port, '--blend', target.blend, '--layers', target.layersDir];
        if (target.fbxFolder) args.push('--fbx-folder', target.fbxFolder);
        const cmd = [...this.workerLauncher, ...args];
        const stamp = logStamp(new Date());
        let log = path.join(dir, `${stamp}.log`);
        // Outside this process's tree (and on Windows outside the app's job): the worker
        // outlives a server restart (bun --watch) and Claude being closed; the next server finds it on its port.
        const proc = await spawnDetached(cmd, {
            cwd: REPO_DIR,
            env: {
                ...process.env,
                GOLFMAP_SHAPING_PORT: port,
                ...(this.token ? { GOLFMAP_SHAPING_TOKEN: this.token } : {}),
                PYTHONIOENCODING: 'utf-8',
            },
            log,
        });
        // Named after the run it holds; the child writes through its inherited handle either way. Not on
        // Windows: there the detached cmd opens the log by name, maybe after this, so the timestamp alone names it.
        if (process.platform !== 'win32') {
            try {
                const named = path.join(dir, `${stamp}-${proc.pid}.log`);
                renameSync(log, named);
                log = named;
            } catch {
                // Kept under the timestamp alone.
            }
        }
        const worker = { proc, log };
        this.worker = worker;
        await writeFile(path.join(dir, LATEST_LOG), `${JSON.stringify({
            file: path.basename(log), pid: proc.pid, startedAt: new Date().toISOString(), command: cmd,
        }, null, 2)}\n`);
    }

    /** Poll `/status` until `ok`; fails early when the worker this server started exits. */
    private async waitFor(
        ok: (s: ShapingWorkerStatus) => boolean, timeoutMs: number, what: string, onPoll?: (s: ShapingWorkerStatus) => void,
    ): Promise<ShapingWorkerStatus> {
        const until = Date.now() + timeoutMs;
        for (;;) {
            const st = await this.workerStatus();
            if (ok(st)) return st;
            onPoll?.(st);
            const w = this.worker;
            if (w && !w.proc.alive() && !st.reachable) {
                throw new ConflictError(`The shaping worker exited (code ${await w.proc.exitCode() ?? '?'}) before ${what.replace(/^the shaping worker /, '')}: ${await logTail(w.log)}`);
            }
            if (Date.now() > until) throw new ConflictError(`Timed out waiting for ${what} (${Math.round(timeoutMs / 1000)} s; ${st.reachable ? `state ${st.state}` : st.error})`);
            await Bun.sleep(this.timeouts.pollMs);
        }
    }

    /**
     * `POST /sync` as a job: the answer names it, `/status` is polled until it
     * is done and its `result` is the run (`GET /job/<id>` when the status has
     * moved on to another job). A worker that answers with the run itself
     * (`?wait=1`, or one that predates the job protocol) is taken as it is, and
     * a connection that drops under it falls back to the worker's `lastRun`.
     *
     * A poll that says nothing about our job — unreachable, or an error answer
     * carrying no job — is TOLERATED for `unreachableMs` (Blender holds the GIL
     * in a long op, so the 5 s `/status` timeout is hit now and then) and only
     * then gives up: the run itself goes on either way, and ending the wait on
     * the first blip left it reported as failed while the worker was still
     * shaping.
     */
    private async sync(dryRun: boolean, rec: JobRecord): Promise<SyncAnswer> {
        const follow = (w: ShapingWorkerStatus) =>
            notePhase(rec, w.phase ? `re-shaping what changed: ${w.phase}` : 're-shaping what changed');
        let started: unknown;
        try {
            started = await this.post('/sync', {
                ...(dryRun ? { dryRun: true } : {}), ...(this.allowGaps ? { allowGaps: true } : {}),
            }, this.timeouts.startMs);
        } catch (e) {
            const st = await this.workerStatus();
            if (!st.reachable) throw e;
            const done = await this.waitFor(idle, this.timeouts.syncMs, 'the shaping worker to finish the sync', follow);
            const last = asRun(done.job?.result ?? done.lastRun);
            if (done.state === 'error' || !last || !Array.isArray(last.changedObjects)) throw e;
            return last;
        }
        const id = jobIdOf(started);
        if (id === null) return asRun(started) ?? started as SyncAnswer;   // the run itself: an older worker, or `?wait=1`
        /** Since when `/status` has told us nothing about job `id`; null while it does. */
        let lostAt: number | null = null;
        const done = await this.waitFor(
            (s) => {
                if (lost(s)) {
                    lostAt ??= Date.now();
                    return Date.now() - lostAt >= this.timeouts.unreachableMs;
                }
                lostAt = null;
                return s.job === null || s.job.id !== id || s.job.state !== 'running';
            },
            this.timeouts.syncMs, 'the shaping worker to finish the sync', follow);
        if (lostAt !== null) {
            throw new ConflictError(`The shaping worker stopped answering during the sync`
                + ` (${Math.round((Date.now() - lostAt) / 1000)} s with no answer about job ${id}): ${done.error ?? 'unreachable'}`);
        }
        // Its status has moved on to another job (another course took the worker over): ask for ours by id.
        const job = done.job?.id === id ? done.job : await this.jobById(id);
        if (!job) throw new ConflictError(`The shaping worker forgot the sync job ${id} (${describeRun(done.lastRun) ?? `state ${done.state}`})`);
        if (job.state === 'failed') throw new ConflictError(`Shaping worker /sync failed: ${job.error ?? 'see its log'}`);
        const result = asRun(job.result);
        if (!result || !Array.isArray(result.changedObjects)) {
            throw new ConflictError(`The shaping worker's sync job ${id} came back without a run (state ${job.state})`);
        }
        return result;
    }

    /**
     * `POST <route>` on the worker as a job (`/check`): the answer names it, `/status` is polled until
     * it is done and its `result` is returned. A worker that answers with the result itself is taken
     * as it is. Same tolerance for a silent worker as `sync`; no course is loaded or switched here.
     */
    async workerRun(
        route: string, body: unknown, opts: { timeoutMs?: number; onPhase?: (phase: string | null) => void } = {},
    ): Promise<unknown> {
        const timeoutMs = opts.timeoutMs ?? this.timeouts.syncMs;
        const started = await this.post(route, body, this.timeouts.startMs);
        const id = jobIdOf(started);
        if (id === null) return started;
        let lostAt: number | null = null;
        const done = await this.waitFor(
            (s) => {
                if (lost(s)) {
                    lostAt ??= Date.now();
                    return Date.now() - lostAt >= this.timeouts.unreachableMs;
                }
                lostAt = null;
                return s.job === null || s.job.id !== id || s.job.state !== 'running';
            },
            timeoutMs, `the shaping worker to finish ${route}`, s => opts.onPhase?.(s.phase));
        if (lostAt !== null) {
            throw new ConflictError(`The shaping worker stopped answering during ${route} (job ${id}): ${done.error ?? 'unreachable'}`);
        }
        const job = done.job?.id === id ? done.job : await this.jobById(id);
        if (!job) throw new ConflictError(`The shaping worker forgot the ${route} job ${id}`);
        if (job.state === 'failed') throw new ConflictError(`Shaping worker ${route} failed: ${job.error ?? 'see its log'}`);
        return job.result;
    }

    /** `GET /job/<id>`; null when the worker does not know it (or cannot be asked). */
    private async jobById(id: string): Promise<ShapingWorkerJob | null> {
        try {
            const res = await fetch(`${this.workerUrl}/job/${encodeURIComponent(id)}`,
                { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
            if (!res.ok) return null;
            return workerJob(await res.json());
        } catch {
            return null;
        }
    }

    /** A path as the worker opens it (GOLFMAP_SHAPING_PATH_MAP; unchanged without one). */
    toWorker<T extends string | null>(p: T): T {
        return (p === null ? p : mapPath(this.pathMap, p, 'toWorker')) as T;
    }

    /** A path the worker reported, as this server opens it. */
    fromWorker<T extends string | null>(p: T): T {
        return (p === null ? p : mapPath(this.pathMap, p, 'fromWorker')) as T;
    }

    /** The shared secret both sides use, when there is one. */
    private headers(): Record<string, string> {
        return this.token ? { 'X-Golfmap-Token': this.token } : {};
    }

    private async post(route: string, body: unknown, timeoutMs: number): Promise<unknown> {
        const res = await fetch(`${this.workerUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.headers() },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch {
            parsed = null;
        }
        if (!res.ok) {
            const err = (parsed as { error?: unknown } | null)?.error;
            throw new ConflictError(`Shaping worker ${route} failed: ${typeof err === 'string' ? err : `HTTP ${res.status} ${text.slice(0, 300)}`}`);
        }
        if (parsed === null) throw new ConflictError(`Shaping worker ${route} answered with something that is not JSON: ${text.slice(0, 300)}`);
        return parsed;
    }

    // --- Unity ---

    /**
     * `golfmap.course.refresh only=<objects>`; a bridge that does not know
     * `only` yet gets the whole refresh instead (with a warning).
     */
    private async refreshUnity(editor: UnityEditor, changed: string[], dryRun: boolean, warnings: string[], more: Record<string, unknown> = {}): Promise<unknown> {
        const extra = { ...(dryRun ? { dryRun: true } : {}), ...more };
        try {
            return await editor.run('golfmap.course.refresh', { only: changed.join(','), ...extra }, this.timeouts.unitySec);
        } catch (e) {
            const msg = (e as Error).message;
            if (!/\bonly\b/.test(msg) || !/unknown|unexpected|unsupported|not (a )?(known|valid)/i.test(msg)) throw e;
            warnings.push(`this Unity bridge does not take only= yet: refreshed the whole course (${msg.split('\n')[0]})`);
            return editor.run('golfmap.course.refresh', extra, this.timeouts.unitySec);
        }
    }
}

// --- Helpers ---

/**
 * Newest first by mtime; on a tie the higher build number (`_svg_110` before
 * `_svg_109`, numbers compared as numbers). A copied .blend keeps its source's
 * mtime, and the name order picked the older build: Omberg's svg_109 and
 * svg_110 had the same mtime, and an apply would have loaded svg_109 over the
 * svg_110 the worker held.
 */
export function newerBlendFirst(a: { name: string; mtime: number }, b: { name: string; mtime: number }): number {
    return b.mtime - a.mtime || b.name.localeCompare(a.name, undefined, { numeric: true });
}

/** GOLFMAP_BLENDER, else Blender 4.5's default install on Windows, else `blender` on PATH. */
export function blenderExecutable(): string {
    if (process.env.GOLFMAP_BLENDER) return process.env.GOLFMAP_BLENDER;
    if (process.platform === 'win32' && existsSync(WINDOWS_BLENDER)) return WINDOWS_BLENDER;
    return 'blender';
}

// --- The job's phases ---

/** A request made in this process, with what is known of the run that serves it. */
interface LocalRequest {
    req: QueueRequest;
    /** The run, when this process runs it. */
    run: JobRecord | null;
    /** The run as another process wrote it, when that one runs it. */
    foreign: QueueRun<ShapingJob, ShapingApplyResult> | null;
    /** Its slice, once this process's run of it is done. */
    slice: RequestSlice | null;
    t0: number;
    /** Lets `apply` return: the run began, or the request waits behind another. */
    settled: () => void;
}

/** A job as this process keeps it: the public job without its phases, plus them and the clocks. */
interface JobRecord {
    job: Omit<ShapingJob, 'phase' | 'phases' | 'step' | 'seconds'>;
    phases: JobPhases<ShapingPhaseId>;
    t0: number;
    t1: number | null;
}

/** The apply job's phases, in order (also mirrored by the GSPro sync board's `meshes` chain). */
export const SHAPING_PHASES: ReadonlyArray<readonly [ShapingPhaseId, string]> = [
    ['layers', 'Generating layers'],
    ['worker', 'Starting the shaping worker'],
    ['blender', 'Blender sync'],
    ['unity', 'Unity refresh'],
    ['vegetation', 'Surface map and grass'],
];

const beginPhase = (rec: JobRecord, id: ShapingPhaseId, detail: string) => rec.phases.begin(id, detail);
/** The running phase's detail (what it is doing now). */
const notePhase = (rec: JobRecord, detail: string) => rec.phases.note(detail);
const endPhase = (rec: JobRecord, id: ShapingPhaseId, status: 'done' | 'failed', detail: string | null) => rec.phases.end(id, status, detail);
const skipPhase = (rec: JobRecord, id: ShapingPhaseId, why: string) => rec.phases.skip(id, why);

/** The job as the API serves it: a copy, with the running phase's seconds and the one-line step up to now. */
function snapshot(rec: JobRecord): ShapingJob {
    return {
        ...rec.job,
        phase: rec.phases.current,
        phases: rec.phases.snapshot(),
        step: rec.phases.step(rec.job.status, rec.job.error),
        seconds: secs((rec.t1 ?? Date.now()) - rec.t0),
    };
}

/** The refresh report's steps with their seconds. */
function unitySteps(report: unknown): ShapingUnityStep[] {
    const steps = (report as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) return [];
    return steps.flatMap(s => {
        const step = s as { id?: unknown; status?: unknown; seconds?: unknown } | null;
        if (typeof step?.id !== 'string') return [];
        return [{ id: step.id, status: typeof step.status === 'string' ? step.status : 'unknown', seconds: typeof step.seconds === 'number' ? step.seconds : null }];
    });
}

/**
 * A poll that says nothing about the run we are waiting for: nothing answered
 * (not started, a dropped connection, the 5 s timeout while Blender holds the
 * GIL), or an error answer with no job in it (a 503 under load, a token gone
 * wrong). Not the same as failure — the worker may well still be shaping.
 */
const lost = (s: ShapingWorkerStatus) => !s.reachable || (s.job === null && s.error !== null);

/** Reachable, not loading or syncing, and with no job of its own still running. */
const idle = (s: ShapingWorkerStatus) =>
    s.reachable && s.state !== 'starting' && s.state !== 'busy' && s.job?.state !== 'running';

/** `/status`'s `job` (or a `/job/<id>` answer) read leniently; null when there is none. */
export function workerJob(value: unknown): ShapingWorkerJob | null {
    const j = value as Record<string, unknown> | null | undefined;
    if (!j || typeof j !== 'object' || j.id === undefined || j.id === null) return null;
    const str = (v: unknown) => typeof v === 'string' && v ? v : null;
    return {
        id: String(j.id),
        kind: str(j.kind),
        state: str(j.state) ?? 'running',
        phase: str(j.phase),
        startedAt: str(j.startedAt),
        seconds: typeof j.seconds === 'number' ? j.seconds : null,
        result: j.result ?? null,
        error: str(j.error),
    };
}

/**
 * A `/sync` answer as a run. A dry run that found changes answers with its plan only (`dryRun`, `changedOps`,
 * `affectedObjects`: what it would restore and re-run): those objects are its changed objects, nothing is exported.
 */
function asRun(answer: unknown): SyncAnswer | null {
    const a = answer as (SyncAnswer & { dryRun?: unknown; affectedObjects?: unknown }) | null;
    if (!a || typeof a !== 'object') return null;
    if (a.dryRun === true && !Array.isArray(a.changedObjects)) {
        return { ...a, changedObjects: strings(a.affectedObjects), exported: [], removed: [] };
    }
    return a;
}

/** The job id a `POST /load`/`/sync` answered with; null when it answered with the run itself. */
function jobIdOf(answer: unknown): string | null {
    const a = answer as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || Array.isArray(a.changedObjects)) return null;
    return typeof a.job === 'string' || typeof a.job === 'number' ? String(a.job) : null;
}

/** `2026-10-14-153012`: one log per spawn, sortable, and the day a prune reads. */
export function logStamp(when: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`
        + `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
}

/** Worker logs older than `LOG_KEEP_DAYS` (by mtime), dropped on every spawn. */
async function pruneLogs(dir: string): Promise<void> {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 3600_000;
    let names: string[] = [];
    try {
        names = await readdir(dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!name.endsWith('.log')) continue;
        const file = path.join(dir, name);
        try {
            if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
        } catch {
            // in use, or gone already
        }
    }
}

/** One prefix of GOLFMAP_SHAPING_PATH_MAP: where this server has it, and where the worker does. */
export interface PathMapEntry {
    local: string;
    worker: string;
}

/** `D:\gspro_courses=/Users/m/gspro_courses;D:\golf-map\docs\gspro=/Volumes/golf-map/docs/gspro` -> entries. */
export function parsePathMap(spec: string): PathMapEntry[] {
    const entries: PathMapEntry[] = [];
    for (const part of spec.split(';').map(s => s.trim()).filter(Boolean)) {
        const eq = part.indexOf('=');
        const local = eq > 0 ? part.slice(0, eq).trim() : '';
        const worker = eq > 0 ? part.slice(eq + 1).trim() : '';
        if (!local || !worker) throw new Error(`GOLFMAP_SHAPING_PATH_MAP: "${part}" is not <local prefix>=<worker prefix>`);
        entries.push({ local, worker });
    }
    return entries;
}

/**
 * `p` moved from one side's prefix to the other's, the longest matching prefix first (a Unity project's FBX folder
 * over SMB inside a folder kept as a local copy). A prefix matches whole path segments, either slash, any case; the
 * rest takes the other side's slashes. A path no prefix matches is returned as it is.
 */
export function mapPath(map: PathMapEntry[], p: string, dir: 'toWorker' | 'fromWorker'): string {
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(p);
    let best: { from: string; to: string } | null = null;
    for (const e of map) {
        const [from, to] = dir === 'toWorker' ? [e.local, e.worker] : [e.worker, e.local];
        const f = norm(from);
        if ((target === f || target.startsWith(`${f}/`)) && (!best || f.length > norm(best.from).length)) best = { from, to };
    }
    if (!best) return p;
    const rest = p.replace(/\\/g, '/').replace(/\/+$/, '').slice(norm(best.from).length);
    const slash = best.to.includes('\\') || /^[A-Za-z]:/.test(best.to) ? '\\' : '/';
    return best.to.replace(/[\\/]+$/, '') + rest.replace(/\//g, slash);
}

const samePath = (a: string | null, b: string) => a !== null && path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase();

/** Whether the worker has `target` loaded: its .blend (the source or its conformed cache) and layer folder. */
function holds(st: ShapingWorkerStatus, target: WorkerTarget): boolean {
    return (samePath(st.blend, target.blend) || samePath(st.conformed, target.blend)) && samePath(st.layersDir, target.layersDir);
}

/** An FBX file name (or path) as its object name: `x/Spline_hole_1_1c_Bunker_-_Blend.fbx` -> `Spline_hole_1_1c_Bunker_-_Blend`. */
export function objectName(fbx: string): string {
    return (fbx.split(/[\\/]/).pop() ?? fbx).replace(/\.fbx$/i, '');
}

/** A rock slab cut out of the ground by `golfmap.cut_out`: `Spline_hall_h11_north_Rock_-_Mesh`. */
export function isRockSlab(object: string): boolean {
    return object.endsWith('_Rock_-_Mesh');
}

function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** The worker's `report.seams` read leniently: null unless it has the summary's shape. */
function seamsOf(value: unknown): ShapingSeams | null {
    const s = value as Partial<ShapingSeams> | null;
    return s && typeof s === 'object' && Array.isArray(s.gaps) ? s as ShapingSeams : null;
}

/** The worker's `report.gates` read leniently; null for a worker that runs none. */
function gatesOf(value: unknown): ShapingGates | null {
    const g = value as Partial<ShapingGates> | null;
    if (!g || typeof g !== 'object' || typeof g.ok !== 'boolean') return null;
    const findings = (v: unknown) => Array.isArray(v) ? v.filter((f): f is ShapingGateFinding => !!f && typeof f === 'object') : [];
    return {
        ok: g.ok,
        allowGaps: g.allowGaps === true,
        limits: { gapM: g.limits?.gapM ?? 0.01, tJunctionM: g.limits?.tJunctionM ?? 0.01 },
        failures: findings(g.failures),
        preExisting: findings(g.preExisting),
        warnings: strings(g.warnings),
    };
}

/** The sync's failed ops as warning lines (`op <layer:id> failed: <error>`). */
function opErrors(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((e) => {
        const err = e as { op?: unknown; error?: unknown } | null;
        return typeof err?.op === 'string' ? [`op ${err.op} failed: ${typeof err.error === 'string' ? err.error : 'see the worker log'}`] : [];
    });
}

function describeRun(run: unknown): string | null {
    const err = (run as { error?: unknown } | null)?.error;
    return typeof err === 'string' ? err : null;
}

/** The last lines of this run's log (both streams go into the one file), for an error message. */
async function logTail(file: string): Promise<string> {
    try {
        const lines = (await readFile(file, 'utf8')).trim().split('\n').slice(-4).filter(Boolean);
        if (lines.length) return `${path.basename(file)}: ${lines.join(' | ')}`;
    } catch {
        // not written (yet)
    }
    return `(nothing in ${file})`;
}
