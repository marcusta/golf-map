import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from './assets.service';
import { TerrainEditsService } from './terrain-edits.service';
import { MapBuildService, type PipelineRunner, type BuildStep } from './map-build.service';

const BBOX = { west: 15.55, south: 58.39, east: 15.58, north: 58.41 };

const MANIFEST = {
    courseId: TEST_COURSE_ID,
    bounds: BBOX,
    layers: { ortho: { minzoom: 14, maxzoom: 20 }, terrain: { minzoom: 12, maxzoom: 16 } },
    elevation: { min: 87.3, max: 142.9 },
    generatedAt: '2026-07-07T10:00:00Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
};

interface RunnerCall { step: string; args: string[] }

/**
 * Fake pipeline runner: records each invocation and, on the `install` step,
 * writes a real manifest.json + tile dirs into dataDir so the post-install
 * asset registration (which reads the manifest) succeeds — no Python runs.
 */
const BBOX_3006 = '529108.19,6486714.12,530872.23,6488954.32';
const VINTAGES = [
    { collection: 'orto-l2-2025', dates: ['2025-05-01'] },
    { collection: 'orto-l2-2023', dates: ['2023-08-15'] },
];

function argValue(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}

// generatedAt the fake `manifest` command writes — a RE-generated manifest
// (re-terrain) is distinguishable from the installed one (MANIFEST above).
const REGENERATED_AT = '2026-07-18T12:00:00Z';

function fakeRunner(opts: {
    dataDir: string;
    calls: RunnerCall[];
    failAt?: BuildStep;
    /** Text of the --edits GeoJSON at apply-dem-edits time (captured). */
    captured?: { editsGeojson?: string };
}): PipelineRunner {
    return async (args) => {
        const step = args[2]; // ['-m','golfpipe','<step>', …]
        opts.calls.push({ step, args });
        // failAt is a BuildStep; helper commands (reproject/list) are never targeted.
        if (opts.failAt && step === opts.failAt) {
            return { code: 1, stdout: '', stderr: 'boom' };
        }
        if (step === 'fetch-lidar') {
            const dir = argValue(args, '--out-dir')!;
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, 'item_648_52.copc.laz'), 'fake');
        }
        if (step === 'reproject-bbox') {
            return { code: 0, stdout: `${BBOX_3006}\n`, stderr: '' };
        }
        if (step === 'list-ortho-vintages') {
            return { code: 0, stdout: JSON.stringify(VINTAGES), stderr: '' };
        }
        // grid-dem, fetch-ortho: write their --out so downstream steps have input.
        if (step === 'grid-dem' || step === 'fetch-ortho') {
            const out = argValue(args, '--out')!;
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, `fake ${step}`);
        }
        if (step === 'apply-dem-edits') {
            if (opts.captured) {
                opts.captured.editsGeojson = await Bun.file(argValue(args, '--edits')!).text();
            }
            const out = argValue(args, '--out')!;
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, 'fake edited dem');
        }
        if (step === 'manifest') {
            // cmd_manifest writes --out (default <tiles-dir>/manifest.json)
            // with a FRESH generatedAt and no vintage fields (the pipeline
            // knows nothing about vintages).
            const target = argValue(args, '--out') ?? path.join(argValue(args, '--tiles-dir')!, 'manifest.json');
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, JSON.stringify({ ...MANIFEST, generatedAt: REGENERATED_AT }));
        }
        if (step === 'install') {
            // Partial-install semantics (mirrors golfpipe install): only the
            // layers passed are (re)written; omitted ones stay untouched.
            // --course is the site id (the on-disk/tile key), not the course id.
            const root = path.join(opts.dataDir, 'tiles', argValue(args, '--course')!);
            if (argValue(args, '--ortho')) await mkdir(path.join(root, 'ortho'), { recursive: true });
            if (argValue(args, '--terrain')) await mkdir(path.join(root, 'terrain'), { recursive: true });
            if (argValue(args, '--hillshade')) await mkdir(path.join(root, 'hillshade'), { recursive: true });
            if (argValue(args, '--manifest')) await writeFile(path.join(root, 'manifest.json'), JSON.stringify(MANIFEST));
        }
        if (step === 'canopy' || step === 'trees-stems') {
            // Both merge into the INSTALLED manifest (keeping every field the
            // pipeline does not own) and bump generatedAt; canopy adds its
            // layer entries, trees-stems its asset entry.
            const target = path.join(argValue(args, '--tiles-dir')!, 'manifest.json');
            const existing = JSON.parse(await Bun.file(target).text());
            const merged = step === 'canopy'
                ? { ...existing, layers: { ...existing.layers, canopy: { minzoom: 12, maxzoom: 17 } }, generatedAt: REGENERATED_AT }
                : { ...existing, assets: { 'tree-stems': { path: 'tree-stems.json', format: 'tree-stems-v1', count: 3 } }, generatedAt: REGENERATED_AT };
            await writeFile(target, JSON.stringify(merged));
            if (step === 'canopy') await writeFile(argValue(args, '--trees-out')!, '{"type":"FeatureCollection","features":[]}');
        }
        if (step === 'tile-ortho') {
            // Materialize the output dir so "is this vintage tiled" checks see it.
            const out = argValue(args, '--out')!;
            await mkdir(out, { recursive: true });
            await writeFile(path.join(out, '.tiled'), 'x');
        }
        return { code: 0, stdout: `ok ${step}\n`, stderr: '' };
    };
}

async function setup(opts: { failAt?: BuildStep } = {}) {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'golf-mapbuild-test-'));
    const calls: RunnerCall[] = [];
    const captured: { editsGeojson?: string } = {};
    const assets = new AssetsService(ctx.db, dataDir);
    const terrainEdits = new TerrainEditsService(ctx.db);
    const svc = new MapBuildService({
        db: ctx.db,
        assets,
        dataDir,
        pipelineDir: '/nonexistent/pipeline',
        python: '/nonexistent/python',
        runner: fakeRunner({ dataDir, calls, failAt: opts.failAt, captured }),
        terrainEdits,
    });
    return { ctx, svc, assets, terrainEdits, dataDir, calls, captured, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

/** Give the test course a site up-front (terrain edits are site-scoped). */
async function seedSite(ctx: Awaited<ReturnType<typeof createTestDb>>, siteId = 'site-tedit'): Promise<string> {
    await ctx.db.insertInto('sites').values({ id: siteId, name: 'Test site', version: 1 }).execute();
    await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: siteId }).execute();
    return siteId;
}

// An easy-to-eyeball ring near Linköping (EPSG:3006 metres, matches BBOX).
const RING_3006 = [{ x: 529500, y: 6487000 }, { x: 529600, y: 6487000 }, { x: 529600, y: 6487100 }];

test('happy path: runs the lidar→dem→ortho chain in order and registers 3 tile assets', async () => {
    const { ctx, svc, assets, dataDir, calls, cleanup } = await setup();
    try {
        const job = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);

        expect(final.status).toBe('succeeded');
        expect(final.error).toBeNull();
        expect(final.step).toBe('register');

        // A site was created for the (site-less) course and linked to it.
        const siteId = final.siteId!;
        expect(siteId).toBeTruthy();
        const course = await ctx.coursesService.get(TEST_COURSE_ID);
        expect(course.siteId).toBe(siteId);

        // Steps in order: lidar→DEM, then list vintages + fetch BOTH, tile
        // active into the flat tree, terrain + baked hillshade, then
        // (post-install) tile the older vintage into ortho/<collection>/ so the
        // client can switch without a re-tile.
        expect(calls.map((c) => c.step)).toEqual([
            'fetch-lidar', 'reproject-bbox', 'grid-dem',
            'list-ortho-vintages', 'fetch-ortho', 'fetch-ortho',
            'tile-ortho', 'tile-terrain', 'tile-hillshade', 'manifest', 'install', 'tile-ortho',
        ]);

        // Both vintages fetched to persisted sources; the newest is tiled flat.
        const orthoFetches = calls.filter((c) => c.step === 'fetch-ortho');
        expect(orthoFetches.map((c) => argValue(c.args, '--collection'))).toEqual(['orto-l2-2025', 'orto-l2-2023']);
        const tileOrthos = calls.filter((c) => c.step === 'tile-ortho');
        // First tile-ortho = active vintage → flat ortho tree.
        expect(argValue(tileOrthos[0].args, '--input')!.endsWith('ortho-orto-l2-2025.tif')).toBe(true);
        expect(argValue(tileOrthos[0].args, '--out')!.endsWith(path.join('ortho'))).toBe(true);
        // Second = the older vintage → ortho/<collection>/ subdir.
        expect(argValue(tileOrthos[1].args, '--input')!.endsWith('ortho-orto-l2-2023.tif')).toBe(true);
        expect(argValue(tileOrthos[1].args, '--out')!.endsWith(path.join('ortho', 'orto-l2-2023'))).toBe(true);
        // install/manifest are keyed by the SITE id.
        expect(argValue(calls.find((c) => c.step === 'install')!.args, '--course')).toBe(siteId);

        const gridDem = calls.find((c) => c.step === 'grid-dem')!;
        expect(argValue(gridDem.args, '--bbox-3006')).toBe(BBOX_3006);

        // Persisted sources live under the SITE id.
        for (const f of ['dem.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif']) {
            expect(await Bun.file(path.join(dataDir, 'sources', siteId, f)).exists()).toBe(true);
        }

        // The .laz is kept (not deleted with the workdir) under sources/<site>/lidar.
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'lidar', 'item_648_52.copc.laz')).exists()).toBe(true);

        // Three assets registered against the site; tile_manifest carries vintages.
        const registered = await assets.listBySite(siteId);
        const byKind = Object.fromEntries(registered.map((a) => [a.kind, a]));
        expect(Object.keys(byKind).sort()).toEqual(['dem_cog', 'ortho_cog', 'tile_manifest']);
        expect(byKind.dem_cog.siteId).toBe(siteId);
        // dem_cog points at the persisted DEM *file* (analysis opens it directly).
        expect(byKind.dem_cog.filename).toBe(`sources/${siteId}/dem.tif`);
        expect(await Bun.file(path.join(dataDir, byKind.dem_cog.filename)).exists()).toBe(true);

        const meta = JSON.parse(byKind.tile_manifest.metaJson!);
        expect(meta.activeOrtho).toBe('orto-l2-2025');
        // Explicit built-vintage marker: the collection the flat ortho tree
        // was tiled from — what T55 ortho patches replay onto.
        expect(meta.builtOrtho).toBe('orto-l2-2025');
        expect(meta.orthoVintages.map((v: { collection: string }) => v.collection)).toEqual(['orto-l2-2025', 'orto-l2-2023']);
        expect(meta.bounds).toEqual(BBOX); // original manifest fields preserved
    } finally {
        await cleanup();
    }
});

test('ensureOrthoTiled is a no-op when the vintage is already tiled (fresh build)', async () => {
    const { svc, assets, calls, cleanup } = await setup();
    try {
        // A fresh build already tiles BOTH vintages (active flat + others per-collection).
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const siteId = (await svc.get(build.id)).siteId!;
        const before = JSON.parse((await assets.listBySite(siteId)).find((a) => a.kind === 'tile_manifest')!.metaJson!);
        calls.length = 0; // focus on the ensure

        const job = await svc.ensureOrthoTiled(TEST_COURSE_ID, 'orto-l2-2023');
        await svc.waitForJob(job.id);
        expect((await svc.get(job.id)).status).toBe('succeeded');

        // Already tiled → no tile-ortho ran, and the manifest is untouched
        // (the switch is client-side; active/generatedAt must not change).
        expect(calls).toEqual([]);
        const after = JSON.parse((await assets.listBySite(siteId)).find((a) => a.kind === 'tile_manifest')!.metaJson!);
        expect(after.activeOrtho).toBe(before.activeOrtho);
        expect(after.generatedAt).toBe(before.generatedAt);
    } finally {
        await cleanup();
    }
});

test('ensureOrthoTiled tiles a missing vintage into ortho/<collection>/ on demand', async () => {
    const { svc, calls, dataDir, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const siteId = (await svc.get(build.id)).siteId!;
        // Simulate a course built before per-vintage tiling: drop the subdir.
        await rm(path.join(dataDir, 'tiles', siteId, 'ortho', 'orto-l2-2023'), { recursive: true, force: true });
        calls.length = 0;

        const job = await svc.ensureOrthoTiled(TEST_COURSE_ID, 'orto-l2-2023');
        await svc.waitForJob(job.id);
        expect((await svc.get(job.id)).status).toBe('succeeded');

        // Tiled from the persisted 2023 source into the per-collection subdir.
        expect(calls.map((c) => c.step)).toEqual(['tile-ortho']);
        expect(argValue(calls[0].args, '--input')!.endsWith('ortho-orto-l2-2023.tif')).toBe(true);
        expect(argValue(calls[0].args, '--out')!.endsWith(path.join('ortho', 'orto-l2-2023'))).toBe(true);
    } finally {
        await cleanup();
    }
});

test('ensureOrthoTiled rejects a vintage with no persisted source or tiles', async () => {
    const { svc, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        await expect(svc.ensureOrthoTiled(TEST_COURSE_ID, 'orto-l2-1999')).rejects.toThrow(/No persisted ortho/);
    } finally {
        await cleanup();
    }
});

test('failure path: nonzero exit marks job failed at the step and registers nothing', async () => {
    const { svc, assets, calls, cleanup } = await setup({ failAt: 'fetch-lidar' });
    try {
        const job = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);

        expect(final.status).toBe('failed');
        expect(final.step).toBe('fetch-lidar');
        expect(final.error).toContain('boom');

        // Chain stopped after the first step.
        expect(calls.map((c) => c.step)).toEqual(['fetch-lidar']);

        // No partial assets.
        const registered = await assets.listByCourse(TEST_COURSE_ID);
        expect(registered).toHaveLength(0);
    } finally {
        await cleanup();
    }
});

test('lidar is persisted even when a later step fails (moved right after fetch)', async () => {
    // Fail at grid-dem — AFTER fetch-lidar has run and the .laz was relocated.
    const { svc, dataDir, cleanup } = await setup({ failAt: 'grid-dem' });
    try {
        const job = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);

        expect(final.status).toBe('failed');
        expect(final.step).toBe('grid-dem');

        // Despite the failure + workdir teardown, the .laz survives persistently.
        const siteId = final.siteId!;
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'lidar', 'item_648_52.copc.laz')).exists()).toBe(true);
    } finally {
        await cleanup();
    }
});

test('lidarInfo lists persisted .laz files; deleteLidar removes them and reports freed bytes', async () => {
    const { svc, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);

        const info = await svc.lidarInfo(TEST_COURSE_ID);
        expect(info.files).toEqual(['item_648_52.copc.laz']);
        expect(info.totalBytes).toBe(4); // 'fake'

        const { freedBytes } = await svc.deleteLidar(TEST_COURSE_ID);
        expect(freedBytes).toBe(4);

        // Gone now — a second read is empty, a second delete is a 0-byte no-op.
        expect(await svc.lidarInfo(TEST_COURSE_ID)).toEqual({ files: [], totalBytes: 0 });
        expect((await svc.deleteLidar(TEST_COURSE_ID)).freedBytes).toBe(0);
    } finally {
        await cleanup();
    }
});

test('lidarInfo returns empty (and mints no site) for a never-built course', async () => {
    const { ctx, svc, cleanup } = await setup();
    try {
        expect(await svc.lidarInfo(TEST_COURSE_ID)).toEqual({ files: [], totalBytes: 0 });
        // Read must not create a site as a side effect.
        const course = await ctx.coursesService.get(TEST_COURSE_ID);
        expect(course.siteId).toBeNull();
    } finally {
        await cleanup();
    }
});

test('a Lantmäteriet 403 is translated into an actionable error', async () => {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'golf-mapbuild-test-'));
    const runner: PipelineRunner = async () => ({
        code: 1,
        stdout: '',
        stderr: 'requests.exceptions.HTTPError: 403 Client Error: Forbidden for url: https://dl1.lantmateriet.se/laser/…/data.copc.laz',
    });
    const svc = new MapBuildService({ db: ctx.db, assets: new AssetsService(ctx.db, dataDir), dataDir, runner });
    try {
        const job = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);

        expect(final.status).toBe('failed');
        expect(final.step).toBe('fetch-lidar');
        expect(final.error).toContain('not subscribed'); // the friendly hint
        expect(final.error).toContain('Laserdata Skog'); // product-specific
        expect(final.error).toContain('403'); // raw detail still preserved
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('rebuild replaces prior tile assets rather than duplicating', async () => {
    const { svc, assets, cleanup } = await setup();
    try {
        // First build creates the site + its 3 assets.
        const first = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(first.id);
        const siteId = (await svc.get(first.id)).siteId!;
        expect(await assets.listBySite(siteId)).toHaveLength(3);

        // Rebuild the same course/site → still exactly 3 (replaced, not duplicated).
        const second = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(second.id);

        const registered = await assets.listBySite(siteId);
        expect(registered).toHaveLength(3);
        const manifest = registered.find((a) => a.kind === 'tile_manifest')!;
        expect(JSON.parse(manifest.metaJson!).activeOrtho).toBe('orto-l2-2025');
    } finally {
        await cleanup();
    }
});

test('start rejects a second concurrent build for the same course', async () => {
    const { svc, cleanup } = await setup();
    try {
        const first = await svc.start(TEST_COURSE_ID, BBOX);
        await expect(svc.start(TEST_COURSE_ID, BBOX)).rejects.toThrow(/already running/);
        await svc.waitForJob(first.id);
    } finally {
        await cleanup();
    }
});

// --- T56: terrain-edit replay in full builds + the fast re-terrain job ---

test('full build replays enabled terrain edits: D-TE5 export, edited-DEM threading, persisted cache', async () => {
    const { ctx, svc, assets, terrainEdits, dataDir, calls, captured, cleanup } = await setup();
    try {
        const siteId = await seedSite(ctx);
        await terrainEdits.create({ siteId, op: 'plane', params: { featherM: 3, flat: true }, rings: [RING_3006] });
        await terrainEdits.create({ siteId, op: 'smooth', params: { featherM: 2, radiusM: 4 }, rings: [RING_3006], enabled: false });

        const job = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(job.id);
        expect((await svc.get(job.id)).status).toBe('succeeded');

        // apply-dem-edits runs between grid-dem and the ortho steps.
        expect(calls.map((c) => c.step)).toEqual([
            'fetch-lidar', 'reproject-bbox', 'grid-dem', 'apply-dem-edits',
            'list-ortho-vintages', 'fetch-ortho', 'fetch-ortho',
            'tile-ortho', 'tile-terrain', 'tile-hillshade', 'manifest', 'install', 'tile-ortho',
        ]);

        // The edited DEM is threaded into EVERY downstream DEM consumer…
        const apply = calls.find((c) => c.step === 'apply-dem-edits')!;
        const editedOut = argValue(apply.args, '--out')!;
        expect(editedOut.endsWith('dem-edited.tif')).toBe(true);
        expect(argValue(calls.find((c) => c.step === 'tile-terrain')!.args, '--input')).toBe(editedOut);
        expect(argValue(calls.find((c) => c.step === 'tile-hillshade')!.args, '--input')).toBe(editedOut);
        expect(argValue(calls.find((c) => c.step === 'manifest')!.args, '--dem')).toBe(editedOut);
        // …while its --input is the raw work DEM (never overwritten).
        expect(argValue(apply.args, '--input')!.endsWith('dem-edited.tif')).toBe(false);

        // D-TE2: raw DEM persisted untouched; edited DEM persisted as a cache.
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'dem.tif')).text()).toBe('fake grid-dem');
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'dem-edited.tif')).text()).toBe('fake edited dem');

        // T57: dem_cog points analysis at the EDITED DEM, not the raw one.
        const demAsset = (await assets.listBySite(siteId)).find((a) => a.kind === 'dem_cog')!;
        expect(demAsset.filename).toBe(`sources/${siteId}/dem-edited.tif`);

        // D-TE5 handoff: WGS84 FeatureCollection, enabled edits only, closed
        // rings, op/params/createdAt properties.
        const fc = JSON.parse(captured.editsGeojson!);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(1); // the disabled smooth is excluded
        const feature = fc.features[0];
        expect(feature.properties.op).toBe('plane');
        expect(feature.properties.featherM).toBe(3);
        expect(feature.properties.flat).toBe(true);
        expect(typeof feature.properties.createdAt).toBe('string');
        const ring = feature.geometry.coordinates[0];
        expect(ring).toHaveLength(4); // 3 points + closing repeat
        expect(ring[3]).toEqual(ring[0]);
        for (const [lon, lat] of ring) {
            expect(lon).toBeGreaterThan(15); // WGS84 lon/lat, not metres
            expect(lon).toBeLessThan(16);
            expect(lat).toBeGreaterThan(58);
            expect(lat).toBeLessThan(59);
        }
    } finally {
        await cleanup();
    }
});

test('zero enabled edits: apply-dem-edits is skipped and a stale cached dem-edited.tif is removed', async () => {
    const { ctx, svc, terrainEdits, dataDir, calls, cleanup } = await setup();
    try {
        const siteId = await seedSite(ctx);
        await terrainEdits.create({ siteId, op: 'smooth', params: { featherM: 2, radiusM: 2 }, rings: [RING_3006], enabled: false });
        // A leftover cache from when edits were enabled must not survive.
        await mkdir(path.join(dataDir, 'sources', siteId), { recursive: true });
        await writeFile(path.join(dataDir, 'sources', siteId, 'dem-edited.tif'), 'stale');

        const job = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(job.id);
        expect((await svc.get(job.id)).status).toBe('succeeded');

        expect(calls.map((c) => c.step)).not.toContain('apply-dem-edits');
        // Tiles come straight from the raw work DEM — identical to today.
        expect(argValue(calls.find((c) => c.step === 'tile-terrain')!.args, '--input')!.endsWith('dem.tif')).toBe(true);
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'dem-edited.tif')).exists()).toBe(false);
    } finally {
        await cleanup();
    }
});

test('re-terrain runs exactly the fast subset with a partial install and preserves the vintage fields', async () => {
    const { svc, assets, terrainEdits, dataDir, calls, cleanup } = await setup();
    try {
        // Full build first (persists the DEM, installs tiles, registers assets).
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const siteId = (await svc.get(build.id)).siteId!;
        const before = Object.fromEntries((await assets.listBySite(siteId)).map((a) => [a.kind, a]));
        await terrainEdits.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [RING_3006] });
        calls.length = 0;

        const job = await svc.reTerrain(TEST_COURSE_ID);
        expect(job.kind).toBe('re-terrain');
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);
        expect(final.status).toBe('succeeded');
        expect(final.error).toBeNull();
        expect(final.step).toBe('register');

        // Exactly the fast subset — no lidar/ortho refetch, no tile-ortho.
        expect(calls.map((c) => c.step)).toEqual([
            'apply-dem-edits', 'tile-terrain', 'tile-hillshade', 'install', 'manifest',
        ]);

        // apply-dem-edits reads the PERSISTED raw DEM.
        const apply = calls.find((c) => c.step === 'apply-dem-edits')!;
        expect(argValue(apply.args, '--input')).toBe(path.join(dataDir, 'sources', siteId, 'dem.tif'));

        // Partial install: only terrain + hillshade; ortho/manifest untouched.
        const install = calls.find((c) => c.step === 'install')!;
        expect(argValue(install.args, '--terrain')).toBeTruthy();
        expect(argValue(install.args, '--hillshade')).toBeTruthy();
        expect(argValue(install.args, '--ortho')).toBeUndefined();
        expect(argValue(install.args, '--manifest')).toBeUndefined();

        // Manifest regenerated from the INSTALLED tile root + the edited DEM.
        const manifest = calls.find((c) => c.step === 'manifest')!;
        expect(argValue(manifest.args, '--tiles-dir')).toBe(path.join(dataDir, 'tiles', siteId));
        expect(argValue(manifest.args, '--dem')!.endsWith('dem-edited.tif')).toBe(true);

        // The tile_manifest asset was refreshed: new generatedAt (→ new ?v=
        // cache-buster) with the vintage fields carried over; ortho_cog was
        // left alone; dem_cog was re-pointed at the edited DEM (T57) so
        // analysis samples the same heights the fresh tiles show.
        const after = Object.fromEntries((await assets.listBySite(siteId)).map((a) => [a.kind, a]));
        expect(Object.keys(after).sort()).toEqual(['dem_cog', 'ortho_cog', 'tile_manifest']);
        const meta = JSON.parse(after.tile_manifest.metaJson!);
        expect(meta.generatedAt).toBe(REGENERATED_AT);
        expect(meta.activeOrtho).toBe('orto-l2-2025');
        expect(meta.builtOrtho).toBe('orto-l2-2025'); // built-vintage marker survives re-terrain
        expect(meta.orthoVintages.map((v: { collection: string }) => v.collection)).toEqual(['orto-l2-2025', 'orto-l2-2023']);
        expect(after.ortho_cog.id).toBe(before.ortho_cog.id);
        expect(before.dem_cog.filename).toBe(`sources/${siteId}/dem.tif`);
        expect(after.dem_cog.filename).toBe(`sources/${siteId}/dem-edited.tif`);

        // The on-disk manifest matches the registered metaJson.
        const onDisk = JSON.parse(await Bun.file(path.join(dataDir, 'tiles', siteId, 'manifest.json')).text());
        expect(onDisk).toEqual(meta);

        // The edited DEM cache was (re)persisted.
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'dem-edited.tif')).exists()).toBe(true);
    } finally {
        await cleanup();
    }
});

test('re-terrain with zero enabled edits re-tiles from the raw DEM (revert path)', async () => {
    const { svc, assets, terrainEdits, dataDir, calls, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const siteId = (await svc.get(build.id)).siteId!;
        const edit = await terrainEdits.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [RING_3006] });
        const demCog = async () => (await assets.listBySite(siteId)).find((a) => a.kind === 'dem_cog')!.filename;

        // Apply once with the edit…
        const first = await svc.reTerrain(TEST_COURSE_ID);
        await svc.waitForJob(first.id);
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'dem-edited.tif')).exists()).toBe(true);
        expect(await demCog()).toBe(`sources/${siteId}/dem-edited.tif`);

        // …then disable it and re-apply: revert to the raw DEM.
        await terrainEdits.update(edit.id, edit.version, { enabled: false });
        calls.length = 0;
        const second = await svc.reTerrain(TEST_COURSE_ID);
        await svc.waitForJob(second.id);
        expect((await svc.get(second.id)).status).toBe('succeeded');

        expect(calls.map((c) => c.step)).toEqual(['tile-terrain', 'tile-hillshade', 'install', 'manifest']);
        expect(argValue(calls.find((c) => c.step === 'tile-terrain')!.args, '--input'))
            .toBe(path.join(dataDir, 'sources', siteId, 'dem.tif'));
        // The stale edited-DEM cache is gone, and dem_cog fell back to raw (T57).
        expect(await Bun.file(path.join(dataDir, 'sources', siteId, 'dem-edited.tif')).exists()).toBe(false);
        expect(await demCog()).toBe(`sources/${siteId}/dem.tif`);
    } finally {
        await cleanup();
    }
});

test('re-terrain fails actionably without a persisted DEM (and without a site at all)', async () => {
    const { ctx, svc, cleanup } = await setup();
    try {
        // Never built: no site → actionable error, no job row.
        await expect(svc.reTerrain(TEST_COURSE_ID)).rejects.toThrow(/full map build/);

        // Site exists but sources/dem.tif does not (e.g. data dir wiped).
        await seedSite(ctx);
        await expect(svc.reTerrain(TEST_COURSE_ID)).rejects.toThrow(/full map build/);
        expect(await svc.latestForCourse(TEST_COURSE_ID)).toBeNull();
    } finally {
        await cleanup();
    }
});

test('re-terrain rejects while another job is running for the course', async () => {
    const { svc, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const running = await svc.start(TEST_COURSE_ID, BBOX);
        await expect(svc.reTerrain(TEST_COURSE_ID)).rejects.toThrow(/already running/);
        await svc.waitForJob(running.id);
    } finally {
        await cleanup();
    }
});

test('reconcileOrphans fails jobs left running by a restart', async () => {
    const { ctx, svc, cleanup } = await setup();
    try {
        await ctx.db.insertInto('map_build_jobs').values({
            id: 'orphan-1', course_id: TEST_COURSE_ID, status: 'running',
            step: 'fetch-dem', bbox_json: JSON.stringify(BBOX), log: '', error: null,
        }).execute();

        await svc.reconcileOrphans();

        const job = await svc.get('orphan-1');
        expect(job.status).toBe('failed');
        expect(job.error).toContain('restart');
    } finally {
        await cleanup();
    }
});

// --- Tree regeneration job (canopy tiles + tree-stems asset from persisted sources) ---

test('re-trees runs canopy + trees-stems against the persisted lidar and DEM, then refreshes the manifest asset', async () => {
    const { svc, assets, dataDir, calls, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const siteId = (await svc.get(build.id)).siteId!;
        const before = Object.fromEntries((await assets.listBySite(siteId)).map((a) => [a.kind, a]));
        calls.length = 0;

        const job = await svc.reTrees(TEST_COURSE_ID);
        expect(job.kind).toBe('trees');
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);
        expect(final.status).toBe('succeeded');
        expect(final.error).toBeNull();
        expect(final.step).toBe('register');

        // No fetch, no install: the two commands write into the installed tree.
        expect(calls.map((c) => c.step)).toEqual(['canopy', 'trees-stems']);
        const lidarFile = path.join(dataDir, 'sources', siteId, 'lidar', 'item_648_52.copc.laz');
        const installedRoot = path.join(dataDir, 'tiles', siteId);
        for (const call of calls) {
            expect(argValue(call.args, '--lidar')).toBe(lidarFile);
            expect(argValue(call.args, '--dem')).toBe(path.join(dataDir, 'sources', siteId, 'dem.tif'));
            expect(argValue(call.args, '--tiles-dir')).toBe(installedRoot);
            expect(argValue(call.args, '--course-id')).toBe(siteId); // manifest courseId is the tile key
        }
        // The polygon GeoJSON lands next to the persisted sources for the import wizard.
        const treesOut = path.join(dataDir, 'sources', siteId, 'trees.geojson');
        expect(argValue(calls[0].args, '--trees-out')).toBe(treesOut);
        expect(await Bun.file(treesOut).exists()).toBe(true);

        // The manifest asset was re-registered with the merged manifest: new
        // generatedAt, the canopy layer, the stems asset, vintages intact.
        const after = Object.fromEntries((await assets.listBySite(siteId)).map((a) => [a.kind, a]));
        expect(Object.keys(after).sort()).toEqual(['dem_cog', 'ortho_cog', 'tile_manifest']);
        const meta = JSON.parse(after.tile_manifest.metaJson!);
        expect(meta.generatedAt).toBe(REGENERATED_AT);
        expect(meta.layers.canopy).toEqual({ minzoom: 12, maxzoom: 17 });
        expect(meta.assets['tree-stems'].count).toBe(3);
        expect(meta.activeOrtho).toBe('orto-l2-2025');
        expect(after.tile_manifest.id).not.toBe(before.tile_manifest.id);
        expect(after.ortho_cog.id).toBe(before.ortho_cog.id);
        expect(after.dem_cog.id).toBe(before.dem_cog.id);
    } finally {
        await cleanup();
    }
});

test('re-trees prefers the edited DEM and refuses without lidar files', async () => {
    const { svc, assets, dataDir, calls, cleanup } = await setup();
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const siteId = (await svc.get(build.id)).siteId!;
        const edited = path.join(dataDir, 'sources', siteId, 'dem-edited.tif');
        await writeFile(edited, 'fake edited dem');
        calls.length = 0;

        const job = await svc.reTrees(TEST_COURSE_ID);
        await svc.waitForJob(job.id);
        expect((await svc.get(job.id)).status).toBe('succeeded');
        expect(argValue(calls[0].args, '--dem')).toBe(edited);

        // Legacy layout: no sources/dem*.tif, dem_cog registered as dem/<siteId>.tif.
        await rm(edited);
        await rm(path.join(dataDir, 'sources', siteId, 'dem.tif'));
        await mkdir(path.join(dataDir, 'dem'), { recursive: true });
        await writeFile(path.join(dataDir, 'dem', `${siteId}.tif`), 'fake legacy dem');
        for (const a of await assets.listBySite(siteId)) if (a.kind === 'dem_cog') await assets.remove(a.id, a.version);
        await assets.register({ siteId, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename: `dem/${siteId}.tif` });
        calls.length = 0;
        const legacy = await svc.reTrees(TEST_COURSE_ID);
        await svc.waitForJob(legacy.id);
        expect((await svc.get(legacy.id)).status).toBe('succeeded');
        expect(argValue(calls[0].args, '--dem')).toBe(path.join(dataDir, 'dem', `${siteId}.tif`));

        await svc.deleteLidar(TEST_COURSE_ID);
        await expect(svc.reTrees(TEST_COURSE_ID)).rejects.toThrow(/No lidar files/);
    } finally {
        await cleanup();
    }
});

test('re-trees fails the job (not the request) when the pipeline step exits nonzero', async () => {
    const { svc, cleanup } = await setup({ failAt: 'trees-stems' });
    try {
        const build = await svc.start(TEST_COURSE_ID, BBOX);
        await svc.waitForJob(build.id);
        const job = await svc.reTrees(TEST_COURSE_ID);
        await svc.waitForJob(job.id);
        const final = await svc.get(job.id);
        expect(final.status).toBe('failed');
        expect(final.step).toBe('trees-stems');
        expect(final.error).toContain('boom');
    } finally {
        await cleanup();
    }
});
