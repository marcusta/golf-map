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
const OTHER_COURSE_ID = 'course-other';
const PROPOSALS = ['epsg3006:477695.92:6457352.36', 'epsg3006:477704.12:6457352.85', 'epsg3006:477791.32:6457262.05']
    .map((id) => ({ id, x: Number(id.split(':')[1]), y: Number(id.split(':')[2]), heightM: 3.5, crownRadiusM: 1.0, kind: 2, source: 'ortho-shadow' }));

async function setup(rules: unknown) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-stems-svc-'));
    const ctx = await createTestDbWith({ dataDir }, seedCourse);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'photo-stems-docs-'));
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Site', version: 1 }).execute();
    await ctx.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    // A second course on the same site (a 27-hole club's other loop sees other open ground).
    await ctx.db.insertInto('courses').values({
        id: OTHER_COURSE_ID, name: 'Linkan Norra', status: 'draft', revision: 1, crs: 'EPSG:3006', georeference_json: null,
        home_lat: 58.4, home_lon: 15.56, notes: null, version: 1, site_id: SITE_ID,
    }).execute();
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
            format: 'golfmap-photo-stems-v1', crs: 'EPSG:3006', calibration: {}, matched: [], proposals: PROPOSALS,
        }));
        return { code: 0, stdout: '', stderr: '' };
    };
    const svc = new PhotoStemsService({
        courses: ctx.coursesService, courseFeatures: ctx.courseFeaturesService, assets: ctx.assetsService,
        dataDir, runner, courseDocsRoot: docs,
    });
    return { svc, calls, dataDir };
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

test("the course's own photo-stems rules reach the pipeline as rule overrides", async () => {
    const { svc, calls } = await setup({ photoStems: { 'shadow-seed': 0.7, _comment: 'darker shadows only' } });
    await svc.propose(TEST_COURSE_ID, { dryRun: true });
    expect(JSON.parse(flag(calls[0]!, '--rule-overrides')!)).toEqual({ 'photo-stems': { 'shadow-seed': 0.7 } });
});

test('the ground comes from the edited DEM when the site has one', async () => {
    const { svc, calls, dataDir } = await setup(null);
    const sources = path.join(dataDir, 'sources', SITE_ID);
    await writeFile(path.join(sources, 'dem.tif'), '');
    await svc.propose(TEST_COURSE_ID, { dryRun: true });
    expect(flag(calls[0]!, '--dem')).toBe(path.join(sources, 'dem.tif'));
    await writeFile(path.join(sources, 'dem-edited.tif'), '');
    await svc.propose(TEST_COURSE_ID, { dryRun: true });
    expect(flag(calls[1]!, '--dem')).toBe(path.join(sources, 'dem-edited.tif'));
});

test("each course keeps its own proposal: one course's ids cannot be accepted for another on the same site", async () => {
    const { svc } = await setup(null);
    await svc.propose(TEST_COURSE_ID);
    await expect(svc.accept(OTHER_COURSE_ID, { accept: [PROPOSALS[0]!.id], skip: [] })).rejects.toThrow(/Not in the last proposal/);
    await svc.propose(OTHER_COURSE_ID);
    // The other course's proposal did not replace this one's.
    const res = await svc.accept(TEST_COURSE_ID, { accept: [PROPOSALS[0]!.id], skip: [] });
    expect(res.acceptedNow).toBe(1);
});

test("accept reports this call's counts beside the site's totals", async () => {
    const { svc } = await setup(null);
    await svc.propose(TEST_COURSE_ID);
    const first = await svc.accept(TEST_COURSE_ID, { accept: [PROPOSALS[0]!.id, PROPOSALS[1]!.id], skip: [] });
    expect(first).toMatchObject({ accepted: 2, skipped: 0, acceptedNow: 2, skippedNow: 0 });
    const second = await svc.accept(TEST_COURSE_ID, { accept: [], skip: [PROPOSALS[2]!.id] });
    expect(second).toMatchObject({ accepted: 2, skipped: 1, acceptedNow: 0, skippedNow: 1 });
});
