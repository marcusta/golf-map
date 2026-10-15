// Vegetation generators: the rules that plant a course's lower vegetation
// (tall rough, creek banks, ...) as generated `vegetation_zone` features.
// Each generator is a strategy: a pipeline script, the zone `source` it owns
// (a run replaces exactly those zones; hand-drawn zones are never touched),
// the zone types it writes, and the inputs it needs. `generateVegetation` is
// the one handler that runs them; GsproExportService.plantVegetation wraps it
// with the zones export and the Unity import (the Vegetation mode's "Plant
// vegetation" button and `bun run grass:zones`).
//
// Adding a kind of vegetation = one more entry in VEGETATION_GENERATORS.
// Their order is the zone stack's: a later generator's zones are imported
// after (above) the earlier ones' and claim the ground first, so a run from
// one generator re-runs every one after it too.
//
// A course can set its own rules: docs/gspro/<course slug>/vegetation-rules.json gives
// each generator flags of its script (Vreta: the tall rough 0.6 as thick beyond 20 m
// from play, 0.3 beyond 50 m); the CLI's tuning flags come after them and win.
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CourseFeaturesService, GeneratedFeatureCollection } from './course-features.service';
import { DEFAULT_ZONE_TYPES, type CourseZoneType, type ZoneTypesService } from './zone-types.service';
import { CREEK_BANK_ZONE_TYPE } from '../../shared/features/creek-vegetation';

/** What the generators read, found from the course by the caller (null = not there). */
export interface VegetationInputs {
    /** The terrain's Unity surface map (`<prefix>-<terrain>-surfaces.json`, bridge `golfmap.surfaces.export`); its DEM sidecar sits next to it. */
    surfaces: string | null;
    /** The site's building survey (fetch-buildings), EPSG:3006 GeoJSON. */
    buildings: string | null;
    /** The site's road centerlines with widths (fetch-roads), EPSG:3006 GeoJSON. */
    roads: string | null;
}

/** A generator's command for one run, or why it cannot run on this course now. */
export type VegetationCommand = { args: string[]; notes?: string[] } | { skip: string };

export interface VegetationGenerator {
    /** The generated zones' `source`: its id, and what a run replaces. */
    readonly source: string;
    /** For reports: "tall rough", "creek banks". */
    readonly label: string;
    /** The pipeline script (relative to the pipeline dir); it takes `--course <id> --out <geojson>` plus `args`. */
    readonly script: string;
    /** The zone types it writes: added to a course that lacks them (from DEFAULT_ZONE_TYPES). */
    readonly zoneTypes: readonly string[];
    command(inputs: VegetationInputs): VegetationCommand;
}

/** Buildings and roads kept clear, when the site has them. */
function clearanceArgs(inputs: VegetationInputs): { args: string[]; notes: string[] } {
    const args: string[] = [];
    const notes: string[] = [];
    if (inputs.buildings) args.push('--buildings', inputs.buildings);
    else notes.push('no building survey: houses are not kept clear (fetch the buildings in the terrain tools)');
    if (inputs.roads) args.push('--roads', inputs.roads);
    else notes.push('no road centerlines: only the course\'s path features keep roads clear (fetch the roads)');
    return { args, notes };
}

const NO_SURFACE_MAP = 'no surface map from Unity - run golfmap.surfaces.export in the course\'s Unity project';

/** Tall rough by rule (pipeline/grass_zones.py): deep rough and the rough's edge, kept off play, water, houses and roads. */
export const TALL_GRASS: VegetationGenerator = {
    source: 'tall-grass',
    label: 'tall rough',
    script: 'grass_zones.py',
    zoneTypes: ['rough_tall'],
    command(inputs) {
        const { args, notes } = clearanceArgs(inputs);
        // Without the surface map the app's drawn features stand in (they miss OPCD's Outer_Deep fill).
        if (inputs.surfaces) args.push('--surfaces', inputs.surfaces);
        else notes.push(`${NO_SURFACE_MAP}; the drawn features stand in (they miss OPCD's Outer_Deep fill)`);
        return { args, notes };
    },
};

/** Creek and pond banks (pipeline/creek_bank_zones.py): the marked creeks and water, and the creek_bank sections. */
export const CREEK_BANKS: VegetationGenerator = {
    source: 'creek-bank',
    label: 'creek banks',
    script: 'creek_bank_zones.py',
    zoneTypes: [CREEK_BANK_ZONE_TYPE],
    command(inputs) {
        // The banks come from the DEM next to the surface map: nothing to go on without it.
        if (!inputs.surfaces) return { skip: NO_SURFACE_MAP };
        const { args, notes } = clearanceArgs(inputs);
        return { args: ['--surfaces', inputs.surfaces, ...args], notes };
    },
};

/**
 * The floor under the trees (pipeline/woodland_floor_zones.py): heath, bilberry, herb or fern by
 * tree kind and terrain, plus the brush along a stand's rim. Above the tall rough, which it
 * replaces under the trees, and below the creek banks.
 */
export const WOODLAND_FLOOR: VegetationGenerator = {
    source: 'woodland-floor',
    label: 'woodland floor',
    script: 'woodland_floor_zones.py',
    zoneTypes: ['woodland_floor'],
    command(inputs) {
        // The terrain's DEM and planted trees sit next to the surface map: nothing to go on without it.
        if (!inputs.surfaces) return { skip: NO_SURFACE_MAP };
        const { args, notes } = clearanceArgs(inputs);
        return { args: ['--surfaces', inputs.surfaces, ...args], notes };
    },
};

/** Every generator, in zone-stack order (later = on top). */
export const VEGETATION_GENERATORS: readonly VegetationGenerator[] = [TALL_GRASS, WOODLAND_FLOOR, CREEK_BANKS];

/** The generators a run from `from` (a source) covers: it and every one after it, which keeps the stack order. */
export function generatorsFrom(from: string | undefined, all: readonly VegetationGenerator[] = VEGETATION_GENERATORS): VegetationGenerator[] {
    if (from === undefined) return [...all];
    const i = all.findIndex((g) => g.source === from);
    if (i < 0) throw new UnknownVegetationGeneratorError(from, all);
    return all.slice(i);
}

export class UnknownVegetationGeneratorError extends Error {
    constructor(source: string, all: readonly VegetationGenerator[]) {
        super(`No vegetation generator '${source}' (have: ${all.map((g) => g.source).join(', ')})`);
    }
}

export interface VegetationDeps {
    features: CourseFeaturesService;
    zoneTypes: ZoneTypesService;
    pipelineDir: string;
    /** The app database the scripts read (`--db`); omitted = the pipeline's default, data/app.sqlite, as the other exports. */
    dbPath?: string;
    /** Runs a pipeline script (args[0] is the script path); throws with the script's output on failure. */
    run(what: string, args: string[], out: string): Promise<{ report: string[] }>;
}

/** The course's own generator rules: `docs/gspro/<course slug>/vegetation-rules.json`. */
export const VEGETATION_RULES_FILE = 'vegetation-rules.json';
export const VEGETATION_RULES_FORMAT = 'golfmap-vegetation-rules-v1';

/** A course's rules file, read: the flags per generator source, and the file they came from (for the report). */
export interface CourseVegetationRules {
    file: string;
    args: Record<string, string[]>;
}

/**
 * The flags a course's rules file gives each generator:
 * `{"format": "golfmap-vegetation-rules-v1", "generators": {"tall-grass": {"far-start": 8, ...}}}`
 * -> `{"tall-grass": ["--far-start", "8", ...]}`. Keys are the script's own flag names; keys
 * starting with `_` are comments. Throws on a source no generator has or a value that is not
 * a number or string, so a typo does not plant the course with the defaults unnoticed. Pure.
 */
export function vegetationRulesArgs(doc: unknown, file: string,
                                    all: readonly VegetationGenerator[] = VEGETATION_GENERATORS): Record<string, string[]> {
    const d = doc as { format?: unknown; generators?: unknown } | null;
    if (!d || d.format !== VEGETATION_RULES_FORMAT || typeof d.generators !== 'object' || d.generators === null) {
        throw new Error(`${file}: not ${VEGETATION_RULES_FORMAT} (needs "format" and a "generators" object)`);
    }
    const out: Record<string, string[]> = {};
    for (const [source, flags] of Object.entries(d.generators as Record<string, unknown>)) {
        if (source.startsWith('_')) continue;
        if (!all.some((g) => g.source === source)) {
            throw new Error(`${file}: no vegetation generator '${source}' (have: ${all.map((g) => g.source).join(', ')})`);
        }
        const args: string[] = [];
        for (const [name, value] of Object.entries((flags ?? {}) as Record<string, unknown>)) {
            if (name.startsWith('_')) continue;
            if (!/^[a-z][a-z0-9-]*$/.test(name) || (typeof value !== 'number' && typeof value !== 'string')) {
                throw new Error(`${file}: ${source}.${name} must be a flag name with a number or string value`);
            }
            args.push(`--${name}`, String(value));
        }
        out[source] = args;
    }
    return out;
}

export interface VegetationOptions {
    /** Run this generator and every one after it (default: all). */
    from?: string;
    /** Write the GeoJSON only: nothing replaced, no zone types added. */
    dryRun?: boolean;
    /** The course's own rules (its vegetation-rules.json), before `extraArgs`. */
    courseRules?: CourseVegetationRules | null;
    /** Extra arguments per generator source (the CLI's tuning flags); after the course's rules, so they win. */
    extraArgs?: Record<string, string[]>;
    /** Where the GeoJSON files go (`<workDir>/<source>.geojson`). */
    workDir: string;
    /** The generators to choose from (tests); default VEGETATION_GENERATORS. */
    generators?: readonly VegetationGenerator[];
}

export interface VegetationRun {
    source: string;
    /** Zones written (or, dry run, generated); null when the generator was skipped. */
    zones: number | null;
    out: string | null;
}

/**
 * Run the generators over the course: each writes its zones as GeoJSON, which
 * replaces that generator's previous zones (in registry order, so the stack
 * order holds). Adds the zone types they use to a course that lacks them, and
 * warns when zones use a mix with no items (nothing grows there - e.g. a
 * creek_bank section left on "Default").
 */
export async function generateVegetation(deps: VegetationDeps, courseId: string, inputs: VegetationInputs,
                                         opts: VegetationOptions): Promise<{ runs: VegetationRun[]; report: string[] }> {
    const report: string[] = [];
    const runs: VegetationRun[] = [];
    for (const g of generatorsFrom(opts.from, opts.generators ?? VEGETATION_GENERATORS)) {
        const command = g.command(inputs);
        if ('skip' in command) {
            report.push(`${g.label}: not planted (${command.skip})`);
            runs.push({ source: g.source, zones: null, out: null });
            continue;
        }
        for (const note of command.notes ?? []) report.push(`${g.label}: warning: ${note}`);
        const own = opts.courseRules?.args[g.source] ?? [];
        if (own.length) report.push(`${g.label}: the course's rules (${opts.courseRules!.file}): ${own.join(' ')}`);
        const out = path.join(opts.workDir, `${g.source}.geojson`);
        const ran = await deps.run(`${g.label} vegetation`, [
            path.join(deps.pipelineDir, g.script), ...(deps.dbPath ? ['--db', deps.dbPath] : []), '--course', courseId, '--out', out,
            ...command.args, ...own, ...(opts.extraArgs?.[g.source] ?? []),
        ], out);
        report.push(...ran.report.filter((l) => !l.includes("'Memory' driver")));
        const collection = JSON.parse(await readFile(out, 'utf8')) as GeneratedFeatureCollection;
        if (opts.dryRun) {
            report.push(`${g.label}: ${collection.features.length} zones (dry run: not imported, ${out})`);
            runs.push({ source: g.source, zones: collection.features.length, out });
            continue;
        }
        const r = await deps.features.replaceGenerated(courseId, g.source, collection);
        report.push(`${g.label}: replaced ${r.deleted} zones with ${r.inserted}`);
        runs.push({ source: g.source, zones: r.inserted, out });
        if (r.inserted > 0) report.push(...await ensureZoneTypes(deps.zoneTypes, courseId, g.zoneTypes));
        report.push(...emptyMixWarnings(collection, await deps.zoneTypes.listByCourse(courseId)));
    }
    return { runs, report };
}

async function ensureZoneTypes(zoneTypes: ZoneTypesService, courseId: string, keys: readonly string[]): Promise<string[]> {
    const have = new Set((await zoneTypes.listByCourse(courseId)).map((t) => t.key));
    const lines: string[] = [];
    for (const key of keys) {
        if (have.has(key)) continue;
        const d = DEFAULT_ZONE_TYPES.find((t) => t.key === key);
        if (!d) continue;
        const t = await zoneTypes.create({ courseId, key: d.key, name: d.name, color: d.color });
        lines.push(`added zone type ${t.key}: bind its items (Vegetation mode: Edit zone types...)`);
    }
    return lines;
}

/** One warning per (zone type, variant) the zones use whose mix binds no items. Pure + exported for tests. */
export function emptyMixWarnings(collection: GeneratedFeatureCollection, types: readonly CourseZoneType[]): string[] {
    const used = new Map<string, number>();
    for (const f of collection.features) {
        const p = f.properties ?? {};
        const key = `${String(p.zoneType ?? '')}/${typeof p.zoneVariant === 'string' ? p.zoneVariant : ''}`;
        used.set(key, (used.get(key) ?? 0) + 1);
    }
    const lines: string[] = [];
    for (const [key, n] of used) {
        const [typeKey, variant] = key.split('/') as [string, string];
        const type = types.find((t) => t.key === typeKey);
        if (!type) continue;  // added above, or not this course's: its bindings are reported there
        const mix = variant ? type.variants.find((v) => v.key === variant) : type;
        if (mix && mix.items.length > 0) continue;
        const what = variant ? (mix ? `variant '${variant}'` : `variant '${variant}' (the type has none by that key)`) : 'Default mix';
        lines.push(`warning: ${n} ${typeKey} zones use its ${what}, which has no items: nothing grows there - pick a palette that has items`);
    }
    return lines;
}
