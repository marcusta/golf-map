// Is the built GSPro course whole, as the ball meets it? The same
// CourseCheckService as the GSPro board's Check row (web/src/export/), so an
// agent or a script gets the same check without the server or a login.
//
//   bun run course:check -- <course> [--hole N] [--cell 0.5] [--buffer 100] [--margin 50] [--no-blender] [--json]
//
// Writes the play lines (`<export dir>/<prefix>-play-lines.json`: every hole's
// tee -> aim points -> green of every course on the site; the area is the
// play-surface meshes they cross + --buffer m) and the course boundary
// (`<export dir>/<prefix>-oob.json`, from the drawn oob features; the area + --margin m
// for a course without holes), runs `golfmap.course.check` in the open Unity editor that has
// the course active (read-only; ~30 s for a whole course), opens GolfMap >
// Review on the findings, then the shaping worker's `/check` when the worker
// is up and holds this course's .blend (`--no-blender` leaves it out). Prints
// each phase, one summary line per layer, the errors and warnings (type, hole,
// note, objects, EPSG:3006) and the report paths. `--json` prints the job
// instead.
//
// <course> is a course id or a unique name substring ("omberg").
// Exit 0: no errors. 1: errors found, or the check failed. 2: the Unity layer
// could not run (no editor has the course active), or bad arguments.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService } from '../server/services/gspro-export.service';
import { ShapingService } from '../server/services/shaping.service';
import {
    CourseCheckService, type CourseCheckJob, type CourseCheckLayerResult, type CourseCheckRunOptions,
} from '../server/services/course-check.service';
import type { JobPhase } from '../server/services/job-phases';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run course:check -- <course> [--hole N] [--cell 0.5] [--buffer 100] [--margin 50] [--no-blender] [--json]');
    process.exit(2);
}

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (!a.startsWith('--')) { positional.push(a); continue; }
        const name = a.slice(2);
        if (name === 'no-blender' || name === 'json') { flags[name] = true; continue; }
        if (!['hole', 'cell', 'margin', 'buffer'].includes(name)) usage(`unknown option --${name}`);
        const value = argv[++i];
        if (value === undefined) usage(`--${name} needs a value`);
        flags[name] = value;
    }
    return { positional, flags };
}

function num(flags: Record<string, string | true>, name: string): number | undefined {
    const v = flags[name];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) usage(`--${name} must be a number`);
    return n;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length !== 1) usage(positional.length ? 'name one course' : undefined);
const json = flags['json'] === true;
const opts: CourseCheckRunOptions = {
    hole: typeof flags['hole'] === 'string' ? flags['hole'] : undefined,
    cellM: num(flags, 'cell'),
    marginM: num(flags, 'margin'),
    bufferM: num(flags, 'buffer'),
    blender: flags['no-blender'] === true ? false : undefined,
};

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const exporter = new GsproExportService({ db, courses, assets: new AssetsService(db, dataDir), dataDir, terrainEdits: new TerrainEditsService(db), pipelineDir });
const shaping = new ShapingService({ courses, exportSettings: exporter, dataDir, pipelineDir, dbPath });
const check = new CourseCheckService({ db, courses, exports: exporter, shaping });

async function resolveCourse(ident: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const exact = rows.filter(r => r.id.toLowerCase() === ident.toLowerCase() || r.name.toLowerCase() === ident.toLowerCase());
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter(r => r.name.toLowerCase().includes(ident.toLowerCase()));
    if (partial.length === 1) return partial[0]!;
    const names = (partial.length ? partial : rows).map(r => `  ${r.name} (${r.id})`).join('\n');
    usage(`${partial.length ? 'several' : 'no'} courses match '${ident}':\n${names}`);
}

const MARK: Record<JobPhase['status'], string> = {
    done: 'ok     ', skipped: 'skipped', failed: 'FAILED ', running: '...    ', pending: '       ',
};

const phaseLine = (p: JobPhase) =>
    `${MARK[p.status]} ${p.label}${p.detail ? ` - ${p.detail}` : ''}${p.seconds !== null ? ` (${p.seconds} s)` : ''}`;

/** Poll the job to its end, printing each phase as it starts and once it is over. */
async function follow(jobId: string): Promise<CourseCheckJob> {
    const printed = new Set<string>();
    let running = '';
    for (;;) {
        const job = check.job(jobId);
        for (const p of job.phases) {
            if (json) break;
            if (p.status === 'running' && p.id !== running) {
                running = p.id;
                console.log(`${MARK.running} ${p.label}${p.detail ? ` - ${p.detail}` : ''}`);
            }
            if ((p.status === 'done' || p.status === 'skipped' || p.status === 'failed') && !printed.has(p.id)) {
                printed.add(p.id);
                console.log(phaseLine(p));
            }
        }
        if (job.status !== 'running') return job;
        await Bun.sleep(300);
    }
}

/** `ombergs-golfklubb-oob.json + 50 m` -> `OOB + 50 m`. */
const areaLabel = (area: string | null) => (area ?? '?').replace(/^\S+-oob\.json/, 'OOB');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `Unity: 13 errors · 49 warnings (OOB + 50 m, 30 s)`. */
function summaryLine(label: string, r: CourseCheckLayerResult): string {
    const what = r.errors === 0 && r.warnings === 0 ? 'nothing found' : `${plural(r.errors, 'error')} · ${plural(r.warnings, 'warning')}`;
    const extra = [areaLabel(r.area), r.hole ? `hole ${r.hole}` : null, r.seconds !== null ? `${Math.round(r.seconds)} s` : null].filter(Boolean);
    return `${label}: ${what} (${extra.join(', ')})`;
}

function printFindings(label: string, r: CourseCheckLayerResult): void {
    if (r.findings.length === 0) return;
    console.log(`\n${label} findings:`);
    for (const f of r.findings) {
        const at = f.epsg3006 ? `E ${f.epsg3006[0]!.toFixed(2)} N ${f.epsg3006[1]!.toFixed(2)}` : '';
        const objects = f.objects.length ? `[${f.objects.join(', ')}]` : '';
        console.log(`  ${f.severity === 'error' ? 'ERROR' : 'warn '}  ${f.type.padEnd(14)} ${(f.hole ? `hole ${f.hole}` : '').padEnd(8)} ${f.note ?? ''}  ${objects}  ${at}`.trimEnd());
    }
    const total = r.errors + r.warnings;
    if (total > r.findings.length) console.log(`  ... ${total - r.findings.length} more in the report`);
}

let exitCode = 0;
try {
    const course = await resolveCourse(positional[0]!);
    const started = await check.run(course.id, opts);
    if (!json) console.log(`${course.name} (${course.id}): course check`);
    const job = await follow(started.id);
    const r = job.result;
    if (json) {
        console.log(JSON.stringify(job, null, 2));
    } else {
        console.log('');
        if (r?.unity) console.log(summaryLine('Unity', r.unity));
        else console.log(`Unity: not run - ${r?.unitySkipped ?? job.error ?? 'unknown'}`);
        if (r?.blender) console.log(summaryLine('Blender', r.blender));
        else console.log(`Blender: not run - ${r?.blenderSkipped ?? 'see the warnings'}`);
        if (r?.unity) printFindings('Unity', r.unity);
        if (r?.blender) printFindings('Blender', r.blender);
        for (const w of r?.warnings ?? []) console.log(`\nwarning: ${w}`);
        console.log('');
        if (r?.playLines.path) console.log(`play lines: ${r.playLines.path}`);
        if (r?.boundary.path) console.log(`boundary: ${r.boundary.path}`);
        if (r?.unity) console.log(`Unity report: ${r.unity.report} (open in GolfMap > Review)`);
        if (r?.blender) console.log(`Blender report: ${r.blender.report}`);
    }
    if (job.status === 'failed') {
        console.error(`error: ${job.error ?? 'the check failed'}`);
        exitCode = 1;
    }
    if (!r?.unity) exitCode = 2;
    else if (exitCode === 0 && (r.unity.errors > 0 || (r.blender?.errors ?? 0) > 0)) exitCode = 1;
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    exitCode = 1;
} finally {
    await db.destroy();
}
process.exit(exitCode);
