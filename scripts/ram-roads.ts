// Roads drawn as NatureManufacture R.A.M. splines on the OPCD ground meshes instead of OPCD road meshes: which
// paths are (render=ram), which could be, and switching them. The same GsproExportService the web's
// `GET /api/courses/:courseId/gspro/ram-roads/proposal` and `POST .../ram-roads/render` drive.
//
//   bun run ramroads -- <course> propose [--min-distance-m 30]
//        the pipeline's candidates (gspro.py ramroads-propose: far enough from play, a centerline), the paths that
//        already are R.A.M. roads and the rejected ones with why. Writes nothing.
//   bun run ramroads -- <course> set <featureNo|path_<no>|featureId>... ram|opcd [--dry-run]
//        set render=ram on those paths, or clear it (opcd: an OPCD mesh again). One path that cannot take it
//        (no centerline, a bridge deck, not a path) stops the call and nothing is written.
//   bun run ramroads -- <course> list
//        the paths with render=ram.
//
// A change shows on the next update of the board's Shapes row (the SVG leaves R.A.M. roads out, so an OPCD build
// follows) and its R.A.M. roads row (`bun run gspro:update -- <course> roads`: the file, then
// golfmap.ramroads.build in Unity). <course> is a course id or a unique name substring ("vreta").
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { GsproExportService } from '../server/services/gspro-export.service';
import { PATH_RENDERS, isPathRender, pathRender } from '../shared/features/path-render';
import { centerlineStations } from '../shared/features/path-transitions';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run ramroads -- <course> propose [--min-distance-m 30]',
        '       bun run ramroads -- <course> set <featureNo|path_<no>|featureId>... ram|opcd [--dry-run]',
        '       bun run ramroads -- <course> list',
    ].join('\n'));
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run') { flags[name] = true; continue; }
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    if (name === 'min-distance-m') flags[name] = v;
    else usage(`unknown flag --${name}`);
}
const [ident, verb, ...rest] = positional;
if (!ident || !verb) usage();
const minDistanceM = flags['min-distance-m'] !== undefined ? Number(flags['min-distance-m']) : undefined;
if (minDistanceM !== undefined && !(Number.isFinite(minDistanceM) && minDistanceM >= 0)) usage('--min-distance-m must be 0 or more metres');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const features = new CourseFeaturesService(db);
const exporter = new GsproExportService({ db, courses, assets: new AssetsService(db, dataDir), dataDir, pipelineDir });

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0];
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

/** `12` / `path_12` = feature number 12; anything else an id (or an id prefix of 6+ characters). */
function findPath(all: CourseFeature[], arg: string): CourseFeature {
    const q = arg.trim().toLowerCase();
    const no = /^(?:path_)?(\d{1,6})$/.exec(q);
    const hits = no ? all.filter((f) => f.no === Number(no[1]))
        : all.filter((f) => f.id.toLowerCase() === q).length === 1 ? all.filter((f) => f.id.toLowerCase() === q)
        : q.length >= 6 ? all.filter((f) => f.id.toLowerCase().startsWith(q)) : [];
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
    return hits[0];
}

const m = (v: number | null) => (v === null ? '?' : `${v.toFixed(1)} m`);
const name = (f: CourseFeature) => no(f.no, f.id);
function no(featureNo: number | null, featureId: string): string {
    return featureNo !== null ? `path_${featureNo}` : featureId;
}
const lengthOf = (f: CourseFeature) => (f.geometry.centerline ? centerlineStations(f.geometry.centerline.points).lengthM : null);

try {
    const course = await resolveCourse(ident);
    console.log(`${course.name} (${course.id})`);
    if (verb === 'propose') {
        if (rest.length) usage(`propose takes no feature arguments (got ${rest.join(' ')})`);
        const p = await exporter.proposeRamRoads(course.id, { minDistanceM });
        console.log(`rules: ${JSON.stringify(p.rules)}`);
        console.log(`${p.candidates.length} candidate(s):`);
        for (const c of p.candidates) {
            const touches = c.touches.length ? `  touches ${c.touches.join(', ')}` : '';
            console.log(`  ${no(c.featureNo, c.featureId).padEnd(10)} ${c.surface.padEnd(12)} ${m(c.widthM).padStart(7)} wide ${m(c.lengthM).padStart(8)} long`
                + `  ${m(c.distanceToPlayM).padStart(7)} from play  ${c.reason}${touches}`);
        }
        if (p.already.length) console.log(`already R.A.M. roads: ${p.already.map((n) => (typeof n === 'number' ? `path_${n}` : n)).join(', ')}`);
        if (p.rejected.length) {
            console.log(`${p.rejected.length} rejected:`);
            for (const r of p.rejected) console.log(`  ${no(r.featureNo, r.featureId).padEnd(10)} ${r.reason}`);
        }
        if (p.candidates.length) {
            console.log(`take them: bun run ramroads -- "${course.name}" set ${p.candidates.map((c) => c.featureNo ?? c.featureId).join(' ')} ram`);
        }
    } else if (verb === 'set') {
        const render = rest[rest.length - 1];
        if (!isPathRender(render)) usage(`end with the render: ${PATH_RENDERS.join(' or ')}`);
        const args = rest.slice(0, -1);
        if (!args.length) usage('name the paths to set');
        const all = await features.listByCourse(course.id);
        const picked = args.map((a) => findPath(all, a));
        const dryRun = flags['dry-run'] === true;
        const r = await exporter.setRoadRender(course.id, picked.map((f) => f.id), render, { dryRun });
        const byId = new Map(picked.map((f) => [f.id, f]));
        const list = (ids: string[]) => ids.map((id) => name(byId.get(id)!)).join(', ') || '(none)';
        console.log(`${dryRun ? 'would set' : 'set'} render=${render}: ${list(r.changed)}`);
        if (r.unchanged.length) console.log(`already ${render}: ${list(r.unchanged)}`);
        if (r.changed.length && !dryRun) {
            console.log(`then: bun run gspro:update -- "${course.name}" shapes, an OPCD build, and bun run gspro:update -- "${course.name}" roads`);
        }
    } else if (verb === 'list') {
        if (rest.length) usage(`list takes no arguments (got ${rest.join(' ')})`);
        const ram = (await features.listByCourse(course.id)).filter((f) => f.type === 'path' && pathRender(f.attributes) === 'ram');
        console.log(`${ram.length} R.A.M. road(s):`);
        for (const f of ram) {
            const len = lengthOf(f);
            const surface = String(f.attributes?.surface ?? '?');
            const width = f.geometry.centerline ? m(f.geometry.centerline.widthM) : '?';
            console.log(`  ${name(f).padEnd(10)} ${surface.padEnd(12)} ${width.padStart(7)} wide ${len === null ? '?' : m(len).padStart(8)} long  ${f.id}`);
        }
    } else {
        usage(`unknown command '${verb}'`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
