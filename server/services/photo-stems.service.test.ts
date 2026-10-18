import { test, expect } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createTestDbWith } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { PhotoStemsService } from './photo-stems.service';
import type { ExportRunner } from './gspro-export.service';

// The pipeline itself runs for real in photo-stems.acceptance.test.ts and pipeline/tests/test_photo_stems.py;
// here the runner records the call (as in gspro-export.service.test.ts) so the test covers what the SERVER decides.

const SITE_ID = 'site-photo';

async function setup(rules: unknown) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-stems-svc-'));
    const ctx = await createTestDbWith({ dataDir }, seedCourse);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'photo-stems-docs-'));
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Site', version: 1 }).execute();
    await ctx.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    await mkdir(path.join(dataDir, 'sources', SITE_ID), { recursive: true });
    await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
    await writeFile(path.join(dataDir, 'sources', SITE_ID, 'ortho-orto-l2-2025.tif'), '');
    await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'tree-stems.json'), '{"trees":[]}');
    await ctx.assetsService.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest', filename: `tiles/${SITE_ID}/manifest.json`,
        metaJson: JSON.stringify({ orthoVintages: [{ collection: 'orto-l2-2025', dates: ['2025-06-14'] }] }),
    });
    if (rules) {
        await mkdir(path.join(docs, 'linkan'), { recursive: true });
        await writeFile(path.join(docs, 'linkan', 'vegetation-rules.json'), JSON.stringify(rules));
    }
    const calls: string[][] = [];
    const runner: ExportRunner = async (args) => {
        calls.push(args);
        await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify({
            format: 'golfmap-photo-stems-v1', crs: 'EPSG:3006', calibration: {}, matched: [], proposals: [],
        }));
        return { code: 0, stdout: '', stderr: '' };
    };
    const svc = new PhotoStemsService({
        courses: ctx.coursesService, courseFeatures: ctx.courseFeaturesService, assets: ctx.assetsService,
        dataDir, runner, courseDocsRoot: docs,
    });
    return { svc, calls };
}

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("the course's lidar size factor reaches the pipeline, so photo stems are sized like the scaled lidar trees", async () => {
    const { svc, calls } = await setup({ trees: { lidarSizeFactor: 1.15 } });
    await svc.propose(TEST_COURSE_ID, { dryRun: true });
    expect(flag(calls[0]!, '--lidar-size-factor')).toBe('1.15');
});

test('without a size factor the lidar stems are calibrated against as they are', async () => {
    const { svc, calls } = await setup(null);
    await svc.propose(TEST_COURSE_ID, { dryRun: true });
    expect(calls[0]).not.toContain('--lidar-size-factor');
});

test('a size factor that is no number above 0 is refused', async () => {
    const { svc } = await setup({ trees: { lidarSizeFactor: 0 } });
    await expect(svc.propose(TEST_COURSE_ID, { dryRun: true })).rejects.toThrow(/lidarSizeFactor must be a number above 0/);
});
