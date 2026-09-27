// Vegetation zones and their zone-type bindings from the command line, through
// the same services the web editor uses (validation, stack order), so an agent
// can author the zones that `gspro:export zones` rasterizes for Unity.
//
//   bun run zones -- types <course>                      zone types, their Default VSP item bindings and
//                                                        each variant's
//   bun run zones -- list <course>                       vegetation_zone features (with their variant)
//   bun run zones -- add <course> <zoneType> --from-feature <id|prefix> [--variant key] [--weight 1] [--feather 2] [--noise 0]
//                        [--blend replace|mix] [--also 'type[/variant][=weight], ...']
//                                                        new course-level zone with another feature's outline
//                                                        (e.g. a deep_rough polygon); prints its id
//   bun run zones -- set <course> <zoneId|prefix> [--variant key|''] [--weight x] [--feather m] [--noise m]
//                        [--blend replace|mix] [--also 'type[/variant][=weight], ...'|'']
//   bun run zones -- remove <course> <zoneId|prefix>
//   bun run zones -- update <course> <zoneId|prefix>...  re-rasterize just those zones' area into the exported masks
//                                                        and respawn it in the open Unity project (the web's
//                                                        "Update in Unity"; GsproExportService.updateZones)
//   bun run zones -- bind <course> <zoneType> [--variant key] --palette <grass-palette.json>   bindings = that palette's items
//   bun run zones -- bind <course> <zoneType> [--variant key] <item>[=maxDensity] ...        bindings given directly
//                                                        (`--name <label>` names the variant, e.g. for the creek panel)
//   bun run zones -- creeks <course>                     water_creek and water features and their bank vegetation
//   bun run zones -- creek <course> <creekId|prefix> --palette <default|variant|none> [--cover 0.5] [--max 4.5] [--wet 1]
//                                                        mark a creek or water for bank vegetation (shared/features/creek-vegetation.ts);
//                                                        `bun run grass:zones` then plants it
//
// A zone's variant (`zoneVariant`) picks one of its type's named item mixes;
// none (or '') is the type's Default items. `bind --variant <key>` sets that
// variant's items instead of the Default ones, creating the variant (name =
// key) if the type does not have it; with --palette it reads the palette
// keyed `<zoneType>/<variant>`, else `<variant>`.
//
// A new zone goes on top of the course-level zone stack, so where it overlaps
// another zone (a lidar woodland-floor stand) it claims its weight first -
// unless it has `--blend mix`, which plants over the zones below instead of
// taking their share (reeds in a pond's palette). `--also` gives the zone more
// palettes on the same footprint, each at the zone's weight times its own
// (shared/features/zone-layers.ts); '' clears them.
// Reads data/app.sqlite (DB_PATH) like the server.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CourseFeaturesService, type FeatureAttributes } from '../server/services/course-features.service';
import { DEFAULT_ZONE_TYPES, ZoneTypesService } from '../server/services/zone-types.service';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService } from '../server/services/gspro-export.service';
import {
    BANK_VEG_ATTRIBUTE, BANK_VEG_COVER_ATTRIBUTE, BANK_VEG_MAX_ATTRIBUTE, BANK_VEG_WET_ATTRIBUTE, CREEK_BANK_ZONE_TYPE, bankVegCoverOf, bankVegOf,
    takesBankVeg,
} from '../shared/features/creek-vegetation';
import {
    ZONE_BLENDS, ZONE_BLEND_ATTRIBUTE, ZONE_EXTRA_PALETTES_ATTRIBUTE, formatZonePalettes, parseZonePalettes, zoneBlendOf,
    zoneExtraPalettesOf,
} from '../shared/features/zone-layers';

const ROOT = path.resolve(import.meta.dir, '..');
const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run zones -- types|list <course> | add <course> <zoneType> --from-feature <id> [--variant --weight --feather --noise --blend --also]\n'
        + '       | set <course> <zoneId> [--variant --weight --feather --noise --blend --also] | remove <course> <zoneId> | update <course> <zoneId>...\n'
        + '       | bind <course> <zoneType> [--variant <key> [--name <label>]] (--palette <grass-palette.json> | <item>[=maxDensity]...)\n'
        + '       | creeks <course> | creek <course> <creekId> --palette <default|variant|none> [--cover 0-1] [--max m] [--wet m]');
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
        const v = process.argv[++i];
        if (v === undefined) usage(`${a} needs a value`);
        flags[a.slice(2)] = v;
    } else positional.push(a);
}

function num(name: string): number | undefined {
    if (flags[name] === undefined) return undefined;
    const n = Number(flags[name]);
    if (!Number.isFinite(n)) usage(`--${name} must be a number`);
    return n;
}

if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const features = new CourseFeaturesService(db);
const zoneTypes = new ZoneTypesService(db);

async function course(ident: string) {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const hit = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = hit.length === 1 ? hit : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}': ${pick.map((r) => r.name).join(', ')}`);
    return pick[0];
}

async function featureByPrefix(courseId: string, prefix: string) {
    const rows = await db.selectFrom('course_features').select(['id', 'type']).where('course_id', '=', courseId).execute();
    const hit = rows.filter((r) => r.id.toLowerCase().startsWith(prefix.toLowerCase()));
    if (hit.length !== 1) usage(`${hit.length ? 'several features' : 'no feature'} with id ${prefix}`);
    return features.findById(hit[0].id);
}

async function zoneType(courseId: string, key: string) {
    const all = await zoneTypes.listByCourse(courseId);
    if (key === CREEK_BANK_ZONE_TYPE && !all.some((z) => z.key === key)) {
        // A course seeded before creek_bank was a default: add it on first use.
        const { key: k, name, color } = DEFAULT_ZONE_TYPES.find((z) => z.key === key)!;
        all.push(await zoneTypes.create({ courseId, key: k, name, color }));
    }
    const t = all.find((z) => z.key === key);
    if (!t) usage(`no zone type '${key}' (have: ${all.map((z) => z.key).join(', ')})`);
    return t;
}

type ZoneTypeRow = Awaited<ReturnType<typeof zoneType>>;
type Items = { item: string; minDensity: number; maxDensity: number }[];

/** `--variant` must name one of the type's variants; '' is the Default mix. */
function variantFlag(t: ZoneTypeRow): string | undefined {
    const v = flags['variant'];
    if (v === undefined || v === '') return v;
    if (!t.variants.some((x) => x.key === v)) {
        usage(`zone type '${t.key}' has no variant '${v}' (have: ${t.variants.map((x) => x.key).join(', ') || 'none'})`);
    }
    return v;
}

function zoneAttributes(base: FeatureAttributes, variant?: string): FeatureAttributes {
    const out: FeatureAttributes = { ...base };
    for (const k of ['weight', 'feather', 'noise']) {
        const v = num(k);
        if (v !== undefined) out[k] = v;
    }
    if (variant !== undefined) out.zoneVariant = variant;
    return out;
}

/**
 * `--blend` and `--also` into `out`. Every extra palette must name a zone type
 * of the course and, when it has one, a variant of that type.
 */
async function layerFlags(courseId: string, out: FeatureAttributes): Promise<FeatureAttributes> {
    const blend = flags['blend'];
    if (blend !== undefined) {
        if (!(ZONE_BLENDS as readonly string[]).includes(blend)) usage(`--blend must be one of ${ZONE_BLENDS.join(', ')}`);
        out[ZONE_BLEND_ATTRIBUTE] = blend;
    }
    const also = flags['also'];
    if (also !== undefined) {
        const parsed = parseZonePalettes(also);
        if ('error' in parsed) usage(`--also: ${parsed.error}`);
        const all = await zoneTypes.listByCourse(courseId);
        for (const e of parsed.palettes) {
            const t = all.find((z) => z.key === e.zoneType);
            if (!t) usage(`--also: no zone type '${e.zoneType}' (have: ${all.map((z) => z.key).join(', ')})`);
            if (e.zoneVariant && !t.variants.some((v) => v.key === e.zoneVariant)) {
                usage(`--also: zone type '${t.key}' has no variant '${e.zoneVariant}' (have: ${t.variants.map((v) => v.key).join(', ') || 'none'})`);
            }
        }
        out[ZONE_EXTRA_PALETTES_ATTRIBUTE] = formatZonePalettes(parsed.palettes);
    }
    return out;
}

const itemList = (items: Items) => items.map((i) => `${i.item} x${i.maxDensity}`).join(', ') || 'no items';

const [command, ident, arg] = positional;
try {
    if (!command || !ident) usage();
    const c = await course(ident);
    if (command === 'types') {
        for (const t of await zoneTypes.listByCourse(c.id)) {
            console.log(`${t.key} (${t.name}) Default: ${itemList(t.items)}`);
            for (const v of t.variants) console.log(`  ${t.key}/${v.key} (${v.name}): ${itemList(v.items)}`);
        }
    } else if (command === 'list') {
        const zones = (await features.listByCourse(c.id)).filter((f) => f.type === 'vegetation_zone');
        for (const z of zones) {
            const variant = z.attributes?.zoneVariant;
            const extras = zoneExtraPalettesOf(z.attributes);
            const slot = `${z.attributes?.zoneType}${typeof variant === 'string' && variant ? `/${variant}` : ' (Default)'}`
                + (extras.length ? ` + ${formatZonePalettes(extras)}` : '')
                + (zoneBlendOf(z.attributes) === 'mix' ? ' [mix]' : '');
            console.log(`${z.id}  ${z.holeId ? 'hole' : 'course'} #${z.sortOrder}  ${slot}  ${JSON.stringify(z.attributes)}${z.source ? `  [${z.source}]` : ''}`);
        }
    } else if (command === 'add') {
        if (!arg) usage('add needs a zone type');
        const variant = variantFlag(await zoneType(c.id, arg));
        if (!flags['from-feature']) usage('add needs --from-feature <id>');
        const from = await featureByPrefix(c.id, flags['from-feature']);
        const created = await features.create({
            courseId: c.id, holeId: null, type: 'vegetation_zone', geometry: from.geometry,
            attributes: await layerFlags(c.id, zoneAttributes({ zoneType: arg, weight: 1, feather: 2, noise: 0 }, variant)),
        });
        console.log(`${created.id}  ${arg}${variant ? `/${variant}` : ''} zone from ${from.type} ${from.id}, stack position ${created.sortOrder}`);
    } else if (command === 'set') {
        if (!arg) usage('set needs a zone id');
        const z = await featureByPrefix(c.id, arg);
        if (z.type !== 'vegetation_zone') usage(`${z.id} is a ${z.type}, not a vegetation_zone`);
        const variant = flags['variant'] === undefined
            ? undefined
            : variantFlag(await zoneType(c.id, String(z.attributes?.zoneType)));
        const updated = await features.update(z.id, z.version, { attributes: await layerFlags(c.id, zoneAttributes(z.attributes ?? {}, variant)) });
        console.log(`${updated.id}  ${JSON.stringify(updated.attributes)}`);
    } else if (command === 'update') {
        const ids = positional.slice(2);
        if (!ids.length) usage('update needs one or more zone ids');
        const zones = [];
        for (const prefix of ids) {
            const z = await featureByPrefix(c.id, prefix);
            if (z.type !== 'vegetation_zone') usage(`${z.id} is a ${z.type}, not a vegetation_zone`);
            zones.push(z.id);
        }
        const exporter = new GsproExportService({
            db, courses: new CoursesService(db), assets: new AssetsService(db, dataDir), dataDir,
            terrainEdits: new TerrainEditsService(db), pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
        });
        const started = Date.now();
        const result = await exporter.updateZones(c.id, zones);
        for (const line of result.report) console.log(line);
        console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } else if (command === 'remove') {
        if (!arg) usage('remove needs a zone id');
        const z = await featureByPrefix(c.id, arg);
        if (z.type !== 'vegetation_zone') usage(`${z.id} is a ${z.type}, not a vegetation_zone`);
        await features.remove(z.id, z.version);
        console.log(`removed ${z.id}`);
    } else if (command === 'bind') {
        if (!arg) usage('bind needs a zone type');
        const t = await zoneType(c.id, arg);
        const variantKey = flags['variant'];
        if (variantKey === '') usage('--variant needs a key (omit it to bind the Default items)');
        let items: Items;
        if (flags['palette']) {
            const doc = JSON.parse(readFileSync(flags['palette'], 'utf8'));
            const keys = variantKey ? [`${arg}/${variantKey}`, variantKey] : [arg];
            const palette = keys.map((k) => (doc.palettes ?? []).find((p: { key: string }) => p.key === k)).find(Boolean);
            if (!palette) usage(`${flags['palette']} has no palette ${keys.map((k) => `'${k}'`).join(' or ')}`);
            items = palette.items.map((i: { name: string; maxDensity?: number }) => ({ item: i.name, minDensity: 0, maxDensity: i.maxDensity ?? 1 }));
        } else {
            const specs = positional.slice(3);
            if (!specs.length) usage('bind needs --palette or item names');
            items = specs.map((s) => {
                const [item, d] = s.split('=');
                return { item, minDensity: 0, maxDensity: d === undefined ? 1 : Number(d) };
            });
        }
        if (variantKey) {
            const exists = t.variants.some((v) => v.key === variantKey);
            const name = flags['name'];
            const variants = exists
                ? t.variants.map((v) => (v.key === variantKey ? { ...v, items, name: name ?? v.name } : v))
                : [...t.variants, { key: variantKey, name: name ?? variantKey, items }];
            const updated = await zoneTypes.update(t.id, { variants });
            const v = updated.variants.find((x) => x.key === variantKey)!;
            console.log(`${updated.key}/${v.key}${exists ? '' : ' (new variant)'}: ${itemList(v.items)}`);
        } else {
            const updated = await zoneTypes.update(t.id, { items });
            console.log(`${updated.key}: ${itemList(updated.items)}`);
        }
    } else if (command === 'creeks') {
        for (const f of (await features.listByCourse(c.id)).filter((x) => takesBankVeg(x.type))) {
            const palette = bankVegOf(f.attributes);
            console.log(`${f.id}  ${f.type.padEnd(11)}  ${f.source ?? 'drawn'}  ${palette ? `bank: ${palette}, cover ${bankVegCoverOf(f.attributes)}` : 'bank: none'}`);
        }
    } else if (command === 'creek') {
        if (!arg) usage('creek needs a creek id');
        const f = await featureByPrefix(c.id, arg);
        if (!takesBankVeg(f.type)) usage(`${f.id} is a ${f.type}, not a water_creek or water`);
        const palette = flags['palette'];
        if (palette === undefined) usage('creek needs --palette <default|variant key|none>');
        const attributes: FeatureAttributes = { ...(f.attributes ?? {}) };
        if (palette === 'none' || palette === '') {
            for (const k of [BANK_VEG_ATTRIBUTE, BANK_VEG_COVER_ATTRIBUTE, BANK_VEG_MAX_ATTRIBUTE, BANK_VEG_WET_ATTRIBUTE]) delete attributes[k];
        } else {
            const t = await zoneType(c.id, CREEK_BANK_ZONE_TYPE);
            if (palette !== 'default' && !t.variants.some((v) => v.key === palette)) {
                console.warn(`warning: ${CREEK_BANK_ZONE_TYPE} has no variant '${palette}' yet (have: ${t.variants.map((v) => v.key).join(', ') || 'none'}); bind it before exporting`);
            }
            attributes[BANK_VEG_ATTRIBUTE] = palette;
            const cover = num('cover');
            if (cover !== undefined) attributes[BANK_VEG_COVER_ATTRIBUTE] = cover;
            const max = num('max');
            if (max !== undefined) attributes[BANK_VEG_MAX_ATTRIBUTE] = max;
            const wet = num('wet');
            if (wet !== undefined) attributes[BANK_VEG_WET_ATTRIBUTE] = wet;
        }
        const updated = await features.update(f.id, f.version, { attributes: Object.keys(attributes).length ? attributes : null });
        console.log(`${updated.id}  ${JSON.stringify(updated.attributes)}`);
    } else usage(`unknown command '${command}'`);
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
} finally {
    await db.destroy();
}
