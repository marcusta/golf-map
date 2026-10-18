// GSPro/OPCD exports from the command line: the same GsproExportService the
// web Export panel drives, and the same GsproSyncService the web's GSPro
// status board drives, so the files, names and folders are identical, but
// runnable by an agent or a script without the server or a login.
//
//   bun run gspro:export -- courses
//   bun run gspro:status -- <course>                  (= `status <course>`)
//   bun run gspro:update -- <course> <target|stale>   (= `update <course> …`)
//   bun run gspro:export -- <course> <export>... [options]
//
// `status` prints the course's folders, terrains, ortho sources and files,
// then the STATUS BOARD: one row per target (Terrain, Photo, Course shapes,
// Meshes, Vegetation, Trees, Buildings, Props, Creeks, Waterfalls, Course file) with when
// it was last updated, what has changed since, whether it is stale, why it
// cannot run, the row's own note (Props: the hand-placed props an update keeps)
// and the manual step that follows it — plus the open Unity editors and the
// Blender shaping worker.
//
// `update <course> <target>` runs that target's WHOLE chain (both terrains,
// the files on the way, the push into the open Unity editor when one has the
// course active), printing each phase as it goes; `update <course> stale` does
// that for every stale, unblocked target in board order. Exit 1 on failure.
//
// <course> is a course id or a unique name substring ("vreta"). Each <export>
// is `kind` or `kind:terrain`:
//
//   svg                      course features as the OPCD SVG (inner)
//   ortho                    the active orthophoto vintage (or --source <file>) as the 8192 px texture
//   outer-ortho              --collection <orto-l2-YYYY> for the outer square
//   dem | hillshade | trees | buildings | zones  [:inner | :outer]   no terrain = both, inner first
//   unity-terrain[:inner|:outer]  the heightmap export, then into the open Unity editor's terrain (golfmap.terrain.update)
//   unity-sculpt[:inner|:outer]   what was sculpted in Unity since, back as that terrain's sculpt layer (golfmap.terrain.capture)
//   unity-ortho                   the inner orthophoto (--source, e.g. the .cleaned.tif), then its -meshes file onto the Unity course meshes (golfmap.orthos.apply)
//   creeks                   the creeks as R.A.M. splines at the water surface (inner; needs the inner dem)
//   waterfalls               the falls' lips, water levels above and below and flow (inner; levels not set read from the lidar)
//   gkd                      GreenKeeper's <scene>.GKD into the course's GSPro folder (--course-dir <folder>
//                            sets it, like the panel does); needs the inner dem exported first
//   arborist                 the Arborist file (arboristdata.dat in the course's GSPro folder): the lower vegetation
//                            from the inner zones export, then the trees out of the open Unity editor's scene
//                            (golfmap.trees.dump; skipped when it is not open). What the web's Update vegetation
//                            runs after the planting. --arborist-out <folder> writes there instead (a trial run)
//
// Exports run one after another, in the order given; the first failure stops
// the rest. Order matters where the service needs an earlier file: trees,
// buildings and zones read the terrain's heightmap sidecar, so export `dem`
// first on a new course. The output folder is the course's GSPro export folder
// (set in the panel, or --dir here, which saves it like the panel does).
//
// Ortho options (ortho, outer-ortho): --darken <x>, --tint, --tint-opacity <0..1>,
// --forest-floor, --floor-color <#rrggbb>, --floor-mix <0..1>, --remove-buildings.
//
// An export whose inputs have not changed since the file in the folder was
// written is skipped, and the report says `unchanged: <file>`
// (server/services/export-fingerprint.ts); --force renders anyway. It works
// for `update` too.
//
// Reads data/app.sqlite (DB_PATH) and data/ (DATA_DIR) like the server. The
// server's one-export-per-course lock is per process: don't start the same
// course's export here and in the panel at once.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import {
    GsproExportService, venvPython, type GsproExportKind, type GsproExportRequest, type TerrainKind,
} from '../server/services/gspro-export.service';
import { ShapingService } from '../server/services/shaping.service';
import { MapBuildService } from '../server/services/map-build.service';
import { GsproSyncService, type GsproSyncJob, type GsproTargetStatus } from '../server/services/gspro-sync.service';
import { GSPRO_TARGET_IDS, isGsproTargetId, gsproTarget, type GsproTargetId } from '../shared/gspro-targets';
import type { JobPhase } from '../server/services/job-phases';

const ROOT = path.resolve(import.meta.dir, '..');
const KINDS: GsproExportKind[] = ['svg', 'ortho', 'outer-ortho', 'dem', 'unity-terrain', 'unity-sculpt', 'unity-ortho', 'hillshade', 'trees', 'buildings', 'zones', 'creeks', 'waterfalls', 'gkd', 'arborist'];
const TERRAIN_KINDS = new Set<GsproExportKind>(['dem', 'unity-terrain', 'unity-sculpt', 'hillshade', 'trees', 'buildings', 'zones']);

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run gspro:export -- courses',
        '       bun run gspro:status -- <course>',
        '       bun run gspro:update -- <course> <target|stale> [--force]',
        '       bun run gspro:export -- <course> <kind[:inner|:outer]>... [--dir <folder>] [--course-dir <folder>] [--source <file>] [--collection <id>]',
        '                                 [--darken <x>] [--tint] [--tint-opacity <x>] [--forest-floor] [--floor-color <#hex>]',
        '                                 [--floor-mix <x>] [--remove-buildings] [--arborist-out <folder>] [--force]',
        `kinds: ${KINDS.join(', ')}`,
        `targets: ${GSPRO_TARGET_IDS.join(', ')}, stale`,
    ].join('\n'));
    process.exit(2);
}

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { positional.push(a); continue; }
        const name = a.slice(2);
        const boolean = ['tint', 'forest-floor', 'remove-buildings', 'force'].includes(name);
        if (boolean) flags[name] = true;
        else {
            const value = argv[++i];
            if (value === undefined) usage(`--${name} needs a value`);
            flags[name] = value;
        }
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

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const arboristOut = process.argv.indexOf('--arborist-out');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const assets = new AssetsService(db, dataDir);
const terrainEdits = new TerrainEditsService(db);
const exporter = new GsproExportService({
    db, courses, assets, dataDir, terrainEdits, pipelineDir,
    arboristOutDir: arboristOut === -1 ? undefined : path.resolve(process.argv[arboristOut + 1] ?? usage('--arborist-out needs a folder')),
});
/** The status board's own service graph: the shaping worker for `meshes`, the map build for the terrain bake. */
const shaping = new ShapingService({ courses, exportSettings: exporter, dataDir, pipelineDir, dbPath });
const mapBuild = new MapBuildService({
    db, assets, dataDir, pipelineDir, terrainEdits,
    // MapBuildService's own default is the POSIX venv path; this box is Windows.
    python: process.env.MAP_PIPELINE_PYTHON ?? venvPython(pipelineDir),
});
const sync = new GsproSyncService({ db, courses, exports: exporter, shaping, mapBuild, dataDir, terrainEdits });

async function resolveCourse(ident: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const exact = rows.filter((r) => r.id.toLowerCase() === ident.toLowerCase() || r.name.toLowerCase() === ident.toLowerCase());
    if (exact.length === 1) return exact[0];
    const partial = rows.filter((r) => r.name.toLowerCase().includes(ident.toLowerCase()));
    if (partial.length === 1) return partial[0];
    const names = (partial.length ? partial : rows).map((r) => `  ${r.name} (${r.id})`).join('\n');
    usage(`${partial.length ? 'several' : 'no'} courses match '${ident}':\n${names}`);
}

function listDir(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => !f.endsWith('.blend1'))
        .map((f) => {
            const s = statSync(path.join(dir, f));
            return s.isFile() ? `  ${s.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${(s.size / 1e6).toFixed(1).padStart(7)} MB  ${f}` : `  ${f}/`;
        });
}

async function cmdCourses() {
    const rows = await db.selectFrom('courses').select(['id', 'name', 'site_id', 'gspro_export_dir']).orderBy('name').execute();
    for (const r of rows) {
        const built = r.site_id ? 'map built' : 'no map';
        console.log(`${r.name}  ${r.id}  ${built}  export: ${r.gspro_export_dir ?? '(Downloads)'}`);
    }
}

async function cmdStatus(ident: string) {
    const course = await resolveCourse(ident);
    const settings = await exporter.settings(course.id);
    console.log(`${course.name} (${course.id})`);
    console.log(`export folder: ${settings.dir}${settings.isDefault ? ' (default)' : ''}`);
    console.log(`GSPro course folder: ${settings.courseDir ? path.join(settings.courseDir, settings.gkdFile ?? '') : '(not set: --course-dir)'}`);
    try {
        const t = await exporter.terrain(course.id);
        console.log(`terrains: ${JSON.stringify(t)}`);
    } catch (e) {
        console.log(`terrains: ${(e as Error).message}`);
    }
    try {
        const sources = await exporter.orthoSources(course.id);
        console.log('ortho sources (--source):');
        for (const s of sources) console.log(`  ${s.source}  ${s.collection}${s.cleaned ? ' cleaned' : ''}${s.active ? ' ACTIVE' : ''}`);
    } catch (e) {
        console.log(`ortho sources: ${(e as Error).message}`);
    }
    const zones = await db.selectFrom('course_features').select(({ fn }) => fn.countAll<number>().as('n'))
        .where('course_id', '=', course.id).where('type', '=', 'vegetation_zone').executeTakeFirst();
    console.log(`vegetation zones drawn: ${zones?.n ?? 0}`);
    console.log('files in the export folder:');
    for (const line of listDir(settings.dir)) console.log(line);
    await printBoard(course.id);
}

// --- The status board (GsproSyncService) ---

/** `2026-10-14T09:12:33.000Z` -> `2026-10-14 09:12` in local time; `never` for null. */
function when(iso: string | null): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function changedText(row: GsproTargetStatus): string {
    if (row.lastRun === null) return '-';
    if (row.changedSince.count === 0) return 'nothing';
    return `${row.changedSince.count} (${row.changedSince.kinds.join(', ')})`;
}

const pad = (text: string, width: number) => text.padEnd(width);

async function printBoard(courseId: string) {
    const status = await sync.status(courseId);
    console.log('\nGSPro status board:');
    console.log(`  ${pad('target', 12)}${pad('last updated', 18)}${pad('changed since', 40)}state`);
    for (const row of status.targets) {
        const state = row.blocked ? `blocked: ${row.blocked}` : row.stale ? 'STALE' : 'up to date';
        console.log(`  ${pad(row.id, 12)}${pad(when(row.lastRun), 18)}${pad(changedText(row), 40)}${state}`
            + (row.seconds !== null ? `  (last took ${row.seconds} s)` : ''));
        if (row.note) console.log(`  ${pad('', 12)}${row.note}`);
        if (row.manual) console.log(`  ${pad('', 12)}then by hand: ${row.manual}`);
    }
    const stale = status.targets.filter(r => r.stale && r.blocked === null).map(r => r.id);
    console.log(`  stale and runnable: ${stale.length ? stale.join(', ') : 'none'}`);

    console.log('\nUnity editors:');
    if (status.unity.editors.length === 0) console.log('  (none open)');
    for (const e of status.unity.editors) {
        console.log(`  ${e.matches ? 'THIS COURSE' : '           '}  ${e.projectName}  ${e.error ?? `course ${e.activeCourse ?? '?'} -> ${e.exportFolder}`}`);
    }
    console.log(`shaping worker: ${status.worker.reachable ? `${status.worker.state ?? 'up'} (${status.worker.url})` : `not running (${status.worker.error ?? status.worker.url})`}`);
    if (status.job) console.log(`last update job: ${status.job.request} - ${status.job.status} - ${status.job.step}`);
    for (const q of status.queue) console.log(`queued: ${q.target} (job ${q.id})`);
}

// --- Update (one target's whole chain, or every stale one) ---

const MARK: Record<JobPhase['status'], string> = {
    done: 'ok     ', skipped: 'skipped', failed: 'FAILED ', running: '...    ', pending: '       ',
};

const phaseLine = (p: JobPhase) =>
    `${MARK[p.status]} ${p.label}${p.detail ? ` - ${p.detail}` : ''}${p.seconds !== null ? ` (${p.seconds} s)` : ''}`;

/** Poll the job to its end, printing each phase once as it finishes (and the one now running when it changes). */
async function follow(jobId: string): Promise<GsproSyncJob> {
    const printed = new Set<string>();
    let running = '';
    for (;;) {
        const job = sync.job(jobId);
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
        if (job.status !== 'running' && job.status !== 'queued') return job;
        await Bun.sleep(500);
    }
}

async function cmdUpdate(ident: string, target: string, force: boolean) {
    const course = await resolveCourse(ident);
    if (target !== 'stale' && !isGsproTargetId(target)) {
        usage(`unknown target '${target}' (have: ${GSPRO_TARGET_IDS.join(', ')}, stale)`);
    }
    const request = target as GsproTargetId | 'stale';
    const started = await sync.update(course.id, request, { force });
    const what = started.targets.length === 0
        ? 'nothing to do'
        : started.targets.map(t => gsproTarget(t).label).join(', ');
    console.log(`${course.name} (${course.id}) -> ${what}`);
    const job = await follow(started.id);
    for (const result of job.results) {
        console.log(`\n${result.label} (${result.seconds} s)${result.error ? ' FAILED' : ''}:`);
        for (const line of result.report) console.log(`  ${line}`);
        if (result.error) console.log(`  error: ${result.error}`);
    }
    console.log(`\n${job.status === 'succeeded' ? 'done' : 'FAILED'} in ${job.seconds} s`);
    if (job.status !== 'succeeded') {
        console.error(`error: ${job.error ?? 'unknown error'}`);
        process.exit(1);
    }
}

function requestsFor(spec: string, flags: Record<string, string | true>, activeSource: () => Promise<string>): Promise<GsproExportRequest[]> {
    const [kindText, terrainText] = spec.split(':');
    const kind = kindText as GsproExportKind;
    if (!KINDS.includes(kind)) usage(`unknown export '${kindText}'`);
    if (terrainText && !TERRAIN_KINDS.has(kind)) usage(`'${kind}' has no terrain; drop ':${terrainText}'`);
    if (terrainText && terrainText !== 'inner' && terrainText !== 'outer') usage(`terrain must be inner or outer, not '${terrainText}'`);
    const ortho = {
        darken: num(flags, 'darken'),
        tint: flags['tint'] === true ? true : undefined,
        tintOpacity: num(flags, 'tint-opacity'),
        forestFloor: flags['forest-floor'] === true ? true : undefined,
        floorColor: typeof flags['floor-color'] === 'string' ? flags['floor-color'] : undefined,
        floorMix: num(flags, 'floor-mix'),
        removeBuildings: flags['remove-buildings'] === true ? true : undefined,
    };
    const force = flags['force'] === true ? true : undefined;
    return (async () => {
        if (TERRAIN_KINDS.has(kind)) {
            const terrains: TerrainKind[] = terrainText ? [terrainText as TerrainKind] : ['inner', 'outer'];
            return terrains.map((terrain) => ({ kind, terrain, force }));
        }
        if (kind === 'ortho' || kind === 'unity-ortho') {
            const source = typeof flags['source'] === 'string' ? flags['source'] : await activeSource();
            return [{ kind, source, ...ortho, force }];
        }
        if (kind === 'outer-ortho') {
            if (typeof flags['collection'] !== 'string') usage('outer-ortho needs --collection <orto-l2-YYYY> (see status for the vintages)');
            return [{ kind, collection: flags['collection'] as string, ...ortho, force }];
        }
        return [{ kind, force }];
    })();
}

async function cmdExport(ident: string, specs: string[], flags: Record<string, string | true>) {
    const course = await resolveCourse(ident);
    if (typeof flags['dir'] === 'string') await exporter.setDir(course.id, path.resolve(flags['dir']));
    if (typeof flags['course-dir'] === 'string') await exporter.setCourseDir(course.id, path.resolve(flags['course-dir']));
    const activeSource = async () => {
        const sources = await exporter.orthoSources(course.id);
        const active = sources.find((s) => s.active) ?? sources[0];
        if (!active) usage('the course has no orthophoto sources; run a map build first');
        return active.source;
    };
    const requests: GsproExportRequest[] = [];
    for (const spec of specs) requests.push(...await requestsFor(spec, flags, activeSource));
    const { dir } = await exporter.settings(course.id);
    console.log(`${course.name} -> ${dir}`);

    for (const request of requests) {
        const t0 = Date.now();
        const started = await exporter.start(course.id, request);
        process.stdout.write(`${started.label} ... `);
        await exporter.whenIdle(course.id);
        const job = exporter.job(started.id);
        const seconds = ((Date.now() - t0) / 1000).toFixed(1);
        if (job.status !== 'succeeded') {
            console.log(`FAILED after ${seconds}s\n${job.error}`);
            process.exit(1);
        }
        console.log(`done in ${seconds}s\n  ${job.result!.path}`);
        for (const line of job.result!.report) console.log(`  ${line}`);
    }
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [first, ...rest] = positional;
try {
    if (!first) usage();
    else if (first === 'courses') await cmdCourses();
    else if (first === 'status') await cmdStatus(rest[0] ?? usage('status needs a course'));
    else if (first === 'update') {
        await cmdUpdate(rest[0] ?? usage('update needs a course'),
            rest[1] ?? usage(`update needs a target (${GSPRO_TARGET_IDS.join(', ')}, stale)`), flags['force'] === true);
    }
    else if (rest.length === 0) usage('name at least one export');
    else await cmdExport(first, rest, flags);
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
} finally {
    await db.destroy();
}
