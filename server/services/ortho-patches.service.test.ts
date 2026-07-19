import { test, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sql } from 'kysely';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from './assets.service';
import type { PipelineRunner } from './map-build.service';
import { OrthoPatchesService, type OrthoPatchInput } from './ortho-patches.service';

// T55 (reworked to seam-free windowed baking) — interactive photo cleaning:
// mask store/log (version 2) + exec-call (incremental bake-ortho-patch on
// accept, full apply-ortho-patches replay on revert) + inpaint-deps
// pre-flight + version bump, over a fixture pipeline runner (map-build test
// pattern — no Python).

const SITE_ID = 'site-t55';
const ACTIVE = 'orto-l2-2025';

const MANIFEST = {
    courseId: TEST_COURSE_ID,
    bounds: { west: 15.55, south: 58.39, east: 15.58, north: 58.41 },
    layers: { ortho: { minzoom: 14, maxzoom: 20 }, terrain: { minzoom: 12, maxzoom: 16 } },
    elevation: { min: 67.8, max: 83.9 },
    generatedAt: '2026-07-14T10:25:11.864Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
    orthoVintages: [{ collection: ACTIVE, dates: ['2025-06-21'] }],
    activeOrtho: ACTIVE,
};

// A real (1x1 transparent) PNG so the signature check passes.
const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const PATCH: OrthoPatchInput = {
    maskPngBase64: TINY_PNG_BASE64,
    bounds3857: { west: 1733000, south: 8018000, east: 1733040, north: 8018040 },
    boundsSweref: { west: 533000, south: 6473000, east: 533040, north: 6473040 },
    tool: 'sam',
};

interface RunnerCall { args: string[] }

function argValue(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}

function fakeRunner(opts: {
    calls: RunnerCall[];
    fail?: () => boolean;
    torchOk?: () => boolean;
}): PipelineRunner {
    return async (args) => {
        // The cached inpaint-deps pre-flight probes `python -c "import torch"`.
        if (args[0] === '-c') {
            return (opts.torchOk?.() ?? true)
                ? { code: 0, stdout: '', stderr: '' }
                : { code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'torch'" };
        }
        opts.calls.push({ args });
        if (opts.fail?.()) return { code: 1, stdout: '', stderr: 'replay boom' };
        // Materialize the working .patched.tif like the real command would.
        const out = argValue(args, '--out');
        if (out) await writeFile(out, 'fake patched tif');
        return { code: 0, stdout: 'ok\n', stderr: '' };
    };
}

async function setup(opts: {
    fail?: () => boolean;
    withSite?: boolean;
    torchOk?: () => boolean;
    withWeights?: boolean;
} = {}) {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'golf-patches-test-'));
    const calls: RunnerCall[] = [];
    const assets = new AssetsService(ctx.db, dataDir);

    const lamaWeights = path.join(dataDir, 'big-lama.pt');
    if (opts.withWeights !== false) await writeFile(lamaWeights, 'weights');

    if (opts.withSite !== false) {
        await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'T55 site', version: 1 }).execute();
        await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID)
            .set({ site_id: SITE_ID, updated_at: sql`(datetime('now'))` }).execute();
        await mkdir(path.join(dataDir, 'sources', SITE_ID), { recursive: true });
        await writeFile(path.join(dataDir, 'sources', SITE_ID, `ortho-${ACTIVE}.tif`), 'pristine');
        await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
        await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), JSON.stringify(MANIFEST));
        await assets.register({
            siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
            filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify(MANIFEST),
        });
    }

    const svc = new OrthoPatchesService({
        db: ctx.db,
        assets,
        dataDir,
        pipelineDir: '/nonexistent/pipeline',
        python: '/nonexistent/python',
        lamaWeights,
        runner: fakeRunner({ calls, fail: opts.fail, torchOk: opts.torchOk }),
    });
    const patchesDir = path.join(dataDir, 'sources', SITE_ID, 'patches');
    const readLog = async () =>
        JSON.parse(await readFile(path.join(patchesDir, 'patches.json'), 'utf8')) as {
            version: number;
            patches: Array<{ seq: number; file: string; tool: string; bounds3857: unknown }>;
        };
    return {
        ctx, svc, assets, dataDir, calls, patchesDir, readLog, lamaWeights,
        cleanup: () => rm(dataDir, { recursive: true, force: true }),
    };
}

test('apply stores the mask + log entry, runs the INCREMENTAL bake with the right args, and bumps the tile version', async () => {
    const { svc, assets, dataDir, calls, patchesDir, readLog, lamaWeights, cleanup } = await setup();
    try {
        const result = await svc.apply(TEST_COURSE_ID, PATCH);
        expect(result.count).toBe(1);
        expect(result.generatedAt).not.toBe(MANIFEST.generatedAt);

        // Mask stored: 1.png (real PNG bytes) + a full VERSION-2 log entry.
        const pngBytes = await readFile(path.join(patchesDir, '1.png'));
        expect(pngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const log = await readLog();
        expect(log.version).toBe(2);
        expect(log.patches).toHaveLength(1);
        expect(log.patches[0].seq).toBe(1);
        expect(log.patches[0].file).toBe('1.png');
        expect(log.patches[0].tool).toBe('sam');
        expect(log.patches[0].bounds3857).toEqual(PATCH.bounds3857);

        // Exactly one pipeline call — the incremental windowed bake of THIS
        // seq (never a full replay), with the pristine source, the patches
        // dir, the .patched.tif working output, the installed flat ortho
        // tile tree, the build's zoom range, and the LaMa weights.
        expect(calls).toHaveLength(1);
        const args = calls[0].args;
        expect(args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'bake-ortho-patch']);
        expect(argValue(args, '--seq')).toBe('1');
        expect(argValue(args, '--ortho')).toBe(path.join(dataDir, 'sources', SITE_ID, `ortho-${ACTIVE}.tif`));
        expect(argValue(args, '--patches-dir')).toBe(patchesDir);
        expect(argValue(args, '--out')).toBe(path.join(dataDir, 'sources', SITE_ID, `ortho-${ACTIVE}.patched.tif`));
        expect(argValue(args, '--tiles-out')).toBe(path.join(dataDir, 'tiles', SITE_ID, 'ortho'));
        expect(argValue(args, '--minzoom')).toBe('14');
        expect(argValue(args, '--maxzoom')).toBe('20');
        expect(argValue(args, '--weights')).toBe(lamaWeights);
        expect(args).not.toContain('--extra-bounds');

        // Version bump landed in BOTH the on-disk manifest and the asset copy.
        const onDisk = JSON.parse(await readFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), 'utf8'));
        expect(onDisk.generatedAt).toBe(result.generatedAt);
        expect(onDisk.activeOrtho).toBe(ACTIVE); // other fields preserved
        const asset = (await assets.listBySite(SITE_ID)).find(a => a.kind === 'tile_manifest')!;
        expect(JSON.parse(asset.metaJson!).generatedAt).toBe(result.generatedAt);
    } finally {
        await cleanup();
    }
});

test('a second apply appends seq 2, bakes ONLY seq 2, and mints a distinct version', async () => {
    const { svc, calls, readLog, patchesDir, cleanup } = await setup();
    try {
        const first = await svc.apply(TEST_COURSE_ID, PATCH);
        const second = await svc.apply(TEST_COURSE_ID, { ...PATCH, tool: 'ellipse' });
        expect(second.count).toBe(2);
        expect(second.generatedAt).not.toBe(first.generatedAt); // ms-precision ISO

        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1, 2]);
        expect(log.patches[1].file).toBe('2.png');
        expect(log.patches[1].tool).toBe('ellipse');
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(true);

        // Each accept is one incremental bake of its own seq.
        expect(calls.map(c => c.args[2])).toEqual(['bake-ortho-patch', 'bake-ortho-patch']);
        expect(argValue(calls[1].args, '--seq')).toBe('2');
    } finally {
        await cleanup();
    }
});

test('a failed bake rolls the stored mask back and leaves the version untouched', async () => {
    const { svc, dataDir, readLog, patchesDir, cleanup } = await setup({ fail: () => true });
    try {
        await expect(svc.apply(TEST_COURSE_ID, PATCH)).rejects.toThrow(/replay boom/);

        const log = await readLog();
        expect(log.patches).toHaveLength(0);
        expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(false);
        const onDisk = JSON.parse(await readFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), 'utf8'));
        expect(onDisk.generatedAt).toBe(MANIFEST.generatedAt);
        expect(await svc.info(TEST_COURSE_ID)).toEqual({
            count: 0, lastCreatedAt: null, lastTool: null, bakeable: true,
        });
    } finally {
        await cleanup();
    }
});

test('revertLast drops the last entry, retiles its bounds via --extra-bounds, deletes the png, bumps the version', async () => {
    const { svc, calls, readLog, patchesDir, cleanup } = await setup();
    try {
        await svc.apply(TEST_COURSE_ID, PATCH);
        const second = { ...PATCH, bounds3857: { west: 1733100, south: 8018100, east: 1733140, north: 8018140 }, tool: 'ellipse' };
        const applied = await svc.apply(TEST_COURSE_ID, second);
        calls.length = 0;

        const result = await svc.revertLast(TEST_COURSE_ID);
        expect(result.count).toBe(1);
        expect(result.generatedAt).not.toBe(applied.generatedAt);

        // Revert runs the FULL replay (remaining fills regenerate), passing
        // the reverted mask's bounds so its tiles rewrite too.
        expect(calls).toHaveLength(1);
        expect(calls[0].args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'apply-ortho-patches']);
        expect(calls[0].args).not.toContain('--seq');
        expect(argValue(calls[0].args, '--extra-bounds'))
            .toBe('1733100,8018100,1733140,8018140');
        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1]);
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(false);
        expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(true);

        const info = await svc.info(TEST_COURSE_ID);
        expect(info.count).toBe(1);
        expect(info.lastTool).toBe('sam');
    } finally {
        await cleanup();
    }
});

test('revertLast with an empty log is a no-op (no pipeline call, no bump)', async () => {
    const { svc, dataDir, calls, cleanup } = await setup();
    try {
        const result = await svc.revertLast(TEST_COURSE_ID);
        expect(result.count).toBe(0);
        expect(calls).toHaveLength(0);
        const onDisk = JSON.parse(await readFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), 'utf8'));
        expect(onDisk.generatedAt).toBe(MANIFEST.generatedAt);
    } finally {
        await cleanup();
    }
});

test('a failed revert replay restores the log entry', async () => {
    let failNext = false;
    const { svc, readLog, cleanup } = await setup({ fail: () => failNext });
    try {
        await svc.apply(TEST_COURSE_ID, PATCH);
        failNext = true;
        await expect(svc.revertLast(TEST_COURSE_ID)).rejects.toThrow(/replay boom/);
        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1]);
        expect((await svc.info(TEST_COURSE_ID)).count).toBe(1);
    } finally {
        await cleanup();
    }
});

test('apply rejects non-PNG payloads and degenerate bounds without storing anything', async () => {
    const { svc, patchesDir, calls, cleanup } = await setup();
    try {
        await expect(svc.apply(TEST_COURSE_ID, { ...PATCH, maskPngBase64: Buffer.from('not a png').toString('base64') }))
            .rejects.toThrow(/not a PNG/);
        await expect(svc.apply(TEST_COURSE_ID, {
            ...PATCH,
            bounds3857: { west: 10, south: 10, east: 5, north: 20 },
        })).rejects.toThrow(/degenerate/);
        expect(calls).toHaveLength(0);
        expect(await Bun.file(path.join(patchesDir, 'patches.json')).exists()).toBe(false);
    } finally {
        await cleanup();
    }
});

test('apply/info for a course without a built map explain themselves', async () => {
    const { svc, cleanup } = await setup({ withSite: false });
    try {
        // info: readable (0 patches, not bakeable) without minting a site.
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.count).toBe(0);
        expect(info.bakeable).toBe(false);
        expect(info.reason).toMatch(/no map|build the map/);
        await expect(svc.apply(TEST_COURSE_ID, PATCH)).rejects.toThrow(/no map|build the map/);
    } finally {
        await cleanup();
    }
});

test('empty ortho-vintage metadata + exactly one ortho-*.tif on disk: bake proceeds via the fallback', async () => {
    // Legacy build: manifest present but no activeOrtho / empty orthoVintages,
    // yet a single pristine ortho-*.tif sits in sources/<siteId>/.
    const { ctx, svc, assets, dataDir, calls, cleanup } = await setup({ withSite: false });
    try {
        await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Legacy site', version: 1 }).execute();
        await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID)
            .set({ site_id: SITE_ID, updated_at: sql`(datetime('now'))` }).execute();
        await mkdir(path.join(dataDir, 'sources', SITE_ID), { recursive: true });
        // One source tif whose name does NOT match any vintage collection.
        await writeFile(path.join(dataDir, 'sources', SITE_ID, 'ortho-legacy.tif'), 'pristine');
        await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
        const legacyManifest = { ...MANIFEST, orthoVintages: [], activeOrtho: undefined };
        await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), JSON.stringify(legacyManifest));
        await assets.register({
            siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
            filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify(legacyManifest),
        });

        // Pre-flight reports bakeable.
        expect((await svc.info(TEST_COURSE_ID)).bakeable).toBe(true);

        // Bake proceeds against the sole source tif.
        const result = await svc.apply(TEST_COURSE_ID, PATCH);
        expect(result.count).toBe(1);
        expect(calls).toHaveLength(1);
        expect(argValue(calls[0].args, '--ortho'))
            .toBe(path.join(dataDir, 'sources', SITE_ID, 'ortho-legacy.tif'));
    } finally {
        await cleanup();
    }
});

// --- Built-vintage resolution (fix: ortho-patch vintage resolution) ---
// The vintage patches replay onto MUST be the vintage the flat tile tree was
// built from. `builtOrtho` is the explicit marker; legacy manifests without
// it infer the newest recorded vintage, and never silently pick another.

/** Site + custom manifest + the given pristine tifs, via the setup() db. */
async function setupVintage(manifest: Record<string, unknown>, tifs: string[]) {
    const base = await setup({ withSite: false });
    const { ctx, assets, dataDir } = base;
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Vintage site', version: 1 }).execute();
    await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID)
        .set({ site_id: SITE_ID, updated_at: sql`(datetime('now'))` }).execute();
    await mkdir(path.join(dataDir, 'sources', SITE_ID), { recursive: true });
    for (const tif of tifs) {
        await writeFile(path.join(dataDir, 'sources', SITE_ID, tif), 'pristine');
    }
    await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
    await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), JSON.stringify(manifest));
    await assets.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
        filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify(manifest),
    });
    return base;
}

const TWO_VINTAGES = [
    { collection: 'orto-l2-2025', dates: ['2025-06-21'] },
    { collection: 'orto-l2-2023', dates: ['2023-04-21'] },
];

test('builtOrtho marker wins: bake + pre-flight replay onto the recorded built vintage', async () => {
    // Marker says 2023 even though 2025 is newest — an explicit record beats
    // any inference (e.g. a site rebuilt while pinned to an older flight).
    const manifest = {
        ...MANIFEST, orthoVintages: TWO_VINTAGES,
        activeOrtho: 'orto-l2-2023', builtOrtho: 'orto-l2-2023',
    };
    const { svc, dataDir, calls, cleanup } =
        await setupVintage(manifest, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif']);
    try {
        expect((await svc.info(TEST_COURSE_ID)).bakeable).toBe(true);
        await svc.apply(TEST_COURSE_ID, PATCH);
        expect(argValue(calls[0].args, '--ortho'))
            .toBe(path.join(dataDir, 'sources', SITE_ID, 'ortho-orto-l2-2023.tif'));
    } finally {
        await cleanup();
    }
});

test('builtOrtho naming a missing tif refuses — never falls back to another vintage', async () => {
    const manifest = {
        ...MANIFEST, orthoVintages: TWO_VINTAGES,
        activeOrtho: 'orto-l2-2025', builtOrtho: 'orto-l2-2025',
    };
    // Only the OTHER vintage's tif is on disk (it is also the sole one — the
    // sole-tif fallback must not kick in for a named vintage).
    const { svc, cleanup } = await setupVintage(manifest, ['ortho-orto-l2-2023.tif']);
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.reason).toMatch(/ortho-orto-l2-2025\.tif.*rebuild/);
        await expect(svc.apply(TEST_COURSE_ID, PATCH)).rejects.toThrow(/ortho-orto-l2-2025\.tif/);
    } finally {
        await cleanup();
    }
});

test('legacy two-tif manifest without marker resolves to the NEWEST recorded vintage', async () => {
    // activeOrtho agrees with orthoVintages[0] (every post-switcher build
    // writes them equal) — resolution must pick 2025, never the older 2023.
    for (const activeOrtho of ['orto-l2-2025', undefined]) {
        const manifest = { ...MANIFEST, orthoVintages: TWO_VINTAGES, activeOrtho, builtOrtho: undefined };
        const { svc, dataDir, calls, cleanup } =
            await setupVintage(manifest, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif']);
        try {
            expect((await svc.info(TEST_COURSE_ID)).bakeable).toBe(true);
            await svc.apply(TEST_COURSE_ID, PATCH);
            expect(argValue(calls[0].args, '--ortho'))
                .toBe(path.join(dataDir, 'sources', SITE_ID, 'ortho-orto-l2-2025.tif'));
        } finally {
            await cleanup();
        }
    }
});

test('legacy manifest with a DIVERGENT activeOrtho (removed in-place switcher) refuses to bake', async () => {
    // Linkan's exact shape: vintages [2025, 2023] but activeOrtho=2023 left
    // behind by the removed re-tiling switcher. The flat tree's vintage is
    // unrecorded — pre-flight and bake must refuse identically, not guess.
    const manifest = {
        ...MANIFEST, orthoVintages: TWO_VINTAGES, activeOrtho: 'orto-l2-2023', builtOrtho: undefined,
    };
    const { svc, calls, cleanup } =
        await setupVintage(manifest, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif']);
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.reason).toMatch(/ambiguous.*rebuild the map/);
        await expect(svc.apply(TEST_COURSE_ID, PATCH)).rejects.toThrow(/ambiguous/);
        expect(calls).toHaveLength(0); // nothing replayed onto either vintage
    } finally {
        await cleanup();
    }
});

test('empty ortho-vintage metadata + NO source tif (Vreta): not bakeable, apply gives the clear error', async () => {
    const { ctx, svc, assets, dataDir, cleanup } = await setup({ withSite: false });
    try {
        await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Vreta-like site', version: 1 }).execute();
        await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID)
            .set({ site_id: SITE_ID, updated_at: sql`(datetime('now'))` }).execute();
        // sources dir has a dem.tif but no ortho-*.tif (mirrors Vreta).
        await mkdir(path.join(dataDir, 'sources', SITE_ID), { recursive: true });
        await writeFile(path.join(dataDir, 'sources', SITE_ID, 'dem.tif'), 'dem');
        await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
        const legacyManifest = { ...MANIFEST, orthoVintages: [], activeOrtho: undefined };
        await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), JSON.stringify(legacyManifest));
        await assets.register({
            siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
            filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify(legacyManifest),
        });

        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.reason).toMatch(/no ortho vintage|rebuild the map/);
        await expect(svc.apply(TEST_COURSE_ID, PATCH)).rejects.toThrow(/no ortho vintage|rebuild the map/);
    } finally {
        await cleanup();
    }
});

// --- Inpaint-deps pre-flight + legacy-log detection (seam-free rework) ------

test('missing LaMa weights: not bakeable with a download hint (previews still fine)', async () => {
    const { svc, lamaWeights, cleanup } = await setup({ withWeights: false });
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.reason).toContain(lamaWeights);
        expect(info.reason).toMatch(/big-lama/);
    } finally {
        await cleanup();
    }
});

test('torch missing in the pipeline venv: not bakeable with the install hint', async () => {
    const { svc, cleanup } = await setup({ torchOk: () => false });
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.reason).toMatch(/torch.*requirements-inpaint/);
    } finally {
        await cleanup();
    }
});

test('a legacy version-1 pixel-patch log is refused, never misread as masks', async () => {
    const { svc, patchesDir, cleanup } = await setup();
    try {
        await mkdir(patchesDir, { recursive: true });
        await writeFile(path.join(patchesDir, 'patches.json'), JSON.stringify({
            version: 1,
            patches: [{
                seq: 1, file: '1.png',
                bounds3857: PATCH.bounds3857, boundsSweref: PATCH.boundsSweref,
                tool: 'sam', createdAt: '2026-07-19T04:25:26.968Z',
            }],
        }));
        await expect(svc.apply(TEST_COURSE_ID, PATCH)).rejects.toThrow(/version-1 pixel-patch log/);
        await expect(svc.info(TEST_COURSE_ID)).rejects.toThrow(/version-1 pixel-patch log/);
    } finally {
        await cleanup();
    }
});

test('an EMPTY legacy version-1 log upgrades silently to version 2 on the next apply', async () => {
    const { svc, patchesDir, readLog, cleanup } = await setup();
    try {
        await mkdir(patchesDir, { recursive: true });
        await writeFile(path.join(patchesDir, 'patches.json'), JSON.stringify({ version: 1, patches: [] }));
        const result = await svc.apply(TEST_COURSE_ID, PATCH);
        expect(result.count).toBe(1);
        expect((await readLog()).version).toBe(2);
    } finally {
        await cleanup();
    }
});
