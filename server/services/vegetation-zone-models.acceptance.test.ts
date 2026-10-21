// Acceptance C4 (app half), zone palettes on the model library: the Planting rules show each zone palette's
// items with the model each refers to and who draws it (the model's renderer), read from the course's
// grass-palette.json and model library; the palette itself names no renderer.
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

test('each zone palette lists its items with their model and renderer from the model library', async () => {
    const ctx = await createTestDb(seedCourse);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'veg-zone-models-docs-'));
    await mkdir(path.join(docs, 'linkan'), { recursive: true });
    const write = (name: string, doc: unknown) => writeFile(path.join(docs, 'linkan', name), JSON.stringify(doc));
    await write('models.json', { format: 'golfmap-models-v1', models: [
        { id: 'vsp:texture:Rustic Grass_15', renderer: 'vsp', form: 'grass', look: { healthy: '#5e9154' } },
        { id: 'arborist:MountainEnv_bush_hazel_01', species: 'hazel', renderer: 'arborist', form: 'shrub', heightM: 2.4, crownWidthM: 2.1 },
    ] });
    await write('grass-palette.json', { format: 'golfmap-grass-v1', palettes: [
        { key: 'rough_tall', items: [{ name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', sampleDistance: 0.43 }] },
        { key: 'woodland_floor/edge', items: [{ name: 'Woodland edge - hazel', model: 'arborist:MountainEnv_bush_hazel_01', sampleDistance: 7 }] },
    ] });
    const svc = new VegetationRulesService({
        courses: new CoursesService(ctx.db), features: new CourseFeaturesService(ctx.db), zoneTypes: new ZoneTypesService(ctx.db),
        courseDocsRoot: docs,
    });

    const rules = await svc.forCourse(TEST_COURSE_ID);

    expect(rules.zoneModels).toEqual([
        { palette: 'rough_tall', items: [{ name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', renderer: 'vsp' }] },
        { palette: 'woodland_floor/edge', items: [{ name: 'Woodland edge - hazel', model: 'arborist:MountainEnv_bush_hazel_01', renderer: 'arborist' }] },
    ]);
});
