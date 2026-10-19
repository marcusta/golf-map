// The cleaned photo from the command line: the same CleanedPhotoService the
// Clean panel drives, without the browser (no upload, no download).
//
//   bun run photo -- info <course>
//   bun run photo -- export <course> [<out.png>]     the photo as a PNG (default: the service's kept copy)
//   bun run photo -- import <course> <image>         any PNG/JPEG/TIFF of 8192 x 8192 px becomes the photo
//   bun run photo -- undo <course>                   back to before the last bake or import
//   bun run photo -- clean <course> [--holes 1,3-9]  clean holes on a copy; prints each hole's review image (changes nothing)
//   bun run photo -- accept <course> [<job>] [--skip 10,11 | --holes 1-9]
//                                                    the run's holes into the photo as one undo step (default: the newest run, every hole)
//
// <course> is a course id or a unique name substring ("vreta"). The first
// export or import on a site makes its cleaned photo (from the pristine
// photo, or from the old patch log's working raster when there is one). The
// image given to import is read, never changed or removed. After import,
// accept or undo, press Refresh in the Clean panel to see it on the map, and
// Update photo to put it on the Unity meshes. docs/photo-cleanup.md has the
// cleanup (clean/accept) in full.
//
// Reads data/app.sqlite (DB_PATH) and data/ (DATA_DIR) like the server. The
// server's one-change-at-a-time queue is per process: don't bake or import in
// the panel while this runs.
import '../server/env-paths';
import * as path from 'node:path';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AssetsService } from '../server/services/assets.service';
import { CoursesService } from '../server/services/courses.service';
import { CleanedPhotoService } from '../server/services/cleaned-photo.service';
import { PhotoCleanupService, type PhotoCleanupJob } from '../server/services/photo-cleanup.service';

const ROOT = path.resolve(import.meta.dir, '..');
const COMMANDS = ['info', 'export', 'import', 'undo', 'clean', 'accept'];

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run photo -- info <course>',
        '       bun run photo -- export <course> [<out.png>]',
        '       bun run photo -- import <course> <image>',
        '       bun run photo -- undo <course>',
        '       bun run photo -- clean <course> [--holes 1,3-9]',
        '       bun run photo -- accept <course> [<job>] [--skip 10,11 | --holes 1-9]',
    ].join('\n'));
    process.exit(2);
}

/** "1,3-5" -> [1, 3, 4, 5]. */
function holeList(spec: string): number[] {
    const out: number[] = [];
    for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m) usage(`not a hole list: ${spec}`);
        for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.push(n);
    }
    return out;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (!value) usage(`${name} needs a value`);
    argv.splice(i, 2);
    return value;
};
const holesFlag = flag('--holes');
const skipFlag = flag('--skip');
const [command, ident, file] = argv;
if (!command || !ident || !COMMANDS.includes(command)) usage();
if (command === 'import' && (!file || !existsSync(file))) usage(file ? `no such file: ${file}` : 'import needs an image');
if (holesFlag && skipFlag) usage('give --holes or --skip, not both');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const svc = new CleanedPhotoService({
    db, assets: new AssetsService(db, dataDir), courses: new CoursesService(db), dataDir, pipelineDir,
});
const cleanup = new PhotoCleanupService({ db, cleanedPhoto: svc, dataDir, pipelineDir });

const seconds = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const px = (n: number) => n.toLocaleString('en-US');

function holeLine(hole: PhotoCleanupJob['holes'][number]): string {
    if (hole.status === 'failed') return `  hole ${hole.hole}: FAILED ${hole.error}`;
    const warn = hole.warnings.length ? `  (${hole.warnings.join('; ')})` : '';
    return `  hole ${String(hole.hole).padStart(2)}: scope ${px(hole.scopePx).padStart(9)} px, targets ${px(hole.targetPx).padStart(8)}, `
        + `changed ${px(hole.changedPx).padStart(8)}, ${hole.seconds ?? '?'} s${warn}`;
}

try {
    const rows = await db.selectFrom('courses').select(['id', 'name', 'site_id']).execute();
    const lower = ident.toLowerCase();
    const exact = rows.filter(r => r.id.toLowerCase() === lower || r.name.toLowerCase() === lower);
    const matches = exact.length === 1 ? exact : rows.filter(r => r.name.toLowerCase().includes(lower));
    if (matches.length !== 1) {
        usage(`${matches.length ? 'several' : 'no'} courses match '${ident}':\n`
            + (matches.length ? matches : rows).map(r => `  ${r.name} (${r.id})`).join('\n'));
    }
    const course = matches[0]!;
    const t0 = Date.now();

    if (command === 'info') {
        const info = await svc.info(course.id);
        console.log(`${course.name}: ${info.exists ? `cleaned photo ${info.size} x ${info.size} px` : 'no cleaned photo yet (made on first use)'}, `
            + `${info.undoDepth} change(s) can be undone`);
        if (info.reason) console.log(`  ${info.reason}`);
    } else if (command === 'export') {
        const out = await svc.exportImage(course.id);
        const target = file ? path.resolve(file) : out.path;
        if (file) copyFileSync(out.path, target);
        console.log(`${course.name}: ${target} (${(out.bytes / 1e6).toFixed(1)} MB) in ${seconds(t0)}`);
    } else if (command === 'import') {
        // importImage deletes the file it is handed, so it gets a copy.
        const tmpPath = await svc.incomingImportPath(course.id);
        copyFileSync(file!, tmpPath);
        console.log(`${course.name}: importing ${path.resolve(file!)} (${(statSync(file!).size / 1e6).toFixed(1)} MB) ...`);
        const r = await svc.importImage(course.id, tmpPath);
        if (!r.changed) {
            console.log(`The image is the cleaned photo as it already was; nothing changed. ${seconds(t0)}`);
        } else {
            const b = r.bounds3006!;
            console.log(`Imported in ${seconds(t0)}: ${r.changedPixels.toLocaleString('en-US')} pixels changed, within `
                + `${(b.east - b.west).toFixed(0)} x ${(b.north - b.south).toFixed(0)} m. ${r.undoDepth} change(s) can be undone.`);
        }
    } else if (command === 'clean') {
        const started = await cleanup.start(course.id, holesFlag ? holeList(holesFlag) : undefined);
        const jobDir = path.join(dataDir, 'sources', course.site_id!, 'photo-cleanup', started.id);
        console.log(`${course.name}: cleaning hole ${started.holes.map(h => h.hole).join(', ')} on a copy of the photo (job ${started.id})`);
        const printed = new Set<number>();
        for (;;) {
            const job = await cleanup.job(course.id, started.id);
            for (const h of job.holes) {
                if ((h.status === 'done' || h.status === 'failed') && !printed.has(h.hole)) {
                    printed.add(h.hole);
                    console.log(holeLine(h));
                    if (h.status === 'done') console.log(`           ${path.join(jobDir, `h${h.hole}`, 'review.png')}`);
                }
            }
            if (job.status !== 'running') {
                if (job.status === 'failed') throw new Error(job.error ?? 'the cleanup failed');
                break;
            }
            await Bun.sleep(1000);
        }
        console.log(`Done in ${seconds(t0)}. Nothing is changed yet: look at each review.png (before | after), then`);
        console.log(`  bun run photo -- accept ${ident} ${started.id} [--skip <holes with a serious defect>]`);
    } else if (command === 'accept') {
        const job = file ? await cleanup.job(course.id, file) : await cleanup.current(course.id);
        if (!job) usage(`${course.name} has no cleanup run: run clean first`);
        const done = job.holes.filter(h => h.status === 'done').map(h => h.hole);
        const skip = new Set(skipFlag ? holeList(skipFlag) : []);
        const holes = holesFlag ? holeList(holesFlag) : done.filter(n => !skip.has(n));
        console.log(`${course.name}: applying hole ${holes.join(', ')} of job ${job.id} ...`);
        const r = await cleanup.apply(course.id, job.id, holes);
        const b = r.import.bounds3006;
        console.log(r.import.changed
            ? `Applied in ${seconds(t0)}: ${px(r.import.changedPixels)} pixels changed${b ? `, within ${(b.east - b.west).toFixed(0)} x ${(b.north - b.south).toFixed(0)} m` : ''}. `
                + `${r.import.undoDepth} change(s) can be undone. Next: Update photo (or bun run gspro:update -- ${ident} photo).`
            : 'Nothing changed: those holes changed no pixels.');
    } else {
        const r = await svc.undo(course.id);
        console.log(`${course.name}: undone in ${seconds(t0)}; ${r.undoDepth} change(s) can still be undone.`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
