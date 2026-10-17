// Water from Lantmäteriet's Hydrografi, a few shapes at a time: the same fetch,
// build and duplicate check as the Import GeoJSON wizard's "Fetch from
// Lantmäteriet" (HydroService -> web/src/import/geojson-build.ts), where the
// shapes are picked by clicking them on the map. Shapes the course already has
// (same source + sourceRef) are listed as "on course" and never imported twice.
//
//   bun run water:import -- <course>                     list the shapes: number, type, area, place, ref, new/on course
//   bun run water:import -- <course> --pick 3,5 [--dry-run]
//   bun run water:import -- <course> --all [--dry-run]   every shape not on the course
//        --pick    numbers from the list, or source refs (StandingWater/123, WatercourseLine/9#2)
//        --dry-run show what would be created, nothing stored
//
// Each fetch spends Hydrografi Direkt quota. The list's numbers follow the
// fetch's order, which is stable while Lantmäteriet's data is. Next for ponds:
// bun run water:edge -- <course> --all (fit the edges to the lidar and photo).

import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { HydroService } from '../server/services/hydro.service';
import { parseGeojsonDocument, bucketByProperty } from '../web/src/import/geojson-parse';
import { alreadyImported, buildFeatures, hydroToFeatureCollection, importedRefs } from '../web/src/import/geojson-build';
import type { BucketAssignment } from '../web/src/import/svg-import.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run water:import -- <course> [--pick <n|ref>,... | --all] [--dry-run]');
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
const pickArg = flags['pick'] as string | undefined;
if (pickArg && flags['all']) usage('use --pick or --all, not both');
const dryRun = flags['dry-run'] === true;

/** Area (m²) and centre of a source polygon's outer ring. */
function measure(ring: number[][]): { area: number; x: number; y: number } {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        a += cross;
        cx += (ring[j][0] + ring[i][0]) * cross;
        cy += (ring[j][1] + ring[i][1]) * cross;
    }
    return a === 0 ? { area: 0, x: ring[0][0], y: ring[0][1] } : { area: Math.abs(a / 2), x: cx / (3 * a), y: cy / (3 * a) };
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
    const hydro = new HydroService({ courses, assets: new AssetsService(db, dataDir) });

    const collection = hydroToFeatureCollection(await hydro.fetchForCourse(course.id));
    const parsed = parseGeojsonDocument(JSON.stringify(collection));
    const buckets = bucketByProperty(parsed, 'type');
    const assignments: Record<string, BucketAssignment> = {};
    for (const b of buckets) assignments[b.key] = b.suggestedType ?? 'skip';
    const built = buildFeatures(parsed, buckets, assignments);
    const refs = importedRefs(await features.listByCourse(course.id));

    const shapes = built.features.map((f, i) => {
        const [index, poly] = f.key!.split('.').map(Number);
        const source = parsed.features.find((p) => p.index === index)!;
        return { no: i + 1, f, onCourse: alreadyImported(f, refs), ...measure(source.polygons[poly ?? 0][0]) };
    });
    console.log(`${course.name}: ${shapes.length} shapes from Hydrografi, ${shapes.filter((s) => s.onCourse).length} on the course`);
    for (const s of shapes) {
        const area = s.f.type === 'water_creek' ? '' : `${Math.round(s.area).toLocaleString('sv-SE')} m2`;
        console.log(`  ${String(s.no).padStart(3)}  ${s.f.type.padEnd(11)} ${area.padStart(12)}  at ${Math.round(s.x)}, ${Math.round(s.y)}  ${(s.f.sourceRef ?? '-').padEnd(26)} ${s.onCourse ? 'on course' : 'new'}`);
    }
    for (const w of built.warnings) console.log(`  skipped: ${w}`);

    let chosen: typeof shapes = [];
    if (flags['all']) chosen = shapes.filter((s) => !s.onCourse);
    else if (pickArg) {
        for (const token of pickArg.split(',').map((t) => t.trim()).filter(Boolean)) {
            const hits = /^\d+$/.test(token) ? shapes.filter((s) => s.no === Number(token)) : shapes.filter((s) => s.f.sourceRef === token);
            if (hits.length === 0) usage(`no shape '${token}' in the list`);
            for (const s of hits) {
                if (s.onCourse) console.log(`  ${s.no} is on the course already: not imported again`);
                else if (!chosen.includes(s)) chosen.push(s);
            }
        }
    } else {
        console.log('nothing picked: --pick <numbers or refs> or --all');
    }
    if (chosen.length > 0) {
        console.log(`${dryRun ? 'would import' : 'importing'} ${chosen.map((s) => s.no).join(', ')}`);
        if (!dryRun) {
            const created = await features.createMany(course.id, chosen.map(({ f }) => ({
                type: f.type,
                geometry: f.geometry,
                source: f.source,
                sourceRef: f.sourceRef,
                license: f.license,
                ...(f.attributes ? { attributes: f.attributes } : {}),
            })));
            console.log(`created ${created.length}: ${created.map((c) => `#${c.no} ${c.type}`).join(', ')}`);
            if (created.some((c) => c.type === 'water')) console.log(`next: bun run water:edge -- "${course.name}" --all`);
        }
    }
    if (dryRun) console.log('dry run, nothing stored');
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
