import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { AssetsService } from './assets.service';
import { TerrainEditsService } from './terrain-edits.service';
import {
    TerrainGeneratorsService, BUILDINGS_SURVEY, ROAD_CENTERLINES, LIDAR_DIR,
} from './terrain-generators.service';
import { OUTER_LIDAR_DIR, type ExportRunner } from './gspro-export.service';
import { courseTerrainFor, innerSquareFrom3006, terrainManifestField } from './terrain-square';
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
    const runner: ExportRunner = async (args, cwd) => {
        calls.push({ args, cwd });
        const cmd = args[2];
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
    return { calls, runner };
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
    const svc = new TerrainGeneratorsService({ courses, assets, terrainEdits, dataDir, pipelineDir: '/pipeline', runner });
    return { ctx, db: ctx.db, svc, dataDir, assets, terrainEdits };
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
    expect(flag(args, '--centerlines-out')).toBe(path.join(dir, ROAD_CENTERLINES));
    expect(result.centerlines).toBe(path.join(dir, ROAD_CENTERLINES));
    expect(await readFile(result.centerlines!, 'utf8')).toContain('FeatureCollection');
    expect((result.geojson as { features: unknown[] }).features).toHaveLength(1);
    expect(result.report).toEqual(['fetch-roads done']);
    // The polygon file itself was a temp file and is gone.
    expect(flag(args, '--out')).not.toContain(dir);
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

test('building pads survey the outer square, so the outer terrain gets pads and buildings too', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    await buildSite(t, { lidar: ['a.copc.laz'] });
    await t.svc.generate(TEST_COURSE_ID, 'building-pads');
    const { wgs84 } = courseTerrainFor(BUILT_INNER).outer;
    expect(flag(calls[0]!.args, '--bbox')).toBe([wgs84.west, wgs84.south, wgs84.east, wgs84.north].join(','));
});

test('fetchRoads surfaces a pipeline failure as a 409 with its last words', async () => {
    const t = await setup(recordingRunner('fetch-roads').runner);
    await buildSite(t);
    await expect(t.svc.fetchRoads(TEST_COURSE_ID)).rejects.toThrow(/Road fetch failed: fetch-roads exploded/);
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
