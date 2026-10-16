// Run a course's terrain generator from the command line: the same handler as
// the terrain editor's generator buttons ("Dig ponds (DEM)", bunkers, creeks,
// building pads, road grades; TerrainGeneratorsService.generate). A run
// replaces that generator's edits for the course (a disabled edit stays
// disabled); "Apply to terrain" (`bun run gspro:update -- <course> terrain`)
// then bakes them into the DEM.
//
//   bun run terrain:generate -- <course> <water-digs|bunker-digs|creek-digs|building-pads|road-grades> [--dry-run]
//
// A dig generator can set one feature's dig settings first, the attributes the
// editor's per-feature panel writes, so a pond's profile is set and dug in one
// deterministic step:
//
//   bun run terrain:generate -- <course> water-digs --feature hole_14_53 --preset deep_water --depth 1 --bank 32
//        --feature   the shape name (hole_14_53, as in Blender and Unity), the feature number, or its id (a prefix will do);
//                    only that feature's dig is written, the others keep theirs (--all re-digs every one, as the button)
//        --preset    the feature's digPreset (shared/features/dig-presets.ts)
//        --depth / --bank / --face   digDepthM / digBankSlopeDeg / digFaceSlopeDeg (bunkers' green face)
//        --bank-above  digBankAboveDeg (ponds): the outline is the water's edge, the bank outside rises from it at this angle
//        --no-dig    marks it dig: false (left alone);  --dig  clears that
//        --reset     drops its dig settings first (back to the generator's default preset)
//
// --dry-run writes nothing, the feature's settings included: it lists every
// dig the run would write and whether it is new, changed or the same as the
// stored one, and the stored digs it would drop.
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService, FEATURE_ORIGIN_REF } from '../server/services/terrain-edits.service';
import { CourseFeaturesService, type CourseFeature, type FeatureAttributes } from '../server/services/course-features.service';
import { TERRAIN_GENERATOR_KINDS, TerrainGeneratorsService, type TerrainGeneratorKind } from '../server/services/terrain-generators.service';
import { CREEK_DIG_PRESETS, DIG_GENERATOR_KINDS, WATER_DIG_PRESETS, type DigGeneratorKind } from '../shared/features/dig-presets';

const ROOT = path.resolve(import.meta.dir, '..');
const DIG_TYPES: Record<DigGeneratorKind, string> = { 'water-digs': 'water', 'bunker-digs': 'bunker', 'creek-digs': 'water_creek' };
const DIG_KEYS = ['digPreset', 'digDepthM', 'digBankSlopeDeg', 'digFaceSlopeDeg', 'digBankAboveDeg', 'dig'];

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error(`usage: bun run terrain:generate -- <course> <${TERRAIN_GENERATOR_KINDS.join('|')}> [--dry-run]\n`
        + '         [--feature <shape name|number|id> [--preset <key>] [--depth <m>] [--bank <deg>] [--face <deg>] [--no-dig|--dig] [--reset]]');
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (['dry-run', 'no-dig', 'dig', 'reset', 'all'].includes(name)) { flags[name] = true; continue; }
    const v = process.argv[++i];
    if (v === undefined) usage(`--${name} needs a value`);
    flags[name] = v;
}
const [ident, kindArg] = positional;
if (!ident || !kindArg) usage();
if (!(TERRAIN_GENERATOR_KINDS as readonly string[]).includes(kindArg)) usage(`unknown generator '${kindArg}'`);
const kind = kindArg as TerrainGeneratorKind;
const isDig = (DIG_GENERATOR_KINDS as readonly string[]).includes(kind);
const dryRun = flags['dry-run'] === true;
const featureArg = flags['feature'] as string | undefined;
const settingFlags = ['preset', 'depth', 'bank', 'face', 'bank-above', 'no-dig', 'dig', 'reset'].filter((f) => f in flags);
if (!isDig && (featureArg || dryRun)) usage(`--feature and --dry-run are for the dig generators (${DIG_GENERATOR_KINDS.join(', ')})`);
if (settingFlags.length && !featureArg) usage(`--${settingFlags[0]} needs --feature`);
if (flags['no-dig'] && flags['dig']) usage('--no-dig and --dig contradict each other');

/** The attributes `--feature`'s flags ask for (validated), from the feature's current ones. */
function settingsFor(f: CourseFeature, k: DigGeneratorKind): FeatureAttributes | null {
    const attrs: FeatureAttributes = { ...(f.attributes ?? {}) };
    if (flags['reset']) for (const key of DIG_KEYS) delete attrs[key];
    const preset = flags['preset'] as string | undefined;
    if (preset !== undefined) {
        const table = k === 'water-digs' ? WATER_DIG_PRESETS : k === 'creek-digs' ? CREEK_DIG_PRESETS : null;
        if (!table) usage('bunkers have one profile, no --preset (set --depth / --bank / --face)');
        if (!(preset in table)) usage(`--preset takes ${Object.keys(table).join(', ')}`);
        attrs.digPreset = preset;
    }
    const nums: [string, string, number, number][] = [['depth', 'digDepthM', 0.05, 20], ['bank', 'digBankSlopeDeg', 1, 89], ['face', 'digFaceSlopeDeg', 1, 89], ['bank-above', 'digBankAboveDeg', 1, 89]];
    for (const [flag, key, lo, hi] of nums) {
        if (!(flag in flags)) continue;
        const v = Number(flags[flag]);
        if (!Number.isFinite(v) || v < lo || v > hi) usage(`--${flag} must be a number from ${lo} to ${hi}`);
        attrs[key] = v;
    }
    if (flags['face'] && k !== 'bunker-digs') usage('--face is the bunker face towards the green');
    if (flags['bank-above'] && k !== 'water-digs') usage('--bank-above is for ponds (water-digs)');
    if (flags['no-dig']) attrs.dig = false;
    if (flags['dig']) delete attrs.dig;
    return Object.keys(attrs).length ? attrs : null;
}

function findFeature(features: CourseFeature[], arg: string, type: string): CourseFeature {
    const q = arg.trim().toLowerCase();
    const shape = /^hole_\d+_([0-9a-f]+)$/.exec(q) ?? /^course_([0-9a-f]+)$/.exec(q);
    const hits = shape ? features.filter((f) => f.no === parseInt(shape[1], 16))
        : /^\d{1,6}$/.test(q) ? features.filter((f) => f.no === Number(q))
        : q.length >= 6 ? features.filter((f) => f.id.toLowerCase().startsWith(q)) : [];
    if (hits.length !== 1) usage(`${hits.length ? 'several features' : 'no feature'} match '${arg}'`);
    if (hits[0].type !== type) usage(`'${arg}' is a ${hits[0].type}; ${kind} digs ${type} features`);
    return hits[0];
}

const shapeName = (f: CourseFeature | undefined, holes: Map<string, number>) =>
    !f ? '(deleted feature)' : f.no === null ? f.id.slice(0, 8)
        : `${f.holeId && holes.has(f.holeId) ? `hole_${holes.get(f.holeId)}` : 'course'}_${f.no.toString(16)}`;

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const course = pick[0];
    const courses = new CoursesService(db);
    const terrainEdits = new TerrainEditsService(db);
    const courseFeatures = new CourseFeaturesService(db);
    const holes = new Map((await db.selectFrom('holes').select(['id', 'number']).where('course_id', '=', course.id).execute()).map((h) => [h.id, h.number]));

    // --feature: its dig settings, written first (a dry run only lends them to the generator).
    let override: { id: string; attributes: FeatureAttributes | null } | null = null;
    if (featureArg) {
        const k = kind as DigGeneratorKind;
        const f = findFeature(await courseFeatures.listByCourse(course.id), featureArg, DIG_TYPES[k]);
        const attributes = settingsFor(f, k);
        override = { id: f.id, attributes };
        const before = JSON.stringify(f.attributes ?? null), after = JSON.stringify(attributes);
        console.log(`${shapeName(f, holes)}: ${before === after ? `settings unchanged ${after}` : `${before} -> ${after}`}${dryRun && before !== after ? ' (dry run, not written)' : ''}`);
        if (!dryRun && before !== after) await courseFeatures.update(f.id, f.version, { attributes });
    }
    const features = dryRun && override
        ? {
            geojsonByCourse: courseFeatures.geojsonByCourse.bind(courseFeatures),
            listByCourse: async (id: string) => (await courseFeatures.listByCourse(id))
                .map((f) => f.id === override!.id ? { ...f, attributes: override!.attributes } : f),
        }
        : courseFeatures;

    const site = (await courses.get(course.id)).siteId;
    const stored = isDig && site ? (await terrainEdits.listBySite(site)).filter((e) => e.origin === kind) : [];
    const svc = new TerrainGeneratorsService({
        courses, assets: new AssetsService(db, dataDir), terrainEdits, courseFeatures: features, dataDir,
        pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
    });
    // --feature without --all: plan every dig, write only that feature's; the others keep their stored edits.
    const onlyRef = override && !flags['all'] ? FEATURE_ORIGIN_REF + override.id : null;
    let result = await svc.generate(course.id, kind, { dryRun: dryRun || onlyRef !== null });
    if (onlyRef && !dryRun) {
        const mine = (result.planned ?? []).filter((e) => e.originRef === onlyRef);
        const kept = stored.filter((e) => e.originRef !== onlyRef)
            .map((e) => ({ op: e.op, params: e.params, rings: e.rings, originRef: e.originRef, enabled: e.enabled }));
        const rows = await terrainEdits.replaceByOrigin(site!, kind, [...kept, ...mine], { courseId: course.id });
        result = { kind, imported: rows.length, skipped: result.skipped, planned: undefined,
            report: [`${mine.length ? 'dug' : 'removed the dig of'} ${featureArg} only; ${kept.length} other dig(s) of ${kind} kept as stored (--all re-digs every one)`] };
    }
    console.log(result.report.map((l) => `  ${l}`).join('\n'));
    if (result.skipped.length) console.log(`  skipped: ${result.skipped.join('; ')}`);

    if (isDig) {
        // What the run does to each dig: the plan (dry run) or what is now stored, against what was.
        const byId = new Map((await courseFeatures.listByCourse(course.id)).map((f) => [f.id, f]));
        const now = dryRun ? (result.planned ?? []).filter((e) => !onlyRef || e.originRef === onlyRef || flags['all'])
            : (await terrainEdits.listBySite(site!)).filter((e) => e.origin === kind);
        const was = new Map(stored.map((e) => [e.originRef, e]));
        const fid = (ref: string | null | undefined) => ref?.startsWith(FEATURE_ORIGIN_REF) ? ref.slice(FEATURE_ORIGIN_REF.length) : '';
        for (const e of now) {
            const old = was.get(e.originRef ?? null);
            const status = !old ? 'new' : JSON.stringify(old.params) === JSON.stringify(e.params) && JSON.stringify(old.rings) === JSON.stringify(e.rings)
                ? 'same' : JSON.stringify(old.params) === JSON.stringify(e.params) ? 'changed outline' : 'changed';
            const p = e.params;
            console.log(`  ${status.padEnd(15)} ${shapeName(byId.get(fid(e.originRef)), holes).padEnd(14)} depth ${p.depthM} m, banks ${p.bankSlopeDeg}°`
                + (p.faceSlopeDeg !== undefined ? `, face ${p.faceSlopeDeg}°` : '') + (p.shelfM !== undefined ? `, shelf ${p.shelfM} m` : ''));
            was.delete(e.originRef ?? null);
        }
        // Left over: dropped, unless the feature is another course's on the same site (its digs stay).
        const elsewhere = new Set((await db.selectFrom('course_features').select('id')
            .where('id', 'in', [...was.values()].map((e) => fid(e.originRef)).filter(Boolean).concat(['-']))
            .where('course_id', '!=', course.id).execute()).map((r) => r.id));
        const ours = [...was.values()].filter((e) => !elsewhere.has(fid(e.originRef)) && (!onlyRef || e.originRef === onlyRef));
        for (const e of ours) console.log(`  ${(dryRun ? 'would drop' : 'dropped').padEnd(15)} ${shapeName(byId.get(fid(e.originRef)), holes)}`);
        if (!dryRun) console.log(`next: bun run gspro:update -- "${course.name}" terrain   (bakes the digs into the DEM and both Unity terrains)`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
