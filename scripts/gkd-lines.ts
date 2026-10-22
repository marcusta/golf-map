// The GreenKeeper course file's hazard lines (GsproExportService.gkdLines -> `gspro.py gkd-lines`; the same lines
// Furniture › Rules lines shows): an automatic line staked round each water body no drawn penalty line holds, each
// drawn penalty line as drawn, the inner OOB rings, each with GSPro's "no as it lies" (noAIL).
//
//   bun run gkd:lines -- <course> [list] [--json]
//        one line per hazard: kind, the features it comes from, noAIL, length. --json prints the pipeline's answer.
//   bun run gkd:lines -- <course> adopt <water,...> [--type penalty_red|penalty_yellow] [--dry-run]
//        Furniture's "Edit line": the automatic line holding exactly those waters becomes a drawn penalty line
//        (red unless --type), fitted as a smooth B-spline (web/src/geo/hazard-line-fit.ts), on the waters' hole when
//        they share one (else course level), keeping its noAIL. The water then gets no automatic line.
//   bun run gkd:lines -- <course> ail <feature,...> on|off [--dry-run]
//        Furniture's "Play as it lies" on drawn penalty lines or on waters (an automatic line takes noAIL from any
//        of its waters): on = played as it lies (the default; `noAsItLies` cleared), off = a ball inside the line
//        must be dropped (`noAsItLies: true`).
//
// <course> is a course id or a unique name substring; a feature is its id or its number (#12). The lines are what
// the next "Update course file" writes into the .GKD. Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { CourseFeaturesService, type CourseFeature } from '../server/services/course-features.service';
import { GsproExportService, type GkdHazardLine } from '../server/services/gspro-export.service';
import { fitHazardLine, ringPerimeterM } from '../web/src/geo/hazard-line-fit';
import { NO_AS_IT_LIES_TYPES, holeOfWaters, noAsItLiesOf, withNoAsItLies } from '../shared/features/no-as-it-lies';

const ROOT = path.resolve(import.meta.dir, '..');
const PENALTY_TYPES = ['penalty_red', 'penalty_yellow'];

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run gkd:lines -- <course> [list] [--json]',
        '       bun run gkd:lines -- <course> adopt <water,...> [--type penalty_red|penalty_yellow] [--dry-run]',
        '       bun run gkd:lines -- <course> ail <feature,...> on|off [--dry-run]',
    ].join('\n'));
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === 'json' || name === 'dry-run') { flags[name] = true; continue; }
    if (name !== 'type') usage(`unknown flag ${a}`);
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    flags[name] = v;
}
const [ident, verb = 'list', list, onOff] = positional;
if (!ident) usage();
if (verb !== 'list' && verb !== 'adopt' && verb !== 'ail') usage(`unknown verb '${verb}'`);
if (verb === 'list' && list) usage('list takes no features');
if (verb !== 'list' && !list) usage(`${verb} needs the features, comma-separated`);
if (verb === 'ail' && onOff !== 'on' && onOff !== 'off') usage('ail ends with on (played as it lies) or off (no as it lies)');
const penaltyType = (flags['type'] as string | undefined) ?? 'penalty_red';
if (!PENALTY_TYPES.includes(penaltyType)) usage(`--type must be one of ${PENALTY_TYPES.join(', ')}`);
const dryRun = flags['dry-run'] === true;

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const features = new CourseFeaturesService(db);
const exporter = new GsproExportService({
    db, courses, assets: new AssetsService(db, dataDir), dataDir, terrainEdits: new TerrainEditsService(db),
    pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
});

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

/** The features named by `arg` (ids or numbers, comma-separated), each once. */
function pick(all: CourseFeature[], arg: string): CourseFeature[] {
    const byId = new Map(all.map((f) => [f.id, f]));
    const out = new Map<string, CourseFeature>();
    for (const token of arg.split(',').map((s) => s.trim()).filter(Boolean)) {
        const no = /^#?(\d+)$/.exec(token);
        const hit = no ? all.find((f) => f.no === Number(no[1])) : byId.get(token);
        if (!hit) usage(`'${token}' is not a feature of this course`);
        out.set(hit.id, hit);
    }
    return [...out.values()];
}

const named = (f: CourseFeature | undefined, id: string) => (f ? `${f.no !== null ? `#${f.no} ` : ''}${f.type} ${f.id}` : `${id} (gone)`);
const noAil = (on: boolean) => (on ? 'noAIL on ' : 'noAIL off');

function describe(line: GkdHazardLine, byId: Map<string, CourseFeature>): string {
    const length = `${Math.round(ringPerimeterM(line.points))} m`.padStart(7);
    const from = line.kind === 'water'
        ? (line.waterIds ?? []).map((id) => named(byId.get(id), id)).join(', ')
        : named(byId.get(line.featureId!), line.featureId!);
    return `  ${line.kind.padEnd(9)} ${length}  ${noAil(line.noAsItLies)}  ${from}`;
}

try {
    const course = await resolveCourse(ident);
    const all = await features.listByCourse(course.id);
    const byId = new Map(all.map((f) => [f.id, f]));

    if (verb === 'list') {
        const doc = await exporter.gkdLines(course.id);
        if (flags['json']) {
            console.log(JSON.stringify(doc, null, 1));
        } else {
            const count = (kind: string) => doc.lines.filter((l) => l.kind === kind).length;
            console.log(`${course.name}: ${doc.lines.length} hazard line(s) — ${count('water')} round water, ${count('penalty')} drawn penalty, `
                + `${count('inner_oob')} inner OOB; water staked ${doc.rule.marginM} m out, to where the bank flattens, at most ${doc.rule.bankMaxM} m`);
            for (const line of doc.lines) console.log(describe(line, byId));
        }
    } else if (verb === 'adopt') {
        const waters = pick(all, list!);
        const notWater = waters.find((f) => f.type !== 'water' && f.type !== 'water_creek');
        if (notWater) usage(`${named(notWater, notWater.id)} is not water`);
        const want = waters.map((f) => f.id).sort().join(',');
        const doc = await exporter.gkdLines(course.id);
        const autos = doc.lines.filter((l) => l.kind === 'water');
        const line = autos.find((l) => [...(l.waterIds ?? [])].sort().join(',') === want);
        if (!line) {
            const near = autos.filter((l) => l.waterIds?.some((id) => want.split(',').includes(id)));
            throw new Error(near.length
                ? `no automatic line holds exactly those waters; ${near.map((l) => `one holds ${(l.waterIds ?? []).map((id) => named(byId.get(id), id)).join(', ')}`).join('; ')}`
                : 'no automatic line holds them (a drawn penalty line may already hold them, or they lie outside the course)');
        }
        const fit = fitHazardLine(line.points);
        const holeId = holeOfWaters(waters);
        const hole = holeId ? await db.selectFrom('holes').select('number').where('id', '=', holeId).executeTakeFirst() : undefined;
        const where = hole ? `hole ${hole.number}` : 'course level';
        const summary = `${penaltyType} round ${waters.map((f) => named(f, f.id)).join(', ')} on ${where}: `
            + `${fit.controls.length} control points over ${Math.round(fit.perimeterM)} m, within ${fit.maxDeviation.toFixed(2)} m of the line, ${noAil(line.noAsItLies).trim()}`;
        if (dryRun) {
            console.log(`would draw ${summary}`);
            console.log('dry run, nothing stored');
        } else {
            const created = await features.create({
                courseId: course.id, holeId, type: penaltyType,
                geometry: { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points: fit.controls }] },
                attributes: line.noAsItLies ? withNoAsItLies(null, true) : null,
            });
            console.log(`drew ${summary}`);
            console.log(`  new feature ${named(created, created.id)}; the water gets no automatic line now`);
        }
    } else {
        const targets = pick(all, list!);
        const wrong = targets.find((f) => !NO_AS_IT_LIES_TYPES.includes(f.type));
        if (wrong) usage(`${named(wrong, wrong.id)} carries no "no as it lies" (only ${NO_AS_IT_LIES_TYPES.join(', ')} do)`);
        const noAsItLies = onOff === 'off';
        const changed = targets.filter((f) => noAsItLiesOf(f.attributes) !== noAsItLies);
        for (const f of targets) {
            console.log(`  ${named(f, f.id)}: ${changed.includes(f) ? `${dryRun ? 'would set' : 'set'} ${noAil(noAsItLies).trim()}` : `already ${noAil(noAsItLies).trim()}`}`);
        }
        if (!dryRun && changed.length) {
            await features.updateMany(changed.map((f) => ({ id: f.id, version: f.version, attributes: withNoAsItLies(f.attributes, noAsItLies) })));
        }
        console.log(dryRun ? 'dry run, nothing stored' : `${changed.length} feature(s) changed; the next course file export carries it`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
