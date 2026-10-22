// Is the built GSPro course whole, as the ball meets it? (builder only)
//
// One implementation behind the GSPro board's Check row (web/src/export/) and
// `bun run course:check` (scripts/course-check.ts). The checks themselves live
// where the meshes are:
//
//   - Unity: `golfmap.course.check` (unity/Editor/GolfMap/GolfMapCourseCheck.cs)
//     reads the open scene's course meshes through their colliders and writes
//     `<export dir>/course-check.json` (golfmap-course-check-v1);
//     `golfmap.review.load path=<report>` then opens GolfMap > Review on it.
//   - Blender: the shaping worker's `POST /check` (blender/tools/course_check.py)
//     on the shaped course as the worker holds it, written to
//     `<export dir>/course-check-blender.json` (`layer: "blender"`).
//
// This service writes the area those checks take - the play lines
// (`<export dir>/<prefix>-play-lines.json`, golfmap-play-lines-v1: every hole's
// tee -> aim points -> green of every course on the site; the checks look at the
// play-surface meshes those lines cross and `bufferM` (100 m) round them), and the
// course boundary for a course without holes (`<export dir>/<prefix>-oob.json`,
// golfmap-oob-v1, from the drawn `oob` features, + `marginM`) - runs both layers as one JOB with phases (polled, like the
// GSPro board's update jobs — `job-phases.ts`), and reads the last reports
// back for the board's status line.
//
//   - `writeBoundary(courseId)`  the oob file; none without an oob feature (the
//                                check then runs over every course mesh, `all`).
//   - `run(courseId, opts)`      the job: boundary → Unity check → Review
//                                window → Blender check. No Unity editor for the
//                                course is a SKIPPED Unity phase (`unitySkipped`
//                                says why; the CLI exits 2). The Blender layer
//                                runs only when the worker is up, idle and holds
//                                this course's .blend — else skipped with why.
//   - `status(courseId)`         the last reports' summaries, read from disk,
//                                and whether the meshes changed since.
//
// One check per course at a time (409 while one runs). The commands are
// read-only: the Unity check touches nothing in the scene, and the Review
// window is the only thing it opens.
import * as path from 'node:path';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { CoursesService } from './courses.service';
import { courseSlug, ensureDir, type GsproExportService } from './gspro-export.service';
import type { ShapingService } from './shaping.service';
import { readRecord } from './gspro-sync.service';
import { flattenRing, type CurveType, type PathRing } from './geo';
import { JobPhases, secs, type JobPhase } from './job-phases';
import { defaultUnityBridge, editorForExportDir, type UnityBridge } from './unity-bridge';

/** How far round the play-surface meshes the play lines cross is checked (m). */
export const PLAY_BUFFER_M = 100;
/** The boundary file's format (what `golfmap.course.check` and course_check.py read). */
export const OOB_FORMAT = 'golfmap-oob-v1';
/** The report both layers write. */
export const CHECK_FORMAT = 'golfmap-course-check-v1';
/** Unity's report, in the export folder (GolfMapCourseCheck.ReportFile). */
export const UNITY_REPORT = 'course-check.json';
/** The Blender layer's report, in the export folder too (passed to the worker as `out`). */
export const BLENDER_REPORT = 'course-check-blender.json';
/** How far the boundary's B-spline is flattened (m). */
const OOB_TOLERANCE_M = 0.2;
/** How long the Unity check may take (the whole Omberg course takes ~30 s). */
const UNITY_CHECK_SEC = 600;
/** Findings a job result carries per layer (the report file has them all). */
const RESULT_FINDINGS = 200;

export type CourseCheckLayer = 'unity' | 'blender';

/** One kind of finding in a report: how many, how bad. */
export interface CourseCheckCount {
    type: string;
    findings: number;
    severity: string;
    /** Probe points / cells behind them (Unity counts them; null when the report does not). */
    points: number | null;
}

/** One finding as the report gives it. */
export interface CourseCheckFinding {
    type: string;
    /** `error` | `warn` | `info`. */
    severity: string;
    hole: string | null;
    note: string | null;
    objects: string[];
    /** Unity world position (x, y, z); null when the report has none. */
    unity: number[] | null;
    /** EPSG:3006 easting, northing; null when the report has none. */
    epsg3006: number[] | null;
}

/** A layer's last report, as the board and the CLI show it. */
export interface CourseCheckSummary {
    layer: CourseCheckLayer;
    /** The report file. */
    report: string;
    /** ISO: when it was made (the report's `generated`, else the file's mtime). */
    at: string;
    ok: boolean;
    errors: number;
    warnings: number;
    /** What was checked: `ombergs-golfklubb-oob.json + 50 m`, `no boundary: every course mesh`. */
    area: string | null;
    /** Only this hole's meshes, when the check was run for one. */
    hole: string | null;
    meshes: number | null;
    /** How long the check took (s). */
    seconds: number | null;
    counts: CourseCheckCount[];
}

/** A layer's result in a job: its summary plus the errors and warnings. */
export interface CourseCheckLayerResult extends CourseCheckSummary {
    /** The error and warning findings, worst first, at most 200 (all of them are in `report`). */
    findings: CourseCheckFinding[];
}

export interface CourseCheckBoundary {
    /** The written file; null when the course has no oob feature (the check runs with `all`). */
    path: string | null;
    rings: number;
    points: number;
}

export interface CourseCheckPlayLines {
    /** The written file; null when it could not be written (the check then falls back to the boundary). */
    path: string | null;
    /** The pipeline's report (courses, holes, lines) or why it failed. */
    note: string;
}

export interface CourseCheckResult {
    boundary: CourseCheckBoundary;
    /** The area the checks took first. */
    playLines: CourseCheckPlayLines;
    unity: CourseCheckLayerResult | null;
    /** Why the Unity layer did not run (no editor has the course active); null when it ran. */
    unitySkipped: string | null;
    blender: CourseCheckLayerResult | null;
    /** Why the Blender layer did not run (worker off, busy, another course, `blender: false`); null when it ran. */
    blenderSkipped: string | null;
    /** What went wrong on the way without failing the job (the Review window, the Blender check). */
    warnings: string[];
}

export type CourseCheckJobStatus = 'running' | 'succeeded' | 'failed';

export interface CourseCheckJob {
    id: string;
    courseId: string;
    status: CourseCheckJobStatus;
    /** The running phase (the failed one once failed); null before the first and once done. */
    phase: string | null;
    /** One line: what it is doing now, or did last. */
    step: string;
    phases: JobPhase[];
    startedAt: string;
    finishedAt: string | null;
    seconds: number;
    /** Null until the job is over (and when it failed before the Unity layer). */
    result: CourseCheckResult | null;
    error: string | null;
}

export interface CourseCheckRunOptions {
    /** Only this hole's meshes (and 40 m round them). */
    hole?: number | string;
    /** The ray grid's cell (m; Unity's default 0.5). */
    cellM?: number;
    /** How far beyond the boundary is checked (m; default 50) - only without play lines. */
    marginM?: number;
    /** How far round the play-surface meshes the play lines cross is checked (m; default 100). */
    bufferM?: number;
    /** False: never the Blender layer. Default: when the worker holds this course. */
    blender?: boolean;
}

export interface CourseCheckStatus {
    /** The boundary file the check takes, when it is there. */
    boundary: string | null;
    unity: CourseCheckSummary | null;
    blender: CourseCheckSummary | null;
    /**
     * ISO: when the course meshes last changed as far as the board knows — the
     * end of the last Meshes update (`gspro-sync.json`) or the newest OPCD
     * .blend in the export folder, whichever is later. Null when neither is known.
     */
    meshesChangedAt: string | null;
    /** The meshes changed after the Unity report was made (always false with no report). */
    meshesChangedSince: boolean;
    /** The running check, else the last one this process ran; null with none. */
    job: CourseCheckJob | null;
}

export interface CourseCheckDeps {
    db: Kysely<Database>;
    courses: Pick<CoursesService, 'get'>;
    exports: Pick<GsproExportService, 'settings'> & Partial<Pick<GsproExportService, 'exportPlayLines'>>;
    /** The shaping worker: its status, and the `/check` job on it. */
    shaping: Pick<ShapingService, 'workerStatus' | 'workerRun' | 'toWorker' | 'fromWorker'>;
    unityBridge?: UnityBridge;
    /** How long the Unity check may take (s; default 600). */
    unitySec?: number;
    /** How long the Blender check may take (ms; default 10 min). */
    blenderMs?: number;
}

interface JobRecord {
    job: Omit<CourseCheckJob, 'phase' | 'phases' | 'step' | 'seconds'>;
    phases: JobPhases;
    t0: number;
    t1: number | null;
    done: Promise<void>;
}

const PHASES: ReadonlyArray<readonly [string, string]> = [
    ['boundary', 'Play lines and boundary'],
    ['unity', 'Unity check'],
    ['review', 'Review window'],
    ['blender', 'Blender check'],
];

export class CourseCheckService {
    private readonly db: Kysely<Database>;
    private readonly courses: Pick<CoursesService, 'get'>;
    private readonly exports: CourseCheckDeps['exports'];
    private readonly shaping: CourseCheckDeps['shaping'];
    private readonly unityBridge: UnityBridge;
    private readonly unitySec: number;
    private readonly blenderMs: number;
    private readonly jobs = new Map<string, JobRecord>();

    constructor(deps: CourseCheckDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.exports = deps.exports;
        this.shaping = deps.shaping;
        this.unityBridge = deps.unityBridge ?? defaultUnityBridge();
        this.unitySec = deps.unitySec ?? UNITY_CHECK_SEC;
        this.blenderMs = deps.blenderMs ?? 10 * 60_000;
    }

    /** The course's export folder and the area files' paths in it (`<prefix>-oob.json`, `<prefix>-play-lines.json`). */
    private async where(courseId: string): Promise<{ dir: string; boundary: string; playLines: string }> {
        const course = await this.courses.get(courseId);
        const { dir } = await this.exports.settings(courseId);
        const prefix = courseSlug(course.name);
        return { dir, boundary: path.join(dir, `${prefix}-oob.json`), playLines: path.join(dir, `${prefix}-play-lines.json`) };
    }

    /** `<export dir>/<prefix>-play-lines.json` for every course on the course's site (`gspro.py play-lines`). */
    async writePlayLines(courseId: string): Promise<CourseCheckPlayLines> {
        const { dir, playLines } = await this.where(courseId);
        if (!this.exports.exportPlayLines) return { path: null, note: 'no pipeline to write the play lines' };
        await ensureDir(dir);
        try {
            const res = await this.exports.exportPlayLines(courseId, playLines);
            return { path: res.path, note: res.report.filter(l => l.trim() && !l.startsWith('Wrote ')).map(l => l.trim()).join('; ') || 'written' };
        } catch (e) {
            return { path: null, note: `not written: ${firstLine(e)}` };
        }
    }

    /**
     * `<export dir>/<prefix>-oob.json` from the course's `oob` features: each
     * ring flattened at 0.2 m (its B-spline or Bézier as drawn), rounded to
     * the centimetre. No oob feature: nothing is written, and `path` is null.
     */
    async writeBoundary(courseId: string): Promise<CourseCheckBoundary> {
        const { dir, boundary } = await this.where(courseId);
        const rows = await this.db.selectFrom('course_features').select(['geometry_json'])
            .where('course_id', '=', courseId).where('type', '=', 'oob').orderBy('sort_order').execute();
        const rings: Array<Array<[number, number]>> = [];
        for (const row of rows) {
            let g: { curveType?: CurveType; rings?: PathRing[] };
            try {
                g = JSON.parse(row.geometry_json);
            } catch {
                continue;
            }
            for (const ring of g.rings ?? []) {
                const pts = flattenRing(ring, OOB_TOLERANCE_M, g.curveType)
                    .map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as [number, number]);
                if (pts.length >= 3) rings.push(pts);
            }
        }
        if (rings.length === 0) return { path: null, rings: 0, points: 0 };
        await ensureDir(dir);
        await writeFile(boundary, JSON.stringify({ format: OOB_FORMAT, crs: 'EPSG:3006', rings }));
        return { path: boundary, rings: rings.length, points: rings.reduce((n, r) => n + r.length, 0) };
    }

    /**
     * Start a check and return its job at once (`running`); poll `job(id)` or
     * `status`. 409 while a check of this course is running, 404 for an
     * unknown course.
     */
    async run(courseId: string, opts: CourseCheckRunOptions = {}): Promise<CourseCheckJob> {
        await this.courses.get(courseId);
        const running = [...this.jobs.values()].find(r => r.job.courseId === courseId && r.job.status === 'running');
        if (running) throw new ConflictError(`A course check is already running for this course (${running.phases.step('running', null)})`);
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
        rec.done = this.perform(rec, opts);
        this.jobs.set(rec.job.id, rec);
        return snapshot(rec);
    }

    /** A job by id; 404 when this process never ran it. */
    job(jobId: string): CourseCheckJob {
        const rec = this.jobs.get(jobId);
        if (!rec) throw new NotFoundError(`No course check job ${jobId} (the server may have restarted)`);
        return snapshot(rec);
    }

    /** Resolves when the course's check (if any) is over (tests, the CLI). */
    async whenIdle(courseId: string): Promise<void> {
        for (const rec of this.jobs.values()) if (rec.job.courseId === courseId) await rec.done;
    }

    /** The last reports on disk, whether the meshes changed since, and the running or last job. */
    async status(courseId: string): Promise<CourseCheckStatus> {
        const { dir, boundary } = await this.where(courseId);
        const [unity, blender, meshesChangedAt, hasBoundary] = await Promise.all([
            readSummary(path.join(dir, UNITY_REPORT), 'unity'),
            readSummary(path.join(dir, BLENDER_REPORT), 'blender'),
            meshesChanged(dir),
            stat(boundary).then(() => true, () => false),
        ]);
        const rec = [...this.jobs.values()].filter(r => r.job.courseId === courseId).sort((a, b) => b.t0 - a.t0)[0];
        return {
            boundary: hasBoundary ? boundary : null,
            unity: unity?.summary ?? null,
            blender: blender?.summary ?? null,
            meshesChangedAt,
            meshesChangedSince: !!unity && meshesChangedAt !== null && meshesChangedAt > unity.summary.at,
            job: rec ? snapshot(rec) : null,
        };
    }

    // --- The job ---

    private async perform(rec: JobRecord, opts: CourseCheckRunOptions): Promise<void> {
        const p = rec.phases;
        const result: CourseCheckResult = {
            boundary: { path: null, rings: 0, points: 0 }, playLines: { path: null, note: '' }, unity: null, unitySkipped: null, blender: null, blenderSkipped: null, warnings: [],
        };
        const marginM = opts.marginM ?? 50;
        const bufferM = opts.bufferM ?? PLAY_BUFFER_M;
        const area = (file: string | null) => (result.playLines.path ? `play-surface meshes under the play lines + ${bufferM} m`
            : file ? `${path.basename(file)} + ${marginM} m` : 'every course mesh (no play lines, no oob drawn)');
        try {
            const { dir } = await this.where(rec.job.courseId);

            p.begin('boundary', 'the holes\' play lines and the course\'s oob features');
            result.playLines = await this.writePlayLines(rec.job.courseId);
            result.boundary = await this.writeBoundary(rec.job.courseId);
            p.end('boundary', 'done', [
                result.playLines.path ? `${path.basename(result.playLines.path)} (${result.playLines.note})` : `no play lines (${result.playLines.note})`,
                result.boundary.path
                    ? `${path.basename(result.boundary.path)} (${result.boundary.rings} ring${result.boundary.rings === 1 ? '' : 's'}, ${result.boundary.points} points)`
                    : 'no oob drawn',
            ].join(' · '));

            p.begin('unity', 'finding the course\'s Unity editor');
            const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
            if (!editor) {
                result.unitySkipped = `Not in Unity: no open Unity editor imports from ${dir}`
                    + (seen.length ? ` (${seen.join('; ')})` : ' (none is open)');
                p.skip('unity', result.unitySkipped);
                p.skip('review', 'no Unity check to show');
                p.current = null;
            } else {
                const args: Record<string, unknown> = { marginM, bufferM };
                if (result.playLines.path) args.playLines = result.playLines.path;
                if (result.boundary.path) args.boundary = result.boundary.path;
                if (!result.playLines.path && !result.boundary.path) args.all = true;
                if (opts.cellM !== undefined) args.cell = opts.cellM;
                if (opts.hole !== undefined && String(opts.hole).trim()) args.hole = String(opts.hole).trim();
                p.note(`golfmap.course.check in ${editor.projectName} (${area(result.boundary.path)})`);
                const answer = await editor.run('golfmap.course.check', args, this.unitySec) as Record<string, unknown> | null;
                const report = typeof answer?.report === 'string' ? answer.report : path.join(dir, UNITY_REPORT);
                result.unity = await readLayer(report, 'unity', answer);
                p.end('unity', 'done', `${countsLine(result.unity)} in ${editor.projectName}`);

                p.begin('review', `golfmap.review.load in ${editor.projectName}`);
                try {
                    await editor.run('golfmap.review.load', { path: report }, 60);
                    p.end('review', 'done', `GolfMap > Review shows ${path.basename(report)}`);
                } catch (e) {
                    const why = firstLine(e);
                    result.warnings.push(`The Review window did not open: ${why}`);
                    p.end('review', 'failed', why);
                }
            }

            await this.blenderLayer(rec, dir, opts, marginM, result);
            rec.job.status = 'succeeded';
            p.current = null;
        } catch (e) {
            rec.job.status = 'failed';
            rec.job.error = e instanceof Error ? e.message : String(e);
            p.failCurrent(firstLine(e));
            p.skipPending('the check failed');
        } finally {
            rec.job.result = result;
            rec.t1 = Date.now();
            rec.job.finishedAt = new Date().toISOString();
        }
    }

    /**
     * The worker's `/check`, when it is up, idle and holds this course's
     * .blend (its `blend` or `conformed` in the export folder). Anything else
     * is a skip with a reason; a check that fails is a warning, not the job's
     * failure — the Unity layer, which GSPro plays, has its answer by then.
     */
    private async blenderLayer(rec: JobRecord, dir: string, opts: CourseCheckRunOptions, marginM: number, result: CourseCheckResult): Promise<void> {
        const p = rec.phases;
        const skip = (why: string) => {
            result.blenderSkipped = why;
            p.skip('blender', why);
        };
        if (opts.blender === false) return skip('not asked for (--no-blender)');
        if (opts.hole !== undefined && String(opts.hole).trim()) return skip('the Blender check has no per-hole mode');
        const worker = await this.shaping.workerStatus();
        if (!worker.reachable) return skip(`the shaping worker is not running (${worker.url})`);
        const held = worker.conformed ?? worker.blend;
        if (!held || !inDir(held, dir)) {
            return skip(`the shaping worker holds ${held ? path.basename(held) : 'nothing'}, not this course's .blend`);
        }
        if (worker.state === 'busy' || worker.state === 'starting' || worker.job?.state === 'running') {
            return skip(`the shaping worker is busy (${worker.job?.kind ?? worker.state}${worker.phase ? `: ${worker.phase}` : ''})`);
        }
        const out = path.join(dir, BLENDER_REPORT);
        p.begin('blender', `/check on ${path.basename(held)}`);
        try {
            // Paths as the worker opens them (another machine: GOLFMAP_SHAPING_PATH_MAP); its report comes back inline too.
            const body: Record<string, unknown> = { marginM, bufferM: opts.bufferM ?? PLAY_BUFFER_M, out: this.shaping.toWorker(out) };
            if (result.playLines.path) body.playLines = this.shaping.toWorker(result.playLines.path);
            if (result.boundary.path) body.boundary = this.shaping.toWorker(result.boundary.path);
            const answer = await this.shaping.workerRun('/check', body, {
                timeoutMs: this.blenderMs,
                onPhase: phase => p.note(`/check on ${path.basename(held)}${phase ? `: ${phase}` : ''}`),
            }) as Record<string, unknown> | null;
            const report = typeof answer?.report === 'string' ? this.shaping.fromWorker(answer.report) : out;
            result.blender = await readLayer(report, 'blender', answer);
            p.end('blender', 'done', countsLine(result.blender));
        } catch (e) {
            const why = firstLine(e);
            result.warnings.push(`The Blender check failed: ${why}`);
            p.end('blender', 'failed', why);
        }
    }
}

// --- Reading the reports ---

/** `13 errors · 49 warnings` / `no errors · 2 warnings` / `✓`. */
function countsLine(s: Pick<CourseCheckSummary, 'errors' | 'warnings'>): string {
    if (s.errors === 0 && s.warnings === 0) return 'nothing found';
    return `${s.errors} error${s.errors === 1 ? '' : 's'} · ${s.warnings} warning${s.warnings === 1 ? '' : 's'}`;
}

type Doc = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every(x => typeof x === 'number') ? v as number[] : null);

/** A report's `seconds`: a number, or the laps (`{objects, seams, total}`) — the total, else the last lap. */
function seconds(v: unknown): number | null {
    if (typeof v === 'number') return v;
    if (!v || typeof v !== 'object') return null;
    const laps = v as Record<string, unknown>;
    if (typeof laps.total === 'number') return laps.total;
    const values = Object.values(laps).filter((x): x is number => typeof x === 'number');
    return values.length ? Math.max(...values) : null;
}

function summaryOf(doc: Doc, layer: CourseCheckLayer, report: string, mtime: Date): CourseCheckSummary {
    const counts = doc.counts && typeof doc.counts === 'object' ? doc.counts as Record<string, Doc> : {};
    const hole = doc.hole;
    return {
        layer,
        report,
        at: str(doc.generated) ?? mtime.toISOString(),
        ok: doc.ok === true || (num(doc.errors) ?? 0) === 0,
        errors: num(doc.errors) ?? 0,
        warnings: num(doc.warnings) ?? 0,
        area: str(doc.area),
        hole: typeof hole === 'string' && hole ? hole : typeof hole === 'number' ? String(hole) : null,
        meshes: num(doc.meshes),
        seconds: seconds(doc.seconds),
        counts: Object.entries(counts).map(([type, c]) => ({
            type, findings: num(c?.findings) ?? 0, severity: str(c?.severity) ?? 'info', points: num(c?.points),
        })),
    };
}

function findingOf(f: Doc): CourseCheckFinding {
    const hole = f.hole;
    return {
        type: str(f.type) ?? '?',
        severity: str(f.severity) ?? 'info',
        hole: typeof hole === 'string' && hole ? hole : typeof hole === 'number' ? String(hole) : null,
        note: str(f.note),
        objects: Array.isArray(f.objects) ? f.objects.filter((o): o is string => typeof o === 'string') : [],
        unity: nums(f.unity),
        epsg3006: nums(f.epsg3006),
    };
}

/** A report file's summary (and the whole document); null when it is not there or not a course check. */
async function readSummary(file: string, layer: CourseCheckLayer): Promise<{ summary: CourseCheckSummary; doc: Doc } | null> {
    try {
        const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
        const doc = JSON.parse(text) as Doc;
        if (!doc || typeof doc !== 'object' || (doc.format !== undefined && doc.format !== CHECK_FORMAT)) return null;
        return { summary: summaryOf(doc, layer, file, st.mtime), doc };
    } catch {
        return null;
    }
}

/**
 * A layer's result: its report file (it has every finding), else the
 * command's own answer (the first `limit` findings) when the file cannot be
 * read. The errors and warnings, worst first.
 */
async function readLayer(report: string, layer: CourseCheckLayer, answer: Doc | null): Promise<CourseCheckLayerResult> {
    const read = await readSummary(report, layer);
    const doc = read?.doc ?? answer ?? {};
    const summary = read?.summary ?? summaryOf(doc, layer, report, new Date());
    const rank = (s: string) => (s === 'error' ? 0 : s === 'warn' ? 1 : 2);
    const findings = (Array.isArray(doc.findings) ? doc.findings as Doc[] : [])
        .map(findingOf).filter(f => f.severity === 'error' || f.severity === 'warn')
        .sort((a, b) => rank(a.severity) - rank(b.severity))
        .slice(0, RESULT_FINDINGS);
    return { ...summary, findings };
}

/**
 * When the course meshes last changed as far as the export folder says: the
 * end of the last Meshes update in `gspro-sync.json`, or the newest source
 * .blend (a new OPCD build), whichever is later.
 */
async function meshesChanged(dir: string): Promise<string | null> {
    const entry = (await readRecord(dir)).targets.meshes;
    let newest = entry ? Date.parse(entry.lastRun) + (entry.seconds ?? 0) * 1000 : NaN;
    try {
        for (const name of await readdir(dir)) {
            const lower = name.toLowerCase();
            if (!lower.endsWith('.blend') || lower.endsWith('.conformed.blend')) continue;
            const m = (await stat(path.join(dir, name))).mtimeMs;
            if (!(newest >= m)) newest = m;
        }
    } catch {
        // no export folder yet
    }
    return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The file lies in `dir` itself. */
function inDir(file: string, dir: string): boolean {
    return norm(path.dirname(file)) === norm(dir);
}

function firstLine(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e);
    return text.split('\n')[0] ?? text;
}

function snapshot(rec: JobRecord): CourseCheckJob {
    return {
        ...rec.job,
        phase: rec.phases.current,
        phases: rec.phases.snapshot(),
        step: rec.phases.step(rec.job.status, rec.job.error),
        seconds: secs((rec.t1 ?? Date.now()) - rec.t0),
    };
}
