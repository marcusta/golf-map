// Union of drawn shapes: the first shape named takes the merged outline (a smooth B-spline, or a polygon when
// every input is one) and keeps its id, type, hole, layer and attributes; the other shapes are deleted. The same
// `unionShapes` is the Draw selection panel's Union button (web/src/draw/shape-union.ts).
//
//   bun run features:union -- <course> <shape> <shape> [<shape> ...] [--dry-run]
//        <shape>     shape name (hole_14_53), feature number or id prefix (6+ characters)
//        --dry-run   print what would change, store nothing
//
// The shapes must overlap or touch; roads and paths (centerlines) are refused. The old geometries are saved to
// data/backups/features-union/ first.
import '../server/env-paths';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { UNION_ERRORS, unionShapes } from '../web/src/draw/shape-union';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run features:union -- <course> <shape> <shape> [<shape> ...] [--dry-run]');
    process.exit(2);
}

const positional = process.argv.slice(2).filter((a) => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const [ident, ...shapeArgs] = positional;
if (!ident || shapeArgs.length < 2) usage('name a course and at least two shapes');

function findFeature(features: CourseFeature[], arg: string): CourseFeature {
    const q = arg.trim().toLowerCase();
    const shape = /^(?:hole_\d+|others|course)_([0-9a-f]+)$/.exec(q);
    const hits = shape ? features.filter((f) => f.no === parseInt(shape[1], 16))
        : /^\d{1,6}$/.test(q) ? features.filter((f) => f.no === Number(q))
        : q.length >= 6 ? features.filter((f) => f.id.toLowerCase().startsWith(q)) : [];
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
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
    const service = new CourseFeaturesService(db);
    const all = await service.listByCourse(pick[0].id);
    const items = shapeArgs.map((a) => findFeature(all, a));
    if (new Set(items.map((f) => f.id)).size !== items.length) usage('a shape is named twice');

    const result = unionShapes(items.map((f) => f.geometry));
    if ('error' in result) throw new Error(UNION_ERRORS[result.error]);
    const [kept, ...gone] = items;
    const outer = result.geometry.rings[0].points.length;
    const holes = result.geometry.rings.length - 1;
    console.log(`${shapeArgs[0]} (${kept.type}) takes the union of ${items.length} shapes: ${outer} ${result.geometry.curveType === 'bspline' ? `spline controls, max deviation ${result.maxDeviation.toFixed(3)} m` : 'corners'}${holes ? `, ${holes} hole(s)` : ''}`);
    console.log(`deleted: ${gone.map((f, i) => `${shapeArgs[i + 1]} (${f.type})`).join(', ')}`);
    if (dryRun) {
        console.log('dry run, nothing stored');
    } else {
        const backups = path.join(dataDir, 'backups', 'features-union');
        await mkdir(backups, { recursive: true });
        const backup = path.join(backups, `${kept.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        await writeFile(backup, JSON.stringify(items, null, 1));
        await service.update(kept.id, kept.version, { geometry: result.geometry });
        await service.removeMany(gone.map((f) => ({ id: f.id, version: f.version })));
        console.log(`stored; the old shapes are in ${backup}`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
