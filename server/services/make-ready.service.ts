// Make ready: is the course fit for a GSPro build? (builder only)
//
// One implementation behind the GSPro board's Course › Ready row
// (web/src/export/) and `bun run course:ready` (scripts/make-ready.ts). It
// checks for faults and that everything within `marginM` (40 m) of the
// playing field (the tee, fairway, green, semi, rough and bunker meshes) has
// a GSPro collider with the right physic material, in three phases, run as
// one JOB (polled, like the board's other jobs — `job-phases.ts`):
//
//   - `unity`     `golfmap.course.ready {fix, marginM}` in the open Unity
//                 editor that has the course active (fix also passes
//                 `save: true`): the scene's trees, water, R.A.M. roads and
//                 creeks, buildings, bushes, stones, props and vehicles near
//                 play, each with the collider and GSP* material it should
//                 have. Writes `<export dir>/make-ready.json`
//                 (golfmap-make-ready-v1); fix adds what is missing.
//   - `arborist`  the trees and bushes Arborist draws in GSPro (they are not
//                 in the Unity scene), read from the course's
//                 `arboristdata.dat` (decoded by `pipeline/arborist.py decode`):
//                 a tree item near play whose ColliderType is Disabled, or a
//                 billboard-only `(far)` item near play, is an error; a
//                 bush (Plant) taller AND wider than 0.5 m near play without a
//                 collider is a warning. Arborist's own collider shapes and
//                 materials are inside its asset bundles and cannot be checked
//                 from the file. REPORT ONLY: make ready never changes
//                 arboristdata.dat.
//   - `check`     the course check (CourseCheckService): its last Unity report
//                 when the meshes did not change since, else a new check. Its
//                 errors count as make ready's errors.
//
// The job's outcome goes to `<export dir>/make-ready-summary.json`
// (golfmap-make-ready-summary-v1), which `status` reads back for the board.
// `ready` = no errors, and the scene and the course check were both looked
// at (Unity closed is never ready). One run per course at a time (409).
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { CoursesService } from './courses.service';
import {
    courseSlug, defaultRunner, ensureDir, statOrNull, surfacesExportFileName, venvPython,
    type ExportRunner, type GsproExportService,
} from './gspro-export.service';
import type { CourseCheckService, CourseCheckSummary } from './course-check.service';
import { terrainsSquare } from './arborist.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { JobPhases, secs, type JobPhase } from './job-phases';
import { defaultUnityBridge, editorForExportDir, type UnityBridge, type UnityEditor } from './unity-bridge';

/** Unity's report (GolfMapCourseReady), in the export folder. */
export const UNITY_READY_REPORT = 'make-ready.json';
export const READY_FORMAT = 'golfmap-make-ready-v1';
/** What a run leaves for `status`: the whole outcome, every phase together. */
export const READY_SUMMARY = 'make-ready-summary.json';
export const SUMMARY_FORMAT = 'golfmap-make-ready-summary-v1';
/** How near the playing field counts as near (m). */
export const READY_MARGIN_M = 40;
/** A bush wants a collider when it is taller AND wider than this (m). */
export const BUSH_COLLIDER_M = 0.5;
/** What the playing field is in the surface map (pipeline/arborist.py FarRule.PLAY). */
export const PLAY_CLASSES = ['rough', 'semi', 'fairway', 'green', 'tee', 'bunker'] as const;
/** The suffix of a billboard-only Arborist item (arborist.py FAR_SUFFIX). */
const FAR_SUFFIX = ' (far)';
/** How long the Unity command may take (s): every object in the scene, near play or not. */
const UNITY_READY_SEC = 600;
/** Findings the Unity command answers with (its file has all). */
const UNITY_LIMIT = 60;
/** Findings a job result carries (the summary file has them all). */
const RESULT_FINDINGS = 200;
const DECODE_TIMEOUT_MS = 5 * 60_000;

export type MakeReadyLayer = 'unity' | 'arborist';
export type MakeReadySeverity = 'error' | 'warn' | 'info';

/** One category's tally: how many objects, how many near play, how many as they should be, fixed, findings. */
export interface MakeReadyCategory {
    layer: MakeReadyLayer;
    /** Unity's own (`trees`, `water`, `roads` ...), or `arborist-trees` / `arborist-bushes`. */
    category: string;
    objects: number;
    near: number;
    ok: number;
    fixed: number;
    findings: number;
}

export interface MakeReadyFinding {
    layer: MakeReadyLayer;
    category: string;
    severity: MakeReadySeverity;
    objects: string[];
    note: string | null;
    /** Unity world position (x, y, z); null when none. */
    unity: number[] | null;
    /** EPSG:3006 easting, northing; null when none. */
    epsg3006: number[] | null;
}

/** What Unity's fix did to one object. */
export interface MakeReadyFix {
    object: string;
    what: string;
}

/** How a phase went, in one line each. */
export interface MakeReadyUnityPart {
    /** Why it did not run (no editor has the course active, or the command failed); null when it ran. */
    skipped: string | null;
    report: string | null;
    errors: number;
    warnings: number;
    fixed: number;
}

export interface MakeReadyArboristPart {
    /** Why nothing was read (no GSPro course folder, no arboristdata.dat, no surface map); null when read. */
    skipped: string | null;
    /** The file read. */
    file: string | null;
    /** Stored instances in it. */
    instances: number;
    errors: number;
    warnings: number;
}

export interface MakeReadyCheckPart {
    /** Why the course check counts for nothing (Unity closed and no fresh report); null when it counts. */
    skipped: string | null;
    /** `run` = checked now; `report` = the last report, made after the last mesh change. */
    source: 'run' | 'report' | null;
    at: string | null;
    report: string | null;
    errors: number;
    warnings: number;
}

/** A run's outcome, as the summary file keeps it and the board shows it. */
export interface MakeReadySummary {
    /** ISO: when the run ended. */
    at: string;
    ready: boolean;
    /** What stands between the course and ready besides its errors (Unity closed, a phase that failed). */
    blockers: string[];
    errors: number;
    warnings: number;
    /** Objects Unity's fix changed. */
    fixed: number;
    fix: boolean;
    marginM: number;
    categories: MakeReadyCategory[];
    unity: MakeReadyUnityPart;
    arborist: MakeReadyArboristPart;
    check: MakeReadyCheckPart;
}

export interface MakeReadyResult extends MakeReadySummary {
    /** Errors, then warnings, then infos; at most 200 (the summary file has all). */
    findings: MakeReadyFinding[];
    /** What Unity's fix changed. */
    fixes: MakeReadyFix[];
    /** The summary file written. */
    file: string;
}

export type MakeReadyJobStatus = 'running' | 'succeeded' | 'failed';

export interface MakeReadyJob {
    id: string;
    courseId: string;
    status: MakeReadyJobStatus;
    phase: string | null;
    step: string;
    phases: JobPhase[];
    startedAt: string;
    finishedAt: string | null;
    seconds: number;
    /** Null until the job is over. */
    result: MakeReadyResult | null;
    /** The first phase that failed; the other phases still ran. */
    error: string | null;
}

export interface MakeReadyRunOptions {
    /** Let Unity add the missing colliders and materials, and save the scene. */
    fix?: boolean;
    /** Near play = within this of the playing field (m; default 40). */
    marginM?: number;
}

export interface MakeReadyStatus {
    /** The last run's outcome (the summary file); null before the first. */
    last: MakeReadySummary | null;
    /** The running run, else the last one this process ran. */
    job: MakeReadyJob | null;
}

/** The decoded Arborist document, as much of it as is read here. */
export interface ArboristDoc {
    VSProSettings?: { vegetationPackages?: Array<{ PackageName?: string; VegetationInfoList?: ArboristItem[] | null }> };
    PersistentVegetationPackage?: {
        PersistentVegetationCellList?: Array<{
            PersistentVegetationInfoList?: Array<{ VegetationItemID?: string; VegetationItemList?: ArboristInstance[] }>;
        }>;
    };
}

export interface ArboristItem {
    VegetationItemID?: string;
    Name?: string;
    Address?: string;
    VegetationType?: string;
    ColliderType?: string;
}

export interface ArboristInstance {
    Position?: { x?: number; y?: number; z?: number };
    Scale?: { x?: number; y?: number; z?: number };
}

export interface MakeReadyDeps {
    courses: Pick<CoursesService, 'get'>;
    exports: Pick<GsproExportService, 'settings'>;
    courseCheck: Pick<CourseCheckService, 'status' | 'run' | 'whenIdle'>;
    dataDir: string;
    pipelineDir?: string;
    /** Runs `arborist.py decode`; default the pipeline venv's Python. */
    runner?: ExportRunner;
    /** The decoded arboristdata.dat (tests hand a document in; default `arborist.py decode`). */
    decodeArborist?: (dat: string) => Promise<ArboristDoc>;
    unityBridge?: UnityBridge;
    /** How long the Unity command may take (s; default 600). */
    unitySec?: number;
}

interface JobRecord {
    job: Omit<MakeReadyJob, 'phase' | 'phases' | 'step' | 'seconds'>;
    phases: JobPhases;
    t0: number;
    t1: number | null;
    done: Promise<void>;
}

const PHASES: ReadonlyArray<readonly [string, string]> = [
    ['unity', 'Unity scene'],
    ['arborist', 'Arborist file'],
    ['check', 'Course check'],
];

export class MakeReadyService {
    private readonly deps: MakeReadyDeps;
    private readonly unityBridge: UnityBridge;
    private readonly unitySec: number;
    private readonly jobs = new Map<string, JobRecord>();

    constructor(deps: MakeReadyDeps) {
        this.deps = deps;
        this.unityBridge = deps.unityBridge ?? defaultUnityBridge();
        this.unitySec = deps.unitySec ?? UNITY_READY_SEC;
    }

    /** Start a run and return its job at once (`running`); 409 while one runs for the course, 404 for an unknown course. */
    async run(courseId: string, opts: MakeReadyRunOptions = {}): Promise<MakeReadyJob> {
        await this.deps.courses.get(courseId);
        const running = [...this.jobs.values()].find(r => r.job.courseId === courseId && r.job.status === 'running');
        if (running) throw new ConflictError(`Make ready is already running for this course (${running.phases.step('running', null)})`);
        for (const [id, rec] of this.jobs) if (rec.job.courseId === courseId) this.jobs.delete(id);
        const rec: JobRecord = {
            job: {
                id: crypto.randomUUID(), courseId, status: 'running', startedAt: new Date().toISOString(),
                finishedAt: null, result: null, error: null,
            },
            phases: new JobPhases(PHASES),
            t0: Date.now(),
            t1: null,
            done: Promise.resolve(),
        };
        rec.done = this.perform(rec, { fix: opts.fix === true, marginM: opts.marginM ?? READY_MARGIN_M });
        this.jobs.set(rec.job.id, rec);
        return snapshot(rec);
    }

    /** A job by id; 404 when this process never ran it. */
    job(jobId: string): MakeReadyJob {
        const rec = this.jobs.get(jobId);
        if (!rec) throw new NotFoundError(`No make-ready job ${jobId} (the server may have restarted)`);
        return snapshot(rec);
    }

    /** Resolves when the course's run (if any) is over (tests, the CLI). */
    async whenIdle(courseId: string): Promise<void> {
        for (const rec of this.jobs.values()) if (rec.job.courseId === courseId) await rec.done;
    }

    /** The last run's outcome from the summary file, and the running or last job. */
    async status(courseId: string): Promise<MakeReadyStatus> {
        await this.deps.courses.get(courseId);
        const { dir } = await this.deps.exports.settings(courseId);
        const last = await readSummaryFile(path.join(dir, READY_SUMMARY));
        const rec = [...this.jobs.values()].filter(r => r.job.courseId === courseId).sort((a, b) => b.t0 - a.t0)[0];
        return { last, job: rec ? snapshot(rec) : null };
    }

    // --- The job ---

    private async perform(rec: JobRecord, opts: Required<MakeReadyRunOptions>): Promise<void> {
        const p = rec.phases;
        const courseId = rec.job.courseId;
        const failures: Array<{ phase: string; error: string }> = [];
        const categories: MakeReadyCategory[] = [];
        const findings: MakeReadyFinding[] = [];
        const fixes: MakeReadyFix[] = [];
        const unity: MakeReadyUnityPart = { skipped: null, report: null, errors: 0, warnings: 0, fixed: 0 };
        const arborist: MakeReadyArboristPart = { skipped: null, file: null, instances: 0, errors: 0, warnings: 0 };
        const check: MakeReadyCheckPart = { skipped: null, source: null, at: null, report: null, errors: 0, warnings: 0 };
        const fail = (phase: string, e: unknown) => {
            const why = firstLine(e);
            failures.push({ phase, error: why });
            p.end(phase, 'failed', why);
        };
        let dir = '';
        let editor: UnityEditor | null = null;
        try {
            const course = await this.deps.courses.get(courseId);
            const settings = await this.deps.exports.settings(courseId);
            dir = settings.dir;

            // a. The Unity scene.
            p.begin('unity', 'finding the course\'s Unity editor');
            const found = await editorForExportDir(this.unityBridge, dir);
            editor = found.editor;
            if (!editor) {
                unity.skipped = `Not in Unity: no open Unity editor imports from ${dir}` + (found.seen.length ? ` (${found.seen.join('; ')})` : ' (none is open)');
                p.skip('unity', unity.skipped);
            } else {
                try {
                    const args: Record<string, unknown> = { fix: opts.fix, marginM: opts.marginM, limit: UNITY_LIMIT };
                    if (opts.fix) args.save = true;
                    p.note(`golfmap.course.ready in ${editor.projectName}${opts.fix ? ' (fix, then save)' : ''}`);
                    const answer = await editor.run('golfmap.course.ready', args, this.unitySec) as Doc | null;
                    const read = await readUnityReport(typeof answer?.file === 'string' ? answer.file : path.join(dir, UNITY_READY_REPORT), answer);
                    unity.report = read.report;
                    unity.errors = read.errors;
                    unity.warnings = read.warnings;
                    unity.fixed = read.fixes.length;
                    categories.push(...read.categories);
                    findings.push(...read.findings);
                    fixes.push(...read.fixes);
                    p.end('unity', 'done', `${countsLine(unity)}${opts.fix ? ` · ${unity.fixed} fixed` : ''} in ${editor.projectName}`);
                } catch (e) {
                    unity.skipped = `golfmap.course.ready failed: ${firstLine(e)}`;
                    fail('unity', e);
                }
            }

            // b. The Arborist file.
            p.begin('arborist', 'reading arboristdata.dat');
            try {
                const why = await this.arboristLayer(course.name, dir, settings.courseDir, opts.marginM, arborist, categories, findings);
                if (why) {
                    arborist.skipped = why;
                    p.skip('arborist', why);
                } else {
                    p.end('arborist', 'done', `${countsLine(arborist)} in ${arborist.instances} instances (report only)`);
                }
            } catch (e) {
                arborist.skipped = `not read: ${firstLine(e)}`;
                fail('arborist', e);
            }

            // c. The course check.
            p.begin('check', 'the last course check');
            try {
                await this.checkLayer(courseId, editor, check, p);
                if (check.skipped) p.skip('check', check.skipped);
                else p.end('check', 'done', `${countsLine(check)} (${check.source === 'run' ? 'checked now' : `report of ${check.at}, meshes unchanged since`})`);
            } catch (e) {
                check.skipped = `failed: ${firstLine(e)}`;
                fail('check', e);
            }
        } catch (e) {
            failures.push({ phase: p.current ?? 'unity', error: firstLine(e) });
            p.failCurrent(firstLine(e));
            p.skipPending('make ready failed');
        }

        const blockers: string[] = [];
        if (unity.skipped) blockers.push(`Unity scene not checked: ${unity.skipped}`);
        if (check.skipped) blockers.push(`Course check: ${check.skipped}`);
        for (const f of failures) if (f.phase === 'arborist') blockers.push(`Arborist file: ${f.error}`);
        const errors = unity.errors + arborist.errors + check.errors;
        const warnings = unity.warnings + arborist.warnings + check.warnings;
        const rank = (s: string) => (s === 'error' ? 0 : s === 'warn' ? 1 : 2);
        findings.sort((a, b) => rank(a.severity) - rank(b.severity));
        const summary: MakeReadySummary = {
            at: new Date().toISOString(),
            ready: errors === 0 && blockers.length === 0 && failures.length === 0,
            blockers,
            errors,
            warnings,
            fixed: fixes.length,
            fix: opts.fix,
            marginM: opts.marginM,
            categories,
            unity,
            arborist,
            check,
        };
        const file = dir ? path.join(dir, READY_SUMMARY) : '';
        if (dir) {
            try {
                await ensureDir(dir);
                await writeFile(file, JSON.stringify({ format: SUMMARY_FORMAT, ...summary, findings, fixes }, null, 1));
            } catch (e) {
                failures.push({ phase: 'summary', error: `the summary was not written: ${firstLine(e)}` });
            }
        }
        rec.job.result = { ...summary, findings: findings.slice(0, RESULT_FINDINGS), fixes, file };
        if (failures.length) {
            rec.job.status = 'failed';
            rec.job.error = failures[0]!.error;
            p.current = failures[0]!.phase !== 'summary' ? failures[0]!.phase : null;
        } else {
            rec.job.status = 'succeeded';
            p.current = null;
        }
        rec.t1 = Date.now();
        rec.job.finishedAt = new Date().toISOString();
    }

    /**
     * The Arborist file against the playing field. Returns why it was not
     * read (nothing to check, or an input missing); null when it was.
     */
    private async arboristLayer(
        courseName: string, dir: string, courseDir: string | null, marginM: number,
        part: MakeReadyArboristPart, categories: MakeReadyCategory[], findings: MakeReadyFinding[],
    ): Promise<string | null> {
        if (!courseDir) return 'no GSPro course folder set: no Arborist file to read';
        const dat = path.join(courseDir, 'arboristdata.dat');
        if (!await statOrNull(dat)) return `no arboristdata.dat in ${courseDir}: Arborist draws nothing`;
        const slug = courseSlug(courseName);
        const square = await terrainsSquare(dir, slug);
        if (!square) return `no inner heightmap sidecar in ${dir}: where Arborist's cells lie is unknown (export the inner heightmap)`;
        const surfacesFile = path.join(dir, surfacesExportFileName(courseName, 'inner'));
        if (!await statOrNull(surfacesFile)) return `no surface map ${path.basename(surfacesFile)}: run golfmap.surfaces.export in Unity (the course refresh does)`;
        const [doc, play, sizes, georef] = await Promise.all([
            (this.deps.decodeArborist ?? (f => this.decode(f)))(dat),
            PlayDistance.read(surfacesFile, marginM),
            readCatalogSizes(path.join(this.deps.dataDir, 'arborist', 'catalog-sizes.json')),
            innerGeoref(dir, slug),
        ]);
        const checked = checkArborist(doc, { origin: { x: square[0], z: square[1] }, play, sizes, marginM, toEpsg3006: georef });
        part.file = dat;
        part.instances = checked.instances;
        part.errors = checked.findings.filter(f => f.severity === 'error').length;
        part.warnings = checked.findings.filter(f => f.severity === 'warn').length;
        categories.push(...checked.categories);
        findings.push(...checked.findings);
        return null;
    }

    /** `arborist.py decode <dat> <tmp json>` with the wrapper key. */
    private async decode(dat: string): Promise<ArboristDoc> {
        const pipelineDir = this.deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        const runner = this.deps.runner ?? defaultRunner(process.env.MAP_PIPELINE_PYTHON ?? venvPython(pipelineDir));
        const key = process.env.GOLFMAP_ARBORIST_KEY ?? path.join(this.deps.dataDir, 'arborist-wrapper.key');
        if (!await statOrNull(key)) throw new Error(`no wrapper key at ${key} (docs/gspro/arborist.md, "What GSPro reads")`);
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'make-ready-'));
        try {
            const out = path.join(tmp, 'arboristdata.json');
            const { code, stdout, stderr } = await runner(
                [path.join(pipelineDir, 'arborist.py'), 'decode', dat, out, '--key-file', key], pipelineDir, { timeoutMs: DECODE_TIMEOUT_MS });
            if (code !== 0) {
                const last = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n').filter(l => l.trim()).at(-1)!.trim();
                throw new Error(`arboristdata.dat not decoded: ${last}`);
            }
            return JSON.parse((await readFile(out, 'utf8')).replace(/^﻿/, '')) as ArboristDoc;
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    }

    /**
     * The course check's errors: its last Unity report when the meshes have
     * not changed since, else a check now (when Unity is open). A check
     * already running (the board's Check row) is waited for.
     */
    private async checkLayer(courseId: string, editor: UnityEditor | null, part: MakeReadyCheckPart, p: JobPhases): Promise<void> {
        const cc = this.deps.courseCheck;
        const before = await cc.status(courseId);
        const take = (s: CourseCheckSummary, source: 'run' | 'report') => {
            part.source = source;
            part.at = s.at;
            part.report = s.report;
            part.errors = s.errors;
            part.warnings = s.warnings;
        };
        if (before.job?.status !== 'running' && before.unity && !before.unity.hole && !before.meshesChangedSince) {
            take(before.unity, 'report');
            return;
        }
        if (!editor) {
            part.skipped = before.unity
                ? 'the last course check is older than the meshes, and Unity is closed: check again in Unity'
                : 'never checked, and Unity is closed';
            return;
        }
        if (before.job?.status === 'running') {
            p.note('waiting for the course check already running');
        } else {
            p.note(`golfmap.course.check in ${editor.projectName}`);
            try {
                await cc.run(courseId);
            } catch (e) {
                if (!(e instanceof ConflictError)) throw e;
            }
        }
        await cc.whenIdle(courseId);
        const after = await cc.status(courseId);
        const result = after.job?.result;
        if (after.job?.status === 'failed') throw new Error(`the course check failed: ${after.job.error ?? 'unknown error'}`);
        if (result?.unity) take(result.unity, 'run');
        else part.skipped = result?.unitySkipped ?? 'the course check did not run in Unity';
        // The Blender layer's errors count too, when it ran.
        if (result?.blender) {
            part.errors += result.blender.errors;
            part.warnings += result.blender.warnings;
        }
    }
}

// --- The Arborist check ---

/** Distance to the playing field, from the surface map (golfmap-surfaces-v1), up to the margin. */
export class PlayDistance {
    /** Coarse cell (m): the map's own, at least 1 m. */
    readonly cellM: number;
    private readonly w: number;
    private readonly h: number;
    private readonly ox: number;
    private readonly oz: number;
    /** Per north-up row, the distance in cells to the nearest play cell in the same row (capped). */
    private readonly row: Uint16Array;
    private readonly cap: number;
    private readonly reach: number;

    constructor(meta: SurfacesMeta, data: Uint8Array, maxM: number) {
        const play = new Uint8Array(256);
        for (const [k, v] of Object.entries(meta.classes)) if ((PLAY_CLASSES as readonly string[]).includes(v)) play[Number(k)] = 1;
        const step = meta.cellM < 1 ? Math.max(1, Math.round(1 / meta.cellM)) : 1;
        this.cellM = meta.cellM * step;
        this.w = Math.floor(meta.width / step);
        this.h = Math.floor(meta.height / step);
        [this.ox, this.oz] = meta.worldOrigin ?? [0, 0];
        this.reach = Math.ceil(maxM / this.cellM) + 1;
        this.cap = Math.min(65535, this.reach + 1);
        this.row = new Uint16Array(this.w * this.h).fill(this.cap);
        const isPlay = new Uint8Array(this.w * this.h);
        for (let r = 0; r < this.h * step; r++) {
            const base = r * meta.width;
            const cr = Math.floor(r / step) * this.w;
            for (let c = 0; c < this.w * step; c++) if (play[data[base + c]!]) isPlay[cr + Math.floor(c / step)] = 1;
        }
        for (let r = 0; r < this.h; r++) {
            const o = r * this.w;
            let d = this.cap;
            for (let c = 0; c < this.w; c++) {
                d = isPlay[o + c] ? 0 : Math.min(this.cap, d + 1);
                this.row[o + c] = d;
            }
            d = this.cap;
            for (let c = this.w - 1; c >= 0; c--) {
                d = isPlay[o + c] ? 0 : Math.min(this.cap, d + 1);
                if (d < this.row[o + c]!) this.row[o + c] = d;
            }
        }
    }

    static async read(file: string, maxM: number): Promise<PlayDistance> {
        const meta = JSON.parse(await readFile(file, 'utf8')) as SurfacesMeta;
        const data = new Uint8Array(await readFile(path.join(path.dirname(file), meta.data)));
        if (data.length < meta.width * meta.height) throw new Error(`${meta.data} is short: ${data.length} bytes for ${meta.width} x ${meta.height}`);
        return new PlayDistance(meta, data, maxM);
    }

    /** Metres from Unity world (x, z) to the nearest play cell; Infinity beyond the margin it was built for. */
    distanceM(x: number, z: number): number {
        const c = Math.floor((x - this.ox) / this.cellM);
        const rs = Math.floor((z - this.oz) / this.cellM);   // rows from the south edge
        let best = Infinity;
        for (let s = Math.max(0, rs - this.reach); s <= Math.min(this.h - 1, rs + this.reach); s++) {
            const o = (this.h - 1 - s) * this.w;   // the map is north-up
            const across = c < 0 ? -c + this.row[o]! : c >= this.w ? c - (this.w - 1) + this.row[o + this.w - 1]! : this.row[o + c]!;
            if (across >= this.cap) continue;
            const d = Math.hypot(across, s - rs);
            if (d < best) best = d;
        }
        return best === Infinity || best > this.reach ? Infinity : best * this.cellM;
    }
}

export interface SurfacesMeta {
    width: number;
    height: number;
    cellM: number;
    /** The bin file beside the json: one class byte per cell, north-up rows. */
    data: string;
    /** Unity world (x, z) of the map's south-west corner. */
    worldOrigin?: [number, number];
    classes: Record<string, string>;
}

/** An Arborist model's size at scale 1 (data/arborist/catalog-sizes.json, by address and by label). */
export interface CatalogSize {
    widthM: number;
    heightM: number;
}

export interface ArboristCheckContext {
    /** Unity world of the instances' (0, 0): the terrains square's south-west corner (arborist.py Grid). */
    origin: { x: number; z: number };
    play: Pick<PlayDistance, 'distanceM'>;
    sizes: Map<string, CatalogSize>;
    marginM: number;
    toEpsg3006: ((x: number, z: number) => [number, number]) | null;
}

export interface ArboristCheck {
    instances: number;
    categories: MakeReadyCategory[];
    findings: MakeReadyFinding[];
}

/**
 * The stored instances of a decoded arboristdata.dat against the playing
 * field. One finding per item and fault (its count in the note, the
 * instance nearest play as its place), plus one info that the colliders
 * themselves are Arborist's and not in the file.
 */
export function checkArborist(doc: ArboristDoc, ctx: ArboristCheckContext): ArboristCheck {
    const items = new Map<string, ArboristItem>();
    for (const pkg of doc.VSProSettings?.vegetationPackages ?? []) {
        for (const item of pkg.VegetationInfoList ?? []) if (item.VegetationItemID) items.set(item.VegetationItemID, item);
    }
    const tally = {
        trees: { layer: 'arborist', category: 'arborist-trees', objects: 0, near: 0, ok: 0, fixed: 0, findings: 0 } as MakeReadyCategory,
        bushes: { layer: 'arborist', category: 'arborist-bushes', objects: 0, near: 0, ok: 0, fixed: 0, findings: 0 } as MakeReadyCategory,
    };
    type Group = { item: ArboristItem; kind: 'far' | 'tree' | 'bush' | 'unsized'; count: number; best: number; at: [number, number, number] };
    const groups = new Map<string, Group>();
    const fault = (id: string, item: ArboristItem, kind: Group['kind'], d: number, at: [number, number, number]) => {
        const key = `${id}|${kind}`;
        const g = groups.get(key);
        if (!g) groups.set(key, { item, kind, count: 1, best: d, at });
        else {
            g.count++;
            if (d < g.best) { g.best = d; g.at = at; }
        }
    };
    let instances = 0;
    for (const cell of doc.PersistentVegetationPackage?.PersistentVegetationCellList ?? []) {
        for (const info of cell.PersistentVegetationInfoList ?? []) {
            const list = info.VegetationItemList ?? [];
            instances += list.length;
            const item = info.VegetationItemID ? items.get(info.VegetationItemID) : undefined;
            if (!item) continue;
            const type = item.VegetationType;
            const isTree = type === 'Tree';
            if (!isTree && type !== 'Plant') continue;
            const t = isTree ? tally.trees : tally.bushes;
            const name = (item.Name ?? '').trim();
            const far = isTree && name.endsWith(FAR_SUFFIX);
            const noCollider = (item.ColliderType ?? 'Disabled') === 'Disabled';
            const size = isTree ? null : sizeOf(item, ctx.sizes);
            for (const inst of list) {
                t.objects++;
                const x = (inst.Position?.x ?? 0) + ctx.origin.x, y = inst.Position?.y ?? 0, z = (inst.Position?.z ?? 0) + ctx.origin.z;
                const d = ctx.play.distanceM(x, z);
                if (!(d <= ctx.marginM)) continue;
                t.near++;
                const at: [number, number, number] = [r2(x), r2(y), r2(z)];
                if (isTree) {
                    if (far) fault(info.VegetationItemID!, item, 'far', d, at);
                    else if (noCollider) fault(info.VegetationItemID!, item, 'tree', d, at);
                    else t.ok++;
                    continue;
                }
                if (!noCollider) { t.ok++; continue; }
                if (!size) { fault(info.VegetationItemID!, item, 'unsized', d, at); continue; }
                const sx = Math.max(Math.abs(inst.Scale?.x ?? 1), Math.abs(inst.Scale?.z ?? 1)), sy = Math.abs(inst.Scale?.y ?? 1);
                if (size.heightM * sy > BUSH_COLLIDER_M && size.widthM * sx > BUSH_COLLIDER_M) fault(info.VegetationItemID!, item, 'bush', d, at);
                else t.ok++;
            }
        }
    }
    const margin = `${ctx.marginM} m`;
    const findings: MakeReadyFinding[] = [];
    for (const g of groups.values()) {
        const n = `${g.count} instance${g.count === 1 ? '' : 's'}`;
        const name = (g.item.Name ?? '?').trim();
        const [severity, category, note]: [MakeReadySeverity, string, string] =
            g.kind === 'far' ? ['error', 'arborist-trees', `${n} within ${margin} of play: a billboard-only (far) item has no collider, the ball flies through. Route them own (Arborist model) or move the far rule out`]
                : g.kind === 'tree' ? ['error', 'arborist-trees', `${n} within ${margin} of play: the tree item's ColliderType is Disabled, the ball flies through (wants GSPwood, crown GSPleaves)`]
                    : g.kind === 'bush' ? ['warn', 'arborist-bushes', `${n} taller and wider than ${BUSH_COLLIDER_M} m within ${margin} of play without a collider (ColliderType Disabled; wants GSPleaves)`]
                        : ['info', 'arborist-bushes', `${n} within ${margin} of play without a collider; the model's size is not in catalog-sizes.json, so not judged`];
        findings.push({
            layer: 'arborist', category, severity, objects: [name], note,
            unity: g.at, epsg3006: ctx.toEpsg3006 ? ctx.toEpsg3006(g.at[0], g.at[2]) : null,
        });
        if (severity !== 'info') (category === 'arborist-trees' ? tally.trees : tally.bushes).findings++;
    }
    findings.push({
        layer: 'arborist', category: 'arborist-trees', severity: 'info', objects: [], unity: null, epsg3006: null,
        note: 'Arborist\'s collider shapes and physic materials are inside its asset bundles: arboristdata.dat only says whether an item has a collider. '
            + 'Make ready reports the Arborist file only; it never changes it.',
    });
    return { instances, categories: [tally.trees, tally.bushes], findings };
}

function sizeOf(item: ArboristItem, sizes: Map<string, CatalogSize>): CatalogSize | null {
    if (item.Address && sizes.has(item.Address)) return sizes.get(item.Address)!;
    const label = (item.Name ?? '').trim().replace(/ \(far\)$/, '');
    return sizes.get(label) ?? null;
}

/** data/arborist/catalog-sizes.json (`{result: {assets: [{address, label, widthM, heightM}]}}`) by address and label; empty without it. */
export async function readCatalogSizes(file: string): Promise<Map<string, CatalogSize>> {
    const sizes = new Map<string, CatalogSize>();
    let doc: Doc;
    try {
        doc = JSON.parse(await readFile(file, 'utf8')) as Doc;
    } catch {
        return sizes;
    }
    const assets = ((doc.result as Doc | undefined)?.assets ?? doc.assets) as Doc[] | undefined;
    for (const a of Array.isArray(assets) ? assets : []) {
        const widthM = num(a.widthM), heightM = num(a.heightM);
        if (widthM === null || heightM === null) continue;
        if (typeof a.address === 'string') sizes.set(a.address, { widthM, heightM });
        if (typeof a.label === 'string') sizes.set(a.label.trim(), { widthM, heightM });
    }
    return sizes;
}

/** Unity world (x, z) -> EPSG:3006 from the inner heightmap sidecar (`square3006` and `unity.position`); null without one. */
async function innerGeoref(dir: string, slug: string): Promise<((x: number, z: number) => [number, number]) | null> {
    let newest: { name: string; t: number } | null = null;
    try {
        for (const n of await readdir(dir)) {
            if (!n.startsWith(`${slug}-inner-dem-`) || !n.endsWith('m.tif.json')) continue;
            const t = (await stat(path.join(dir, n))).mtimeMs;
            if (!newest || t > newest.t) newest = { name: n, t };
        }
        if (!newest) return null;
        const sidecar = JSON.parse(await readFile(path.join(dir, newest.name), 'utf8')) as { square3006?: number[]; unity?: { position?: { x?: number; z?: number } } };
        const sq = sidecar.square3006;
        if (!Array.isArray(sq) || sq.length < 2) return null;
        const px = sidecar.unity?.position?.x ?? 0, pz = sidecar.unity?.position?.z ?? 0;
        return (x, z) => [r2(sq[0]! + x - px), r2(sq[1]! + z - pz)];
    } catch {
        return null;
    }
}

// --- Reading Unity's report ---

type Doc = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every(x => typeof x === 'number') ? v as number[] : null);
const r2 = (v: number) => Math.round(v * 100) / 100;

function severityOf(v: unknown): MakeReadySeverity {
    return v === 'error' || v === 'warn' ? v : 'info';
}

/**
 * Unity's `make-ready.json` (every finding), else the command's own answer
 * (the first `limit` findings) when the file cannot be read.
 */
async function readUnityReport(file: string, answer: Doc | null): Promise<{
    report: string | null; errors: number; warnings: number; categories: MakeReadyCategory[]; findings: MakeReadyFinding[]; fixes: MakeReadyFix[];
}> {
    let doc: Doc | null = null;
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as Doc;
        if (parsed && typeof parsed === 'object' && (parsed.format === undefined || parsed.format === READY_FORMAT)) doc = parsed;
    } catch {
        // the answer stands in
    }
    const src = doc ?? answer ?? {};
    const findings: MakeReadyFinding[] = (Array.isArray(src.findings) ? src.findings as Doc[] : []).map(f => ({
        layer: 'unity',
        category: str(f.category) ?? '?',
        severity: severityOf(f.severity),
        objects: Array.isArray(f.objects) ? f.objects.filter((o): o is string => typeof o === 'string') : [],
        note: str(f.note),
        unity: nums(f.unity),
        epsg3006: nums(f.epsg3006),
    }));
    const fixes: MakeReadyFix[] = (Array.isArray(src.fixed) ? src.fixed as Doc[] : [])
        .filter(f => f && typeof f === 'object')
        .map(f => ({ object: str(f.object) ?? '?', what: str(f.what) ?? '' }));
    const counts = src.counts && typeof src.counts === 'object' ? src.counts as Record<string, Doc> : {};
    const categories: MakeReadyCategory[] = Object.entries(counts).map(([category, c]) => ({
        layer: 'unity', category,
        objects: num(c?.objects) ?? 0, near: num(c?.near) ?? 0, ok: num(c?.ok) ?? 0, fixed: num(c?.fixed) ?? 0, findings: num(c?.findings) ?? 0,
    }));
    // The file has every finding, so its own tally; the answer carries the totals beside its first `limit`.
    const tallied = (sev: string) => findings.filter(f => f.severity === sev).length;
    const errors = doc ? num(doc.errors) ?? tallied('error') : num(answer?.errors) ?? tallied('error');
    const warnings = doc ? num(doc.warnings) ?? tallied('warn') : num(answer?.warnings) ?? tallied('warn');
    return { report: doc ? file : null, errors, warnings, categories, findings, fixes };
}

async function readSummaryFile(file: string): Promise<MakeReadySummary | null> {
    try {
        const doc = JSON.parse(await readFile(file, 'utf8')) as Doc;
        if (doc.format !== SUMMARY_FORMAT) return null;
        const { format: _format, findings: _findings, fixes: _fixes, ...summary } = doc;
        return summary as unknown as MakeReadySummary;
    } catch {
        return null;
    }
}

function countsLine(s: { errors: number; warnings: number }): string {
    if (s.errors === 0 && s.warnings === 0) return 'nothing found';
    return `${s.errors} error${s.errors === 1 ? '' : 's'} · ${s.warnings} warning${s.warnings === 1 ? '' : 's'}`;
}

function firstLine(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e);
    return text.split('\n')[0] ?? text;
}

function snapshot(rec: JobRecord): MakeReadyJob {
    return {
        ...rec.job,
        phase: rec.phases.current,
        phases: rec.phases.snapshot(),
        step: rec.phases.step(rec.job.status, rec.job.error),
        seconds: secs((rec.t1 ?? Date.now()) - rec.t0),
    };
}
