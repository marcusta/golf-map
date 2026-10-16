// A pond's outline fitted to the water's edge: found on the orthophoto between the lidar's open water and the drawn
// line (PondEdgeService -> pipeline/golfpipe/water_edge.py), fitted as a smooth B-spline the way the draw tool
// fits a stroke (web/src/geo/spline-fit.ts), and stored on the feature. The same service is the terrain editor's
// "Fit edge to water" (the web shows the proposal on the map and Accept stores it).
//
//   bun run water:edge -- <course> --feature <shape name|number|id> [--dry-run] [--image <png>]
//   bun run water:edge -- <course> --all [--dry-run]
//        --dry-run   propose only: the numbers (and --image, a check picture), nothing stored
//        --toward t  instead of the photo: move each point t (0-1) of the way to the lidar's edge
//        --min m     points less than m outside the lidar's water stay (default 0.2)
//
// Stretches where the photo shows no clear water edge (reeds, lily pads, shade) keep the drawn line and are
// listed. The old geometry is saved to data/backups/water-edge/ first. Then re-dig the pond
// (`bun run terrain:generate -- <course> water-digs --feature <shape> --bank-above 45`) and apply the terrain.
import '../server/env-paths';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { PondEdgeService, type PondEdgeProposal } from '../server/services/pond-edge.service';
import { fitPondEdge } from '../web/src/terrain-edit/pond-edge-fit';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run water:edge -- <course> (--feature <shape name|number|id> | --all) [--dry-run] [--image <png>] [--toward 0-1] [--min 0.2]');
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run' || name === 'all') { flags[name] = true; continue; }
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    flags[name] = v;
}
const ident = positional[0] ?? usage();
const featureArg = flags['feature'] as string | undefined;
if (!featureArg === !flags['all']) usage('name one pond with --feature, or --all');
const toward = flags['toward'] !== undefined ? Number(flags['toward']) : undefined;
const minM = flags['min'] !== undefined ? Number(flags['min']) : undefined;
if (toward !== undefined && !(toward > 0 && toward <= 1)) usage('--toward must be in (0, 1]');
if (minM !== undefined && !(minM >= 0)) usage('--min must be >= 0');
const dryRun = flags['dry-run'] === true;

function findFeature(features: CourseFeature[], arg: string): CourseFeature {
    const q = arg.trim().toLowerCase();
    const shape = /^(?:hole_\d+|others|course)_([0-9a-f]+)$/.exec(q);
    const hits = shape ? features.filter((f) => f.no === parseInt(shape[1], 16))
        : /^\d{1,6}$/.test(q) ? features.filter((f) => f.no === Number(q))
        : q.length >= 6 ? features.filter((f) => f.id.toLowerCase().startsWith(q)) : [];
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
    if (hits[0].type !== 'water') usage(`'${arg}' is a ${hits[0].type}, not a pond (water)`);
    return hits[0];
}

function describe(p: PondEdgeProposal, controls: number, was: number, deviation: number) {
    console.log(`${p.shape}: water level ${p.level} m (lidar); area ${p.areaM2.drawn} m2 drawn, ${p.areaM2.lidar} m2 lidar water -> ${p.areaM2.new} m2`);
    console.log(`  drawn line outside the lidar's water: p50 ${p.outsideLidarM.p50} m, max ${p.outsideLidarM.max} m`);
    console.log(`  moved ${p.toward !== null ? `(toward ${p.toward})` : '(to the edge on the photo)'}: p50 ${p.movedM.p50} m, p90 ${p.movedM.p90} m, max ${p.movedM.max} m`);
    const kept = p.kept.reduce((s, k) => s + (k.toM - k.fromM), 0);
    if (p.kept.length) console.log(`  kept the drawn line on ${kept.toFixed(0)} m in ${p.kept.length} stretch(es): ${p.kept[0].why}`);
    if (p.photos.length) console.log(`  photos: ${p.photos.map((ph) => `separation ${ph.separation}`).join(', ')}`);
    console.log(`  B-spline: ${controls} control points (was ${was}), max deviation ${deviation.toFixed(3)} m`);
    if (p.image) console.log(`  check picture: ${p.image}`);
}

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const courses = new CoursesService(db);
    const course = await courses.get(pick[0].id);
    const features = new CourseFeaturesService(db);
    const svc = new PondEdgeService({ db, courses, courseFeatures: features, dataDir });

    let proposals: PondEdgeProposal[];
    if (featureArg) {
        const f = findFeature(await features.listByCourse(course.id), featureArg);
        proposals = [await svc.propose(course.id, f.id, { toward, minM, image: flags['image'] as string | undefined })];
    } else {
        const all = await svc.proposeAll(course.id, { toward, minM });
        for (const x of all.failed) console.log(`${x.shape}: not proposed - ${x.error}`);
        proposals = all.proposals;
    }
    const byId = new Map((await features.listByCourse(course.id)).map((f) => [f.id, f]));
    for (const p of proposals) {
        const f = byId.get(p.featureId)!;
        const fit = fitPondEdge(p.ring);
        describe(p, fit.controls.length, f.geometry.rings[0].points.length, fit.maxDeviation);
        if (dryRun) continue;
        if (f.version !== p.version) { console.log('  changed since the proposal: not stored'); continue; }
        const backups = path.join(dataDir, 'backups', 'water-edge');
        await mkdir(backups, { recursive: true });
        const backup = path.join(backups, `${f.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        await writeFile(backup, JSON.stringify({ featureId: f.id, version: f.version, geometry: f.geometry }, null, 1));
        const rings = [{ ...f.geometry.rings[0], points: fit.controls }, ...f.geometry.rings.slice(1)];
        await features.update(f.id, f.version, { geometry: { ...f.geometry, curveType: 'bspline', rings } });
        console.log(`  stored; the old outline is in ${backup}`);
    }
    if (dryRun) console.log('dry run, nothing stored');
    else if (proposals.length) console.log(`next: bun run terrain:generate -- "${course.name}" water-digs --feature <shape> --bank-above 45, then bun run gspro:update -- "${course.name}" terrain`);
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
