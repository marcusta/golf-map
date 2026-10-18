// The Blender shaping loop from the command line: the same ShapingService.apply
// the web Terrain editor starts (server/services/shaping.service.ts), so the
// shaping layer files are regenerated first (`gspro.py shaping-global`), then
// the headless Blender worker re-shapes what changed and the course's open
// Unity editor refreshes those objects. A changed rock slab (the Blender op
// golfmap.cut_out) also gets the surface map exported and the vegetation
// planted again (the `vegetation` phase), so the tall grass leaves the rock.
//
//   bun run shaping -- <course> [--dry-run] [--paths] [--note <text>] [--region x0,y0,x1,y1] [--feature <id>]...
// --paths runs the Draw mode's Update paths workflow, including
// re-exporting the current path surface and transition settings first.
//
// Runs QUEUE (docs/shaping-queue.md): while another process's run is going
// this one waits, and every request that came in meanwhile is served by ONE
// next run. --note says what you changed (a bead id); --region (EPSG:3006) and
// --feature (a feature id; its box joins the region) say where, and the
// output ends with "Your part": the changed objects and warnings there, and
// the other requests of the run that changed the same area.
//
// <course> is a course id, slug or name (a unique name substring works too).
// --dry-run is the service's own: the worker and Unity plan only, nothing is
// written to Blender's FBX folder or Unity, and the surface map and planting
// are not run (the layer files in docs/gspro/<course>/shaping are still
// regenerated, as in the panel). Each phase is printed as it finishes, then
// the changed objects, the warnings and the Unity refresh steps. Exit 1 when
// the job failed. No web server needed; it reads data/app.sqlite (DB_PATH) and
// data/ (DATA_DIR) like the server, and one worker serves the machine: not
// while the panel's apply runs.
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService, courseSlug } from '../server/services/gspro-export.service';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { ShapingService, type ShapingJob, type ShapingPhase } from '../server/services/shaping.service';
import { featuresRegion, parseRegion, type Region3006 } from '../server/services/shaping-queue';

const ROOT = path.resolve(import.meta.dir, '..');
const MARK: Record<ShapingPhase['status'], string> = { done: 'ok     ', skipped: 'skipped', failed: 'FAILED ', running: '...    ', pending: '       ' };
const POLL_MS = 500;

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run shaping -- <course> [--dry-run] [--paths] [--note <text>] [--region x0,y0,x1,y1] [--feature <id>]...');
    process.exit(2);
}

const positional: string[] = [];
let dryRun = false;
let paths = false;
let note: string | undefined;
let region: Region3006 | undefined;
const featureIds: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === '--dry-run') dryRun = true;
    else if (a === '--paths') paths = true;
    else if (a === '--note') note = value();
    else if (a === '--region') region = parseRegion(value()) ?? usage('--region is x0,y0,x1,y1 in EPSG:3006');
    else if (a === '--feature') featureIds.push(value());
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else positional.push(a);
}
const ident = positional[0] ?? usage();
if (positional.length > 1) usage('name one course');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const exporter = new GsproExportService({
    db, courses, assets: new AssetsService(db, dataDir), dataDir,
    terrainEdits: new TerrainEditsService(db), pipelineDir,
});
const shaping = new ShapingService({ courses, exportSettings: exporter, dataDir, pipelineDir, dbPath });

async function resolveCourse(text: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = text.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q || courseSlug(r.name) === q);
    if (exact.length === 1) return exact[0];
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    const names = (partial.length ? partial : rows).map((r) => `  ${r.name} (${r.id})`).join('\n');
    usage(`${partial.length ? 'several' : 'no'} courses match '${text}':\n${names}`);
}

const phaseLine = (p: ShapingPhase) =>
    `${MARK[p.status]} ${p.label}${p.detail ? ` - ${p.detail}` : ''}${p.seconds !== null ? ` (${p.seconds} s)` : ''}`;

/** Poll the job to its end, printing each phase once as it finishes (and the one now running when it changes). */
async function follow(jobId: string): Promise<ShapingJob> {
    const printed = new Set<string>();
    let running = '';
    let waiting = '';
    for (;;) {
        const job = shaping.job(jobId);
        if (job.queued && job.step !== waiting) {
            waiting = job.step;
            console.log(`        ${job.step}`);
        }
        for (const p of job.phases) {
            if (p.status === 'running' && p.id !== running) {
                running = p.id;
                console.log(`${MARK.running} ${p.label}`);
            }
            if ((p.status === 'done' || p.status === 'skipped' || p.status === 'failed') && !printed.has(p.id)) {
                printed.add(p.id);
                console.log(phaseLine(p));
            }
        }
        if (job.status !== 'running') return job;
        await Bun.sleep(POLL_MS);
    }
}

function printResult(job: ShapingJob): void {
    const r = job.result;
    if (!r) return;
    console.log(`\nchanged objects (${r.changedObjects.length}):${r.changedObjects.length ? '' : ' none'}`);
    for (const name of r.changedObjects) console.log(`  ${name}`);
    if (r.removed.length) console.log(`removed FBX (${r.removed.length}): ${r.removed.join(', ')}`);
    console.log(`blend: ${r.blend}\nlayers: ${r.layersDir}\nFBX folder: ${r.fbxFolder ?? '(none)'}`);
    if (r.warnings.length) {
        console.log('\nwarnings:');
        for (const w of r.warnings) console.log(`  ${w}`);
    }
    console.log(r.unitySteps.length ? '\nUnity refresh steps:' : '\nUnity refresh steps: none (Unity was not refreshed)');
    for (const s of r.unitySteps) console.log(`  ${s.id}: ${s.status}${s.seconds !== null ? ` (${s.seconds} s)` : ''}`);
    if (r.unityError) console.log(`Unity error: ${r.unityError}`);
    if (r.vegetation.length) {
        console.log('\nvegetation planting:');
        for (const line of r.vegetation) console.log(`  ${line}`);
    }
    const s = job.slice;
    if (s && !s.whole) {
        console.log(`\nYour part (${s.places.length} place(s)):`);
        for (const name of s.changedObjects) console.log(`  ${name}`);
        if (s.changedObjects.length === 0) console.log('  nothing changed there');
        for (const w of s.warnings) console.log(`  warning: ${w}`);
    }
    for (const line of s?.overlaps ?? []) console.log(`  ${line}`);
}

try {
    const course = await resolveCourse(ident);
    console.log(`${course.name} (${course.id})${dryRun ? ' - dry run' : ''}`);
    if (featureIds.length) {
        const features = await Promise.all(featureIds.map(id => new CourseFeaturesService(db).findById(id)));
        const box = featuresRegion(features);
        if (box) region = region ? [Math.min(region[0], box[0]), Math.min(region[1], box[1]), Math.max(region[2], box[2]), Math.max(region[3], box[3])] : box;
    }
    const started = await shaping.apply(course.id, { dryRun, paths, note, region, featureIds });
    const job = await follow(started.id);
    printResult(job);
    console.log(`\n${job.status === 'succeeded' ? 'done' : 'FAILED'} in ${job.seconds} s${job.runId ? ` (run ${job.runId})` : ''}`);
    if (job.status !== 'succeeded') {
        console.error(`error: ${job.error ?? 'unknown error'}`);
        process.exitCode = 1;
    }
    // Holding the queue's lease, this process runs the next batch too (other agents' requests): finish it before exiting.
    await shaping.whenIdle();
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
