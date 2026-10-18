// Acceptance A5 (app half): the Planting rules show each species' models and who draws each one,
// read from the course's palette and model library; the palette itself names no renderer.
import { expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { CourseFeaturesService } from './course-features.service';
import { ZoneTypesService } from './zone-types.service';
import { VegetationRulesService } from './vegetation-rules.service';

test("each species lists its models with the renderer and size from the model library", async () => {
    const ctx = await createTestDb(seedCourse);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'veg-models-docs-'));
    await mkdir(path.join(docs, 'linkan'), { recursive: true });
    const write = (name: string, doc: unknown) => writeFile(path.join(docs, 'linkan', name), JSON.stringify(doc));
    await write('models.json', { format: 'golfmap-models-v1', models: [
        { id: 'arborist:CE_DA_Forest_Tree_16018', species: 'beech', renderer: 'arborist', heightM: 22.9, crownWidthM: 14.0, kind: 'broadleaf', form: 'tree' },
        { id: 'vsp:PF_Oak_tall Terrain', species: 'oak', renderer: 'vsp', heightM: 20.4, crownWidthM: 14.67, kind: 'broadleaf', form: 'tree' },
    ] });
    await write('palette.json', { format: 'golfmap-tree-palette-v1', seed: 's1', rules: { speciesWeights: { oak: 0.6, beech: 0.4 } },
        assets: [{ model: 'arborist:CE_DA_Forest_Tree_16018', enabled: true }, { model: 'vsp:PF_Oak_tall Terrain', enabled: true }] });
    const svc = new VegetationRulesService({
        courses: new CoursesService(ctx.db), features: new CourseFeaturesService(ctx.db), zoneTypes: new ZoneTypesService(ctx.db),
        courseDocsRoot: docs,
    });

    const rules = await svc.forCourse(TEST_COURSE_ID);

    expect(rules.treeModels).toEqual([
        { species: 'beech', weight: 0.4, models: [{ id: 'arborist:CE_DA_Forest_Tree_16018', renderer: 'arborist', heightM: 22.9, crownWidthM: 14.0, enabled: true }] },
        { species: 'oak', weight: 0.6, models: [{ id: 'vsp:PF_Oak_tall Terrain', renderer: 'vsp', heightM: 20.4, crownWidthM: 14.67, enabled: true }] },
    ]);
});
