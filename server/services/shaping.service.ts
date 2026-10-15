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
// layersDir?, fbxFolder?}`, `POST /sync {dryRun?}` (contract in
// blender/README.md, "Shaping worker"). The two POSTs are JOBS: they answer
// `{job, kind, state: 'running'}` at once (409 while one is going) and this
// service polls `/status` — `job: {id, kind, state, phase, startedAt, seconds,
// result | error}` — for the outcome, so a sync that runs for an hour holds no
// connection. A worker that answers with the run itself (`?wait=1`, or an older
// one) is still read as before.
//
// The worker may be on another machine: GOLFMAP_SHAPING_URL points at it,
// GOLFMAP_SHAPING_TOKEN is the shared secret both sides use (`X-Golfmap-Token`
// on every request), and the paths it is given (blend, layersDir, fbxFolder)
// must be ones it can open — the same mount on both sides, or UNC.
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
import { closeSync, existsSync, openSync, renameSync } from 'node:fs';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { CoursesService } from './courses.service';
import {
    courseSlug, defaultRunner, ensureDir, failure, reportLines, venvPython,
    type ExportRunner, type GsproExportService,
} from './gspro-export.service';
import { defaultUnityBridge, editorForExportDir, type UnityBridge, type UnityEditor } from './unity-bridge';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import {
    defaultRecipeLibraryPath, loadRecipeLibrary, recipesFor, type RecipeSurface, type ShapingRecipe,
} from './shaping-recipes';
import { JobPhases, secs, type JobPhase, type JobPhaseStatus } from './job-phases';

export const DEFAULT_SHAPING_URL = 'http://127.0.0.1:8766';
/** The pointer file in `<data>/shaping-worker/` naming the log of the worker running now. */
export const LATEST_LOG = 'latest.json';
/** How long a worker log is kept (pruned on the next spawn). */
export const LOG_KEEP_DAYS = 14;
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
    /** The worker's seam check. */
    seams: unknown;
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
    id: string;
    courseId: string;
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
}

export const DEFAULT_SHAPING_TIMEOUTS: ShapingTimeouts = {
    startMs: 120_000, loadMs: 60 * 60_000, syncMs: 30 * 60_000, unitySec: 1800, pollMs: 1000,
    unreachableMs: 60_000,
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
    /** The command before the worker's own arguments (default `[blender, -b, --python, <repo>/blender/tools/shape_worker.py]`). */
    workerLauncher?: string[];
    /** Replaces `<repo>/docs/gspro`: the course's layers are `<root>/<course slug>/shaping`. */
    layersRoot?: string;
    recipeLibrary?: string;
    /** The .blend to shape (absolute, or a name in the export folder). */
    blend?: string;
    fbxFolder?: string;
    timeouts?: Partial<ShapingTimeouts>;
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
    report?: { warnings?: unknown; seams?: unknown; changedPlaces?: unknown };
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
    private readonly workerLauncher: string[];
    private readonly layersRoot: string;
    private readonly recipeLibrary: string;
    private readonly blend: string | undefined;
    private readonly fbxFolder: string | undefined;
    private readonly timeouts: ShapingTimeouts;
    private readonly jobs = new Map<string, JobRecord>();
    private running: { rec: JobRecord; done: Promise<void> } | null = null;
    private worker: { proc: ReturnType<typeof Bun.spawn>; exitCode: number | null; log: string } | null = null;

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
        this.workerLauncher = deps.workerLauncher ?? [
            blenderExecutable(), '-b', '--python', path.join(REPO_DIR, 'blender', 'tools', 'shape_worker.py'),
        ];
        this.layersRoot = deps.layersRoot ?? process.env.GOLFMAP_SHAPING_LAYERS_ROOT ?? path.join(REPO_DIR, 'docs', 'gspro');
        this.recipeLibrary = deps.recipeLibrary ?? defaultRecipeLibraryPath();
        this.blend = deps.blend ?? process.env.GOLFMAP_SHAPING_BLEND;
        this.fbxFolder = deps.fbxFolder ?? process.env.GOLFMAP_SHAPING_FBX_FOLDER;
        this.timeouts = { ...DEFAULT_SHAPING_TIMEOUTS, ...deps.timeouts };
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
     * Start an apply job and return it at once (`status: running`). 409 while
     * any apply runs (one worker for the machine; the message names it), 404
     * for an unknown course. Poll `job(id)` or `status(courseId)`.
     */
    async apply(courseId: string, opts: ShapingApplyOptions = {}): Promise<ShapingJob> {
        await this.courses.get(courseId);
        if (this.running) {
            const r = snapshot(this.running.rec);
            throw new ConflictError(`A shaping run is already going (course ${r.courseId}, job ${r.id}: ${r.step}): wait for it to finish`);
        }
        for (const [id, rec] of this.jobs) {
            if (rec.job.courseId === courseId) this.jobs.delete(id);
        }
        const rec: JobRecord = {
            job: {
                id: crypto.randomUUID(), courseId, status: 'running',
                dryRun: opts.dryRun === true, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
            },
            phases: new JobPhases(SHAPING_PHASES),
            t0: Date.now(),
            t1: null,
        };
        this.jobs.set(rec.job.id, rec);
        const done = this.perform(rec, opts).then(
            (result) => {
                rec.job.status = 'succeeded';
                rec.job.result = result;
                rec.phases.current = null;
            },
            (err) => {
                rec.job.status = 'failed';
                rec.job.error = err instanceof Error ? err.message : String(err);
                rec.phases.failCurrent(rec.job.error);
            },
        ).finally(() => {
            rec.t1 = Date.now();
            rec.job.finishedAt = new Date().toISOString();
            if (this.running?.rec === rec) this.running = null;
        });
        this.running = { rec, done };
        return snapshot(rec);
    }

    /** A job by id; 404 when this process never ran it. */
    job(jobId: string): ShapingJob {
        const rec = this.jobs.get(jobId);
        if (!rec) throw new NotFoundError(`No shaping job ${jobId} (the server may have restarted)`);
        return snapshot(rec);
    }

    /**
     * The apply running on this machine, whatever course it belongs to, else
     * null. One worker per machine means one apply at a time across courses
     * (`apply` 409s for the rest), so a caller that has to QUEUE behind it —
     * the GSPro status board's `meshes` chain — needs to see another course's
     * run, not only its own.
     */
    runningAnywhere(): ShapingJob | null {
        return this.running ? snapshot(this.running.rec) : null;
    }

    /** The timeouts this service runs with: what a caller bounds its own wait for an apply by. */
    get waits(): ShapingTimeouts {
        return { ...this.timeouts };
    }

    /** The course's running or last job, else null. */
    current(courseId: string): ShapingJob | null {
        let latest: JobRecord | null = null;
        for (const rec of this.jobs.values()) {
            if (rec.job.courseId !== courseId) continue;
            if (rec.job.status === 'running') return snapshot(rec);
            if (!latest || rec.t0 > latest.t0) latest = rec;
        }
        return latest ? snapshot(latest) : null;
    }

    /** The worker and the course's last job. */
    async status(courseId: string): Promise<ShapingStatus> {
        await this.courses.get(courseId);
        return { worker: await this.workerStatus(), job: this.current(courseId) };
    }

    /** Resolves when no apply is running (tests, shutdown). */
    async whenIdle(): Promise<void> {
        await this.running?.done;
    }

    /** Stop the worker this server started, if any (tests; the worker otherwise outlives the server on purpose). */
    async stopWorker(): Promise<void> {
        const w = this.worker;
        if (!w) return;
        w.proc.kill();
        await w.proc.exited;
        this.worker = null;
    }

    // --- The job ---

    private async perform(rec: JobRecord, opts: ShapingApplyOptions): Promise<ShapingApplyResult> {
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
        const layers = await this.writeLayers(rec.job.courseId, layersDir);
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
        warnings.push(...strings(sync.report?.warnings));
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
            seams: sync.report?.seams ?? null,
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

    /** `gspro.py shaping-global` into the course's layer folder; its report lines. */
    private async writeLayers(courseId: string, layersDir: string): Promise<string[]> {
        await ensureDir(layersDir);
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'shaping-global',
            '--course', courseId,
            '--out-dir', layersDir,
            '--library', this.recipeLibrary,
        ];
        if (this.dbPath) args.push('--db', this.dbPath);
        const { code, stdout, stderr } = await this.runner(args, this.pipelineDir);
        if (code !== 0) throw failure('Shaping layers (gspro.py shaping-global)', code, stdout, stderr);
        return reportLines(stdout);
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
        const newest = (list: typeof blends) => list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))[0] ?? null;
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
        const spawnedPid = this.worker && this.worker.exitCode === null ? this.worker.proc.pid : null;
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
                blend: str(body.blend),
                conformed: str(body.conformed),
                layersDir: str(body.layersDir),
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
            await this.post('/load', { blend: target.blend, layersDir: target.layersDir, fbxFolder: target.fbxFolder }, this.timeouts.startMs);
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
        const fd = openSync(log, 'a');
        let proc: ReturnType<typeof Bun.spawn>;
        try {
            proc = Bun.spawn(cmd, {
                cwd: REPO_DIR,
                env: {
                    ...process.env,
                    GOLFMAP_SHAPING_PORT: port,
                    ...(this.token ? { GOLFMAP_SHAPING_TOKEN: this.token } : {}),
                    PYTHONIOENCODING: 'utf-8',
                },
                stdin: 'ignore',
                stdout: fd,
                stderr: fd,
            });
        } finally {
            closeSync(fd);   // the child holds its own copy
        }
        try {
            // Named after the run it holds; the child writes through its inherited handle either way.
            const named = path.join(dir, `${stamp}-${proc.pid}.log`);
            renameSync(log, named);
            log = named;
        } catch {
            // Windows may refuse while the child has it open: the timestamp alone names the run then.
        }
        const worker = { proc, exitCode: null as number | null, log };
        proc.exited.then(code => { worker.exitCode = code; });
        // The worker outlives a server restart (bun --watch): the next server finds it on its port.
        proc.unref();
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
            if (w && w.exitCode !== null && !st.reachable) {
                throw new ConflictError(`The shaping worker exited (code ${w.exitCode}) before ${what.replace(/^the shaping worker /, '')}: ${await logTail(w.log)}`);
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
            started = await this.post('/sync', dryRun ? { dryRun: true } : {}, this.timeouts.startMs);
        } catch (e) {
            const st = await this.workerStatus();
            if (!st.reachable) throw e;
            const done = await this.waitFor(idle, this.timeouts.syncMs, 'the shaping worker to finish the sync', follow);
            const last = (done.job?.result ?? done.lastRun) as SyncAnswer | null;
            if (done.state === 'error' || !last || !Array.isArray(last.changedObjects)) throw e;
            return last;
        }
        const id = jobIdOf(started);
        if (id === null) return started as SyncAnswer;   // the run itself: an older worker, or `?wait=1`
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
        const result = job.result as SyncAnswer | null;
        if (!result || !Array.isArray(result.changedObjects)) {
            throw new ConflictError(`The shaping worker's sync job ${id} came back without a run (state ${job.state})`);
        }
        return result;
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

/** GOLFMAP_BLENDER, else Blender 4.5's default install on Windows, else `blender` on PATH. */
export function blenderExecutable(): string {
    if (process.env.GOLFMAP_BLENDER) return process.env.GOLFMAP_BLENDER;
    if (process.platform === 'win32' && existsSync(WINDOWS_BLENDER)) return WINDOWS_BLENDER;
    return 'blender';
}

// --- The job's phases ---

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
