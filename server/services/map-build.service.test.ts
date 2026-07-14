import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from './assets.service';
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

function fakeRunner(opts: { dataDir: string; calls: RunnerCall[]; failAt?: BuildStep }): PipelineRunner {
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
        if (step === 'install') {
            // --course is the site id (the on-disk/tile key), not the course id.
            const root = path.join(opts.dataDir, 'tiles', argValue(args, '--course')!);
            await mkdir(path.join(root, 'ortho'), { recursive: true });
            await mkdir(path.join(root, 'terrain'), { recursive: true });
            await writeFile(path.join(root, 'manifest.json'), JSON.stringify(MANIFEST));
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
    const assets = new AssetsService(ctx.db, dataDir);
    const svc = new MapBuildService({
        db: ctx.db,
        assets,
        dataDir,
        pipelineDir: '/nonexistent/pipeline',
        python: '/nonexistent/python',
        runner: fakeRunner({ dataDir, calls, failAt: opts.failAt }),
    });
    return { ctx, svc, assets, dataDir, calls, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

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
