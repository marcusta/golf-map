// The planting rules a course's vegetation is made with, gathered for reading (the
// Vegetation mode's "Planting rules" panel and `bun run vegetation:rules`). Nothing
// here plants or edits: it reads what the generators and planters read.
//
// - The generators (tall rough, woodland floor, rock shore, creek banks), in zone-stack
//   order: each rule from pipeline/vegetation-rules/<source>.json (the values the
//   scripts bind at import), with the course's own value from
//   docs/gspro/<course>/vegetation-rules.json beside it, and the zone types' mixes the
//   generator switches on (a far or dark variant only grows where the course binds items).
// - The trees: the detection and export rules (trees.json, the same for every course),
//   the species/model pick from the course's palette.json, who draws what from its
//   arborist-species.json (each described by a notes file in vegetation-rules/), and
//   the drawn tree species areas.
// - The zone palettes (grass-palette.json): each zone item with the model it refers to and who draws it
//   (the model's renderer; shared/vegetation/zone-models.ts).
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CoursesService } from './courses.service';
import type { CourseFeaturesService } from './course-features.service';
import type { ZoneTypesService } from './zone-types.service';
import { courseSlug } from './gspro-export.service';
import { loadModelLibrary, resolveAsset, type PaletteAsset } from '../../shared/vegetation/tree-models';
import { rendererOf } from '../../shared/vegetation/model-id';
import { loadZonePalettes, zoneModels, type ZoneModels } from '../../shared/vegetation/zone-models';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import {
    VEGETATION_GENERATORS, VEGETATION_RULES_FILE, readRuleDefaults,
    type RuleDefaultsDoc,
} from './vegetation-generators';
import { TREE_AREA_TYPE, speciesMixOf, treeAreaIgnoresKind, treeAreaNameOf } from '../../shared/features/tree-areas';

/** One rule as it applies to the course. */
export interface PlantingRule {
    key: string;
    unit: string | null;
    text: string;
    /** The script has a flag of this name (a CLI run can pass it too). */
    flag: boolean;
    /** The value in code's config (pipeline/vegetation-rules), null = only set per course. */
    defaultValue: unknown;
    /** Whether the course's file sets it. */
    courseSets: boolean;
    /** The course's value (null when it does not set it). */
    courseValue: unknown;
    /** What the planting uses: the course's value, else the default. */
    value: unknown;
}

export interface PlantingRuleGroup {
    title: string;
    rules: PlantingRule[];
}

/** A zone type's mix a generator writes zones of, and what the course binds to it. */
export interface PlantingMix {
    zoneType: string;
    zoneTypeName: string;
    /** '' = the Default mix. */
    variant: string;
    variantName: string;
    items: string[];
}

export interface PlantingRuleSection {
    /** Generator source, or `trees`, `tree-palette`, `arborist`. */
    source: string;
    label: string;
    /** Where it runs: the pipeline script or the Unity side. */
    script: string | null;
    summary: string;
    steps: string[];
    /** The course file its values come from (docs/gspro/<course>/...), null when it has none or the rules are the same everywhere. */
    courseFile: string | null;
    groups: PlantingRuleGroup[];
    /** Keys the course's file sets that are not rules in the defaults (a script flag such as `clearance`). */
    courseExtras: { key: string; value: unknown }[];
    /** Generators: the mixes of the zone types it writes. */
    mixes: PlantingMix[];
}

export interface TreeAreaRule {
    name: string;
    mix: string;
    ignoreKind: boolean;
}

export interface PlantingRules {
    courseId: string;
    courseName: string;
    /** docs/gspro/<slug>/, relative to the repo root. */
    courseDocs: string;
    /** The generators, bottom of the zone stack first (a later one claims the ground first). */
    generators: PlantingRuleSection[];
    trees: PlantingRuleSection[];
    treeAreas: TreeAreaRule[];
    /** The tree palette's assets per species (enabled / all). */
    treeAssets: { species: string; enabled: number; total: number }[];
    /** Each species of the palette with its weight and its models (model library: who draws it, its size), by species name. */
    treeModels: TreeSpeciesModels[];
    /** Each zone palette (grass-palette.json) in file order with its items' models and who draws each (the model's renderer); palettes of the older form, whose items name no model, are left out. */
    zoneModels: ZoneModels[];
}

export interface TreeModelRule {
    /** `arborist:<label>` or `vsp:<prefab>`. */
    id: string;
    /** What draws it in GSPro: `arborist` or `vsp`. */
    renderer: string;
    heightM: number;
    crownWidthM: number;
    enabled: boolean;
    /** The palette refers to a model its library (models.json) lacks: shown so it can be fixed, with no size. */
    missing?: boolean;
}

export interface TreeSpeciesModels {
    species: string;
    /** The palette's speciesWeights share; 0 = not raced for. */
    weight: number;
    models: TreeModelRule[];
}

export interface VegetationRulesDeps {
    courses: CoursesService;
    features: CourseFeaturesService;
    zoneTypes: ZoneTypesService;
    pipelineDir?: string;
    /** docs/gspro by default (as GsproExportService). */
    courseDocsRoot?: string;
}

/** `a.b.c` of a JSON document, or undefined. */
function at(doc: unknown, keyPath: string): unknown {
    let v: unknown = doc;
    for (const part of keyPath.split('.')) {
        if (v === null || typeof v !== 'object' || !(part in (v as object))) return undefined;
        v = (v as Record<string, unknown>)[part];
    }
    return v;
}

async function readJson(file: string): Promise<unknown | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`${file}: ${(e as Error).message}`);
    }
}

/** A section's rules with the course's values: `courseValues` = the object its keys are looked up in (dotted keys walk it). */
function section(doc: RuleDefaultsDoc, courseValues: unknown, courseFile: string | null): PlantingRuleSection {
    const known = new Set<string>();
    const groups = doc.groups.map((g) => ({
        title: g.title,
        rules: g.rules.map((r): PlantingRule => {
            known.add(r.key.split('.')[0]!);
            const course = courseValues == null ? undefined : at(courseValues, r.key);
            const courseSets = course !== undefined;
            return {
                key: r.key, unit: r.unit ?? null, text: r.text, flag: r.flag === true,
                defaultValue: r.value ?? null, courseSets, courseValue: courseSets ? course : null,
                value: courseSets ? course : (r.value ?? null),
            };
        }),
    }));
    // A generator's course section is flat: whatever it sets beyond the rules is a flag of the script.
    const courseExtras = courseValues && typeof courseValues === 'object' && doc.courseFile === undefined
        ? Object.entries(courseValues as Record<string, unknown>)
            .filter(([k]) => !k.startsWith('_') && !known.has(k)).map(([key, value]) => ({ key, value }))
        : [];
    return {
        source: doc.source, label: doc.label, script: doc.script ?? null, summary: doc.summary, steps: doc.steps,
        courseFile, groups, courseExtras, mixes: [],
    };
}

export class VegetationRulesService {
    private readonly pipelineDir: string;
    private readonly courseDocsRoot: string;

    constructor(private readonly deps: VegetationRulesDeps) {
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        this.courseDocsRoot = deps.courseDocsRoot ?? path.join(this.pipelineDir, '..', 'docs', 'gspro');
    }

    async forCourse(courseId: string): Promise<PlantingRules> {
        const course = await this.deps.courses.get(courseId);
        const slug = courseSlug(course.name);
        const docs = path.join(this.courseDocsRoot, slug);
        const rel = (file: string) => path.relative(path.join(this.pipelineDir, '..'), file).split(path.sep).join('/');
        const defaults = await readRuleDefaults(this.pipelineDir);
        const zoneTypes = await this.deps.zoneTypes.listByCourse(courseId);

        const rulesFile = path.join(docs, VEGETATION_RULES_FILE);
        const courseRules = await readJson(rulesFile) as { generators?: Record<string, unknown> } | null;
        const generators: PlantingRuleSection[] = [];
        for (const g of VEGETATION_GENERATORS) {
            const doc = defaults.get(g.source);
            if (!doc) continue;
            const own = courseRules?.generators?.[g.source] ?? null;
            const s = section(doc, own, courseRules ? rel(rulesFile) : null);
            s.script = doc.script ?? g.script;
            for (const key of doc.zoneTypes ?? g.zoneTypes) {
                const t = zoneTypes.find((z) => z.key === key);
                if (!t) continue;
                const items = (list: { item: string }[]) => list.map((i) => i.item);
                s.mixes.push({ zoneType: t.key, zoneTypeName: t.name, variant: '', variantName: 'Default', items: items(t.items) });
                for (const v of t.variants) {
                    s.mixes.push({ zoneType: t.key, zoneTypeName: t.name, variant: v.key, variantName: v.name, items: items(v.items) });
                }
            }
            generators.push(s);
        }

        const trees: PlantingRuleSection[] = [];
        const treeDoc = defaults.get('trees');
        if (treeDoc) trees.push(section(treeDoc, null, null));
        // The photo stems (golfpipe photo-stems): young trees the lidar missed, from their shadows in the summer photo.
        const photoDoc = defaults.get('photo-stems');
        if (photoDoc) trees.push(section(photoDoc, null, null));
        // Who draws each tree: a course is routed when its vegetation-rules.json has `routing` (arborist.py route,
        // before planting; the routing section's keys carry the `routing.` prefix, so the whole course file is its
        // values). One that is not keeps the older path, read from its arborist-species.json (arborist-legacy).
        const routed = !!(courseRules as { routing?: unknown } | null)?.routing;
        let palette: unknown = null;
        for (const source of ['tree-palette', 'arborist', 'arborist-legacy', 'routing']) {
            const doc = defaults.get(source);
            if (!doc?.courseFile || (source === 'arborist-legacy' && routed)) continue;
            const file = path.join(docs, doc.courseFile);
            const values = await readJson(file);
            if (source === 'tree-palette') palette = values;
            trees.push(section(doc, values, values ? rel(file) : null));
        }

        const models = palette ? paletteModels(docs, palette) : [];
        const bySpecies = new Map<string, { enabled: number; total: number }>();
        for (const m of models) {
            const n = bySpecies.get(m.species) ?? { enabled: 0, total: 0 };
            n.total++;
            if (m.rule.enabled) n.enabled++;
            bySpecies.set(m.species, n);
        }
        const weights = (at(palette, 'rules.speciesWeights') ?? {}) as Record<string, number>;
        const treeModels = groupBySpecies(models, weights);

        const treeAreas = (await this.deps.features.listByCourse(courseId))
            .filter((f) => f.type === TREE_AREA_TYPE)
            .map((f) => ({
                name: treeAreaNameOf(f.attributes),
                mix: speciesMixOf(f.attributes).map((m) => `${m.species} ${m.weight}`).join(', '),
                ignoreKind: treeAreaIgnoresKind(f.attributes),
            }));

        return {
            courseId, courseName: course.name, courseDocs: rel(docs), generators, trees, treeAreas,
            treeAssets: [...bySpecies].map(([species, n]) => ({ species, ...n })).sort((a, b) => b.total - a.total),
            treeModels,
            zoneModels: courseZoneModels(docs),
        };
    }
}

/** The course's zone palettes on its model library; none when it has no grass-palette.json (or one that does not read). */
function courseZoneModels(docs: string): ZoneModels[] {
    try {
        return zoneModels(loadZonePalettes(docs), loadModelLibrary(docs));
    } catch {
        return [];
    }
}

/** A palette asset as the Planting rules show it: its model, and the species it is counted under. */
interface PaletteModel { species: string; rule: TreeModelRule }

/** A model the palette refers to that its library lacks is counted under this name. */
const MISSING_SPECIES = 'not in models.json';

/**
 * The palette's assets read through the course's model library (shared/vegetation/tree-models.ts, as the
 * planter reads them), in palette order. A reference the library lacks is kept, flagged missing.
 */
function paletteModels(docs: string, palette: unknown): PaletteModel[] {
    const byId = new Map(loadModelLibrary(docs).models.map((m) => [m.id, m]));
    return ((at(palette, 'assets') as PaletteAsset[] | undefined) ?? []).map((asset) => {
        try {
            const a = resolveAsset(asset, byId);
            return {
                species: a.species || a.kind || 'unlabelled',
                rule: { id: a.model, renderer: a.renderer, heightM: a.heightM, crownWidthM: a.crownWidthM, enabled: a.enabled !== false },
            };
        } catch {
            const id = String(asset.model);
            return { species: MISSING_SPECIES, rule: { id, renderer: rendererOf(id) ?? '?', heightM: 0, crownWidthM: 0, enabled: asset.enabled !== false, missing: true } };
        }
    });
}

/** Each species with its palette weight and its models, by species name. */
function groupBySpecies(models: PaletteModel[], weights: Record<string, number>): TreeSpeciesModels[] {
    const bySpecies = new Map<string, TreeModelRule[]>();
    for (const m of models) bySpecies.set(m.species, [...(bySpecies.get(m.species) ?? []), m.rule]);
    return [...bySpecies].sort(([a], [b]) => a.localeCompare(b))
        .map(([species, rules]) => ({ species, weight: weights[species] ?? 0, models: rules }));
}
