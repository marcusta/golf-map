import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { AssetsService } from './assets.service';
import { TerrainEditsService } from './terrain-edits.service';
import { CourseFeaturesService } from './course-features.service';
import {
    TerrainGeneratorsService, BUILDINGS_SURVEY, ROAD_CENTERLINES, LIDAR_DIR, ROADS_NEAR_M, WATER_DIG_PRESETS, BUNKER_DIG,
} from './terrain-generators.service';
import { OUTER_LIDAR_DIR, type ExportRunner } from './gspro-export.service';
import { courseTerrainFor, innerSquareFrom3006, terrainArg, terrainManifestField } from './terrain-square';
import { NotFoundError, ConflictError } from '@basics/core/server/auth';

/**
 * The pipeline commands are pinned by pipeline/tests; the runner is the seam
 * here (gspro-export.service.test.ts pattern), so these cover what the
 * SERVER decides: which area, which lidar, where the survey and centerlines
 * land, and that the generated edits replace only their own origin.
 */

/** A D-TE5 edits file with `n` generated edits under `origin`. */
function editsFile(origin: string, n: number, op = 'plane'): string {
    const features = [];
    for (let i = 0; i < n; i++) {
        const lon = 15.50 + i * 0.001;
        features.push({
            type: 'Feature',
            properties: {
                op, featherM: 4, ...(op === 'plane' ? { flat: true } : { smoothM: 25, widthM: 5, centerline: [[lon, 58.52], [lon + 0.0004, 58.52]] }),
                origin, originRef: `osm:way/${i + 1}`, createdAt: `2026-09-15T10:00:00Z#${i}`,
            },
            geometry: { type: 'Polygon', coordinates: [[[lon, 58.52], [lon + 0.0004, 58.52], [lon + 0.0004, 58.5203], [lon, 58.5203], [lon, 58.52]]] },
        });
    }
    return JSON.stringify({ type: 'FeatureCollection', features });
}

const ROADS_GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
    features: [{ type: 'Feature', properties: { type: 'path', road_class: 'road', osm_ids: [1] },
        geometry: { type: 'Polygon', coordinates: [[[530000, 6487000], [530100, 6487000], [530100, 6487005], [530000, 6487005], [530000, 6487000]]] } }],
});

function recordingRunner(fail: string | null = null) {
    const calls: { args: string[]; cwd: string }[] = [];
    /** The `--near` file's content as fetch-roads saw it (it is a temp file). */
    const near: string[] = [];
    const runner: ExportRunner = async (args, cwd) => {
        calls.push({ args, cwd });
        const cmd = args[2];
        if (args.includes('--near')) near.push(await readFile(args[args.indexOf('--near') + 1], 'utf8'));
        if (fail === cmd) return { code: 1, stdout: '', stderr: `${cmd} exploded` };
        const out = args[args.indexOf('--out') + 1];
        await mkdir(path.dirname(out), { recursive: true });
        if (cmd === 'fetch-roads') {
            await writeFile(out, ROADS_GEOJSON);
            const lines = args[args.indexOf('--centerlines-out') + 1];
            await mkdir(path.dirname(lines), { recursive: true });
            await writeFile(lines, '{"type":"FeatureCollection","features":[]}');
        } else if (cmd === 'fetch-buildings') {
            await writeFile(out, '{"type":"FeatureCollection","features":[]}');
        } else if (cmd === 'building-pads') {
            await writeFile(out, editsFile('building-pads', 3));
        } else if (cmd === 'road-grades') {
            await writeFile(out, editsFile('road-grades', 2, 'corridor'));
        }
        return { code: 0, stdout: `${cmd} done\n`, stderr: '' };
    };
    return { calls, runner, near };
}

const GEOREF_BBOX: [number, number, number, number] = [529028, 6486667, 531082, 6488721];
const BUILT_INNER: [number, number, number, number] = [529030, 6486670, 531040, 6488680];
const SITE_ID = 'site-gen';

async function setup(runner: ExportRunner, opts: { georeference?: boolean } = {}) {
    const ctx = await createTestDb(seedCourse);
    if (opts.georeference !== false) {
        // A georeference outranks the built terrain (course-bbox.ts), as for the exports.
        await ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: GEOREF_BBOX }) })
            .where('id', '=', TEST_COURSE_ID).execute();
    }
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gen-data-'));
    const courses = new CoursesService(ctx.db);
    const assets = new AssetsService(ctx.db, dataDir);
    const terrainEdits = new TerrainEditsService(ctx.db);
    const courseFeatures = new CourseFeaturesService(ctx.db);
    const svc = new TerrainGeneratorsService({ courses, assets, terrainEdits, courseFeatures, dataDir, pipelineDir: '/pipeline', runner });
    return { ctx, db: ctx.db, svc, dataDir, assets, terrainEdits, courseFeatures };
}

/** A built site with lidar tiles persisted (inner, and optionally outer with the inner's hard-linked twins). */
async function buildSite(t: Awaited<ReturnType<typeof setup>>, opts: { lidar?: string[]; outerLidar?: string[] } = {}) {
    await t.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await t.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const dir = path.join(t.dataDir, 'sources', SITE_ID);
    await mkdir(dir, { recursive: true });
    for (const [sub, names] of [[LIDAR_DIR, opts.lidar ?? []], [OUTER_LIDAR_DIR, opts.outerLidar ?? []]] as const) {
        if (names.length === 0) continue;
        await mkdir(path.join(dir, sub), { recursive: true });
        for (const n of names) await writeFile(path.join(dir, sub, n), 'fake lidar');
    }
    await t.assets.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
        filename: `tiles/${SITE_ID}/manifest.json`,
        metaJson: JSON.stringify({
            bounds: { west: 15.49, south: 58.51, east: 15.53, north: 58.53 },
            terrain: terrainManifestField(BUILT_INNER),
        }),
    });
    return dir;
}

function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
}

// --- fetchRoads ---

test('fetchRoads runs fetch-roads over the inner square of a built site and keeps the centerlines there', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    const dir = await buildSite(t);
    const result = await t.svc.fetchRoads(TEST_COURSE_ID);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'fetch-roads']);
    // Roads are only wanted on the inner terrain.
    const { wgs84 } = courseTerrainFor(BUILT_INNER).inner;
    expect(flag(args, '--bbox')).toBe([wgs84.west, wgs84.south, wgs84.east, wgs84.north].join(','));
    // Clipped to the exact square, not its (larger) WGS84 envelope.
    expect(flag(args, '--square-3006')).toBe(BUILT_INNER.join(','));
    expect(flag(args, '--centerlines-out')).toBe(path.join(dir, ROAD_CENTERLINES));
    expect(result.centerlines).toBe(path.join(dir, ROAD_CENTERLINES));
    expect(await readFile(result.centerlines!, 'utf8')).toContain('FeatureCollection');
    expect((result.geojson as { features: unknown[] }).features).toHaveLength(1);
    expect(result.report).toEqual(['fetch-roads done']);
    // The polygon file itself was a temp file and is gone.
    expect(flag(args, '--out')).not.toContain(dir);
});

test('fetchRoads hands fetch-roads the course features so only roads near the course come back', async () => {
    const { calls, runner, near } = recordingRunner();
    const t = await setup(runner);
    await t.courseFeatures.create({
        courseId: TEST_COURSE_ID, type: 'green',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [
            { x: 530000, y: 6487000 }, { x: 530030, y: 6487000 }, { x: 530030, y: 6487030 }, { x: 530000, y: 6487030 },
        ] }] },
    });
    await t.svc.fetchRoads(TEST_COURSE_ID);

    const args = calls[0]!.args;
    expect(flag(args, '--near-m')).toBe(String(ROADS_NEAR_M));
    expect(ROADS_NEAR_M).toBe(200);
    const doc = JSON.parse(near[0]!) as { type: string; features: { properties: { type: string }; geometry: { type: string } }[] };
    expect(doc.type).toBe('FeatureCollection');
    // Every course feature goes along (the pipeline picks the types that count).
    const all = await t.courseFeatures.geojsonByCourse(TEST_COURSE_ID);
    expect(doc.features).toHaveLength(all.features.length);
    expect(doc.features.map(f => [f.properties.type, f.geometry.type])).toContainEqual(['green', 'Polygon']);
});

test('fetchRoads on a georeferenced but unbuilt course covers the inner square its georeference implies and persists nothing', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const result = await t.svc.fetchRoads(TEST_COURSE_ID);
    expect(result.centerlines).toBeNull();
    const { wgs84 } = courseTerrainFor(innerSquareFrom3006(GEOREF_BBOX)).inner;
    expect(flag(calls[0]!.args, '--bbox')).toBe([wgs84.west, wgs84.south, wgs84.east, wgs84.north].join(','));
    // ~2 km of longitude at 58.5° N — the inner, not the 5 km outer.
    expect(wgs84.east - wgs84.west).toBeLessThan(0.05);
});

test('building pads survey the outer square (the outer buildings export) but pad only the inner terrain', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    await buildSite(t, { lidar: ['a.copc.laz'] });
    await t.svc.generate(TEST_COURSE_ID, 'building-pads');
    const { outer, inner } = courseTerrainFor(BUILT_INNER);
    const wgs84 = outer.wgs84;
    expect(flag(calls[0]!.args, '--bbox')).toBe([wgs84.west, wgs84.south, wgs84.east, wgs84.north].join(','));
    expect(calls[1]!.args[2]).toBe('building-pads');
    expect(flag(calls[1]!.args, '--square-3006')).toBe(terrainArg(inner));
});

test('fetchRoads surfaces a pipeline failure as a 409 with its last words', async () => {
    const t = await setup(recordingRunner('fetch-roads').runner);
    await buildSite(t);
    await expect(t.svc.fetchRoads(TEST_COURSE_ID)).rejects.toThrow(/Road fetch failed: fetch-roads exploded/);
});

// --- road fetch jobs ---

test('a road fetch job returns at once, runs, and carries the polygons as its result', async () => {
    const { runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    await buildSite(t);
    const started = await t.svc.startRoadsFetch(TEST_COURSE_ID);
    expect(started.status).toBe('running');
    expect(started.result).toBeNull();
    // One at a time per course: a second start is a 409 naming the running job.
    await expect(t.svc.startRoadsFetch(TEST_COURSE_ID)).rejects.toThrow(ConflictError);
    expect(t.svc.currentRoadsFetch(TEST_COURSE_ID)?.id).toBe(started.id);

    await t.svc.whenRoadsIdle(TEST_COURSE_ID);
    const done = t.svc.roadsFetchJob(started.id);
    expect(done.status).toBe('succeeded');
    expect(done.finishedAt).not.toBeNull();
    expect((done.result!.geojson as { features: unknown[] }).features).toHaveLength(1);
    expect(done.result!.report).toEqual(['fetch-roads done']);
    expect(t.svc.currentRoadsFetch(TEST_COURSE_ID)?.status).toBe('succeeded');

    // A new start replaces the finished job.
    const again = await t.svc.startRoadsFetch(TEST_COURSE_ID);
    await t.svc.whenRoadsIdle(TEST_COURSE_ID);
    expect(() => t.svc.roadsFetchJob(started.id)).toThrow(NotFoundError);
    expect(t.svc.currentRoadsFetch(TEST_COURSE_ID)?.id).toBe(again.id);
});

test('a failed road fetch job carries the pipeline\'s last words; unknown ids and courses 404', async () => {
    const t = await setup(recordingRunner('fetch-roads').runner);
    await buildSite(t);
    const job = await t.svc.startRoadsFetch(TEST_COURSE_ID);
    await t.svc.whenRoadsIdle(TEST_COURSE_ID);
    const failed = t.svc.roadsFetchJob(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Road fetch failed: fetch-roads exploded/);
    expect(failed.result).toBeNull();
    expect(() => t.svc.roadsFetchJob('nope')).toThrow(NotFoundError);
    await expect(t.svc.startRoadsFetch('no-such-course')).rejects.toThrow(NotFoundError);
    expect(t.svc.currentRoadsFetch('no-such-course')).toBeNull();
});

// --- building pads ---

test('building pads: survey from every persisted lidar tile once, then pads imported under their origin', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const dir = await buildSite(t, { lidar: ['a.copc.laz', 'b.copc.laz', 'notes.txt'], outerLidar: ['b.copc.laz', 'c.copc.laz'] });

    const result = await t.svc.generate(TEST_COURSE_ID, 'building-pads');
    expect(result).toMatchObject({ kind: 'building-pads', imported: 3, skipped: [] });
    expect(result.report).toEqual(['fetch-buildings done', 'building-pads done']);

    const [survey, pads] = calls.map(c => c.args);
    expect(survey!.slice(0, 3)).toEqual(['-m', 'golfpipe', 'fetch-buildings']);
    expect(flag(survey!, '--out')).toBe(path.join(dir, BUILDINGS_SURVEY));
    const lidar = survey!.slice(survey!.indexOf('--lidar') + 1, survey!.indexOf('--out'));
    expect(lidar.map(p => path.basename(p))).toEqual(['a.copc.laz', 'b.copc.laz', 'c.copc.laz']);
    expect(lidar[1]).toBe(path.join(dir, LIDAR_DIR, 'b.copc.laz')); // the inner copy, not the outer twin
    expect(pads!.slice(0, 3)).toEqual(['-m', 'golfpipe', 'building-pads']);
    expect(flag(pads!, '--survey')).toBe(path.join(dir, BUILDINGS_SURVEY));

    const edits = await t.terrainEdits.listBySite(SITE_ID);
    expect(edits).toHaveLength(3);
    expect(edits.every(e => e.origin === 'building-pads' && e.op === 'plane' && e.params.flat)).toBe(true);
    expect(edits.map(e => e.originRef)).toEqual(['osm:way/1', 'osm:way/2', 'osm:way/3']);
    // EPSG:3006 rings, closed point dropped.
    expect(edits[0]!.rings[0]).toHaveLength(4);
    expect(edits[0]!.rings[0]![0]!.x).toBeGreaterThan(500_000);
});

test('regenerating pads replaces the previous generation, keeps a disabled pad disabled, leaves hand-drawn edits alone', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t, { lidar: ['a.copc.laz'] });
    const manual = await t.terrainEdits.create({
        siteId: SITE_ID, op: 'smooth', params: { featherM: 1, radiusM: 2 },
        rings: [[{ x: 530000, y: 6487000 }, { x: 530010, y: 6487000 }, { x: 530010, y: 6487010 }]],
    });
    await t.svc.generate(TEST_COURSE_ID, 'building-pads');
    const first = (await t.terrainEdits.listBySite(SITE_ID)).filter(e => e.origin === 'building-pads');
    await t.terrainEdits.update(first[1]!.id, first[1]!.version, { enabled: false });

    await t.svc.generate(TEST_COURSE_ID, 'building-pads');
    const all = await t.terrainEdits.listBySite(SITE_ID);
    expect(all).toHaveLength(4);
    expect(all.some(e => e.id === manual.id)).toBe(true);
    const pads = all.filter(e => e.origin === 'building-pads');
    expect(pads.map(e => e.id)).not.toContain(first[1]!.id);
    expect(pads.map(e => [e.originRef, e.enabled])).toEqual([['osm:way/1', true], ['osm:way/2', false], ['osm:way/3', true]]);
    // Generated first, hand-drawn last.
    expect(all[all.length - 1]!.id).toBe(manual.id);
});

test('building pads need a built site with lidar', async () => {
    const t = await setup(recordingRunner().runner);
    await expect(t.svc.generate(TEST_COURSE_ID, 'building-pads')).rejects.toBeInstanceOf(NotFoundError);
    await buildSite(t);
    await expect(t.svc.generate(TEST_COURSE_ID, 'building-pads')).rejects.toBeInstanceOf(ConflictError);
    await expect(t.svc.generate(TEST_COURSE_ID, 'building-pads')).rejects.toThrow(/No lidar/);
});

// --- road grades ---

test('road grades fetch the centerlines first when there are none, then import corridors', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const dir = await buildSite(t);

    const result = await t.svc.generate(TEST_COURSE_ID, 'road-grades');
    expect(result).toMatchObject({ kind: 'road-grades', imported: 2, skipped: [] });
    expect(result.report).toEqual(['fetch-roads done', 'road-grades done']);
    expect(calls.map(c => c.args[2])).toEqual(['fetch-roads', 'road-grades']);
    expect(flag(calls[1]!.args, '--centerlines')).toBe(path.join(dir, ROAD_CENTERLINES));

    const edits = await t.terrainEdits.listBySite(SITE_ID);
    expect(edits).toHaveLength(2);
    expect(edits.every(e => e.origin === 'road-grades' && e.op === 'corridor')).toBe(true);
    expect(edits[0]!.params.centerline).toHaveLength(2);
    expect(edits[0]!.params.widthM).toBe(5);

    // With the centerlines in place a rerun skips the fetch.
    calls.length = 0;
    await t.svc.generate(TEST_COURSE_ID, 'road-grades');
    expect(calls.map(c => c.args[2])).toEqual(['road-grades']);
    expect((await t.terrainEdits.listBySite(SITE_ID))).toHaveLength(2);
});

test('road grades follow the course\'s own paths: lines as corridors, paved areas as planes, road outlines skipped', async () => {
    const lines: string[] = [];
    const { calls, runner } = recordingRunner();
    const t = await setup(async (args, cwd) => {
        if (args[2] === 'road-grades') lines.push(await readFile(args[args.indexOf('--centerlines') + 1], 'utf8'));
        return runner(args, cwd);
    });
    const dir = await buildSite(t);
    // A fetched file is there, but the course's own paths win over it.
    await writeFile(path.join(dir, ROAD_CENTERLINES), JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: 'osm:parking/7', road_class: 'parking' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [9, 0], [9, 9], [0, 0]]] } },
    ] }));
    const X = 530000, Y = 6487000;
    const road = await t.courseFeatures.create({
        courseId: TEST_COURSE_ID, type: 'path',
        geometry: { crs: 'EPSG:3006', rings: [], centerline: { points: [{ x: X, y: Y }, { x: X + 80, y: Y + 20 }], widthM: 4 } },
    });
    const rect = (x0: number, y0: number, w: number, h: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
        { x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
    ] }] });
    const yard = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: rect(X + 100, Y, 30, 20), attributes: { surface: 'asphalt' } });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: rect(X, Y + 100, 300, 5) }); // an old road outline
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: rect(X, Y + 200, 20, 20) });

    const result = await t.svc.generate(TEST_COURSE_ID, 'road-grades');
    // No fetch: the course has roads of its own.
    expect(calls.map(c => c.args[2])).toEqual(['road-grades']);
    expect(result.report[0]).toBe('From the course\'s paths: 1 road centerline(s), 1 paved area(s) smoothed; 1 long thin path polygon(s) skipped (draw roads as centerlines to grade them)');
    const doc = JSON.parse(lines[0]!) as { features: Array<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }> };
    expect(doc.features.map(f => f.properties.id)).toEqual([`feature:${road.id}`, `feature:${yard.id}`]);
    const [line, area] = doc.features;
    expect(line!.properties.widthM).toBe(4);
    expect(line!.geometry.type).toBe('LineString');
    const coords = line!.geometry.coordinates as number[][];
    expect(coords[0]).toEqual([X, Y]);
    expect(coords.at(-1)).toEqual([X + 80, Y + 20]);
    expect(area!.properties).toMatchObject({ road_class: 'parking', surface: 'asphalt' });
    expect(area!.geometry.type).toBe('Polygon');
    expect((area!.geometry.coordinates as number[][][])[0]).toHaveLength(5);
});

test('road grades leave a bridge ungraded: a path line is cut where it crosses a pond', async () => {
    const lines: string[] = [];
    const { runner } = recordingRunner();
    const t = await setup(async (args, cwd) => {
        if (args[2] === 'road-grades') lines.push(await readFile(args[args.indexOf('--centerlines') + 1], 'utf8'));
        return runner(args, cwd);
    });
    await buildSite(t);
    const X = 530000, Y = 6487000;
    const road = await t.courseFeatures.create({
        courseId: TEST_COURSE_ID, type: 'path',
        geometry: { crs: 'EPSG:3006', rings: [], centerline: { points: [{ x: X, y: Y }, { x: X + 40, y: Y }], widthM: 2 } },
    });
    // a pond across the middle, 6 m wide
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: { crs: 'EPSG:3006', rings: [{ points: [
        { x: X + 17, y: Y - 10 }, { x: X + 23, y: Y - 10 }, { x: X + 23, y: Y + 10 }, { x: X + 17, y: Y + 10 },
    ] }] } });
    await t.svc.generate(TEST_COURSE_ID, 'road-grades');
    const doc = JSON.parse(lines[0]!) as { features: Array<{ properties: Record<string, unknown>; geometry: { coordinates: number[][] } }> };
    expect(doc.features.map(f => f.properties.id)).toEqual([`feature:${road.id}`, `feature:${road.id}`]);
    const [west, east] = doc.features.map(f => f.geometry.coordinates);
    expect(west![0]).toEqual([X, Y]);
    expect(west!.at(-1)![0]).toBeLessThanOrEqual(X + 17);
    expect(east![0]![0]).toBeGreaterThanOrEqual(X + 23);
    expect(east!.at(-1)).toEqual([X + 40, Y]);
});

test('road grades merge overlapping paved polygons into one lot; a road outline drawn into a lot is left out', async () => {
    const lines: string[] = [];
    const { runner } = recordingRunner();
    const t = await setup(async (args, cwd) => {
        if (args[2] === 'road-grades') lines.push(await readFile(args[args.indexOf('--centerlines') + 1], 'utf8'));
        return runner(args, cwd);
    });
    await buildSite(t);
    const X = 530000, Y = 6487000;
    const rect = (x0: number, y0: number, w: number, h: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
        { x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
    ] }] });
    const path_ = (geometry: ReturnType<typeof rect>, surface?: string) =>
        t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: surface ? { surface } : {} });
    // Lot A: a 40 x 20 m lot, a 30 x 30 m piece over its east end, and a thin 3 x 80 m aisle across both.
    const lotA = await path_(rect(X, Y, 40, 20), 'gravel');
    const eastA = await path_(rect(X + 30, Y - 5, 30, 30), 'asphalt');
    await path_(rect(X + 20, Y - 30, 3, 80));
    // Lot B: 30 x 20 m with an old 300 x 5 m road outline drawn through it.
    const lotB = await path_(rect(X, Y + 200, 30, 20));
    await path_(rect(X - 135, Y + 208, 300, 5));
    // Lot C: on its own.
    const lotC = await path_(rect(X + 500, Y, 20, 20));

    const result = await t.svc.generate(TEST_COURSE_ID, 'road-grades');
    expect(result.report[0]).toBe('From the course\'s paths: 0 road centerline(s), 3 paved area(s) smoothed (3 overlapping polygon(s) merged); 1 long thin path polygon(s) skipped (draw roads as centerlines to grade them)');
    const doc = JSON.parse(lines[0]!) as { features: Array<{ properties: Record<string, unknown>; geometry: { coordinates: number[][][] } }> };
    const byId = new Map(doc.features.map(f => [f.properties.id, f]));
    expect([...byId.keys()].sort()).toEqual([`feature:${eastA.id}`, `feature:${lotB.id}`, `feature:${lotC.id}`].sort());
    expect(byId.has(`feature:${lotA.id}`)).toBe(false);
    // Lot A is one outline taking the largest piece's surface; its extent covers the aisle.
    const a = byId.get(`feature:${eastA.id}`)!;
    expect(a.properties.surface).toBe('asphalt');
    expect(a.geometry.coordinates).toHaveLength(1);
    const ys = a.geometry.coordinates[0]!.map(q => q[1]!);
    expect(Math.min(...ys)).toBe(Y - 30);
    expect(Math.max(...ys)).toBe(Y + 50);
    // Lot B is only the lot: the road outline is not in it.
    const xsB = byId.get(`feature:${lotB.id}`)!.geometry.coordinates[0]!.map(q => q[0]!);
    expect([Math.min(...xsB), Math.max(...xsB)]).toEqual([X, X + 30]);
});

// --- Digs (no pipeline run: straight from the course's features) ---

const rectRing = (x0: number, y0: number, w: number, h: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
    { x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
] }] });

test('water digs dry run: the digs it would write, nothing written', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    const pond = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(530000, 6487000, 40, 30), attributes: { digPreset: 'deep_water', digDepthM: 1 } });
    const result = await t.svc.generate(TEST_COURSE_ID, 'water-digs', { dryRun: true });
    expect(result.imported).toBe(0);
    expect(result.report).toEqual(['dry run, nothing written', '1 pond(s) to dig below their water level (Deep Water 1)']);
    expect(result.planned?.map(p => [p.originRef, p.params.depthM, p.params.bankSlopeDeg])).toEqual([[`feature:${pond.id}`, 1, WATER_DIG_PRESETS.deep_water.bankSlopeDeg]]);
    expect(await t.terrainEdits.listBySite(SITE_ID)).toEqual([]);
    await expect(t.svc.generate(TEST_COURSE_ID, 'road-grades', { dryRun: true })).rejects.toThrow(/dig generators/);
});

test('water digs: a pond with a steep bank and lowered water reach the dig', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    const pond = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(530000, 6487000, 40, 30),
        attributes: { digPreset: 'deep_water', digBankAboveDeg: 45, digLevelOffsetM: -0.3 } });
    const plain = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(530100, 6487000, 20, 20), attributes: { digLevelOffsetM: 0 } });
    const result = await t.svc.generate(TEST_COURSE_ID, 'water-digs', { dryRun: true });
    const by = new Map(result.planned?.map(p => [p.originRef, p.params]));
    expect(by.get(`feature:${pond.id}`)).toMatchObject({ reference: 'level', bankAboveDeg: 45, levelOffsetM: -0.3 });
    expect(by.get(`feature:${plain.id}`)?.levelOffsetM).toBeUndefined();
});

test('water digs: one level dig per pond with its preset, outline as drawn, creeks and dig: false left alone', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t);
    const X = 530000, Y = 6487000;
    const pond = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(X, Y, 40, 30) });
    const deep = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(X + 100, Y, 20, 20), attributes: { digPreset: 'deep_water', digDepthM: 1.6 } });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(X + 200, Y, 20, 20), attributes: { dig: false } });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water_creek', geometry: rectRing(X, Y + 100, 200, 3) });

    const result = await t.svc.generate(TEST_COURSE_ID, 'water-digs');
    expect(calls).toHaveLength(0);
    expect(result.imported).toBe(2);
    expect(result.report).toEqual([
        '2 pond(s) dug below their water level (Natural Pond 1, Deep Water 1)',
        '1 water feature(s) marked dig: false left alone',
    ]);
    const edits = await t.terrainEdits.listBySite(SITE_ID);
    expect(edits.map(e => [e.op, e.origin, e.originRef])).toEqual([
        ['dig', 'water-digs', `feature:${pond.id}`],
        ['dig', 'water-digs', `feature:${deep.id}`],
    ]);
    const natural = WATER_DIG_PRESETS.natural_pond;
    expect(edits[0]!.params).toMatchObject({ featherM: 0, reference: 'level', depthM: natural.depthM, bankSlopeDeg: natural.bankSlopeDeg, shelfM: natural.shelfM });
    expect(edits[0]!.params.faceBearingDeg).toBeUndefined();
    expect(edits[1]!.params).toMatchObject({ depthM: 1.6, bankSlopeDeg: WATER_DIG_PRESETS.deep_water.bankSlopeDeg });
    expect(edits[0]!.rings[0]).toEqual([{ x: X, y: Y }, { x: X + 40, y: Y }, { x: X + 40, y: Y + 30 }, { x: X, y: Y + 30 }]);
});

test('bunker digs face their own hole\'s green, else the nearest green; overrides and regeneration', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    const X = 530000, Y = 6487000;
    // Hole 1's green is due east of its bunker; hole 2's green is closer, due north.
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'green', geometry: rectRing(X + 100, Y - 10, 20, 20) });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type: 'green', geometry: rectRing(X - 10, Y + 40, 20, 20) });
    const own = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'bunker', geometry: rectRing(X - 5, Y - 5, 10, 10) });
    const loose = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: rectRing(X - 5, Y - 5, 10, 10), attributes: { digDepthM: 0.7, digFaceSlopeDeg: 50 } });

    const first = await t.svc.generate(TEST_COURSE_ID, 'bunker-digs');
    expect(first.report).toEqual(['2 bunker(s) dug below the ground around them, face towards the green']);
    const edits = await t.terrainEdits.listBySite(SITE_ID);
    const byRef = new Map(edits.map(e => [e.originRef, e]));
    expect(byRef.get(`feature:${own.id}`)!.params).toMatchObject({
        reference: 'plane', rimM: BUNKER_DIG.rimM, depthM: BUNKER_DIG.depthM, bankSlopeDeg: BUNKER_DIG.bankSlopeDeg,
        faceSlopeDeg: BUNKER_DIG.faceSlopeDeg, faceBearingDeg: 90,
    });
    // No hole: the nearest green (hole 2's, due north), with the feature's overrides.
    expect(byRef.get(`feature:${loose.id}`)!.params).toMatchObject({ depthM: 0.7, faceSlopeDeg: 50, faceBearingDeg: 0 });

    // A dig switched off stays off when the digs are regenerated; the seed keeps the same shape.
    const off = byRef.get(`feature:${own.id}`)!;
    await t.terrainEdits.update(off.id, off.version, { enabled: false });
    await t.svc.generate(TEST_COURSE_ID, 'bunker-digs');
    const again = new Map((await t.terrainEdits.listBySite(SITE_ID)).map(e => [e.originRef, e]));
    expect(again.get(`feature:${own.id}`)!.enabled).toBe(false);
    expect(again.get(`feature:${own.id}`)!.params.seed).toBe(off.params.seed);
    expect(again.size).toBe(2);
});

test('bunker digs with no green anywhere dig even banks and say so', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    await t.db.deleteFrom('course_features').where('type', '=', 'green').execute(); // the seed's green
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: rectRing(530000, 6487000, 10, 10) });
    const result = await t.svc.generate(TEST_COURSE_ID, 'bunker-digs');
    expect(result.report).toEqual(['1 bunker(s) dug below the ground around them, face towards the green; 1 with no green to face (even banks)']);
    const [edit] = await t.terrainEdits.listBySite(SITE_ID);
    expect(edit!.params.faceSlopeDeg).toBeUndefined();
    expect(edit!.params.faceBearingDeg).toBeUndefined();
});

test('creek digs: a centerline creek sends its line and width, a polygon creek leaves the line to the pipeline', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    const X = 530000, Y = 6487000;
    const drawn = await t.courseFeatures.create({
        courseId: TEST_COURSE_ID, type: 'water_creek', attributes: { digPreset: 'eroded_gully' },
        geometry: { crs: 'EPSG:3006', rings: [], centerline: { points: [{ x: X, y: Y }, { x: X + 60, y: Y + 10 }], widthM: 2.5 } },
    });
    const ribbon = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water_creek', geometry: rectRing(X, Y + 50, 80, 2), attributes: { digDepthM: 0.5 } });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water_creek', geometry: rectRing(X, Y + 90, 80, 2), attributes: { dig: false } });

    const result = await t.svc.generate(TEST_COURSE_ID, 'creek-digs');
    expect(result.report).toEqual([
        '2 creek bed(s) dug below their falling water surface (Eroded Gully 1, Maintained Drain 1); 1 along a drawn centerline, 1 along the line found down their polygon',
        '1 creek(s) marked dig: false left alone',
    ]);
    const byRef = new Map((await t.terrainEdits.listBySite(SITE_ID)).map(e => [e.originRef, e]));
    const line = byRef.get(`feature:${drawn.id}`)!;
    expect(line.params).toMatchObject({ reference: 'stream', rimM: 1, depthM: 0.7, bankSlopeDeg: 38, widthM: 2.5 });
    expect(line.params.centerline![0]).toEqual({ x: X, y: Y });
    expect(line.params.centerline!.at(-1)).toEqual({ x: X + 60, y: Y + 10 });
    const poly = byRef.get(`feature:${ribbon.id}`)!;
    expect(poly.params).toMatchObject({ reference: 'stream', depthM: 0.5, bankSlopeDeg: 18 });
    expect(poly.params.centerline).toBeUndefined();
});

test('creek digs: a waterfall on a creek is sent as a step with its sill, one elsewhere is not', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    const X = 530000, Y = 6487000;
    const creek = await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'water_creek', geometry: rectRing(X, Y, 80, 4) });
    const lip = (x: number, y: number) => ({ crs: 'EPSG:3006' as const, rings: [], centerline: { points: [{ x, y: y - 2 }, { x, y: y + 2 }], widthM: 2 } });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'waterfall', geometry: lip(X + 40, Y + 2), attributes: { style: 'sill', sillM: 1.5 } });
    await t.courseFeatures.create({ courseId: TEST_COURSE_ID, type: 'waterfall', geometry: lip(X + 40, Y + 60), attributes: { style: 'outlet' } });

    const result = await t.svc.generate(TEST_COURSE_ID, 'creek-digs');
    expect(result.report).toContain('1 waterfall(s) cut into them: each stretch between falls keeps its own level, the sills stay');
    const [edit] = (await t.terrainEdits.listBySite(SITE_ID)).filter(e => e.originRef === `feature:${creek.id}`);
    expect(edit!.params.steps).toHaveLength(1);
    expect(edit!.params.steps![0]!.sillM).toBe(1.5);
    expect(edit!.params.steps![0]!.line[0]!.x).toBeCloseTo(X + 40, 3);
});

// --- Several courses on one site ---

test('courses sharing a site: generating digs on one course leaves the other course\'s digs alone', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t);
    const B = (await new CoursesService(t.db).create({ name: 'Second course', siteId: SITE_ID })).id;
    const X = 530000, Y = 6487000;
    const features = async (courseId: string, dx: number) => ({
        pond: await t.courseFeatures.create({ courseId, type: 'water', geometry: rectRing(X + dx, Y, 40, 30) }),
        bunker: await t.courseFeatures.create({ courseId, type: 'bunker', geometry: rectRing(X + dx, Y + 50, 10, 10) }),
        creek: await t.courseFeatures.create({ courseId, type: 'water_creek', geometry: rectRing(X + dx, Y + 100, 80, 2) }),
    });
    const a = await features(TEST_COURSE_ID, 0);
    const b = await features(B, 500);
    const kinds = ['water-digs', 'bunker-digs', 'creek-digs'] as const;
    const byRef = async () => new Map((await t.terrainEdits.listBySite(SITE_ID)).map(e => [e.originRef, e]));

    for (const kind of kinds) await t.svc.generate(TEST_COURSE_ID, kind);
    const aPond = (await byRef()).get(`feature:${a.pond.id}`)!;
    await t.terrainEdits.update(aPond.id, aPond.version, { enabled: false });
    const aBefore = await byRef();

    // Course B's run adds its digs and counts only them; course A's rows are the very same rows.
    for (const kind of kinds) expect((await t.svc.generate(B, kind)).imported).toBe(1);
    const both = await byRef();
    expect(both.size).toBe(6);
    for (const f of Object.values(a)) {
        const ref = `feature:${f.id}`;
        expect(both.get(ref)).toEqual(aBefore.get(ref)!);
    }
    expect(both.get(`feature:${a.pond.id}`)!.enabled).toBe(false);
    for (const f of Object.values(b)) expect(both.get(`feature:${f.id}`)!.enabled).toBe(true);
    // Each origin's rows keep distinct replay slots across the two courses.
    const edits = await t.terrainEdits.listBySite(SITE_ID);
    for (const kind of kinds) {
        const stamps = edits.filter(e => e.origin === kind).map(e => e.createdAt);
        expect(new Set(stamps).size).toBe(2);
    }

    // A feature course B deletes loses its dig on B's next run; A's still stand.
    await t.courseFeatures.remove(b.bunker.id, b.bunker.version);
    await t.svc.generate(B, 'bunker-digs');
    const afterDelete = await byRef();
    expect(afterDelete.has(`feature:${b.bunker.id}`)).toBe(false);
    expect(afterDelete.get(`feature:${a.bunker.id}`)).toEqual(aBefore.get(`feature:${a.bunker.id}`)!);

    // Regenerating A replaces A's own rows (the disabled pond stays disabled) and keeps B's.
    for (const kind of kinds) await t.svc.generate(TEST_COURSE_ID, kind);
    const again = await byRef();
    expect(again.size).toBe(5);
    expect(again.get(`feature:${a.pond.id}`)!.id).not.toBe(aPond.id);
    expect(again.get(`feature:${a.pond.id}`)!.enabled).toBe(false);
    expect(again.get(`feature:${b.pond.id}`)).toEqual(both.get(`feature:${b.pond.id}`)!);
    expect(again.get(`feature:${b.creek.id}`)).toEqual(both.get(`feature:${b.creek.id}`)!);
});

test('courses sharing a site: road grades of one course\'s paths survive grading the other course; fetched ones are the site\'s', async () => {
    // road-grades echoes each centerline it is given as one corridor edit, its id as the originRef.
    const runner: ExportRunner = async (args) => {
        const out = args[args.indexOf('--out') + 1];
        await mkdir(path.dirname(out), { recursive: true });
        const lines = JSON.parse(await readFile(args[args.indexOf('--centerlines') + 1], 'utf8')) as { features: Array<{ properties: { id: string } }> };
        const doc = JSON.parse(editsFile('road-grades', lines.features.length, 'corridor')) as { features: Array<{ properties: Record<string, unknown> }> };
        doc.features.forEach((f, i) => { f.properties.originRef = lines.features[i]!.properties.id; });
        await writeFile(out, JSON.stringify(doc));
        return { code: 0, stdout: '', stderr: '' };
    };
    const t = await setup(runner);
    const dir = await buildSite(t);
    // A fetched network the site already has, for a course with no paths of its own.
    await writeFile(path.join(dir, ROAD_CENTERLINES), JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: 'osm:way/7' }, geometry: { type: 'LineString', coordinates: [[530000, 6487000], [530100, 6487000]] } },
    ] }));
    const B = (await new CoursesService(t.db).create({ name: 'Second course', siteId: SITE_ID })).id;
    const road = (courseId: string, y: number) => t.courseFeatures.create({
        courseId, type: 'path', geometry: { crs: 'EPSG:3006', rings: [], centerline: { points: [{ x: 530000, y }, { x: 530100, y }], widthM: 4 } },
    });
    const aRoad = await road(TEST_COURSE_ID, 6487200);
    await t.svc.generate(TEST_COURSE_ID, 'road-grades');
    const aGrade = (await t.terrainEdits.listBySite(SITE_ID)).find(e => e.originRef === `feature:${aRoad.id}`)!;

    // B has no paths: it grades the fetched centerlines, and A's own road stays graded.
    await t.svc.generate(B, 'road-grades');
    const refs = async () => (await t.terrainEdits.listBySite(SITE_ID)).map(e => e.originRef).sort();
    expect(await refs()).toEqual([`feature:${aRoad.id}`, 'osm:way/7'].sort());
    expect((await t.terrainEdits.listBySite(SITE_ID)).find(e => e.originRef === `feature:${aRoad.id}`)).toEqual(aGrade);

    // Once B draws its own road, B's run replaces the site's fetched grades with it; A's still stands.
    const bRoad = await road(B, 6487400);
    await t.svc.generate(B, 'road-grades');
    expect(await refs()).toEqual([`feature:${aRoad.id}`, `feature:${bRoad.id}`].sort());
});

test('building pads are the site\'s: a run on either course replaces the whole generation', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t, { lidar: ['a.laz'] });
    const B = (await new CoursesService(t.db).create({ name: 'Second course', siteId: SITE_ID })).id;
    await t.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: GEOREF_BBOX }) }).where('id', '=', B).execute();
    await t.svc.generate(TEST_COURSE_ID, 'building-pads');
    const first = (await t.terrainEdits.listBySite(SITE_ID)).map(e => e.id);
    await t.svc.generate(B, 'building-pads');
    const second = await t.terrainEdits.listBySite(SITE_ID);
    expect(second).toHaveLength(3);
    expect(second.some(e => first.includes(e.id))).toBe(false);
});

test('a creek running into a pond is dug on through the pond bank: one strip from its mouth, as wide as the creek there', async () => {
    const { creekMouths } = await import('./terrain-generators.service');
    // A creek 2 m wide running east, its end on the west shore of a pond (x 20..60).
    const creek = [{ x: 0, y: -1 }, { x: 20.5, y: -1 }, { x: 20.5, y: 1 }, { x: 0, y: 1 }];
    const pond = [{ x: 20, y: -20 }, { x: 60, y: -20 }, { x: 60, y: 20 }, { x: 20, y: 20 }];
    const [strip, ...more] = creekMouths(creek, [{ ring: pond, runM: 6.6 }]);
    expect(more).toEqual([]);
    const xs = strip.map(p => p.x), ys = strip.map(p => p.y);
    expect(Math.max(...xs)).toBeCloseTo(20.5 + 6.6, 1);         // from the mouth on into the pond by the bank's run
    expect(Math.min(...xs)).toBeLessThan(20.5);                    // from inside the creek
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2, 1);   // the creek's width at the mouth
    // A creek nowhere near a pond gets none.
    expect(creekMouths(creek.map(p => ({ x: p.x - 100, y: p.y })), [{ ring: pond, runM: 6.6 }])).toEqual([]);
});
