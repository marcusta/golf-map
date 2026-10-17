import { test, expect } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { CourseFeaturesService } from './course-features.service';
import { ZoneTypesService } from './zone-types.service';
import { VegetationRulesService, type PlantingRuleSection } from './vegetation-rules.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { RULE_OVERRIDES_FLAG, VEGETATION_GENERATORS, readRuleDefaults, vegetationRulesArgs } from './vegetation-generators';

async function setup(files: Record<string, unknown>) {
    const ctx = await createTestDb(seedCourse);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'veg-rules-docs-'));
    await mkdir(path.join(docs, 'linkan'), { recursive: true });
    for (const [name, doc] of Object.entries(files)) await writeFile(path.join(docs, 'linkan', name), JSON.stringify(doc));
    const svc = new VegetationRulesService({
        courses: new CoursesService(ctx.db), features: new CourseFeaturesService(ctx.db), zoneTypes: new ZoneTypesService(ctx.db),
        courseDocsRoot: docs,
    });
    return { svc, db: ctx.db };
}

const rule = (s: PlantingRuleSection | undefined, key: string) => s?.groups.flatMap((g) => g.rules).find((r) => r.key === key);

test("the planting rules: every generator in stack order, each rule's default from the pipeline's rules files and the course's own value marked", async () => {
    const { svc } = await setup({
        'vegetation-rules.json': {
            format: 'golfmap-vegetation-rules-v1',
            generators: { 'tall-grass': { 'far-start': 8, 'verge-cover': 0.5, clearance: 2, _why: 'a comment' } },
        },
        'palette.json': { format: 'golfmap-tree-palette-v1', seed: 's1', rules: { minScale: 0.6, speciesWeights: { oak: 0.7, birch: 0.3 } },
            assets: [{ species: 'oak', enabled: true }, { species: 'oak', enabled: false }, { kind: 'conifer' }] },
    });
    const rules = await svc.forCourse(TEST_COURSE_ID);

    expect(rules.generators.map((g) => g.source)).toEqual(VEGETATION_GENERATORS.map((g) => g.source));
    const tall = rules.generators[0];
    expect(tall?.courseFile).toMatch(/linkan\/vegetation-rules\.json$/);
    expect(rule(tall, 'far-start')).toMatchObject({ flag: true, defaultValue: 30, courseSets: true, courseValue: 8, value: 8, unit: 'm' });
    expect(rule(tall, 'verge-cover')).toMatchObject({ flag: false, defaultValue: 0.75, courseSets: true, value: 0.5 });
    expect(rule(tall, 'max-distance')).toMatchObject({ courseSets: false, value: 75, courseValue: null });
    expect(rule(tall, 'clearances')?.value).toContainEqual({ surfaces: ['tee', 'green'], clear: 4, ramp: 4 });
    // A key that is no rule is a flag of the script the course passes.
    expect(tall?.courseExtras).toEqual([{ key: 'clearance', value: 2 }]);
    // The mixes of the zone types it writes, as the course binds them (nothing bound on a fresh course).
    expect(tall?.mixes[0]).toMatchObject({ zoneType: 'rough_tall', variant: '', items: [] });
    expect(rules.generators[1]?.courseFile).toMatch(/vegetation-rules\.json$/);
    expect(rule(rules.generators[1], 'reach')?.courseSets).toBe(false);

    // The trees: the code's rules, the course's palette (per course only), no species file.
    expect(rules.trees.map((s) => s.source)).toEqual(expect.arrayContaining(['tree-palette', 'arborist']));
    const palette = rules.trees.find((s) => s.source === 'tree-palette');
    expect(rule(palette, 'rules.minScale')).toMatchObject({ defaultValue: null, courseSets: true, value: 0.6 });
    expect(rule(palette, 'rules.maxScale')).toMatchObject({ courseSets: false, value: null });
    expect(rule(palette, 'rules.speciesWeights')?.value).toEqual({ oak: 0.7, birch: 0.3 });
    expect(rule(palette, 'seed')?.value).toBe('s1');
    const arborist = rules.trees.find((s) => s.source === 'arborist');
    expect(arborist?.courseFile).toBeNull();
    expect(rule(arborist, 'billboardBeyondM.outsideOob')).toMatchObject({ courseSets: false, value: 40 });
    expect(rules.treeAssets).toEqual([{ species: 'oak', enabled: 1, total: 2 }, { species: 'conifer', enabled: 1, total: 1 }]);
    expect(rules.treeAreas).toEqual([]);
});

test('a course with no rules files of its own shows the defaults alone', async () => {
    const { svc } = await setup({});
    const rules = await svc.forCourse(TEST_COURSE_ID);
    expect(rules.generators.every((g) => g.courseFile === null && g.courseExtras.length === 0)).toBe(true);
    expect(rules.generators.flatMap((g) => g.groups.flatMap((x) => x.rules)).some((r) => r.courseSets)).toBe(false);
    expect(rule(rules.generators[0], 'far-start')?.value).toBe(30);
});

test("a course's rule without a flag reaches every generator as --rule-overrides; a flag stays a flag", async () => {
    const defaults = await readRuleDefaults(DEFAULT_PIPELINE_DIR);
    const args = vegetationRulesArgs({
        format: 'golfmap-vegetation-rules-v1',
        generators: { 'tall-grass': { 'far-start': 8, clearances: [{ surfaces: ['tee'], clear: 5, ramp: 1 }] }, 'creek-bank': { cover: 0.4 } },
    }, 'rules.json', undefined, defaults);
    const overrides = JSON.stringify({ 'tall-grass': { clearances: [{ surfaces: ['tee'], clear: 5, ramp: 1 }] }, 'creek-bank': { cover: 0.4 } });
    expect(args['tall-grass']).toEqual(['--far-start', '8', RULE_OVERRIDES_FLAG, overrides]);
    for (const source of ['woodland-floor', 'rock-shore', 'creek-bank']) expect(args[source]).toEqual([RULE_OVERRIDES_FLAG, overrides]);

    // Without overrides the arguments are what they always were.
    expect(vegetationRulesArgs({ format: 'golfmap-vegetation-rules-v1', generators: { 'tall-grass': { 'far-start': 8 } } }, 'r', undefined, defaults))
        .toEqual({ 'tall-grass': ['--far-start', '8'] });
});

test("every generator has a rules file, and a rule's key is unique in it", async () => {
    const defaults = await readRuleDefaults(DEFAULT_PIPELINE_DIR);
    for (const g of VEGETATION_GENERATORS) {
        const doc = defaults.get(g.source);
        expect(doc?.label).toBeTruthy();
        const keys = doc!.groups.flatMap((x) => x.rules.map((r) => r.key));
        expect(new Set(keys).size).toBe(keys.length);
        expect(doc!.steps.length).toBeGreaterThan(0);
    }
});
