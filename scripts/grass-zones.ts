// Tall-grass vegetation zones for a whole course, by rule, in one command:
// runs pipeline/grass_zones.py over the course and imports the result as the
// course's generated `tall-grass` vegetation zones (a re-run replaces exactly
// those; hand-drawn zones are never touched), then re-exports the terrain's
// zones for Unity. See .claude/skills/grass-planting/SKILL.md for the loop.
//
//   bun run grass:zones -- <course> [--terrain inner|outer] [--dry-run] [--no-export]
//                          [--max-distance 75] [--spill 1.5] [--feather 4] [--noise 2]
//                          [--zone-type rough_tall] [--source tall-grass]
//
// Inputs, found from the course: the Unity surface map in its GSPro export
// folder (<prefix>-<terrain>-surfaces.json, written by the bridge command
// golfmap.surfaces.export; without it the app's drawn features stand in, which
// misses OPCD's Outer_Deep fill), the site's building survey
// (sources/<site>/buildings.geojson, fetch-buildings) and OSM road centerlines
// (sources/<site>/roads-centerlines.geojson, fetch-roads).
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService, courseSlug, venvPython } from '../server/services/gspro-export.service';
import { BUILDINGS_SURVEY, ROAD_CENTERLINES } from '../server/services/terrain-generators.service';

const ROOT = path.resolve(import.meta.dir, '..');
const PIPELINE = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const PASS = ['max-distance', 'spill', 'feather', 'band-feather', 'noise', 'zone-type', 'source', 'building-margin', 'road-margin'];

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run grass:zones -- <course> [--terrain inner|outer] [--dry-run] [--no-export] '
        + `[${PASS.map((p) => `--${p} <v>`).join('] [')}]`);
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run' || name === 'no-export') { flags[name] = true; continue; }
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    flags[name] = v;
}
const ident = positional[0] ?? usage();
const terrain = (flags['terrain'] as string | undefined) ?? 'inner';
if (terrain !== 'inner' && terrain !== 'outer') usage('--terrain must be inner or outer');
const source = (flags['source'] as string | undefined) ?? 'tall-grass';

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const exporter = new GsproExportService({
    db, courses, assets: new AssetsService(db, dataDir), dataDir,
    terrainEdits: new TerrainEditsService(db), pipelineDir: PIPELINE,
});

try {
    const rows = await db.selectFrom('courses').select(['id', 'name', 'site_id']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const course = pick[0];
    const { dir } = await exporter.settings(course.id);
    const surfaces = path.join(dir, `${courseSlug(course.name)}-${terrain}-surfaces.json`);
    const sources = course.site_id ? path.join(dataDir, 'sources', course.site_id) : null;
    const buildings = sources ? path.join(sources, BUILDINGS_SURVEY) : null;
    const roads = sources ? path.join(sources, ROAD_CENTERLINES) : null;

    const work = mkdtempSync(path.join(tmpdir(), 'grass-zones-'));
    const out = path.join(work, 'tall-grass.geojson');
    const args = ['grass_zones.py', '--db', dbPath, '--course', course.id, '--out', out];
    if (existsSync(surfaces)) args.push('--surfaces', surfaces);
    else console.warn(`warning: no surface map at ${surfaces}; using the app's drawn features (misses OPCD's Outer_Deep fill). Run the bridge command golfmap.surfaces.export first.`);
    if (buildings && existsSync(buildings)) args.push('--buildings', buildings);
    else console.warn(`warning: no building survey (${buildings ?? 'course has no site'}); houses are not kept clear. Run golfpipe fetch-buildings.`);
    if (roads && existsSync(roads)) args.push('--roads', roads);
    else console.warn(`warning: no road centerlines (${roads ?? 'course has no site'}); only golf-map path features keep roads clear.`);
    for (const p of PASS) if (typeof flags[p] === 'string') args.push(`--${p}`, flags[p] as string);

    const proc = Bun.spawnSync([venvPython(PIPELINE), ...args], { cwd: PIPELINE, stdout: 'pipe', stderr: 'pipe' });
    const text = (proc.stdout.toString() + proc.stderr.toString()).split('\n').filter((l) => l && !l.includes("'Memory' driver")).join('\n');
    console.log(text);
    if (proc.exitCode !== 0) throw new Error(`grass_zones.py failed (${proc.exitCode})`);

    if (flags['dry-run']) {
        console.log(`dry run: not imported (${out})`);
    } else {
        const collection = await Bun.file(out).json();
        const r = await new CourseFeaturesService(db).replaceGenerated(course.id, source, collection);
        console.log(`${course.name}: replaced ${r.deleted} '${source}' zones with ${r.inserted}`);
        if (!flags['no-export']) {
            const job = await exporter.start(course.id, { kind: 'zones', terrain });
            await exporter.whenIdle(course.id);
            const done = exporter.job(job.id);
            if (done.status !== 'succeeded') throw new Error(`zones export failed: ${done.error}`);
            console.log(done.result!.report.map((l) => `  ${l}`).join('\n'));
            console.log(`next, in Unity: golfmap.zones.import {terrain: "${terrain}", package: "GolfMap lower vegetation"}, then golfmap.grass.apply`);
        }
    }
    rmSync(work, { recursive: true, force: true });
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
