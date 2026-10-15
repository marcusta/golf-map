// Plant a course's lower vegetation from the command line: the same handler as
// the web command bar's "Update vegetation" button
// (GsproExportService.plantVegetation). It runs every vegetation generator
// (server/services/vegetation-generators.ts: tall rough, then creek banks,
// ...) and imports each one's zones as the course's generated zones of its
// source (a re-run replaces exactly those; hand-drawn zones are never
// touched), then re-exports the terrain's zones for Unity and, for a course
// with an Arborist species file, writes the Arborist file's lower vegetation
// from them (--no-arborist leaves that; the trees need Unity and are the
// button's or `bun run gspro:export -- <course> arborist`). The Unity import
// is left to Unity here (the button does it too). See
// .claude/skills/grass-planting/SKILL.md for the loop.
//
//   bun run grass:zones -- <course> [--terrain inner|outer] [--dry-run] [--no-export] [--no-arborist]
//                          [--only <source>]   that generator and every one after it (keeps the zone stack order)
//                          [--max-distance 75] [--spill 0.3] [--feather 4] [--noise 0] [--zone-type rough_tall]
//                          [--far-start 30] [--far-ramp 10] [--far-weight 0.56] [--near-start 8 --near-ramp 4 --near-weight 0.5] [--out-start 40]   thinner far from play; the <type>/far mix
//                                              tall-rough tuning, passed to pipeline/grass_zones.py after the
//                                              course's own (docs/gspro/<course>/vegetation-rules.json), so they win
//
// Inputs, found from the course: the Unity surface map in its GSPro export
// folder (<prefix>-<terrain>-surfaces.json, written by the bridge command
// golfmap.surfaces.export), the site's building survey
// (sources/<site>/buildings.geojson, fetch-buildings) and road centerlines
// (sources/<site>/roads-centerlines.geojson, fetch-roads).
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService } from '../server/services/gspro-export.service';
import { TALL_GRASS, VEGETATION_GENERATORS } from '../server/services/vegetation-generators';

const ROOT = path.resolve(import.meta.dir, '..');
const PIPELINE = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const TALL_GRASS_TUNING = ['max-distance', 'spill', 'feather', 'band-feather', 'noise', 'zone-type', 'building-margin', 'road-margin', 'path-margin', 'far-start', 'far-ramp', 'far-weight', 'near-start', 'near-ramp', 'near-weight', 'out-start'];

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run grass:zones -- <course> [--terrain inner|outer] [--dry-run] [--no-export] [--no-arborist] '
        + `[--only ${VEGETATION_GENERATORS.map((g) => g.source).join('|')}] [${TALL_GRASS_TUNING.map((p) => `--${p} <v>`).join('] [')}]`);
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run' || name === 'no-export' || name === 'no-arborist') { flags[name] = true; continue; }
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    flags[name] = v;
}
const ident = positional[0] ?? usage();
const terrain = (flags['terrain'] as string | undefined) ?? 'inner';
if (terrain !== 'inner' && terrain !== 'outer') usage('--terrain must be inner or outer');
const only = flags['only'] as string | undefined;
if (only !== undefined && !VEGETATION_GENERATORS.some((g) => g.source === only)) {
    usage(`--only takes ${VEGETATION_GENERATORS.map((g) => `'${g.source}'`).join(' or ')}`);
}

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const db = createDb<Database>(dbPath);
const exporter = new GsproExportService({
    db, courses: new CoursesService(db), assets: new AssetsService(db, dataDir), dataDir,
    terrainEdits: new TerrainEditsService(db), pipelineDir: PIPELINE,
});

try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const course = pick[0];

    const tuning = TALL_GRASS_TUNING.flatMap((p) => typeof flags[p] === 'string' ? [`--${p}`, flags[p] as string] : []);
    const result = await exporter.plantVegetation(course.id, terrain, {
        from: only,
        dryRun: flags['dry-run'] === true,
        exportZones: flags['no-export'] !== true,
        unity: false,
        arborist: flags['no-arborist'] === true ? false : 'lower',
        dbPath,
        extraArgs: { [TALL_GRASS.source]: tuning },
    });
    console.log(result.report.map((l) => `  ${l}`).join('\n'));
    if (!flags['dry-run'] && !flags['no-export'] && terrain === 'inner') {
        console.log(`next, in Unity: golfmap.zones.import {terrain: "${terrain}", package: "GolfMap lower vegetation"}, then golfmap.grass.apply`
            + ' (or press Update vegetation in the web command bar, which does it all)');
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
