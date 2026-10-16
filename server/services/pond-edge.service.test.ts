import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { CourseFeaturesService } from './course-features.service';
import { PondEdgeService, pondEdgeOrthos } from './pond-edge.service';
import type { ExportRunner } from './gspro-export.service';

const SITE_ID = 'site-pond';
const square = (x0: number, y0: number, s: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
    { x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s },
] }] });

async function setup(runner: ExportRunner, files = ['dem.tif', 'ortho-orto-l2-2023.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif', 'outer-ortho-orto-l2-2025.tif']) {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pond-edge-'));
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await ctx.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const sources = path.join(dataDir, 'sources', SITE_ID);
    await mkdir(sources, { recursive: true });
    for (const f of files) await writeFile(path.join(sources, f), '');
    const features = new CourseFeaturesService(ctx.db);
    const svc = new PondEdgeService({ db: ctx.db, courses: new CoursesService(ctx.db), courseFeatures: features, dataDir, pipelineDir: '/pipeline', runner });
    return { svc, features, sources };
}

/** A pipeline stand-in: answers with the drawn ring moved 1 m in and one kept stretch, and records the request. */
function fakePipeline() {
    const requests: Record<string, unknown>[] = [];
    const runner: ExportRunner = async (args) => {
        const req = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
        requests.push(req);
        const ring = (req.ring as [number, number][]);
        await writeFile(args[args.indexOf('--out') + 1], JSON.stringify({
            ring: ring.map(([x, y]) => [x + 1, y + 1]), lidarRing: ring, level: 103.43,
            areaM2: { drawn: 400, lidar: 300, new: 324 }, outsideLidarM: { p50: 1, p90: 2, max: 3 },
            movedM: { p50: 1, p90: 1, max: 1.4 }, kept: [{ fromM: 0, toM: 3, why: 'reeds' }], photos: [{ separation: 4 }], image: null,
        }));
        return { code: 0, stdout: 'ok\n', stderr: '' };
    };
    return { runner, requests };
}

test('the orthophotos a proposal reads: the inner square raw photos, newest first', () => {
    expect(pondEdgeOrthos(['dem.tif', 'ortho-orto-l2-2023.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif', 'outer-ortho-orto-l2-2025.tif']))
        .toEqual(['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif']);
});

test('propose: the flattened outline, the DEM and the photos go to the pipeline; the answer comes back as points, nothing stored', async () => {
    const { runner, requests } = fakePipeline();
    const t = await setup(runner);
    const pond = await t.features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'water', geometry: square(530000, 6487000, 20) });
    const p = await t.svc.propose(TEST_COURSE_ID, pond.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.dem).toBe(path.join(t.sources, 'dem.tif'));
    expect(requests[0]!.orthos).toEqual([path.join(t.sources, 'ortho-orto-l2-2025.tif'), path.join(t.sources, 'ortho-orto-l2-2023.tif')]);
    expect((requests[0]!.ring as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect(p.shape).toBe(`hole_1_${pond.no!.toString(16)}`);
    expect(p.version).toBe(pond.version);
    expect(p.ring[0]).toEqual({ x: 530001, y: 6487001 });
    expect(p.kept).toEqual([{ fromM: 0, toM: 3, why: 'reeds' }]);
    expect(p.toward).toBeNull();
    expect((await t.features.listByCourse(TEST_COURSE_ID)).find((f) => f.id === pond.id)!.version).toBe(pond.version);
});

test('propose refuses what is not a pond, and proposeAll leaves out lakes marked dig: false', async () => {
    const { runner, requests } = fakePipeline();
    const t = await setup(runner);
    const bunker = await t.features.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: square(530100, 6487000, 5) });
    await expect(t.svc.propose(TEST_COURSE_ID, bunker.id)).rejects.toThrow(/not a pond/);
    const pond = await t.features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: square(530000, 6487000, 20) });
    await t.features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: square(530200, 6487000, 200), attributes: { dig: false } });
    const all = await t.svc.proposeAll(TEST_COURSE_ID);
    expect(all.proposals.map((p) => p.featureId)).toEqual([pond.id]);
    expect(all.proposals[0]!.shape).toBe(`others_${pond.no!.toString(16)}`);
    expect(requests).toHaveLength(1);
});

test('a pond the photos cannot read comes back as the pipeline says why', async () => {
    const runner: ExportRunner = async () => ({ code: 1, stdout: '', stderr: "Traceback ...\nValueError: no orthophoto tells this pond's water from its land: draw the edge by hand, or use --toward\n" });
    const t = await setup(runner);
    const pond = await t.features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: square(530000, 6487000, 20) });
    await expect(t.svc.propose(TEST_COURSE_ID, pond.id)).rejects.toThrow(/no orthophoto tells/);
    const all = await t.svc.proposeAll(TEST_COURSE_ID);
    expect(all.failed.map((f) => f.featureId)).toEqual([pond.id]);
});
