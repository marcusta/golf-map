// Find falls: where a creek or a chain of ponds drops from one level to the next, found on the raw lidar
// (WaterStepsService -> pipeline/golfpipe/water_steps.py), and the water split there: each run a pond at its level
// (a `water` feature dug to hold it) or a creek, each step a `waterfall` feature along its lip. The same service and
// the same planner (web/src/terrain-edit/water-steps-apply.ts) as the terrain editor's "Find falls".
//
//   bun run water:steps -- <course> --feature <shape|number|id> [--feature ...] [--dry-run]
//        --cut e,n | lat,lon   a step here though the lidar shows none sharply (a sill under water plants); repeatable
//        --skip e,n | lat,lon  no step near here; repeatable
//        --min-drop m          the least drop that is a fall (default 0.3)
//        --sill m              a sill's crest width left out between two waters (default 1)
//        --image <png>         a check picture: the photo, the drawn water, the pieces and the falls
//        --dry-run             propose only: the pieces and falls, nothing stored
//
// The largest piece of each feature keeps it (its shape name and number stay); the others and the falls are new
// features in the same hole. The old features are saved to data/backups/water-steps/ first. Then dig the ponds and
// creeks, and update the terrain, the shapes, the meshes and the waterfalls.
import '../server/env-paths';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { WATER_STEPS_TYPES, WaterStepsService, type WaterStepsPoint } from '../server/services/water-steps.service';
import { wgs84ToSweref99tm } from '../server/services/geo';
import { planWaterSteps, type WaterStepsFeatureInput } from '../web/src/terrain-edit/water-steps-apply';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run water:steps -- <course> --feature <shape|number|id> [--feature ...] [--cut e,n|lat,lon]... [--skip e,n|lat,lon]...\n'
        + '         [--min-drop 0.3] [--sill 1] [--image <png>] [--dry-run]');
    process.exit(2);
}

const positional: string[] = [];
const multi: Record<'feature' | 'cut' | 'skip', string[]> = { feature: [], cut: [], skip: [] };
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run') { flags[name] = true; continue; }
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    if (name === 'feature' || name === 'cut' || name === 'skip') multi[name].push(v);
    else if (['min-drop', 'sill', 'image'].includes(name)) flags[name] = v;
    else usage(`unknown flag --${name}`);
}
const ident = positional[0] ?? usage();
if (multi.feature.length === 0) usage('name the ponds and creeks with --feature');
const minDropM = flags['min-drop'] !== undefined ? Number(flags['min-drop']) : undefined;
const sillM = flags['sill'] !== undefined ? Number(flags['sill']) : undefined;
if (minDropM !== undefined && !(minDropM >= 0.05 && minDropM <= 10)) usage('--min-drop must be 0.05..10 m');
if (sillM !== undefined && !(sillM >= 0 && sillM <= 5)) usage('--sill must be 0..5 m');
const dryRun = flags['dry-run'] === true;

/** `e,n` (EPSG:3006) or `lat,lon` (WGS84, told apart by size). */
function point(arg: string, flag: string): WaterStepsPoint {
    const parts = arg.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 2 || !parts.every(Number.isFinite)) usage(`--${flag} takes e,n or lat,lon (got '${arg}')`);
    const [a, b] = parts as [number, number];
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return wgs84ToSweref99tm(a, b);
    return { x: a, y: b };
}
const cuts = multi.cut.map((c) => point(c, 'cut'));
const skips = multi.skip.map((c) => point(c, 'skip'));

function findFeature(features: CourseFeature[], arg: string): CourseFeature {
    const q = arg.trim().toLowerCase();
    const shape = /^(?:hole_\d+|others|course)_([0-9a-f]+)$/.exec(q);
    const hits = shape ? features.filter((f) => f.no === parseInt(shape[1], 16))
        : /^\d{1,6}$/.test(q) ? features.filter((f) => f.no === Number(q))
        : q.length >= 6 ? features.filter((f) => f.id.toLowerCase().startsWith(q)) : [];
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
    if (!WATER_STEPS_TYPES.includes(hits[0].type)) usage(`'${arg}' is a ${hits[0].type}, not a pond (water) or creek (water_creek)`);
    return hits[0];
}

const m = (v: number | null) => (v === null ? '?' : `${v.toFixed(2)} m`);
const at = (p: WaterStepsPoint) => `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;

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
    const svc = new WaterStepsService({ db, courses, courseFeatures: features, dataDir });

    const all = await features.listByCourse(course.id);
    const picked = multi.feature.map((a) => findFeature(all, a));
    const p = await svc.propose(course.id, picked.map((f) => f.id), { cuts, skips, minDropM, sillM, image: flags['image'] as string | undefined });

    for (const b of p.bodies) {
        const pieces = p.pieces.filter((x) => x.bodyId === b.featureId);
        console.log(`${b.shape} (${b.type}): ${pieces.length} piece(s), ${b.steps} step(s)`);
        for (const x of pieces) {
            const level = x.kind === 'pond' ? `level ${m(x.levelM)}` : `${m(x.topM)} -> ${m(x.bottomM)}`;
            const dig = x.kind === 'pond' && x.digLevelOffsetM ? `, dig level offset ${x.digLevelOffsetM.toFixed(2)} m` : '';
            console.log(`  ${b.shape}·${x.index}  ${x.kind.padEnd(5)}  ${level}  ${x.areaM2.toFixed(0)} m2${dig}`);
        }
    }
    const shapeOf = new Map(p.bodies.map((b) => [b.featureId, b.shape]));
    for (const f of p.falls) {
        const from = `${shapeOf.get(f.fromBodyId)}·${f.fromPiece ?? '?'}`;
        const to = `${shapeOf.get(f.toBodyId)}·${f.toPiece ?? '?'}`;
        const extra = [f.forced ? 'cut asked' : '', f.gapM !== null ? `${f.gapM.toFixed(1)} m apart` : ''].filter(Boolean).join(', ');
        console.log(`fall ${f.style.padEnd(6)} ${f.dropM.toFixed(2)} m  ${from} -> ${to}  at ${at(f.at)}  ${f.widthM.toFixed(1)} m wide${extra ? ` (${extra})` : ''}`);
    }
    if (p.image) console.log(`check picture: ${p.image}`);

    const byId = new Map(all.map((f) => [f.id, f]));
    const plan = planWaterSteps(p, picked.map((f): WaterStepsFeatureInput => ({
        id: f.id, type: f.type, holeId: f.holeId, layer: f.layer, version: f.version,
        geometry: f.geometry as WaterStepsFeatureInput['geometry'], attributes: f.attributes as Record<string, unknown> | null,
    })));
    console.log(`plan: ${plan.updates.length} feature(s) kept and changed, ${plan.creates.filter((c) => c.type !== 'waterfall').length} new piece(s), `
        + `${plan.creates.filter((c) => c.type === 'waterfall').length} waterfall(s); B-spline max deviation ${plan.maxDeviationM.toFixed(2)} m`);
    for (const w of plan.warnings) console.log(`  note: ${w}`);

    if (dryRun) {
        console.log('dry run, nothing stored');
    } else {
        const backups = path.join(dataDir, 'backups', 'water-steps');
        await mkdir(backups, { recursive: true });
        const backup = path.join(backups, `${course.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        await writeFile(backup, JSON.stringify(picked.map((f) => byId.get(f.id)), null, 1));
        // Version-checked: a feature changed since the proposal stops the whole update.
        await features.updateMany(plan.updates.map((u) => ({
            id: u.featureId, version: u.version, type: u.patch.type,
            geometry: u.patch.geometry as CourseFeature['geometry'], attributes: u.patch.attributes,
        })));
        const created = await features.createMany(course.id, plan.creates.map((c) => ({
            type: c.type, holeId: c.holeId, layer: c.layer, geometry: c.geometry as CourseFeature['geometry'], attributes: c.attributes,
        })));
        console.log(`stored: ${plan.updates.length} changed, ${created.length} created; the old features are in ${backup}`);
        const name = `"${course.name}"`;
        console.log('next:');
        console.log(`  bun run terrain:generate -- ${name} water-digs     (the ponds dug to hold their levels)`);
        console.log(`  bun run terrain:generate -- ${name} creek-digs`);
        console.log(`  bun run gspro:update -- ${name} terrain, then shapes (the SVG; build it in OPCD), meshes, waterfalls`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
