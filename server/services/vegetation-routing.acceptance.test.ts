// Acceptance B4 (app half): the Planting rules show the routing policy - who draws a tree far out and how
// far out is thinned - with the course's own values marked, read from its vegetation-rules.json `routing`.
// The species file (arborist-species.json) no longer carries them.
import { expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { CourseFeaturesService } from './course-features.service';
import { ZoneTypesService } from './zone-types.service';
import { VegetationRulesService, type PlantingRuleSection } from './vegetation-rules.service';

const rule = (s: PlantingRuleSection | undefined, key: string) => s?.groups.flatMap((g) => g.rules).find((r) => r.key === key);

async function rulesFor(files: Record<string, unknown>) {
    const ctx = await createTestDb(seedCourse);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'veg-routing-docs-'));
    await mkdir(path.join(docs, 'linkan'), { recursive: true });
    for (const [name, doc] of Object.entries(files)) await writeFile(path.join(docs, 'linkan', name), JSON.stringify(doc));
    const svc = new VegetationRulesService({
        courses: new CoursesService(ctx.db), features: new CourseFeaturesService(ctx.db), zoneTypes: new ZoneTypesService(ctx.db),
        courseDocsRoot: docs,
    });
    return svc.forCourse(TEST_COURSE_ID);
}

test("the routing rules: the course's values from vegetation-rules.json, the rest the defaults", async () => {
    const rules = await rulesFor({
        'vegetation-rules.json': {
            format: 'golfmap-vegetation-rules-v1',
            routing: { farBillboard: { outsideOob: 80, fromPlay: 120 }, outerKeep: [[400, 0.8], [null, 0.2]] },
            generators: {},
        },
    });

    const routing = rules.trees.find((s) => s.source === 'routing');
    expect(routing).toBeDefined();
    expect(routing!.courseFile).toMatch(/linkan[\\/]vegetation-rules\.json$/);
    expect(rule(routing, 'routing.farBillboard.fromPlay')).toMatchObject({ courseSets: true, value: 120, defaultValue: 40, unit: 'm' });
    expect(rule(routing, 'routing.farBillboard.outsideOob')).toMatchObject({ courseSets: true, value: 80, defaultValue: 40, unit: 'm' });
    expect(rule(routing, 'routing.outerKeep')).toMatchObject({ courseSets: true, value: [[400, 0.8], [null, 0.2]] });
    // The Arborist section keeps the looks only: the far rule and the keep list are gone from it.
    const arborist = rules.trees.find((s) => s.source === 'arborist');
    expect(rule(arborist, 'billboardBeyondM.fromPlay')).toBeUndefined();
    expect(rule(arborist, 'vsp')).toBeUndefined();
});

test('a course without routing rules shows the defaults, none marked as its own', async () => {
    const rules = await rulesFor({ 'vegetation-rules.json': { format: 'golfmap-vegetation-rules-v1', generators: {} } });
    const routing = rules.trees.find((s) => s.source === 'routing');
    expect(rule(routing, 'routing.farBillboard.fromPlay')).toMatchObject({ courseSets: false, value: 40 });
    expect(rule(routing, 'routing.outerKeep')).toMatchObject({ courseSets: false });
});
