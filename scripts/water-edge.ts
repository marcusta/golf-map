// Move a pond's outline part of the way in to the lidar's water edge (pipeline/golfpipe/water_edge.py) and store
// it on the feature as a smooth B-spline, fitted the way the draw tool fits a stroke (web/src/geo/spline-fit.ts).
//
//   bun run water:edge -- <course> --feature <shape name|number|id> [--toward 0.5] [--min 0.2] [--dry-run]
//        --toward  how far towards the lidar edge a point moves, 0-1 (0.5: halfway, between the ortho's shore
//                  and the lidar's open water)
//        --min     points less than this outside the lidar edge stay where they are (m)
//
// The lidar DEM is the site's own, before the terrain edits (sources/<site>/dem.tif): its flat sheet is the water.
// The old geometry is saved to data/backups/water-edge/ first. Then re-dig the pond
// (`bun run terrain:generate -- <course> water-digs`) and apply the terrain.
import '../server/env-paths';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { venvPython } from '../server/services/gspro-export.service';
import { flattenRing } from '../server/services/geo';
import { fitClosedBspline } from '../web/src/geo/spline-fit';

const ROOT = path.resolve(import.meta.dir, '..');
const FIT_TOLERANCE_M = 0.1;  // the drawn ponds are fitted this close (the import's 1.5 m is for long shorelines)

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run water:edge -- <course> --feature <shape name|number|id> [--toward 0.5] [--min 0.2] [--dry-run]');
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
    flags[name] = v;
}
const ident = positional[0] ?? usage();
const featureArg = (flags['feature'] as string | undefined) ?? usage('name the pond with --feature');
const toward = Number(flags['toward'] ?? 0.5);
const minM = Number(flags['min'] ?? 0.2);
if (!(toward > 0 && toward <= 1)) usage('--toward must be in (0, 1]');
if (!(minM >= 0)) usage('--min must be >= 0');

function findFeature(features: CourseFeature[], arg: string, holes: Map<string, number>): CourseFeature {
    const q = arg.trim().toLowerCase();
    const shape = /^(?:hole_\d+|course|others)_([0-9a-f]+)$/.exec(q);
    const hits = shape ? features.filter((f) => f.no === parseInt(shape[1], 16))
        : /^\d{1,6}$/.test(q) ? features.filter((f) => f.no === Number(q))
        : q.length >= 6 ? features.filter((f) => f.id.toLowerCase().startsWith(q)) : [];
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
    if (hits[0].type !== 'water') usage(`'${arg}' is a ${hits[0].type}, not a pond (water)`);
    void holes;
    return hits[0];
}

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const course = await new CoursesService(db).get(pick[0].id);
    if (!course.siteId) usage('the course has no built map (no lidar DEM)');
    const features = new CourseFeaturesService(db);
    const holes = new Map((await db.selectFrom('holes').select(['id', 'number']).where('course_id', '=', course.id).execute()).map((h) => [h.id, h.number]));
    const f = findFeature(await features.listByCourse(course.id), featureArg, holes);
    const outer = f.geometry.rings[0];
    const flat = flattenRing(outer, 0.05, f.geometry.curveType);

    const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
    const proc = Bun.spawn([venvPython(pipelineDir), '-m', 'golfpipe.water_edge'], {
        cwd: pipelineDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    proc.stdin.write(JSON.stringify({ dem: path.join(dataDir, 'sources', course.siteId, 'dem.tif'), ring: flat, toward, minM }));
    proc.stdin.end();
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`water_edge failed: ${err.trim().split('\n').slice(-3).join(' | ')}`);
    const r = JSON.parse(out) as {
        ring: [number, number][]; level: number;
        areaM2: { drawn: number; lidar: number; new: number };
        outsideLidarM: { p50: number; p90: number; max: number }; movedM: { p50: number; p90: number; max: number };
    };

    let perimeter = 0;
    for (let i = 0; i < r.ring.length; i++) {
        const [ax, ay] = r.ring[i], [bx, by] = r.ring[(i + 1) % r.ring.length];
        perimeter += Math.hypot(bx - ax, by - ay);
    }
    const cap = Math.min(256, Math.max(outer.points.length, Math.ceil(perimeter / 1.5)));
    const fit = fitClosedBspline(r.ring.map(([x, y]) => ({ x, y })), FIT_TOLERANCE_M, cap);
    if (fit.controls.length < 3 || !fit.controls.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        throw new Error('the B-spline fit failed');
    }
    console.log(`${featureArg}: water level ${r.level} m (lidar), area ${r.areaM2.drawn} m2 drawn, ${r.areaM2.lidar} m2 lidar water -> ${r.areaM2.new} m2`);
    console.log(`  drawn outline outside the lidar edge: p50 ${r.outsideLidarM.p50} m, p90 ${r.outsideLidarM.p90} m, max ${r.outsideLidarM.max} m`);
    console.log(`  moved in (toward ${toward}, from ${minM} m out): p50 ${r.movedM.p50} m, p90 ${r.movedM.p90} m, max ${r.movedM.max} m`);
    console.log(`  B-spline: ${fit.controls.length} control points (was ${outer.points.length}), max deviation ${fit.maxDeviation.toFixed(3)} m`);
    if (flags['dry-run']) {
        console.log('  dry run, nothing written');
    } else {
        const backups = path.join(dataDir, 'backups', 'water-edge');
        await mkdir(backups, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = path.join(backups, `${f.id}-${stamp}.json`);
        await writeFile(backup, JSON.stringify({ featureId: f.id, version: f.version, geometry: f.geometry }, null, 1));
        const rings = [{ ...outer, points: fit.controls.map((p) => ({ x: p.x, y: p.y })) }, ...f.geometry.rings.slice(1)];
        await features.update(f.id, f.version, { geometry: { ...f.geometry, curveType: 'bspline', rings } });
        console.log(`  stored; the old outline is in ${backup}`);
        console.log(`next: bun run terrain:generate -- "${course.name}" water-digs --feature ${featureArg} ..., then bun run gspro:update -- "${course.name}" terrain`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
