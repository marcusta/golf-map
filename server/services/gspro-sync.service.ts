// The GSPro status board (builder only): one row per TARGET — the thing you
// changed in the editor — with "last updated / what changed since / Update".
//
// The export panel grew one button per file (`GsproExportService`), and
// knowing which of them to press, in what order, after an edit was the
// operator's job: the heightmap before the trees, the SVG before Blender, the
// zones before the Arborist file. The board turns that round. The targets are
// `shared/gspro-targets.ts` (shared so the web uses the same ids and words),
// and each has ONE verb:
//
//   - `status(courseId)`  per target: when it was last updated, what has
//                         changed since, whether it is stale, the manual step
//                         that follows it and why it cannot run now; plus the
//                         open Unity editors, the shaping worker, the running
//                         or last job and the queue.
//   - `update(courseId, target | 'stale')`
//                         a JOB with phases (like `ShapingJob`, same
//                         `job-phases.ts` bookkeeping) that runs the WHOLE
//                         chain for the target — both terrains, every file on
//                         the way, and the push into the open Unity editor.
//                         No editor is a SKIPPED phase ("Not in Unity: …"),
//                         never a failure: the files are written either way.
//                         `'stale'` runs every stale, unblocked target in
//                         board order.
//
// Jobs QUEUE per course (FIFO) instead of 409ing: a second Update while one
// runs comes back `queued`, and the board shows it in `queue`. A sync job also
// waits for a legacy `GsproExportService` job or a `ShapingService` apply —
// they touch the same files, and the shaping run the same one Blender worker,
// whichever course it belongs to (so a `meshes` update of one course queues
// behind another's run instead of being refused). The `wait` phase names what
// it is waiting for, and is skipped when that is over by the time its turn
// comes.
//
// Every Unity push a chain makes runs with `save: true` (unity/README.md,
// "Saving what a command changed"), so what it changed is on disk when the job
// is done instead of waiting for someone to press Ctrl+S; the report names the
// scenes that were saved. And each file is only rendered again when its inputs
// have changed (export-fingerprint.ts) — `update(…, { force: true })` renders
// anyway, which is what `bun run gspro:update -- … --force` passes.
//
// "Last updated" comes from `<export dir>/gspro-sync.json`
// (`golfmap-gspro-sync-v1`), written after each successful target, and falls
// back to the mtime of the file that target writes, so a course that was
// exported before the board existed does not read "never". "Changed since" is
// counted from the migration-025 edit history
// (`FeatureHistoryService.countChangesSince`,
// `TerrainEditsService.countChangesSince`) plus the cleaned photo's mtime and
// the course's own tables.
//
// Everything it drives lives elsewhere: `GsproExportService` (the files and
// the Unity pushes), `ShapingService` (the Blender meshes), `MapBuildService`
// (`reTerrain` — the terrain tool's "Apply to terrain"). This service only
// decides what is stale, in what order, and reports it.

import * as path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import {
    GSPRO_TARGETS, GSPRO_TARGET_IDS, gsproTarget, type GsproTargetId,
} from '../../shared/gspro-targets';
import type { CoursesService } from './courses.service';
import { DIG_WATER_LEVELS_SOURCE, type MapBuildService } from './map-build.service';
import {
    buildingsExportFileName, courseSlug, creeksExportFileName, demExportFileName, demSidecarName, ensureDir,
    failure, meshTextureFileName, reportLines, savedLine, statOrNull, treesExportFileName, venvPython,
    zonesExportFileName,
    type GsproExportService, type GsproOrthoSource, type TerrainKind,
} from './gspro-export.service';
import { BUILDINGS_SURVEY } from './terrain-generators.service';
import { fingerprint, mtimeMs, recordInputs, unchangedLine } from './export-fingerprint';
import {
    PROPS_FOLDER, PROPS_MANIFEST, PROPS_PLACED, propsNote, propsSpecs, type PropsSpec,
} from './gspro-props';
import { FeatureHistoryService, sqlStamp, type ChangeCount } from './feature-history.service';
import { TerrainEditsService } from './terrain-edits.service';
import {
    blenderExecutable, SHAPING_PHASES,
    type ShapingJob, type ShapingTimeouts, type ShapingWorkerStatus, type ShapingService,
} from './shaping.service';
import { JobPhases, secs, type JobPhase } from './job-phases';
import { defaultUnityBridge, editorForExportDir, unityEditorsFor, type UnityBridge, type UnityEditor, type UnityEditorInfo } from './unity-bridge';
import type { CourseTerrain } from './terrain-square';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';

// --- The record in the export folder ---

/** Where the per-target "last updated" is kept, next to the files themselves. */
export const SYNC_RECORD_FILE = 'gspro-sync.json';
export const SYNC_RECORD_FORMAT = 'golfmap-gspro-sync-v1';

export interface GsproSyncRecordEntry {
    /** ISO; the START of the job that updated the target, so an edit made while it ran counts as "since". */
    lastRun: string;
    /** How long that update took, so the board can say "about 40 s" next time. */
    seconds: number;
    report?: string[];
}

export interface GsproSyncRecord {
    format: string;
    targets: Partial<Record<GsproTargetId, GsproSyncRecordEntry>>;
}

// --- Public types ---

export interface GsproTargetStatus {
    id: GsproTargetId;
    label: string;
    /** ISO of the last update, from the record or the written file's mtime; null = never. */
    lastRun: string | null;
    /** How long the last recorded update took (seconds), null without a record entry. */
    seconds: number | null;
    /** Edits since `lastRun`; `{ count: 0, kinds: [] }` when `lastRun` is null (nothing to count from). */
    changedSince: ChangeCount;
    /** `changedSince.count > 0 || lastRun === null`. */
    stale: boolean;
    /** The step a human must do after an update of this target, else null. */
    manual: string | null;
    /** Why an update cannot run now (and so is left out of a `'stale'` run), else null. */
    blocked: string | null;
    /**
     * One line of extra state this row has and no other way to say — `props`:
     * how many props an update keeps as they were moved by hand, read from
     * Unity's `placed.json`. Null where the row has nothing to add (every
     * other row today). The board shows it under the status line.
     */
    note: string | null;
}

export interface GsproSyncUnity {
    editors: UnityEditorInfo[];
    /** `projectName` of the editor whose active course exports to this course's folder; null with none. */
    matched: string | null;
    /** The folder an editor has to import from to match. */
    exportDir: string;
}

export type GsproSyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** One target an update finished (successfully or not). */
export interface GsproSyncTargetResult {
    target: GsproTargetId;
    label: string;
    seconds: number;
    report: string[];
    /** Null when it went through. */
    error: string | null;
}

export interface GsproSyncJob {
    id: string;
    courseId: string;
    /** What was asked for — a target id, or `stale`. */
    request: GsproTargetId | 'stale';
    /** The targets this job updates, in chain order (empty for a `'stale'` run with nothing stale). */
    targets: GsproTargetId[];
    status: GsproSyncJobStatus;
    /** The running phase's id (the failed one once it failed); null before the first and once done. */
    phase: string | null;
    /** One line: what it is doing now, or did last. */
    step: string;
    phases: JobPhase[];
    /** ISO; `startedAt` is null while the job waits in the queue. */
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    seconds: number;
    results: GsproSyncTargetResult[];
    error: string | null;
}

export interface GsproSyncStatus {
    unity: GsproSyncUnity;
    /** The Blender shaping worker (the `meshes` target runs through it). */
    worker: ShapingWorkerStatus;
    /** One per target, in board order. */
    targets: GsproTargetStatus[];
    /** The running job, else the first queued one, else the last finished one. */
    job: GsproSyncJob | null;
    /** The jobs waiting their turn, in FIFO order. */
    queue: Array<{ id: string; target: GsproTargetId | 'stale' }>;
}

export interface GsproSyncDeps {
    db: Kysely<Database>;
    courses: Pick<CoursesService, 'get'>;
    /** Every file and every Unity push the chains run. */
    exports: GsproExportService;
    /** The `meshes` chain: `apply` already does layers → worker → Unity refresh. */
    shaping: Pick<ShapingService, 'apply' | 'job' | 'status' | 'layersDir' | 'whenIdle' | 'current' | 'runningAnywhere' | 'waits'>;
    /** The `terrain` chain's bake: the terrain tool's "Apply to terrain". */
    mapBuild: Pick<MapBuildService, 'reTerrain' | 'waitForJob' | 'get'>;
    /** Root of `sources/<siteId>/` — where the cleaned photo lives. */
    dataDir: string;
    history?: FeatureHistoryService;
    terrainEdits?: TerrainEditsService;
    unityBridge?: UnityBridge;
    /**
     * The `props` chain's two commands (the spec's Python, then Blender over
     * `build_props.py`), as `[executable, ...args]`. Default: `Bun.spawn` from
     * the repo root. Tests record the invocations instead of running them.
     */
    commandRunner?: CommandRunner;
    /** The interpreter the props generators run under (default the pipeline venv's). */
    propsPython?: string;
    /** Blender for the props models (default `blenderExecutable()`, as the shaping worker's). */
    blender?: string;
    /** How long a `build_props.py` run may take (ms; default 10 min). */
    propsBuildMs?: number;
    /** How often a mirrored shaping job is polled (ms; default 500). */
    pollMs?: number;
    /**
     * How long the `meshes` chain follows its shaping job before it gives up on
     * it (ms). Default: the shaping service's own budget for a run (load +
     * sync + the Unity refresh) — past that the job is not going to settle,
     * and a sync job that polls for ever is one nothing can ever follow.
     */
    meshesTimeoutMs?: number;
}

/**
 * A command the `props` chain runs: the whole argv, so one seam covers both
 * the pipeline's Python and Blender. Same answer shape as `ExportRunner`.
 */
export type CommandRunner = (
    command: string[], cwd: string, opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `Bun.spawn` of the whole argv, with the pipeline's UTF-8 stdout. */
export function defaultCommandRunner(): CommandRunner {
    return async (command, cwd, opts) => {
        const proc = Bun.spawn(command, {
            cwd,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        let timedOut = false;
        const timer = opts?.timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs) : null;
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
            return { code: code || 124, stdout, stderr: `${stderr}\ntimed out after ${Math.round(opts!.timeoutMs! / 1000)} s` };
        }
        return { code, stdout, stderr };
    };
}

/** `gspro.py shaping-global`'s first layer file — the `meshes` target's "last updated" fallback. */
const GLOBAL_LAYER_FILE = '00-global.gen.json';

/** The repo root: where the props generators are run from (docs/workflows.md section 4). */
const REPO_DIR = path.resolve(import.meta.dir, '..', '..');

/** How long `build_props.py` may run before the phase gives up on it. */
const PROPS_BUILD_MS = 10 * 60_000;

/** How long a props bridge command may run (the place walks every instance onto the ground). */
const PROPS_UNITY_SEC = 600;

/** The generator whose terrain edits are building pads (`TerrainGeneratorKind`). */
const BUILDING_PADS_ORIGIN = 'building-pads';

/** The order a `'stale'` run takes the targets in — the board's own order. */
const STALE_ORDER: readonly GsproTargetId[] = GSPRO_TARGET_IDS;

// --- Service ---

export class GsproSyncService {
    private readonly db: Kysely<Database>;
    private readonly courses: Pick<CoursesService, 'get'>;
    private readonly exports: GsproExportService;
    private readonly shaping: GsproSyncDeps['shaping'];
    private readonly mapBuild: GsproSyncDeps['mapBuild'];
    private readonly dataDir: string;
    private readonly history: FeatureHistoryService;
    private readonly terrainEdits: TerrainEditsService;
    private readonly unityBridge: UnityBridge;
    private readonly command: CommandRunner;
    private readonly propsPython: string;
    private readonly blender: string;
    private readonly propsBuildMs: number;
    private readonly pollMs: number;
    private readonly meshesTimeoutMs: number | undefined;
    /** Every job this process started, by id. */
    private readonly jobs = new Map<string, JobRecord>();
    /** Per course: the tail of the FIFO chain, so the next `update` starts after it. */
    private readonly chain = new Map<string, Promise<void>>();

    constructor(deps: GsproSyncDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.exports = deps.exports;
        this.shaping = deps.shaping;
        this.mapBuild = deps.mapBuild;
        this.dataDir = deps.dataDir;
        this.history = deps.history ?? new FeatureHistoryService(deps.db);
        this.terrainEdits = deps.terrainEdits ?? new TerrainEditsService(deps.db);
        this.unityBridge = deps.unityBridge ?? defaultUnityBridge();
        this.command = deps.commandRunner ?? defaultCommandRunner();
        this.propsPython = deps.propsPython ?? process.env.MAP_PIPELINE_PYTHON
            ?? venvPython(process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR);
        this.blender = deps.blender ?? blenderExecutable();
        this.propsBuildMs = deps.propsBuildMs ?? PROPS_BUILD_MS;
        this.pollMs = deps.pollMs ?? 500;
        this.meshesTimeoutMs = deps.meshesTimeoutMs;
    }

    // --- Status ---

    /** The whole board: Unity, the shaping worker, every target, the job and the queue. */
    async status(courseId: string): Promise<GsproSyncStatus> {
        const ctx = await this.context(courseId);
        // The Props row reads the course folder out of the matched editor, so the
        // board's one probe is the row's too (`SyncContext.unity`).
        ctx.unity = this.unityStatus(ctx.dir);
        const [unity, worker, targets] = await Promise.all([
            ctx.unity,
            this.shaping.status(courseId).then(s => s.worker),
            this.targetStatuses(ctx),
        ]);
        return { unity, worker, targets, job: this.current(courseId), queue: this.queue(courseId) };
    }

    /** The Unity part of `status` alone — what the command bar's chip polls. */
    async unity(courseId: string): Promise<GsproSyncUnity> {
        const { dir } = await this.exports.settings(courseId);
        return this.unityStatus(dir);
    }

    private async unityStatus(dir: string): Promise<GsproSyncUnity> {
        const editors = await unityEditorsFor(this.unityBridge, dir);
        return { editors, matched: editors.find(e => e.matches)?.projectName ?? null, exportDir: dir };
    }

    /**
     * All ten rows, side by side — the board asks for them on every poll and
     * each row stats files, reads the history and (for `meshes`) lists the
     * export folder. `Promise.all` keeps the board's own order while the file
     * work overlaps; Kysely on bun:sqlite serialises the queries anyway.
     */
    private async targetStatuses(ctx: SyncContext): Promise<GsproTargetStatus[]> {
        return Promise.all(GSPRO_TARGETS.map(async (target): Promise<GsproTargetStatus> => {
            const entry = ctx.record.targets[target.id];
            const lastRun = entry?.lastRun ?? await this.fallbackLastRun(ctx, target.id);
            const [changedSince, blocked, note] = await Promise.all([
                this.changedSince(ctx, target.id, lastRun),
                this.blocked(ctx, target.id),
                this.note(ctx, target.id),
            ]);
            return {
                id: target.id,
                label: target.label,
                lastRun,
                seconds: entry?.seconds ?? null,
                changedSince,
                stale: changedSince.count > 0 || lastRun === null,
                manual: target.manual,
                blocked,
                note,
            };
        }));
    }

    /**
     * The row's one line of extra state. Only `props` has one today: what
     * Unity's `placed.json` says about the props standing in the scene, which
     * needs the editor — without one there is nothing to read, and the row
     * says nothing rather than guessing.
     */
    private async note(ctx: SyncContext, target: GsproTargetId): Promise<string | null> {
        if (target !== 'props') return null;
        const dir = await this.propsDir(ctx);
        return dir ? propsNote(dir) : null;
    }

    /**
     * When a target was last updated according to the files it writes — so a
     * course exported before this service existed does not read "never".
     * Only used where the record has no entry.
     */
    private async fallbackLastRun(ctx: SyncContext, target: GsproTargetId): Promise<string | null> {
        switch (target) {
            case 'terrain':
                return ctx.terrain ? mtimeIso(ctx.demSidecar('inner')) : null;
            case 'photo':
                return newestMtime(await this.innerMeshTextures(ctx));
            case 'shapes':
                return (await FeatureHistoryService.latestSnapshot(ctx.dir))?.exportedAt ?? null;
            case 'meshes':
                return mtimeIso(path.join(await this.shaping.layersDir(ctx.courseId), GLOBAL_LAYER_FILE));
            case 'vegetation':
                return mtimeIso(ctx.file(zonesExportFileName(ctx.courseName, 'inner')));
            case 'trees':
                return mtimeIso(ctx.file(treesExportFileName(ctx.courseName, 'inner')));
            case 'buildings':
                return mtimeIso(ctx.file(buildingsExportFileName(ctx.courseName, 'inner')));
            case 'props': {
                // The manifest `build_props.py` wrote into the Unity project; nothing to read without the editor.
                const dir = await this.propsDir(ctx);
                return dir ? mtimeIso(path.join(dir, PROPS_MANIFEST)) : null;
            }
            case 'creeks':
                return mtimeIso(ctx.file(creeksExportFileName(ctx.courseName)));
            case 'course-file':
                return ctx.courseDir && ctx.gkdFile ? mtimeIso(path.join(ctx.courseDir, ctx.gkdFile)) : null;
        }
    }

    /** The inner `-meshes.jpg` files in the export folder (cleaned or plain, any vintage). */
    private async innerMeshTextures(ctx: SyncContext): Promise<string[]> {
        let names: string[];
        try {
            names = await readdir(ctx.dir);
        } catch {
            return [];
        }
        return names
            .filter(n => n.startsWith(`${ctx.slug}-`) && !n.startsWith(`${ctx.slug}-outer-`) && n.endsWith('-meshes.jpg'))
            .map(n => ctx.file(n));
    }

    /**
     * What has changed since the target was last updated: the course's
     * features of the target's types, plus whatever else that target is made
     * of (terrain edits, zone types, the cleaned photo, the course's holes and
     * tees). Empty when `since` is null — with no last run there is nothing to
     * count from, and `stale` is already true.
     */
    private async changedSince(ctx: SyncContext, target: GsproTargetId, since: string | null): Promise<ChangeCount> {
        if (since === null) return { count: 0, kinds: [] };
        const parts: ChangeCount[] = [];
        const types = gsproTarget(target).featureTypes;
        if (types.length > 0) parts.push(await this.history.countChangesSince(ctx.courseId, since, types));

        switch (target) {
            case 'terrain': {
                if (ctx.siteId) {
                    // Every op but `recipe` changes the DEM; a recipe shapes the Blender meshes (the Meshes row).
                    parts.push(named(await this.terrainEdits.countChangesSince(ctx.siteId, since, { exceptOps: ['recipe'] }), 'terrain edits'));
                    // Edits applied to the map but not yet in the exported heightmap are a change of their own.
                    const unapplied = await this.innerStale(ctx);
                    if (unapplied) parts.push({ count: 1, kinds: ['unapplied edits'] });
                }
                break;
            }
            case 'meshes':
                if (ctx.siteId) parts.push(named(await this.terrainEdits.countChangesSince(ctx.siteId, since, { ops: ['recipe'] }), 'recipes'));
                break;
            case 'buildings':
                if (ctx.siteId) {
                    parts.push(named(await this.terrainEdits.countChangesSince(ctx.siteId, since, { origins: [BUILDING_PADS_ORIGIN] }), 'building pads'));
                }
                break;
            case 'vegetation':
                parts.push(await this.zoneTypeChanges(ctx.courseId, since));
                break;
            case 'photo':
                parts.push(await this.cleanedPhotoChange(ctx, since));
                break;
            case 'props':
                parts.push(await this.propsSpecChanges(ctx, since));
                break;
            case 'course-file':
                parts.push(await this.courseFileChanges(ctx.courseId, since));
                break;
            default:
                break;
        }
        return merge(parts);
    }

    /** Zone types edited since (their item bindings decide what the masks hold). */
    private async zoneTypeChanges(courseId: string, since: string): Promise<ChangeCount> {
        const row = await this.db.selectFrom('course_zone_types').select(({ fn }) => fn.countAll<number>().as('n'))
            .where('course_id', '=', courseId).where('updated_at', '>', sqlStamp(since)).executeTakeFirst();
        return named({ count: Number(row?.n ?? 0), kinds: [] }, 'zone types');
    }

    /** The cleaned photo (`sources/<siteId>/ortho-*.cleaned.tif`) touched since. */
    private async cleanedPhotoChange(ctx: SyncContext, since: string): Promise<ChangeCount> {
        if (!ctx.siteId) return { count: 0, kinds: [] };
        const cleaned = (await this.orthoSources(ctx)).filter(s => s.cleaned)
            .map(s => path.join(this.dataDir, 'sources', ctx.siteId!, s.source));
        const newest = await newestMtime(cleaned);
        return newest !== null && newest > since ? { count: 1, kinds: ['cleaned photo'] } : { count: 0, kinds: [] };
    }

    /**
     * The props specs edited since the last update: one count per
     * `*-props.gen.py` whose mtime has moved. The GENERATOR only — the
     * `*-props.json` beside it is what the chain itself writes, so counting it
     * would leave the row stale from the moment an update finished.
     */
    private async propsSpecChanges(ctx: SyncContext, since: string): Promise<ChangeCount> {
        let count = 0;
        for (const spec of await this.propsSpecs(ctx)) {
            const at = await mtimeIso(spec.gen);
            if (at !== null && at > since) count++;
        }
        return { count, kinds: count > 0 ? ['props spec'] : [] };
    }

    /**
     * The course's own tables the `.GKD` is written from. The course details
     * (`courses.gspro_meta_json`) carry no time of their own — `courses.updated_at`
     * moves on any course change at all — so a details-only edit does not show
     * here; the row goes stale on the next tee, pin or hole change.
     */
    private async courseFileChanges(courseId: string, since: string): Promise<ChangeCount> {
        const at = sqlStamp(since);
        const holes = await this.db.selectFrom('holes').select(eb => eb.fn.countAll<number>().as('n'))
            .where('course_id', '=', courseId).where('updated_at', '>', at).executeTakeFirst();
        const tees = await this.db.selectFrom('tees').innerJoin('holes', 'holes.id', 'tees.hole_id')
            .select(eb => eb.fn.countAll<number>().as('n'))
            .where('holes.course_id', '=', courseId).where('tees.updated_at', '>', at).executeTakeFirst();
        const greens = await this.db.selectFrom('greens').innerJoin('holes', 'holes.id', 'greens.hole_id')
            .select(eb => eb.fn.countAll<number>().as('n'))
            .where('holes.course_id', '=', courseId).where('greens.updated_at', '>', at).executeTakeFirst();
        const pins = await this.db.selectFrom('pins').innerJoin('greens', 'greens.id', 'pins.green_id')
            .innerJoin('holes', 'holes.id', 'greens.hole_id')
            .select(eb => eb.fn.countAll<number>().as('n'))
            .where('holes.course_id', '=', courseId).where('pins.updated_at', '>', at).executeTakeFirst();
        const aims = await this.db.selectFrom('aim_points').innerJoin('holes', 'holes.id', 'aim_points.hole_id')
            .select(eb => eb.fn.countAll<number>().as('n'))
            .where('holes.course_id', '=', courseId).where('aim_points.updated_at', '>', at).executeTakeFirst();
        const sets = await this.db.selectFrom('course_tee_sets').select(eb => eb.fn.countAll<number>().as('n'))
            .where('course_id', '=', courseId).where('updated_at', '>', at).executeTakeFirst();
        return merge([
            named({ count: Number(holes?.n ?? 0), kinds: [] }, 'holes'),
            named({ count: Number(tees?.n ?? 0), kinds: [] }, 'tees'),
            named({ count: Number(greens?.n ?? 0), kinds: [] }, 'greens'),
            named({ count: Number(pins?.n ?? 0), kinds: [] }, 'pins'),
            named({ count: Number(aims?.n ?? 0), kinds: [] }, 'aim points'),
            named({ count: Number(sets?.n ?? 0), kinds: [] }, 'tee sets'),
        ]);
    }

    /**
     * Why an update of `target` cannot run now, or null. Only the cheap,
     * certain reasons — the chains still throw their own 409s for everything
     * else; this is what the board greys out and what a `'stale'` run skips.
     */
    private async blocked(ctx: SyncContext, target: GsproTargetId): Promise<string | null> {
        const noMap = 'Build the map first';
        switch (target) {
            case 'terrain':
                if (!ctx.siteId) return noMap;
                return ctx.terrainError;
            case 'photo':
                if (!ctx.siteId) return noMap;
                return (await this.orthoSources(ctx)).length === 0 ? 'Build the map first — there is no orthophoto to render' : null;
            case 'shapes':
                return ctx.terrainError;
            case 'meshes':
                return (await this.blendFiles(ctx)).length === 0
                    ? `No .blend in ${ctx.dir} — build the course's .blend with OPCD first`
                    : null;
            case 'vegetation':
                return ctx.siteId ? null : noMap;
            case 'trees':
                return ctx.siteId ? null : noMap;
            case 'buildings':
                if (!ctx.siteId) return noMap;
                return await statOrNull(path.join(this.dataDir, 'sources', ctx.siteId, BUILDINGS_SURVEY))
                    ? null
                    : 'Run "Generate building pads" in the terrain tool first';
            case 'props':
                return (await this.propsSpecs(ctx)).length === 0
                    ? `No props spec in ${await this.docsDirLabel(ctx)}`
                    : null;
            case 'creeks':
                return ctx.siteId ? null : noMap;
            case 'course-file':
                if (!ctx.courseDir) return 'Set the GSPro course folder first';
                return ctx.siteId ? null : noMap;
        }
    }

    // --- Jobs ---

    /**
     * Update one target — or every stale, unblocked one (`'stale'`, in board
     * order) — and return the job at once. A job starts `queued` when another
     * sync job, a legacy GSPro export or a shaping apply is still going for
     * the course, and runs when its turn comes; poll `job(id)` or `status`.
     * 404 for an unknown course.
     */
    async update(courseId: string, request: GsproTargetId | 'stale', opts: { force?: boolean } = {}): Promise<GsproSyncJob> {
        const ctx = await this.context(courseId);
        let targets: GsproTargetId[];
        if (request === 'stale') {
            const statuses = await this.targetStatuses(ctx);
            const stale = new Set(statuses.filter(s => s.stale && s.blocked === null).map(s => s.id));
            targets = STALE_ORDER.filter(id => stale.has(id));
        } else {
            const blocked = await this.blocked(ctx, request);
            if (blocked) throw new ConflictError(`${gsproTarget(request).label} cannot be updated: ${blocked}`);
            targets = [request];
        }

        // Forget this course's finished jobs: one live job plus its queue is all the board shows.
        for (const [id, rec] of this.jobs) {
            if (rec.job.courseId === courseId && (rec.job.status === 'succeeded' || rec.job.status === 'failed')) this.jobs.delete(id);
        }

        const phases = new JobPhases();
        const waitFor = await this.busyWith(courseId, { targets });
        if (waitFor) phases.add('wait', `Waiting for ${waitFor}`);
        for (const target of targets) addPhases(phases, target, targets.length > 1);

        const rec: JobRecord = {
            job: {
                id: crypto.randomUUID(), courseId, request, targets, status: 'queued',
                queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, results: [], error: null,
            },
            phases,
            force: opts.force === true,
            t0: null,
            t1: null,
        };
        this.jobs.set(rec.job.id, rec);

        const previous = this.chain.get(courseId);
        // Nothing of this course's ahead of it: it is running from this moment, so the
        // board (and the caller's own answer) never shows a job as queued behind nothing.
        if (!previous) this.begin(rec);
        const done = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.run(rec)).finally(() => {
            if (this.chain.get(courseId) === done) this.chain.delete(courseId);
        });
        this.chain.set(courseId, done);
        return snapshot(rec);
    }

    /** A job by id; 404 when this process never ran it. */
    job(jobId: string): GsproSyncJob {
        const rec = this.jobs.get(jobId);
        if (!rec) throw new NotFoundError(`No GSPro sync job ${jobId} (the server may have restarted)`);
        return snapshot(rec);
    }

    /** The course's running job, else the first queued one, else its last finished one. */
    current(courseId: string): GsproSyncJob | null {
        const mine = [...this.jobs.values()].filter(r => r.job.courseId === courseId);
        const running = mine.find(r => r.job.status === 'running');
        if (running) return snapshot(running);
        const queued = mine.filter(r => r.job.status === 'queued').sort(byQueuedAt)[0];
        if (queued) return snapshot(queued);
        const last = mine.sort(byQueuedAt).at(-1);
        return last ? snapshot(last) : null;
    }

    /** The course's waiting jobs, in FIFO order. */
    queue(courseId: string): Array<{ id: string; target: GsproTargetId | 'stale' }> {
        return [...this.jobs.values()]
            .filter(r => r.job.courseId === courseId && r.job.status === 'queued')
            .sort(byQueuedAt)
            .map(r => ({ id: r.job.id, target: r.job.request }));
    }

    /** Resolves when the course has no sync job queued or running (tests, shutdown). */
    async whenIdle(courseId: string): Promise<void> {
        await this.chain.get(courseId);
    }

    /**
     * What a job of this course would have to wait for, in words; null when it
     * can start at once. `exceptJob` is the job asking — its own record is not
     * something to wait for, which is what makes the `wait` phase, re-asked
     * when its turn comes, able to say that the way is clear.
     *
     * A shaping run of ANOTHER course counts when the job updates the meshes:
     * there is one Blender worker per machine, so `ShapingService.apply` 409s
     * while any course's run is going. The other targets write their own files
     * and do not care.
     */
    private async busyWith(courseId: string, opts: { targets?: readonly GsproTargetId[]; exceptJob?: string } = {}): Promise<string | null> {
        const other = [...this.jobs.values()].find(r =>
            r.job.courseId === courseId && r.job.id !== opts.exceptJob && r.job.status === 'running');
        if (other) return 'the GSPro update already running for this course';
        const exporting = this.exports.current(courseId);
        if (exporting?.status === 'running') return `the ${exporting.label} export`;
        const shaping = this.shaping.runningAnywhere();
        if (shaping) {
            if (shaping.courseId === courseId) return 'the Blender shaping run';
            // Only the meshes go through the worker; `targets` unset (a plain "is anything going?") counts it.
            if (!opts.targets || opts.targets.includes('meshes')) {
                return `the shaping run for ${await this.courseLabel(shaping.courseId)}`;
            }
        }
        return null;
    }

    /** A course's name for a message about it; its id when it is not there any more. */
    private async courseLabel(courseId: string): Promise<string> {
        try {
            return (await this.courses.get(courseId)).name;
        } catch {
            return courseId;
        }
    }

    // --- The job ---

    /** Queued → running, once (a job with nothing ahead of it is marked by `update` itself). */
    private begin(rec: JobRecord): void {
        if (rec.job.status !== 'queued') return;
        rec.job.status = 'running';
        rec.job.startedAt = new Date().toISOString();
        rec.t0 = Date.now();
    }

    private async run(rec: JobRecord): Promise<void> {
        this.begin(rec);
        try {
            if (rec.phases.has('wait')) await this.waitTurn(rec);
            const ctx = { ...await this.context(rec.job.courseId), force: rec.force };
            // One probe for the whole job: every Unity push in the chains uses this answer.
            const { editor, info, seen } = await editorForExportDir(this.unityBridge, ctx.dir);
            const unity: UnityTarget = {
                editor,
                why: editor ? null : `Not in Unity: no open Unity editor imports from ${ctx.dir}`
                    + (seen.length ? ` (${seen.join('; ')})` : ' (none is open)'),
                courseFolder: info?.courseFolder ?? null,
            };
            for (const target of rec.job.targets) {
                const t0 = Date.now();
                const prefix = (step: string) => `${target}:${step}`;
                try {
                    const report = await this.runTarget(rec, ctx, target, unity, prefix);
                    const seconds = secs(Date.now() - t0);
                    rec.job.results.push({ target, label: gsproTarget(target).label, seconds, report, error: null });
                    await this.writeRecordEntry(ctx, target, { lastRun: rec.job.startedAt!, seconds, report });
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    rec.phases.failCurrent(firstLine(message));
                    rec.phases.skipPending(`${gsproTarget(target).label} failed`);
                    rec.job.results.push({ target, label: gsproTarget(target).label, seconds: secs(Date.now() - t0), report: [], error: message });
                    throw new ConflictError(`${gsproTarget(target).label}: ${message}`);
                }
            }
            rec.job.status = 'succeeded';
            rec.phases.current = null;
        } catch (err) {
            rec.job.status = 'failed';
            rec.job.error = err instanceof Error ? err.message : String(err);
            rec.phases.failCurrent(firstLine(rec.job.error));
        } finally {
            rec.t1 = Date.now();
            rec.job.finishedAt = new Date().toISOString();
        }
    }

    /**
     * The `wait` phase: whatever was in the way out of the way before anything
     * is written. Asked again here — what the job queued behind may well be
     * over by the time its turn comes, and then the phase is SKIPPED rather
     * than waiting for nothing. This job's own record is left out of the
     * question (it is running by now).
     */
    private async waitTurn(rec: JobRecord): Promise<void> {
        const waiting = await this.busyWith(rec.job.courseId, { targets: rec.job.targets, exceptJob: rec.job.id });
        if (!waiting) {
            rec.phases.skip('wait', 'nothing else was running');
            return;
        }
        rec.phases.begin('wait', waiting);
        await this.exports.whenIdle(rec.job.courseId);
        await this.shaping.whenIdle();
        rec.phases.end('wait', 'done', `waited for ${waiting}`);
    }

    private runTarget(rec: JobRecord, ctx: SyncContext, target: GsproTargetId, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        switch (target) {
            case 'terrain': return this.updateTerrain(rec, ctx, unity, id);
            case 'photo': return this.updatePhoto(rec, ctx, unity, id);
            case 'shapes': return this.updateShapes(rec, ctx, id);
            case 'meshes': return this.updateMeshes(rec, ctx, id);
            case 'vegetation': return this.updateVegetation(rec, ctx, id);
            case 'trees': return this.updateTrees(rec, ctx, unity, id);
            case 'buildings': return this.updateBuildings(rec, ctx, unity, id);
            case 'props': return this.updateProps(rec, ctx, unity, id);
            case 'creeks': return this.updateCreeks(rec, ctx, unity, id);
            case 'course-file': return this.updateCourseFile(rec, ctx, id);
        }
    }

    // --- The chains ---

    /**
     * Terrain: bake the edits into the map when the exported heightmap lacks
     * them, export both heightmaps, put them onto the Unity terrains, then
     * re-export the files that read the heightmap — only those the folder
     * already has, so a course that never exported buildings does not get
     * them now.
     */
    private async updateTerrain(rec: JobRecord, ctx: SyncContext, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        const report: string[] = [];
        const stale = await this.innerStale(ctx);
        if (!stale) {
            rec.phases.skip(id('apply'), 'the map already carries every terrain edit');
        } else {
            rec.phases.begin(id('apply'), stale);
            const started = await this.mapBuild.reTerrain(ctx.courseId);
            await this.mapBuild.waitForJob(started.id);
            const done = await this.mapBuild.get(started.id);
            if (done.status !== 'succeeded') {
                throw new ConflictError(`Apply to terrain failed (${done.step ?? 'no step'}): ${done.error ?? 'see the build log'}`);
            }
            rec.phases.end(id('apply'), 'done', 'terrain edits baked into the map');
            report.push('applied the terrain edits to the map (re-terrain)');
        }

        rec.phases.begin(id('dem'), 'the inner heightmap');
        const before: Partial<Record<TerrainKind, number | null>> = {};
        for (const kind of TERRAINS) {
            rec.phases.note(`the ${kind} heightmap`);
            before[kind] = await this.exports.demSidecarMinM(ctx.courseId, kind);
            report.push(...prefixed(kind, (await this.exports.exportDem(ctx.courseId, kind, { force: ctx.force })).report));
        }
        // The water-edge ponds' water levels, in the new heightmap's frame (golfmap.waterplanes.build reads them).
        report.push(...(await this.exports.exportWaterLevels(ctx.courseId)).report);
        rec.phases.end(id('dem'), 'done', 'inner and outer heightmaps exported');

        if (!unity.editor) {
            rec.phases.skip(id('unity'), unity.why!);
            report.push(unity.why!);
        } else {
            rec.phases.begin(id('unity'), `the inner terrain in ${unity.editor.projectName}`);
            for (const kind of TERRAINS) {
                rec.phases.note(`the ${kind} terrain in ${unity.editor.projectName}`);
                // A heightmap whose render was skipped still goes in: the push reads the files in the folder.
                const pushed = await this.exports.pushUnityTerrain(ctx.courseId, kind, { minBefore: before[kind] ?? null, save: true });
                report.push(...prefixed(kind, pushed.report));
            }
            rec.phases.end(id('unity'), 'done', `both terrains updated in ${unity.editor.projectName}`);
        }

        rec.phases.begin(id('dependents'), 'finding the files that read the heightmap');
        const again = await this.heightmapDependents(ctx);
        if (again.length === 0) {
            rec.phases.end(id('dependents'), 'done', 'no file in the folder reads the heightmap yet');
        } else {
            for (const dep of again) {
                rec.phases.note(dep.what);
                report.push(...prefixed(dep.what, (await dep.run()).report));
            }
            rec.phases.end(id('dependents'), 'done', `${again.map(d => d.what).join(', ')} re-exported`);
        }
        report.push('Still manual in Unity: Terrain › Export To OBJ for Blender, and the terrain conform once the meshes are rebuilt.');
        return report;
    }

    /**
     * The files already in the export folder that carry heights read from a
     * heightmap sidecar, each as the re-export that refreshes it. Only the
     * ones that are there: this is a refresh, not a first export.
     */
    private async heightmapDependents(ctx: SyncContext): Promise<Array<{ what: string; run: () => Promise<{ report: string[] }> }>> {
        const out: Array<{ what: string; run: () => Promise<{ report: string[] }> }> = [];
        const has = (name: string) => statOrNull(ctx.file(name)).then(s => s !== null);
        const force = { force: ctx.force };
        for (const kind of TERRAINS) {
            if (await has(treesExportFileName(ctx.courseName, kind))) {
                out.push({ what: `${kind} trees`, run: () => this.exports.exportTrees(ctx.courseId, kind, force) });
            }
            if (await has(buildingsExportFileName(ctx.courseName, kind))) {
                out.push({ what: `${kind} buildings`, run: () => this.exports.exportBuildings(ctx.courseId, kind, force) });
            }
            if (await has(zonesExportFileName(ctx.courseName, kind))) {
                out.push({ what: `${kind} vegetation zones`, run: () => this.exports.exportZones(ctx.courseId, kind, force) });
            }
        }
        if (await has(creeksExportFileName(ctx.courseName))) {
            out.push({ what: 'creeks', run: () => this.exports.exportCreeks(ctx.courseId, force) });
        }
        if (ctx.courseDir && ctx.gkdFile && await statOrNull(path.join(ctx.courseDir, ctx.gkdFile))) {
            out.push({ what: 'GreenKeeper course file', run: () => this.exports.exportGkd(ctx.courseId) });
        }
        return out;
    }

    /**
     * Photo: the ACTIVE vintage's inner orthophoto — its cleaned copy when the
     * Clean tool has made one, else the photo as the map was built with —
     * rendered with the export panel's defaults (forest floor, buildings
     * removed, the grass surfaces tinted) and put onto the Unity course
     * meshes, plus the outer terrain's texture of the same vintage.
     *
     * Never another vintage: a cleaned file left over from an older collection
     * used to win over the vintage the map shows, which put a photo of another
     * year on the course.
     */
    private async updatePhoto(rec: JobRecord, ctx: SyncContext, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        const sources = await this.orthoSources(ctx);
        if (sources.length === 0) throw new ConflictError('No orthophoto is persisted for this course — build its map first');
        // No active vintage recorded (a map built before that was kept): the newest collection stands in.
        const collection = (sources.find(s => s.active) ?? sources[0]!).collection;
        const vintage = sources.filter(s => s.collection === collection);
        const picked = vintage.find(s => s.cleaned) ?? vintage[0]!;
        const which = picked.cleaned
            ? `photo: ${collection}, cleaned`
            : `photo: ${collection}, no cleaned photo yet: the photo as built`;
        const report: string[] = [which];

        rec.phases.begin(id('inner'), `rendering ${picked.source} (${which})`);
        // The panel's defaults: the tint (the `-meshes` file Unity takes), the forest floor and the roofs filled.
        const exported = await this.exports.exportOrtho(ctx.courseId, picked.source, undefined, {}, {}, true, { force: ctx.force });
        const meshes = meshTextureFileName(path.basename(exported.path));
        report.push(...prefixed('inner photo', exported.report));
        rec.phases.end(id('inner'), 'done', `${path.basename(exported.path)} (+ its -terrain and -meshes twins)`);

        if (!unity.editor) {
            rec.phases.skip(id('unity'), unity.why!);
            report.push(`${unity.why!} — ${meshes} is written, run GolfMap's orthos apply there to take it`);
        } else {
            rec.phases.begin(id('unity'), `${meshes} onto the course meshes in ${unity.editor.projectName}`);
            report.push(...(await this.exports.pushUnityOrtho(ctx.courseId, meshes, { save: true })).report);
            rec.phases.end(id('unity'), 'done', `${meshes} onto the course meshes in ${unity.editor.projectName}`);
        }

        rec.phases.begin(id('outer'), `the outer square from ${collection}`);
        const outer = await this.exports.exportOuterOrtho(ctx.courseId, collection, undefined, {}, {}, true, { force: ctx.force });
        report.push(...prefixed('outer photo', outer.report));
        report.push('The outer texture is written only: there is no Unity push for the outer terrain — set it on the terrain by hand once.');
        rec.phases.end(id('outer'), 'done', path.basename(outer.path));
        return report;
    }

    /** Course shapes: the full SVG (kept as an export snapshot), then Blender by hand. */
    private async updateShapes(rec: JobRecord, ctx: SyncContext, id: (s: string) => string): Promise<string[]> {
        rec.phases.begin(id('svg'), 'gspro.py svg');
        const exported = await this.exports.export(ctx.courseId, {});
        rec.phases.end(id('svg'), 'done', path.basename(exported.path));
        return [...exported.report, `Next: ${gsproTarget('shapes').manual}.`];
    }

    /**
     * Meshes: `ShapingService.apply` does the whole chain already (layers →
     * Blender worker → Unity refresh of the changed objects → the grass round
     * a changed rock slab), so this mirrors its job's phases into ours while
     * it runs.
     */
    private async updateMeshes(rec: JobRecord, ctx: SyncContext, id: (s: string) => string): Promise<string[]> {
        const started = await this.shaping.apply(ctx.courseId, { save: true });
        const limitMs = this.meshesTimeoutMs ?? shapingBudget(this.shaping.waits);
        const until = Date.now() + limitMs;
        let job: ShapingJob = started;
        for (;;) {
            this.mirror(rec, job, id);
            if (job.status !== 'running') break;
            if (Date.now() >= until) {
                throw new ConflictError(`The shaping run (job ${started.id}) has not finished after ${secs(limitMs)} s`
                    + ` — it is on "${job.step}" and goes on in the background: watch the Meshes row, and run Update meshes again once the worker is free`);
            }
            await Bun.sleep(this.pollMs);
            try {
                job = this.shaping.job(started.id);
            } catch (e) {
                // Another apply of this course forgot it, or the server restarted under us: it is not ours to follow any more.
                throw new ConflictError(`The shaping run (job ${started.id}) can no longer be followed: `
                    + `${firstLine(e instanceof Error ? e.message : String(e))}`);
            }
        }
        if (job.status !== 'succeeded') throw new ConflictError(job.error ?? 'the shaping run failed');
        const result = job.result!;
        const saved = savedLine(result.unityReport);
        return [
            ...result.layers,
            `${result.changedObjects.length} object(s) re-shaped, ${result.exported.length} FBX exported`
                + (result.changedObjects.length ? `: ${result.changedObjects.join(', ')}` : ''),
            ...(saved ? [saved] : []),
            ...result.vegetation,
            ...result.warnings.map(w => `warning: ${w}`),
        ];
    }

    /**
     * The shaping job's phases copied into this job's, one for one — status,
     * detail and SECONDS as the shaping job itself reports them. Its own
     * clocks are the truth: timing the mirror instead would restart the
     * running phase on every poll (≈ one poll interval, for ever) and give a
     * phase that went pending → done between two polls no time at all.
     * Pending phases are left alone, so they read pending here too.
     */
    private mirror(rec: JobRecord, job: ShapingJob, id: (s: string) => string): void {
        for (const phase of job.phases) {
            if (phase.status === 'pending') continue;
            rec.phases.set(id(phase.id), { status: phase.status, detail: phase.detail, seconds: phase.seconds });
        }
    }

    /**
     * Vegetation: the whole planting for the inner terrain; for the outer only its zones file, when
     * it already has one — the outer terrain's vegetation is Arborist's, never the course's VSP
     * (OUTER_VEGETATION_IS_ARBORIST, which `plantVegetation` puts in the report).
     */
    private async updateVegetation(rec: JobRecord, ctx: SyncContext, id: (s: string) => string): Promise<string[]> {
        const report: string[] = [];
        rec.phases.begin(id('inner'), 'generators, masks, Unity, the Arborist file');
        const plant = { save: true, force: ctx.force };
        report.push(...prefixed('inner', (await this.exports.plantVegetation(ctx.courseId, 'inner', plant)).report));
        rec.phases.end(id('inner'), 'done', 'planted for the inner terrain');

        if (!await statOrNull(ctx.file(zonesExportFileName(ctx.courseName, 'outer')))) {
            rec.phases.skip(id('outer'), 'the outer terrain has no vegetation zones export to refresh');
        } else {
            rec.phases.begin(id('outer'), 'the outer zones file (its vegetation is Arborist\'s: nothing into Unity)');
            report.push(...prefixed('outer', (await this.exports.plantVegetation(ctx.courseId, 'outer', plant)).report));
            rec.phases.end(id('outer'), 'done', 'outer zones file written; nothing planted in Unity (Arborist draws the outer)');
        }
        return report;
    }

    /** Trees: both terrains' tree files, then the Tree Planter in Unity. */
    private async updateTrees(rec: JobRecord, ctx: SyncContext, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        const report: string[] = [];
        rec.phases.begin(id('files'), 'the inner trees');
        for (const kind of TERRAINS) {
            rec.phases.note(`the ${kind} trees`);
            report.push(...prefixed(kind, (await this.exports.exportTrees(ctx.courseId, kind, { force: ctx.force })).report));
        }
        rec.phases.end(id('files'), 'done', 'inner and outer trees exported');
        await this.intoUnity(rec, unity, id('unity'), 'Tree Planter',
            TERRAINS.map(kind => ({ what: `${kind} trees`, command: 'golfmap.trees.plant', args: { terrain: kind } })), report);
        return report;
    }

    /** Buildings: both terrains' building files; the planting itself has no bridge command yet. */
    private async updateBuildings(rec: JobRecord, ctx: SyncContext, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        const report: string[] = [];
        rec.phases.begin(id('files'), 'the inner buildings');
        for (const kind of TERRAINS) {
            rec.phases.note(`the ${kind} buildings`);
            report.push(...prefixed(kind, (await this.exports.exportBuildings(ctx.courseId, kind, { force: ctx.force })).report));
        }
        rec.phases.end(id('files'), 'done', 'inner and outer buildings exported');
        // No `[BridgeCommand]` plants buildings (unity/Editor/GolfMap/GolfMapBuildingPlanter.cs is a menu item only).
        const manual = gsproTarget('buildings').manual!;
        rec.phases.skip(id('unity'), `no bridge command plants buildings: ${manual}`);
        report.push(`Next in Unity: ${manual}.`);
        return report;
    }

    /**
     * Props: the course's spec through its own Python, the FBX + manifest
     * through Blender into the Unity project, then placed in the scene —
     * docs/workflows.md section 4's three commands as one job.
     *
     * The models and the place need the editor (the out folder is INSIDE the
     * Unity project): without one the spec is still written and the two phases
     * are skipped, so a spec edit made away from the machine running Unity is
     * not lost.
     *
     * The place keeps every prop the user moved by hand — but only when Unity
     * has a record of what it placed last time. On a scene from before that
     * existed there is none, so `golfmap.props.record` seeds it first: without
     * that one call the place would drop the hand moves one last time (three
     * sessions were lost to exactly that).
     */
    private async updateProps(rec: JobRecord, ctx: SyncContext, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        const report: string[] = [];
        const specs = await this.propsSpecs(ctx);
        if (specs.length === 0) throw new ConflictError(`No props spec in ${await this.docsDirLabel(ctx)}`);

        rec.phases.begin(id('spec'), `${specs[0]!.name}-props.gen.py`);
        for (const spec of specs) {
            rec.phases.note(path.basename(spec.gen));
            report.push(...prefixed('spec', await this.runPropsSpec(ctx, spec)));
        }
        rec.phases.end(id('spec'), 'done', `${specs.map(s => path.basename(s.json)).join(', ')} written`);

        const out = unity.courseFolder ? path.join(unity.courseFolder, PROPS_FOLDER) : null;
        if (!out) {
            const why = unity.why
                ?? `Not in Unity: ${unity.editor!.projectName} has this course active but no saved course asset to build into`;
            rec.phases.skip(id('models'), why);
            rec.phases.skip(id('unity'), why);
            report.push(`${why} — the spec is written; the models and the place wait for the editor`);
            return report;
        }

        rec.phases.begin(id('models'), `build_props.py into ${out}`);
        for (const spec of specs) {
            rec.phases.note(`${path.basename(spec.json)} into ${out}`);
            report.push(...prefixed('models', await this.buildPropModels(ctx, spec, out)));
        }
        rec.phases.end(id('models'), 'done', `${specs.length} spec(s) built into ${out}`);

        await this.placeProps(rec, unity.editor!, out, specs, report, id('unity'));
        return report;
    }

    /**
     * One `*-props.gen.py` under the pipeline venv's Python, from the repo root
     * (docs/workflows.md section 4), writing its `*-props.json`. Skipped while
     * neither the generator nor the interpreter has changed since it last ran.
     */
    private async runPropsSpec(ctx: SyncContext, spec: PropsSpec): Promise<string[]> {
        const fp = await fingerprint(spec.json, {
            files: [spec.gen],
            values: { python: this.propsPython, pythonMtime: await mtimeMs(this.propsPython) },
            outputs: [spec.json],
        });
        if (!ctx.force) {
            const unchanged = await unchangedLine(fp);
            if (unchanged) return [unchanged];
        }
        const { code, stdout, stderr } = await this.command([this.propsPython, spec.gen], REPO_DIR);
        if (code !== 0) throw failure(`The props spec (${path.basename(spec.gen)})`, code, stdout, stderr);
        await recordInputs(fp);
        return [`wrote ${path.basename(spec.json)}`, ...reportLines(stdout)];
    }

    /**
     * `blender -b --factory-startup --python blender/tools/build_props.py` for
     * one spec: the per-asset FBX, the textures and the `props.json` manifest
     * into the Unity course folder's `Props/`. Skipped while the spec, the two
     * Blender scripts and the manifest in the folder are all as they were —
     * the manifest is among the outputs, so a hand-deleted one rebuilds.
     *
     * Blender says nothing on success worth a report line, and a lot on
     * failure: the last of its output goes into the 409 (`failure`), which is
     * what the phase's detail shows.
     *
     * Its EXIT CODE cannot be trusted. `blender -b --python` quits 0 after an
     * unhandled Python exception — a spec naming a material `props_kit` has no
     * texture for raises `KeyError` halfway through and still exits 0, with
     * `props.json` never written and the FBX half old, half new. So the
     * manifest having been (re)written is the test of success, not the code.
     */
    private async buildPropModels(ctx: SyncContext, spec: PropsSpec, out: string): Promise<string[]> {
        const manifest = path.join(out, PROPS_MANIFEST);
        const fp = await fingerprint(path.join(out, `${spec.name}-props.json`), {
            files: [spec.json],
            values: {
                buildProps: await mtimeMs(path.join(REPO_DIR, 'blender', 'tools', 'build_props.py')),
                propsKit: await mtimeMs(path.join(REPO_DIR, 'blender', 'tools', 'props_kit.py')),
                out,
            },
            outputs: [manifest],
        });
        if (!ctx.force) {
            const unchanged = await unchangedLine(fp);
            if (unchanged) return [unchanged];
        }
        await ensureDir(out);
        const startedAt = Date.now();
        const { code, stdout, stderr } = await this.command([
            this.blender, '-b', '--factory-startup', '--python', path.join(REPO_DIR, 'blender', 'tools', 'build_props.py'),
            '--', '--spec', spec.json, '--out', out,
        ], REPO_DIR, { timeoutMs: this.propsBuildMs });
        const what = `Building the props (${path.basename(spec.json)})`;
        if (code !== 0) throw failure(what, code, stdout, stderr);
        const written = await statOrNull(manifest);
        // 2 s of slack: a file system's mtime is coarser than this clock.
        if (!written || written.mtimeMs < startedAt - 2000) {
            throw failure(`${what} wrote no ${PROPS_MANIFEST} (Blender quit 0 — read the traceback)`, code, stdout, stderr);
        }
        await recordInputs(fp);
        return [`built ${path.basename(spec.json)} into ${out}`, ...reportLines(stdout).slice(-4)];
    }

    /**
     * The place in Unity: `golfmap.props.record` first when the folder has no
     * `placed.json` (nothing is touched by it — it only writes down where the
     * props stand, so the place that follows can tell a hand move from the
     * spec), then `golfmap.props.place {save: true}`. The report is the
     * interesting part: every instance the place KEPT where the user put it,
     * with how far it had been moved, and a warning for each one the spec took
     * back, each one added by hand, and each one dropped.
     */
    private async placeProps(
        rec: JobRecord, editor: UnityEditor, out: string, specs: PropsSpec[], report: string[], phaseId: string,
    ): Promise<void> {
        rec.phases.begin(phaseId, `golfmap.props.place in ${editor.projectName}`);
        if (!await statOrNull(path.join(out, PROPS_PLACED))) {
            rec.phases.note(`golfmap.props.record in ${editor.projectName} (no ${PROPS_PLACED} yet)`);
            const recorded = await editor.run('golfmap.props.record', {}, PROPS_UNITY_SEC) as PropsRecordResult | null;
            const pairing = recorded?.pairing ?? {};
            report.push(`Unity (${editor.projectName}): golfmap.props.record — ${num(pairing.pairedByPosition)} paired by position,`
                + ` ${num(pairing.indexStillRight)} still at their index, ${count(recorded?.handPlaced)} hand-placed`
                + ` (nothing in the scene was touched)`);
            rec.phases.note(`golfmap.props.place in ${editor.projectName}`);
        }
        const placed = await editor.run('golfmap.props.place', { save: true }, PROPS_UNITY_SEC) as PropsPlaceResult | null;
        const kept = num(placed?.kept);
        report.push(`Unity (${editor.projectName}): golfmap.props.place — placed ${num(placed?.placed)} prop(s),`
            + ` ${kept} kept where they were moved by hand`);
        for (const row of rows(placed?.handPlaced)) {
            report.push(`kept: ${row.name ?? row.asset ?? '?'} moved by hand ${num(row.movedByHand?.m)} m / ${num(row.movedByHand?.deg)}°`);
        }
        for (const row of rows(placed?.specWon)) {
            report.push(`warning: the spec moved ${row.name ?? row.asset ?? '?'} since it was placed by hand: it is back on the spec`);
        }
        for (const row of rows(placed?.handAdded)) {
            report.push(`warning: ${row.name ?? row.asset ?? '?'} was added by hand in Unity and is left standing`);
        }
        for (const row of rows(placed?.droppedHand)) {
            report.push(`warning: dropped the hand-placed ${row.name ?? row.asset ?? '?'} (${row.why ?? 'the spec no longer has it'})`);
        }
        const saved = savedLine(placed);
        report.push(saved ?? 'Save the scene in Unity to keep it.');
        if (kept > 0) {
            report.push(`A hand move becomes permanent only in ${specs.map(s => path.basename(s.gen)).join(' / ')}`
                + ' (docs/workflows.md section 4).');
        }
        rec.phases.end(phaseId, 'done', `${num(placed?.placed)} prop(s) placed, ${kept} kept in ${editor.projectName}`);
    }

    /** Creeks: the R.A.M. spline file, then the import in Unity. */
    private async updateCreeks(rec: JobRecord, ctx: SyncContext, unity: UnityTarget, id: (s: string) => string): Promise<string[]> {
        rec.phases.begin(id('file'), 'gspro.py creeks');
        const exported = await this.exports.exportCreeks(ctx.courseId, { force: ctx.force });
        rec.phases.end(id('file'), 'done', path.basename(exported.path));
        const report = [...exported.report];
        await this.intoUnity(rec, unity, id('unity'), 'Creeks',
            [{ what: 'creeks', command: 'golfmap.creeks.import', args: {} }], report);
        return report;
    }

    /** Course file: GreenKeeper's `.GKD` in the course's GSPro folder. */
    private async updateCourseFile(rec: JobRecord, ctx: SyncContext, id: (s: string) => string): Promise<string[]> {
        rec.phases.begin(id('gkd'), 'gspro.py gkd');
        const exported = await this.exports.exportGkd(ctx.courseId);
        rec.phases.end(id('gkd'), 'done', path.basename(exported.path));
        return exported.report;
    }

    /**
     * One phase that runs a list of bridge commands in the matched editor, or
     * is SKIPPED when none works on the course — the files are written either
     * way, so "no Unity" is never a failure. Each command runs with
     * `save: true`, and the report names what it saved instead of asking for
     * it (a command that saved nothing still gets the old line).
     */
    private async intoUnity(
        rec: JobRecord, unity: UnityTarget, phaseId: string, what: string,
        commands: Array<{ what: string; command: string; args: Record<string, unknown> }>, report: string[],
    ): Promise<void> {
        if (!unity.editor) {
            rec.phases.skip(phaseId, unity.why!);
            report.push(`${unity.why!} — the file(s) are written, run ${what} there to take them`);
            return;
        }
        const editor = unity.editor;
        rec.phases.begin(phaseId, `${what} in ${editor.projectName}`);
        const saved: string[] = [];
        for (const c of commands) {
            rec.phases.note(`${c.what} in ${editor.projectName}`);
            const result = await editor.run(c.command, { ...c.args, save: true }, 600);
            report.push(`Unity (${editor.projectName}): ${c.command} — ${describeUnityResult(result) ?? 'done'}`);
            const line = savedLine(result);
            if (line && !saved.includes(line)) saved.push(line);
        }
        rec.phases.end(phaseId, 'done', `${what} run in ${editor.projectName}`);
        report.push(...(saved.length ? saved : ['Save the scene in Unity to keep it.']));
    }

    // --- Internals ---

    /** Everything the board and the chains need about the course, read once. */
    private async context(courseId: string): Promise<SyncContext> {
        const course = await this.courses.get(courseId);
        const { dir, courseDir, gkdFile } = await this.exports.settings(courseId);
        let terrain: CourseTerrain | null = null;
        let terrainError: string | null = null;
        try {
            terrain = await this.exports.terrain(courseId);
        } catch (e) {
            terrainError = firstLine(e instanceof Error ? e.message : String(e));
        }
        const slug = courseSlug(course.name);
        return {
            courseId,
            courseName: course.name,
            slug,
            siteId: course.siteId,
            dir,
            courseDir,
            gkdFile,
            terrain,
            terrainError,
            record: await readRecord(dir),
            force: false,
            file: (name: string) => path.join(dir, name),
            demSidecar: (kind: TerrainKind) => path.join(dir, demSidecarName(demExportFileName(course.name, kind, terrain![kind].sideM))),
        };
    }

    /**
     * Memoized per call chain: `orthoSources` reads the site's sources folder.
     * The PROMISE is kept, not its answer, so the rows that ask for it at the
     * same time (the Photo row's "blocked" and its "changed since") share one
     * read.
     */
    private orthoSources(ctx: SyncContext): Promise<GsproOrthoSource[]> {
        ctx.orthos ??= this.exports.orthoSources(ctx.courseId);
        return ctx.orthos;
    }

    /**
     * The course's docs folder, `docs/gspro/<course slug>/` — where its props
     * spec lives. The same resolution as the shaping layers (which are
     * `<that>/shaping`), so a course that moved its layers root moves with it.
     */
    private async docsDir(ctx: SyncContext): Promise<string> {
        return path.dirname(await this.shaping.layersDir(ctx.courseId));
    }

    /** That folder as a message names it: repo-relative (`docs/gspro/vreta/`) when it is in the repo. */
    private async docsDirLabel(ctx: SyncContext): Promise<string> {
        const dir = await this.docsDir(ctx);
        const rel = path.relative(REPO_DIR, dir);
        const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : dir;
        return `${shown.replace(/\\/g, '/')}/`;
    }

    /**
     * The course's props specs, memoized per call chain like `orthoSources`:
     * the Props row asks for them three times over (blocked, changed since,
     * and the chain itself), and each ask reads a directory.
     */
    private propsSpecs(ctx: SyncContext): Promise<PropsSpec[]> {
        ctx.specs ??= this.docsDir(ctx).then(propsSpecs);
        return ctx.specs;
    }

    /**
     * `<Unity course folder>/Props` — where `build_props.py` writes and
     * `golfmap.props.place` reads. Null when no open editor has this course
     * active, or its course asset is not saved (then there is no folder to
     * name): everything that needs it says "Not in Unity" instead.
     */
    private async propsDir(ctx: SyncContext): Promise<string | null> {
        ctx.unity ??= this.unityStatus(ctx.dir);
        const folder = (await ctx.unity).editors.find(e => e.matches)?.courseFolder ?? null;
        return folder ? path.join(folder, PROPS_FOLDER) : null;
    }

    private async blendFiles(ctx: SyncContext): Promise<string[]> {
        try {
            return (await readdir(ctx.dir)).filter(n => n.toLowerCase().endsWith('.blend'));
        } catch {
            return [];
        }
    }

    /** `innerDemStale`, or null for a course with no built map (the row is blocked for that). */
    private async innerStale(ctx: SyncContext): Promise<string | null> {
        if (!ctx.siteId) return null;
        try {
            const stale = await this.exports.innerDemStale(ctx.courseId);
            if (stale) return stale;
        } catch {
            return null;   // no DEM persisted at all: `blocked` already says to build the map
        }
        // A pond dug with its outline at the water's edge needs its water level, which apply-dem-edits writes
        // next to the edited DEM: an edited DEM from before that is applied again.
        const waterEdge = (await this.terrainEdits.listDemEdits(ctx.siteId)).some(e => e.op === 'dig' && e.params.bankAboveDeg !== undefined);
        if (waterEdge && !await Bun.file(path.join(this.dataDir, 'sources', ctx.siteId, DIG_WATER_LEVELS_SOURCE)).exists()) {
            return "the water-edge ponds' water levels are not worked out yet";
        }
        return null;
    }

    /** One target's entry in `<export dir>/gspro-sync.json`, the rest of the file kept. */
    private async writeRecordEntry(ctx: SyncContext, target: GsproTargetId, entry: GsproSyncRecordEntry): Promise<void> {
        await ensureDir(ctx.dir);
        const file = path.join(ctx.dir, SYNC_RECORD_FILE);
        // Re-read: another course on the same folder, or a run of the CLI, may have written since.
        const record = await readRecord(ctx.dir);
        record.targets[target] = entry;
        ctx.record = record;
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    }
}

// --- Helpers ---

const TERRAINS: readonly TerrainKind[] = ['inner', 'outer'];

/** The matched Unity editor for one job, or why there is none. */
interface UnityTarget {
    editor: UnityEditor | null;
    /** Set exactly when `editor` is null: the line every skipped push uses. */
    why: string | null;
    /** The matched course's folder in the project (`<project>/Assets/GolfMap/Vreta`); null with no editor. */
    courseFolder: string | null;
}

interface SyncContext {
    courseId: string;
    courseName: string;
    slug: string;
    siteId: string | null;
    dir: string;
    courseDir: string | null;
    gkdFile: string | null;
    /** Null when the course has no map area; `terrainError` then says so. */
    terrain: CourseTerrain | null;
    terrainError: string | null;
    record: GsproSyncRecord;
    /** This job's `--force`: render every file again, whatever its inputs say (false while only reading the board). */
    force: boolean;
    /** The one `orthoSources` read of this call chain (see `GsproSyncService.orthoSources`). */
    orthos?: Promise<GsproOrthoSource[]>;
    /** The one props-spec listing of this call chain (`GsproSyncService.propsSpecs`). */
    specs?: Promise<PropsSpec[]>;
    /** The one Unity probe of this call chain — the Props row needs the matched editor's course folder. */
    unity?: Promise<GsproSyncUnity>;
    file(name: string): string;
    /** Only safe with `terrain` non-null. */
    demSidecar(kind: TerrainKind): string;
}

/** A job as this process keeps it: the public job without its phases, plus them and the clocks. */
interface JobRecord {
    job: Omit<GsproSyncJob, 'phase' | 'phases' | 'step' | 'seconds'>;
    phases: JobPhases;
    /** Render every file again, whatever its input fingerprint says. */
    force: boolean;
    /** When it started running (ms); null while queued. */
    t0: number | null;
    t1: number | null;
}

/** The phases one target's chain reports, in order. */
export function targetPhases(target: GsproTargetId): ReadonlyArray<readonly [string, string]> {
    switch (target) {
        case 'terrain': return [
            ['apply', 'Applying terrain edits'],
            ['dem', 'Heightmaps'],
            ['unity', 'Unity terrain'],
            ['dependents', 'Files that read the heightmap'],
        ];
        case 'photo': return [['inner', 'Inner photo'], ['unity', 'Photo onto the Unity meshes'], ['outer', 'Outer photo']];
        case 'shapes': return [['svg', 'Course SVG']];
        case 'meshes': return SHAPING_PHASES;
        case 'vegetation': return [['inner', 'Vegetation, inner'], ['outer', 'Vegetation, outer']];
        case 'trees': return [['files', 'Tree files'], ['unity', 'Trees into Unity']];
        case 'buildings': return [['files', 'Building files'], ['unity', 'Buildings into Unity']];
        case 'props': return [['spec', 'Props spec'], ['models', 'Prop models (Blender)'], ['unity', 'Props into Unity']];
        case 'creeks': return [['file', 'Creeks file'], ['unity', 'Creeks into Unity']];
        case 'course-file': return [['gkd', 'GreenKeeper course file']];
    }
}

/** One target's phases into the job's list, namespaced so a `'stale'` run's ids stay unique. */
function addPhases(phases: JobPhases, target: GsproTargetId, withTargetLabel: boolean): void {
    for (const [id, label] of targetPhases(target)) {
        phases.add(`${target}:${id}`, withTargetLabel ? `${gsproTarget(target).label}: ${label}` : label);
    }
}

function snapshot(rec: JobRecord): GsproSyncJob {
    const started = rec.t0;
    return {
        ...rec.job,
        phase: rec.phases.current,
        phases: rec.phases.snapshot(),
        step: rec.phases.step(rec.job.status, rec.job.error),
        seconds: started === null ? 0 : secs((rec.t1 ?? Date.now()) - started),
        targets: [...rec.job.targets],
        results: rec.job.results.map(r => ({ ...r, report: [...r.report] })),
    };
}

const byQueuedAt = (a: JobRecord, b: JobRecord) => a.job.queuedAt.localeCompare(b.job.queuedAt);

/** A count with no kinds of its own given one word, so the board can name it. */
function named(count: ChangeCount, kind: string): ChangeCount {
    return { count: count.count, kinds: count.count > 0 ? [kind] : [] };
}

/** Several counts as one: the counts added, the kinds deduplicated in the order they came. */
function merge(parts: ChangeCount[]): ChangeCount {
    const kinds: string[] = [];
    let count = 0;
    for (const part of parts) {
        count += part.count;
        for (const kind of part.kinds) if (!kinds.includes(kind)) kinds.push(kind);
    }
    return { count, kinds };
}

const prefixed = (what: string, lines: string[]) => lines.map(l => `${what}: ${l}`);

// --- The props bridge answers, read leniently (the editor's own JSON) ---

/** One row of a place report's hand-edit lists (`GolfMapProps.HandRow`). */
interface PropsRow {
    asset?: string;
    name?: string;
    why?: string;
    movedByHand?: { m?: number; deg?: number };
}

interface PropsPlaceResult {
    placed?: number;
    kept?: number;
    handPlaced?: unknown;
    specWon?: unknown;
    handAdded?: unknown;
    droppedHand?: unknown;
}

interface PropsRecordResult {
    pairing?: { pairedByPosition?: number; indexStillRight?: number };
    handPlaced?: unknown;
}

/** A number the editor reported, or 0 — a report line must never read `undefined`. */
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const rows = (value: unknown): PropsRow[] =>
    (Array.isArray(value) ? value : []).filter((r): r is PropsRow => !!r && typeof r === 'object');

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * How long a shaping apply may take at the outside, from the shaping service's
 * own timeouts: the worker's load, the `/sync` and the Unity refresh, one after
 * the other. What the `meshes` chain follows its job for.
 */
function shapingBudget(waits: ShapingTimeouts): number {
    return waits.loadMs + waits.syncMs + waits.unitySec * 1000;
}

function firstLine(text: string): string {
    return text.split('\n')[0] ?? text;
}

/** A bridge answer's own words, for the report; null when it says nothing useful. */
function describeUnityResult(result: unknown): string | null {
    const r = result as Record<string, unknown> | null | undefined;
    for (const key of ['status', 'summary', 'message']) {
        const value = r?.[key];
        if (typeof value === 'string' && value.trim()) return firstLine(value.trim());
    }
    return r ? firstLine(JSON.stringify(r).slice(0, 300)) : null;
}

/** A file's mtime as an ISO timestamp; null when it is not there. */
async function mtimeIso(file: string): Promise<string | null> {
    const stats = await statOrNull(file);
    return stats ? new Date(stats.mtimeMs).toISOString() : null;
}

/** The newest mtime among the files, as ISO; null when none of them is there. */
async function newestMtime(files: string[]): Promise<string | null> {
    let newest: string | null = null;
    for (const file of files) {
        const at = await mtimeIso(file);
        if (at !== null && (newest === null || at > newest)) newest = at;
    }
    return newest;
}

/** The record in an export folder; an empty one when there is none or it is not ours. */
export async function readRecord(dir: string): Promise<GsproSyncRecord> {
    try {
        const doc = JSON.parse(await readFile(path.join(dir, SYNC_RECORD_FILE), 'utf8')) as Partial<GsproSyncRecord>;
        if (doc.format !== SYNC_RECORD_FORMAT || !doc.targets || typeof doc.targets !== 'object') {
            return { format: SYNC_RECORD_FORMAT, targets: {} };
        }
        return { format: SYNC_RECORD_FORMAT, targets: doc.targets };
    } catch {
        return { format: SYNC_RECORD_FORMAT, targets: {} };
    }
}
