import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { CourseFeaturesService } from './course-features.service';
import { WaterStepsService } from './water-steps.service';
import { defaultRunner, venvPython } from './gspro-export.service';

/**
 * Find falls for real: golfpipe.water_steps (the venv's Python) on a synthetic lidar DEM written by the same venv —
 * a channel 6 m wide with a pond at 10.0 m to x=40, a weir down to a pond at 9.0 m to x=80, a weir down to a creek
 * falling 8.0 -> 7.0 m to x=120, and past a 5 m dam a pond at 6.0 m (pipeline/tests/test_water_steps.py's ground).
 */
const PIPELINE = path.resolve(import.meta.dir, '..', '..', 'pipeline');
const PYTHON = venvPython(PIPELINE);
const MISSING = !existsSync(PYTHON);
if (MISSING) console.warn(`water-steps.service.test: the tests that run golfpipe.water_steps are skipped, they need the pipeline venv (${PYTHON})`);

const SITE_ID = 'site-steps';
const E0 = 500000, N0 = 6500000;

const WRITE_DEM = `
import sys, numpy as np, rasterio
from rasterio.transform import from_origin
E0, N0, RES = ${E0}.0, ${N0}.0, 0.5
nx, ny = int(160 / RES), int(60 / RES)
X, Y = np.meshgrid((np.arange(nx) + 0.5) * RES - 20.0, N0 + 30 - (np.arange(ny) + 0.5) * RES)
xc = np.clip(X, 0, 120)
water = np.where(xc < 40, 10.0, np.where(xc < 80, 9.0, 8.0 - (xc - 80) / 40.0))
z = np.where((abs(Y - N0) <= 3.0) & (X >= 0) & (X <= 120), water, water + 2.0)
z = np.where((abs(Y - N0) <= 6.0) & (X >= 125) & (X <= 138), 6.0, z)
with rasterio.open(sys.argv[1], "w", driver="GTiff", width=nx, height=ny, count=1, dtype="float32", crs="EPSG:3006",
                   transform=from_origin(E0 - 20.0, N0 + 30, RES, RES), nodata=-9999) as dst:
    dst.write(z.astype(np.float32), 1)
`;

const box = (x0: number, x1: number, half: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
    { x: E0 + x0, y: N0 - half }, { x: E0 + x1, y: N0 - half }, { x: E0 + x1, y: N0 + half }, { x: E0 + x0, y: N0 + half },
] }] });

async function setup() {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'water-steps-'));
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await ctx.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const sources = path.join(dataDir, 'sources', SITE_ID);
    await mkdir(sources, { recursive: true });
    const script = path.join(dataDir, 'write_dem.py');
    await writeFile(script, WRITE_DEM);
    if (MISSING) await writeFile(path.join(sources, 'dem.tif'), '');
    else {
        const made = Bun.spawnSync([PYTHON, script, path.join(sources, 'dem.tif')], { stderr: 'pipe' });
        if (made.exitCode !== 0) throw new Error(`writing the DEM failed: ${made.stderr.toString()}`);
    }
    const features = new CourseFeaturesService(ctx.db);
    const svc = new WaterStepsService({ db: ctx.db, courses: new CoursesService(ctx.db), courseFeatures: features, dataDir, pipelineDir: PIPELINE, runner: defaultRunner(PYTHON) });
    return { svc, features, dataDir };
}

test.skipIf(MISSING)('a creek with two weirs and a pond past a dam: ponds at their levels, a creek, two sills and an outlet; nothing stored', async () => {
    const t = await setup();
    const creek = await t.features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'water_creek', geometry: box(0, 120, 3) });
    const pond = await t.features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: box(125, 138, 6), attributes: { digPreset: 'deep_water' } });
    const image = path.join(t.dataDir, 'check.png');
    const p = await t.svc.propose(TEST_COURSE_ID, [creek.id, pond.id], { image });

    expect(p.bodies.map((b) => [b.featureId, b.shape, b.type, b.version])).toEqual([
        [creek.id, `hole_1_${creek.no!.toString(16)}`, 'water_creek', creek.version],
        [pond.id, `others_${pond.no!.toString(16)}`, 'water', pond.version],
    ]);
    const mine = p.pieces.filter((x) => x.bodyId === creek.id);
    expect(mine.map((x) => x.kind)).toEqual(['pond', 'pond', 'creek']);
    expect(mine[0]!.levelM).toBeCloseTo(10, 1);
    expect(mine[1]!.levelM).toBeCloseTo(9, 1);
    expect(mine[2]!.levelM).toBeNull();
    expect(mine[0]!.ring.length).toBeGreaterThanOrEqual(4);
    expect(mine[0]!.shape).toBe(p.bodies[0]!.shape);

    const sills = p.falls.filter((f) => f.style === 'sill');
    expect(sills).toHaveLength(2);
    expect(sills[0]!.dropM).toBeCloseTo(1, 0);
    expect(sills[0]!.flow.x).toBeCloseTo(1, 1);                 // downstream = east
    expect(sills[0]!.sillM).toBe(1);
    expect(sills[0]!.forced).toBe(false);
    const outlet = p.falls.find((f) => f.style === 'outlet')!;
    expect([outlet.fromBodyId, outlet.toBodyId]).toEqual([creek.id, pond.id]);
    expect(outlet.bottomM).toBeCloseTo(6, 1);
    expect(outlet.gapM).toBeGreaterThan(4);
    expect(outlet.sillM).toBeNull();
    expect(p.image).toBe(image);
    expect(existsSync(image)).toBe(true);

    const stored = await t.features.listByCourse(TEST_COURSE_ID);
    expect(stored.find((f) => f.id === creek.id)!.version).toBe(creek.version);
    expect(stored.find((f) => f.id === pond.id)!.type).toBe('water');
}, 60_000);

test.skipIf(MISSING)('a cut where the lidar shows no step is kept (forced), a skip drops a found one; a centerline creek is read by its corridor', async () => {
    const t = await setup();
    const creek = await t.features.create({ courseId: TEST_COURSE_ID, type: 'water_creek', geometry: {
        crs: 'EPSG:3006', rings: [],
        centerline: { points: [{ x: E0 + 1, y: N0 }, { x: E0 + 119, y: N0 }], widthM: 6, startCap: { shape: 'rounded', rounding: 0 }, endCap: { shape: 'rounded', rounding: 0 } },
    } });
    const p = await t.svc.propose(TEST_COURSE_ID, [creek.id], { cuts: [{ x: E0 + 20, y: N0 }], skips: [{ x: E0 + 80, y: N0 + 1 }] });
    expect(p.cuts).toEqual([{ x: E0 + 20, y: N0 }]);
    const sills = p.falls.filter((f) => f.style === 'sill');
    expect(sills.map((f) => Math.round(f.at.x - E0))).toEqual([expect.any(Number), expect.any(Number)]);
    expect(Math.abs(sills[0]!.at.x - E0 - 20)).toBeLessThan(2);
    expect(sills[0]!.forced).toBe(true);
    expect(Math.abs(sills[1]!.at.x - E0 - 40)).toBeLessThan(2.5);
    expect(p.pieces.filter((x) => x.kind === 'pond').length).toBeGreaterThanOrEqual(2);
}, 60_000);

test.skipIf(MISSING)('a fall the course already has a waterfall for is marked exists, with its id; one further off is not', async () => {
    const t = await setup();
    const creek = await t.features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'water_creek', geometry: box(0, 120, 3) });
    const first = await t.svc.propose(TEST_COURSE_ID, [creek.id]);
    expect(first.falls.every((f) => !f.exists && f.existingId === null)).toBe(true);
    const sill = first.falls.find((f) => f.style === 'sill')!;
    // Drawn by hand across the lip, its midpoint 2 m off the found one; another 10 m off.
    const near = await t.features.create({ courseId: TEST_COURSE_ID, type: 'waterfall', geometry: { crs: 'EPSG:3006', rings: [],
        centerline: { points: [{ x: sill.at.x + 2, y: sill.at.y - 3 }, { x: sill.at.x + 2, y: sill.at.y + 3 }], widthM: 2 } }, attributes: { style: 'sill' } });
    await t.features.create({ courseId: TEST_COURSE_ID, type: 'waterfall', geometry: { crs: 'EPSG:3006', rings: [],
        centerline: { points: [{ x: sill.at.x + 10, y: sill.at.y - 3 }, { x: sill.at.x + 10, y: sill.at.y + 3 }], widthM: 2 } } });

    const again = await t.svc.propose(TEST_COURSE_ID, [creek.id]);
    const same = again.falls.find((f) => Math.hypot(f.at.x - sill.at.x, f.at.y - sill.at.y) < 0.5)!;
    expect(same.exists).toBe(true);
    expect(same.existingId).toBe(near.id);
    expect(again.falls.filter((f) => f.exists)).toHaveLength(1);
}, 60_000);

test.skipIf(MISSING)('two waters further apart than gapM: a cascade along the ground between them, its line along the flow', async () => {
    const t = await setup();
    const creek = await t.features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'water_creek', geometry: box(0, 120, 3) });
    const pond = await t.features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: box(125, 138, 6) });
    const p = await t.svc.propose(TEST_COURSE_ID, [creek.id, pond.id], { gapM: 3 });
    expect(p.falls.some((f) => f.style === 'outlet')).toBe(false);
    const cascade = p.falls.find((f) => f.style === 'cascade')!;
    expect([cascade.fromBodyId, cascade.toBodyId]).toEqual([creek.id, pond.id]);
    expect(cascade.line.length).toBeGreaterThanOrEqual(2);
    expect(cascade.line[0]!.x).toBeLessThan(cascade.line.at(-1)!.x);    // upstream (the creek, west) first
    expect(cascade.widthM).toBeGreaterThan(0);
    expect(cascade.gapM).toBeGreaterThan(3);
    expect(cascade.exists).toBe(false);
}, 60_000);

test('refuses what is not water, and features of another course', async () => {
    const t = await setup();
    const bunker = await t.features.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: box(0, 5, 2) });
    await expect(t.svc.propose(TEST_COURSE_ID, [bunker.id])).rejects.toThrow(/no water/);
    await expect(t.svc.propose(TEST_COURSE_ID, ['nope'])).rejects.toThrow(/not on this course/);
    await expect(t.svc.propose(TEST_COURSE_ID, [])).rejects.toThrow(/at least one/);
});
