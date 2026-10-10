// GSPro/OPCD exports from the command line: the same GsproExportService the
// web Export panel drives, so the files, names and folders are identical, but
// runnable by an agent or a script without the server or a login.
//
//   bun run gspro:export -- courses
//   bun run gspro:export -- status <course>
//   bun run gspro:export -- <course> <export>... [options]
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
//   gkd                      GreenKeeper's <scene>.GKD into the course's GSPro folder (--course-dir <folder>
//                            sets it, like the panel does); needs the inner dem exported first
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
    GsproExportService, type GsproExportKind, type GsproExportRequest, type TerrainKind,
} from '../server/services/gspro-export.service';

const ROOT = path.resolve(import.meta.dir, '..');
const KINDS: GsproExportKind[] = ['svg', 'ortho', 'outer-ortho', 'dem', 'unity-terrain', 'unity-sculpt', 'unity-ortho', 'hillshade', 'trees', 'buildings', 'zones', 'creeks', 'gkd'];
const TERRAIN_KINDS = new Set<GsproExportKind>(['dem', 'unity-terrain', 'unity-sculpt', 'hillshade', 'trees', 'buildings', 'zones']);

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run gspro:export -- courses',
        '       bun run gspro:export -- status <course>',
        '       bun run gspro:export -- <course> <kind[:inner|:outer]>... [--dir <folder>] [--course-dir <folder>] [--source <file>] [--collection <id>]',
        '                                 [--darken <x>] [--tint] [--tint-opacity <x>] [--forest-floor] [--floor-color <#hex>]',
        '                                 [--floor-mix <x>] [--remove-buildings]',
        `kinds: ${KINDS.join(', ')}`,
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
        const boolean = ['tint', 'forest-floor', 'remove-buildings'].includes(name);
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
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const assets = new AssetsService(db, dataDir);
const exporter = new GsproExportService({
    db, courses, assets, dataDir,
    terrainEdits: new TerrainEditsService(db),
    pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
});

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
    return (async () => {
        if (TERRAIN_KINDS.has(kind)) {
            const terrains: TerrainKind[] = terrainText ? [terrainText as TerrainKind] : ['inner', 'outer'];
            return terrains.map((terrain) => ({ kind, terrain }));
        }
        if (kind === 'ortho' || kind === 'unity-ortho') {
            const source = typeof flags['source'] === 'string' ? flags['source'] : await activeSource();
            return [{ kind, source, ...ortho }];
        }
        if (kind === 'outer-ortho') {
            if (typeof flags['collection'] !== 'string') usage('outer-ortho needs --collection <orto-l2-YYYY> (see status for the vintages)');
            return [{ kind, collection: flags['collection'] as string, ...ortho }];
        }
        return [{ kind }];
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
    else if (rest.length === 0) usage('name at least one export');
    else await cmdExport(first, rest, flags);
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
} finally {
    await db.destroy();
}
