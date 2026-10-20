// Make ready: is the course fit for a GSPro build? The same MakeReadyService
// as the GSPro board's Course › Ready row (web/src/export/), so an agent or a
// script gets the same run without the server or a login.
//
//   bun run course:ready -- <course> [--fix] [--margin 40] [--json]
//
// Runs `golfmap.course.ready` in the open Unity editor that has the course
// active (every object within --margin m of the playing field has a GSPro
// collider with the right GSP* material; --fix adds what is missing and saves
// the scene), reads the course's arboristdata.dat for trees and bushes near
// play without a collider (report only: it never changes the file), and folds
// in the course check (its last report when the meshes did not change since,
// else a new one). Prints each phase, the counts per category, the first
// findings and the report files. `--json` prints the job instead.
//
// <course> is a course id or a unique name substring ("omberg").
// Exit 0: ready. 1: not ready (errors, or a part could not be checked).
// 2: the run failed, Unity could not run, or bad arguments.
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
import { CourseCheckService } from '../server/services/course-check.service';
import { MakeReadyService, type MakeReadyJob, type MakeReadyResult } from '../server/services/make-ready.service';
import type { JobPhase } from '../server/services/job-phases';

const ROOT = path.resolve(import.meta.dir, '..');
/** Findings printed (the summary file has them all). */
const PRINT_FINDINGS = 20;

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run course:ready -- <course> [--fix] [--margin 40] [--json]');
    process.exit(2);
}

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (!a.startsWith('--')) { positional.push(a); continue; }
        const name = a.slice(2);
        if (name === 'fix' || name === 'json') { flags[name] = true; continue; }
        if (name !== 'margin') usage(`unknown option --${name}`);
        const value = argv[++i];
        if (value === undefined) usage(`--${name} needs a value`);
        flags[name] = value;
    }
    return { positional, flags };
}

const MARK: Record<JobPhase['status'], string> = {
    done: 'ok     ', skipped: 'skipped', failed: 'FAILED ', running: '...    ', pending: '       ',
};

export const phaseLine = (p: JobPhase) =>
    `${MARK[p.status]} ${p.label}${p.detail ? ` - ${p.detail}` : ''}${p.seconds !== null ? ` (${p.seconds} s)` : ''}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The outcome as the CLI prints it after the phases: verdict, categories, findings, files. */
export function resultLines(r: MakeReadyResult): string[] {
    const lines: string[] = [];
    lines.push(r.ready
        ? `READY: no errors${r.warnings ? ` · ${plural(r.warnings, 'warning')}` : ''}${r.fix ? ` · ${r.fixed} fixed` : ''}`
        : `NOT READY: ${plural(r.errors, 'error')} · ${plural(r.warnings, 'warning')}${r.fix ? ` · ${r.fixed} fixed` : ''}`);
    for (const b of r.blockers) lines.push(`  ${b}`);
    if (r.categories.length) {
        lines.push('', `${'category'.padEnd(18)} ${'objects'.padStart(7)} ${'near'.padStart(6)} ${'ok'.padStart(6)} ${'fixed'.padStart(6)} ${'findings'.padStart(8)}`);
        for (const c of r.categories) {
            lines.push(`${c.category.padEnd(18)} ${String(c.objects).padStart(7)} ${String(c.near).padStart(6)} ${String(c.ok).padStart(6)} ${String(c.fixed).padStart(6)} ${String(c.findings).padStart(8)}`);
        }
    }
    lines.push('', `course check: ${r.check.skipped ? `not counted - ${r.check.skipped}`
        : `${plural(r.check.errors, 'error')} · ${plural(r.check.warnings, 'warning')} (${r.check.source === 'run' ? 'checked now' : `report of ${r.check.at}`})`}`);
    const shown = r.findings.slice(0, PRINT_FINDINGS);
    if (shown.length) {
        lines.push('', 'findings:');
        for (const f of shown) {
            const sev = f.severity === 'error' ? 'ERROR' : f.severity === 'warn' ? 'warn ' : 'info ';
            const at = f.epsg3006 ? `E ${f.epsg3006[0]!.toFixed(1)} N ${f.epsg3006[1]!.toFixed(1)}` : '';
            const objects = f.objects.length ? `[${f.objects.slice(0, 3).join(', ')}${f.objects.length > 3 ? ', ...' : ''}]` : '';
            lines.push(`  ${sev} ${f.category.padEnd(16)} ${objects} ${f.note ?? ''}  ${at}`.trimEnd());
        }
        if (r.findings.length > shown.length) lines.push(`  ... ${r.findings.length - shown.length} more in the summary file`);
    }
    if (r.fixes.length) {
        lines.push('', 'fixed:');
        for (const f of r.fixes.slice(0, PRINT_FINDINGS)) lines.push(`  ${f.object}: ${f.what}`);
        if (r.fixes.length > PRINT_FINDINGS) lines.push(`  ... ${r.fixes.length - PRINT_FINDINGS} more`);
    }
    lines.push('');
    if (r.unity.report) lines.push(`Unity report: ${r.unity.report}`);
    if (r.arborist.file) lines.push(`Arborist file: ${r.arborist.file} (report only, not changed)`);
    if (r.file) lines.push(`summary: ${r.file}`);
    return lines;
}

/** 0 ready, 1 not ready, 2 failed or Unity could not run. */
export function exitCodeOf(job: MakeReadyJob): number {
    const r = job.result;
    if (job.status === 'failed' || !r || r.unity.skipped) return 2;
    return r.ready ? 0 : 1;
}

if (import.meta.main) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (positional.length !== 1) usage(positional.length ? 'name one course' : undefined);
    const json = flags['json'] === true;
    let marginM: number | undefined;
    if (typeof flags['margin'] === 'string') {
        marginM = Number(flags['margin']);
        if (!Number.isFinite(marginM) || marginM < 0) usage('--margin must be a number of metres');
    }

    const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
    const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
    const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
    if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
    const db = createDb<Database>(dbPath);
    const courses = new CoursesService(db);
    const exporter = new GsproExportService({ db, courses, assets: new AssetsService(db, dataDir), dataDir, terrainEdits: new TerrainEditsService(db), pipelineDir });
    const shaping = new ShapingService({ courses, exportSettings: exporter, dataDir, pipelineDir, dbPath });
    const courseCheck = new CourseCheckService({ db, courses, exports: exporter, shaping });
    const ready = new MakeReadyService({ courses, exports: exporter, courseCheck, dataDir, pipelineDir });

    const resolveCourse = async (ident: string): Promise<{ id: string; name: string }> => {
        const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
        const exact = rows.filter(r => r.id.toLowerCase() === ident.toLowerCase() || r.name.toLowerCase() === ident.toLowerCase());
        if (exact.length === 1) return exact[0]!;
        const partial = rows.filter(r => r.name.toLowerCase().includes(ident.toLowerCase()));
        if (partial.length === 1) return partial[0]!;
        const names = (partial.length ? partial : rows).map(r => `  ${r.name} (${r.id})`).join('\n');
        usage(`${partial.length ? 'several' : 'no'} courses match '${ident}':\n${names}`);
    };

    /** Poll the job to its end, printing each phase as it starts and once it is over. */
    const follow = async (jobId: string): Promise<MakeReadyJob> => {
        const printed = new Set<string>();
        let running = '';
        for (;;) {
            const job = ready.job(jobId);
            for (const p of json ? [] : job.phases) {
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
    };

    let exitCode = 0;
    try {
        const course = await resolveCourse(positional[0]!);
        const started = await ready.run(course.id, { fix: flags['fix'] === true, marginM });
        if (!json) console.log(`${course.name} (${course.id}): make ready${flags['fix'] === true ? ' (fix)' : ''}`);
        const job = await follow(started.id);
        if (json) console.log(JSON.stringify(job, null, 2));
        else {
            console.log('');
            if (job.result) for (const line of resultLines(job.result)) console.log(line);
        }
        if (job.status === 'failed') console.error(`error: ${job.error ?? 'make ready failed'}`);
        exitCode = exitCodeOf(job);
    } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        exitCode = 2;
    } finally {
        await db.destroy();
    }
    process.exit(exitCode);
}
