// A stone wall in place of a bank, as a terrain edit (op `wall`, pipeline dem_edit._wall_target): the ground behind
// the wall's line is left alone; on its water side the ground drops straight from the line to where the bank ends in
// the lidar (a terrace, or the water: never below the shelf's floor, --level), and the ground beyond is left alone.
//
//   bun run terrain:wall -- <course> --id <name> --line "e,n e,n ..." --water <shape> [--above 0.15 | --level <m>]
//        [--reach 6] [--behind 3] [--run 0.3] [--min-shelf 0.5] [--keep <shape>]... [--keep-margin 3] [--avoid e,n,r]... [--dry-run]
//
//   --line       the wall's line (its top edge on the green side), EPSG:3006 points, west to east or any way round
//   --water      the pond the wall stands at (shape name, number or id): the wall's outer side, and the floor of its
//                foot, the pond's dug water level (the dig's recorded level) plus --above
//   --level      the floor's height instead (metres above sea level)
//   --min-shelf  the ground at the wall's foot at least this wide (0: the foot where the bank ends)
//   --reach      how far out from the line the ground is shaped (the edit's polygon), metres
//   --behind     how far behind it the plateau is kept on its own slope (raised back where a pond's bank cut it)
//   --keep       a feature whose ground must stay (another pond's bank): left out of the polygon, --keep-margin round it
//   --avoid      a circle left out (e,n,radius): a fall's sill, a bridge's footing
// The edit is stored as origin `wall`, originRef `wall:<id>` (a second run with the same id replaces it), dated now so
// it replays after the generated digs. Then: `bun run gspro:update -- <course> terrain`, terrain.obj, the meshes.
import '../server/env-paths';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { flattenRing } from '../server/services/geo';
import { wallSideOf, wallZone } from '../shared/features/wall-zone';

const ROOT = path.resolve(import.meta.dir, '..');
type Pt = { x: number; y: number };

function usage(msg?: string): never {
    if (msg) console.error(`error: ${msg}`);
    console.error('usage: bun run terrain:wall -- <course> --id <name> --line "e,n e,n ..." --water <shape> [--above 0.15 | --level <m>]\n'
        + '         [--reach 6] [--behind 3] [--run 0.3] [--min-shelf 0.5] [--keep <shape>]... [--keep-margin 3] [--avoid e,n,r]... [--dry-run]');
    process.exit(2);
}

const args = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string | true> = {};
const multi: Record<string, string[]> = { keep: [], avoid: [] };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run') { flags[name] = true; continue; }
    const v = args[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    if (name in multi) multi[name].push(v);
    else flags[name] = v;
}
const [ident] = positional;
if (!ident) usage();
const id = typeof flags.id === 'string' ? flags.id : usage('--id names the wall');
const num = (k: string, d: number) => (flags[k] === undefined ? d : Number(flags[k]));
const reach = num('reach', 6), behind = num('behind', 3), run = num('run', 0.3), minShelf = num('min-shelf', 0.5), above = num('above', 0.15), keepMargin = num('keep-margin', 3);
const line: Pt[] = String(flags.line ?? '').split(/[\s;]+/).filter(Boolean).map((s) => {
    const [x, y] = s.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) usage(`--line point '${s}' is not e,n`);
    return { x, y };
});
if (line.length < 2) usage('--line needs at least two points');

function findFeature(all: CourseFeature[], arg: string): CourseFeature {
    const q = arg.trim().toLowerCase();
    const shape = /^(?:hole_\d+|others|course)_([0-9a-f]+)$/.exec(q);
    const hits = shape ? all.filter((f) => f.no === parseInt(shape[1], 16))
        : /^\d{1,6}$/.test(q) ? all.filter((f) => f.no === Number(q))
        : all.filter((f) => f.id.toLowerCase().startsWith(q));
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
    return hits[0];
}
const ringOf = (f: CourseFeature): Pt[] => flattenRing(f.geometry.rings[0], 0.1, f.geometry.curveType).map(([x, y]) => ({ x, y }));
const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const pick = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const chosen = pick.length === 1 ? pick : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (chosen.length !== 1) usage(`${chosen.length ? 'several' : 'no'} courses match '${ident}'`);
    const course = await new CoursesService(db).get(chosen[0].id);
    if (!course.siteId) usage('the course has no built map');
    const all = await new CourseFeaturesService(db).listByCourse(course.id);

    // The shelf's level and the water side.
    let level = flags.level !== undefined ? Number(flags.level) : NaN;
    let side: 1 | -1 = 1;
    if (typeof flags.water === 'string') {
        const pond = findFeature(all, flags.water);
        if (!Number.isFinite(level)) {
            const file = path.join(dataDir, 'sources', course.siteId, 'dem-edited.water-levels.json');
            const levels = JSON.parse(await readFile(file, 'utf8').catch(() => '{"levels":{}}')).levels ?? {};
            const water = levels[`feature:${pond.id}`];
            if (typeof water !== 'number') usage(`no dug water level for ${flags.water} in ${file} (dig it with digBankAboveDeg, or give --level)`);
            level = water + above;
        }
        side = wallSideOf(line, ringOf(pond));
    }
    if (!Number.isFinite(level)) usage('give --water (its dug level + --above) or --level');

    // The polygon: the strip `reach` wide on the water side of the line, less what must stay.
    const avoid = multi.avoid.map((a) => {
        const [x, y, r] = a.split(',').map(Number);
        if (![x, y, r].every(Number.isFinite)) usage(`--avoid '${a}' is not e,n,r`);
        return { x, y, r };
    });
    const zone = wallZone(line, side, reach, multi.keep.map((k) => ringOf(findFeature(all, k))), keepMargin, avoid, behind);
    if (!zone) usage('nothing left of the polygon');
    const { rings, dropped } = zone;
    const lengthM = line.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - line[i].x, p.y - line[i].y), 0);
    console.log(`wall ${id}: ${lengthM.toFixed(1)} m line, shelf at ${level.toFixed(2)} m, face ${run} m out, shelf at least ${minShelf} m, `
        + `shaped ${reach} m out and ${behind} m behind (${rings[0].length} points${dropped ? `, ${dropped} small piece(s) dropped` : ''})`);
    if (flags['dry-run']) { console.log('dry run, nothing stored'); process.exit(0); }

    const edits = new TerrainEditsService(db);
    const ref = `wall:${id}`;
    const old = await db.selectFrom('terrain_edits').select(['id', 'version']).where('site_id', '=', course.siteId).where('origin_ref', '=', ref).execute();
    for (const r of old) await edits.remove(r.id, r.version);
    const made = await edits.create({
        siteId: course.siteId, op: 'wall', origin: 'wall', originRef: ref, rings,
        params: { featherM: 0, centerline: line, levelM: Math.round(level * 1000) / 1000, runM: run, minShelfM: minShelf },
    });
    console.log(`stored ${made.id}${old.length ? ` (replaced ${old.length})` : ''}`);
    console.log(`next: bun run gspro:update -- "${course.name}" terrain, then terrain.obj and the meshes`);
} finally {
    await db.destroy();
}
