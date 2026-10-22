// How deep each creek comes out in the course meshes, before the bake (GsproExportService.creekDepth ->
// `gspro.py creek-depth`; the same check as the Terrain editor's Depth button on the "Dig creeks (DEM)" row): every
// `water_creek` measured across on the DEM its digs are in and on a model of the meshes OPCD conforms onto
// terrain.obj (1 m nodes, OPCD's smooth, ~1.2 m triangles), with what its dig is.
//
//   bun run water:depth -- <course> [--feature <id or start>[,...]]... [--json]
//        one line per creek: ok / shallow (and where first, EPSG:3006) / not-dug / stale (its dig misses part of
//        it or has another depth) / off (dig: false) / on-lake. --json prints the whole report.
//
// The DEM is sources/<site>/dem-edited.tif when no enabled terrain edit changed after the last Apply to terrain,
// else the raw dem.tif with the site's enabled edits replayed onto it in memory (a dig stored but not applied yet is
// measured too). The inner heightmap is exported first when the export folder has none.
// <course> is a course id or a unique name substring. Exit 0 when every creek is ok, off or on a lake, 1 when any is
// shallow, not dug or stale, 2 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService, type CreekDepthStatus } from '../server/services/gspro-export.service';

const ROOT = path.resolve(import.meta.dir, '..');
/** The statuses that need work before the bake (exit 1). */
const NEEDS_WORK: readonly CreekDepthStatus[] = ['shallow', 'not-dug', 'stale'];

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run water:depth -- <course> [--feature <id or start>[,...]]... [--json]');
    process.exit(2);
}

const positional: string[] = [];
const only: string[] = [];
let json = false;
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    if (a === '--json') { json = true; continue; }
    if (a !== '--feature') usage(`unknown flag ${a}`);
    const v = process.argv[++i];
    if (v === undefined) usage('--feature needs a value');
    only.push(...v.split(',').map(s => s.trim()).filter(Boolean));
}
const [ident, extra] = positional;
if (!ident || extra !== undefined) usage();

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const exporter = new GsproExportService({
    db, courses: new CoursesService(db), assets: new AssetsService(db, dataDir), dataDir, terrainEdits: new TerrainEditsService(db),
    pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
});

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    await db.destroy();
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

try {
    const course = await resolveCourse(ident);
    const report = await exporter.creekDepth(course.id, { only });
    if (json) {
        console.log(JSON.stringify(report, null, 1));
    } else {
        for (const line of report.lines) console.log(line);
        if (report.demSource === 'replayed') {
            console.log('  note: terrain edits not applied yet were replayed onto the raw DEM; Apply to terrain (or Update terrain) bakes them');
        }
        if (only.length > 0 && report.creeks.length === 0) console.log(`  no creek matches ${only.join(', ')}`);
    }
    process.exitCode = report.creeks.some((c) => NEEDS_WORK.includes(c.status)) ? 1 : 0;
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 2;
} finally {
    await db.destroy();
}
