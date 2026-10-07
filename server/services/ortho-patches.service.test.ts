import { test, expect } from 'bun:test';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sql } from 'kysely';
import { TEST_COURSE_ID } from '../db/seeds/course';
import {
    ACTIVE, FRAME, IMPORT_BOUNDS_3006, IMPORT_BOUNDS_3857, MANIFEST, SITE_ID, TINY_PNG_BASE64,
    argValue, argValues, setup, type FakeImportOutcome,
} from '../testing/ortho-patches';
import {
    InvalidOrthoImportError,
    type OrthoMaskEditInput,
    type OrthoStampEditInput,
} from './ortho-patches.service';

// Interactive photo cleaning — batch mask+stamp edit log (version 2) +
// exec-call (batch bake-ortho-patch on accept, full apply-ortho-patches
// replay on revert) + dual-photo-state sim overlay (bakes retile into
// ortho-sim/, pristine tree and its version untouched) + inpaint-deps
// pre-flight split (masks need torch, stamps don't) + the external-edit loop
// (square export, diff import as a raster entry), over a fixture pipeline
// runner (testing/ortho-patches.ts — no Python).

const MASK_EDIT: OrthoMaskEditInput = {
    kind: 'mask',
    maskPngBase64: TINY_PNG_BASE64,
    bounds3857: { west: 1733000, south: 8018000, east: 1733040, north: 8018040 },
    boundsSweref: { west: 533000, south: 6473000, east: 533040, north: 6473040 },
    tool: 'sam',
};

const STAMP_EDIT: OrthoStampEditInput = {
    kind: 'stamp',
    brush: { sizeM: 3, opacity: 1, flow: 0.6, hardness: 0.7 },
    offsetM: { dx: 12.5, dy: -3.25 },
    path: [{ x: 533020, y: 6473020 }, { x: 533026, y: 6473024 }],
    aligned: true,
    toneMatch: true,
    bounds3857: { west: 1733030, south: 8018030, east: 1733060, north: 8018060 },
    boundsSweref: { west: 533018, south: 6473018, east: 533028, north: 6473026 },
};

test('applyEdits stores the mask + log entry, runs the batch bake into the SIM overlay, and bumps ONLY the sim version', async () => {
    const { svc, assets, dataDir, calls, patchesDir, readLog, readManifest, lamaWeights, cleanup } = await setup();
    try {
        const result = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
        expect(result.count).toBe(1);
        expect(result.patchesGeneratedAt).toBeTruthy();

        // Mask stored: 1.png (real PNG bytes) + a full VERSION-2 log entry.
        const pngBytes = await readFile(path.join(patchesDir, '1.png'));
        expect(pngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const log = await readLog();
        expect(log.version).toBe(2);
        expect(log.patches).toHaveLength(1);
        expect(log.patches[0].seq).toBe(1);
        expect(log.patches[0].kind).toBe('mask');
        expect(log.patches[0].file).toBe('1.png');
        expect(log.patches[0].tool).toBe('sam');
        expect(log.patches[0].bounds3857).toEqual(MASK_EDIT.bounds3857);

        // Exactly one pipeline call — the batch windowed bake of THIS seq,
        // with the pristine source, the patches dir, the .patched.tif
        // working output, the SIM overlay tile tree (never the pristine
        // flat tree), the pristine tree as parent-derivation fallback, the
        // build's zoom range, and the LaMa weights.
        expect(calls).toHaveLength(1);
        const args = calls[0].args;
        expect(args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'bake-ortho-patch']);
        expect(argValues(args, '--seq')).toEqual(['1']);
        expect(argValue(args, '--ortho')).toBe(path.join(dataDir, 'sources', SITE_ID, `ortho-${ACTIVE}.tif`));
        expect(argValue(args, '--patches-dir')).toBe(patchesDir);
        expect(argValue(args, '--out')).toBe(path.join(dataDir, 'sources', SITE_ID, `ortho-${ACTIVE}.patched.tif`));
        expect(argValue(args, '--tiles-out')).toBe(path.join(dataDir, 'tiles', SITE_ID, 'ortho-sim'));
        expect(argValue(args, '--pristine-tiles')).toBe(path.join(dataDir, 'tiles', SITE_ID, 'ortho'));
        expect(argValue(args, '--minzoom')).toBe('14');
        expect(argValue(args, '--maxzoom')).toBe('20');
        expect(argValue(args, '--weights')).toBe(lamaWeights);
        expect(args).not.toContain('--extra-bounds');

        // Dual photo state: the SIM version stamp landed in BOTH the on-disk
        // manifest and the asset copy — and the pristine generatedAt is
        // UNTOUCHED (cleaning must never invalidate pristine tile caches).
        const onDisk = await readManifest();
        expect(onDisk.patchesGeneratedAt).toBe(result.patchesGeneratedAt);
        expect(onDisk.generatedAt).toBe(MANIFEST.generatedAt);
        expect(onDisk.activeOrtho).toBe(ACTIVE); // other fields preserved
        const asset = (await assets.listBySite(SITE_ID)).find(a => a.kind === 'tile_manifest')!;
        expect(JSON.parse(asset.metaJson!).patchesGeneratedAt).toBe(result.patchesGeneratedAt);
        expect(JSON.parse(asset.metaJson!).generatedAt).toBe(MANIFEST.generatedAt);
    } finally {
        await cleanup();
    }
});

test('a BATCH of mixed mask+stamp edits appends in order and bakes with ONE pipeline call + one version bump', async () => {
    const { svc, calls, readLog, patchesDir, cleanup } = await setup();
    try {
        const result = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT, STAMP_EDIT, { ...MASK_EDIT, tool: 'ellipse' }]);
        expect(result.count).toBe(3);

        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1, 2, 3]);
        expect(log.patches.map(p => p.kind)).toEqual(['mask', 'stamp', 'mask']);
        expect(log.patches[0].file).toBe('1.png');
        expect(log.patches[1].file).toBeUndefined(); // stamps carry no pixels
        expect(log.patches[2].file).toBe('3.png');
        expect(log.patches[1].tool).toBe('stamp');
        // Stamp payload round-trips the log exactly (path as [x, y] pairs).
        expect(log.patches[1].stamp).toEqual({
            brush: STAMP_EDIT.brush,
            offsetM: STAMP_EDIT.offsetM,
            path: STAMP_EDIT.path.map(p => [p.x, p.y]),
            aligned: true,
            toneMatch: true,
        });
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(false);

        // ONE batch bake carrying every seq in order.
        expect(calls).toHaveLength(1);
        expect(calls[0].args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'bake-ortho-patch']);
        expect(argValues(calls[0].args, '--seq')).toEqual(['1', '2', '3']);
    } finally {
        await cleanup();
    }
});

test('a second applyEdits appends after the existing log and mints a distinct sim version', async () => {
    const { svc, calls, readLog, cleanup } = await setup();
    try {
        const first = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
        const second = await svc.applyEdits(TEST_COURSE_ID, [{ ...MASK_EDIT, tool: 'ellipse' }, STAMP_EDIT]);
        expect(second.count).toBe(3);
        expect(second.patchesGeneratedAt).not.toBe(first.patchesGeneratedAt); // ms-precision ISO

        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1, 2, 3]);
        expect(log.patches[1].tool).toBe('ellipse');

        expect(calls.map(c => c.args[2])).toEqual(['bake-ortho-patch', 'bake-ortho-patch']);
        expect(argValues(calls[1].args, '--seq')).toEqual(['2', '3']);
    } finally {
        await cleanup();
    }
});

test('a failed batch bake rolls back EVERY stored edit and leaves versions untouched', async () => {
    const { svc, readLog, patchesDir, readManifest, cleanup } = await setup({ fail: () => true });
    try {
        await expect(svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT, STAMP_EDIT])).rejects.toThrow(/replay boom/);

        const log = await readLog();
        expect(log.patches).toHaveLength(0);
        expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(false);
        const onDisk = await readManifest();
        expect(onDisk.generatedAt).toBe(MANIFEST.generatedAt);
        expect(onDisk.patchesGeneratedAt).toBeUndefined();
        expect(await svc.info(TEST_COURSE_ID)).toEqual({
            count: 0, lastCreatedAt: null, lastTool: null,
            bakeable: true, stampBakeable: true, patchesGeneratedAt: null,
            exports: [], frame: null,
        });
    } finally {
        await cleanup();
    }
});

test('revertLast peels ONE entry (not one batch), retiles its bounds via --extra-bounds, and bumps the sim version', async () => {
    const { svc, calls, readLog, patchesDir, cleanup } = await setup();
    try {
        const applied = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT, STAMP_EDIT]);
        calls.length = 0;

        const result = await svc.revertLast(TEST_COURSE_ID);
        expect(result.count).toBe(1); // the stamp came off, the mask stays
        expect(result.patchesGeneratedAt).not.toBe(applied.patchesGeneratedAt);

        // Revert runs the FULL replay (remaining fills regenerate), passing
        // the reverted entry's bounds so its sim tiles rewrite too.
        expect(calls).toHaveLength(1);
        expect(calls[0].args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'apply-ortho-patches']);
        expect(calls[0].args).not.toContain('--seq');
        expect(argValue(calls[0].args, '--extra-bounds'))
            .toBe('1733030,8018030,1733060,8018060');
        expect(argValue(calls[0].args, '--tiles-out')).toContain('ortho-sim');
        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1]);
        expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(true);

        const info = await svc.info(TEST_COURSE_ID);
        expect(info.count).toBe(1);
        expect(info.lastTool).toBe('sam');
    } finally {
        await cleanup();
    }
});

test('reverting the LAST remaining entry deletes the sim overlay tree (pure pristine fallback)', async () => {
    const { svc, simDir, cleanup } = await setup();
    try {
        await svc.applyEdits(TEST_COURSE_ID, [STAMP_EDIT]);
        // Simulate the sim overlay the real retile would have written.
        await mkdir(path.join(simDir, '20', '1'), { recursive: true });
        await writeFile(path.join(simDir, '20', '1', '2.webp'), 'sim tile');

        const result = await svc.revertLast(TEST_COURSE_ID);
        expect(result.count).toBe(0);
        expect(await Bun.file(path.join(simDir, '20', '1', '2.webp')).exists()).toBe(false);
    } finally {
        await cleanup();
    }
});

test('revertLast with an empty log is a no-op (no pipeline call, no bump)', async () => {
    const { svc, calls, readManifest, cleanup } = await setup();
    try {
        const result = await svc.revertLast(TEST_COURSE_ID);
        expect(result.count).toBe(0);
        expect(calls).toHaveLength(0);
        expect((await readManifest()).generatedAt).toBe(MANIFEST.generatedAt);
    } finally {
        await cleanup();
    }
});

test('a failed revert replay restores the log entry', async () => {
    let failNext = false;
    const { svc, readLog, cleanup } = await setup({ fail: () => failNext });
    try {
        await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
        failNext = true;
        await expect(svc.revertLast(TEST_COURSE_ID)).rejects.toThrow(/replay boom/);
        const log = await readLog();
        expect(log.patches.map(p => p.seq)).toEqual([1]);
        expect((await svc.info(TEST_COURSE_ID)).count).toBe(1);
    } finally {
        await cleanup();
    }
});

test('applyEdits rejects bad payloads without storing anything', async () => {
    const { svc, patchesDir, calls, cleanup } = await setup();
    try {
        await expect(svc.applyEdits(TEST_COURSE_ID, [])).rejects.toThrow(/No edits/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [
            { ...MASK_EDIT, maskPngBase64: Buffer.from('not a png').toString('base64') },
        ])).rejects.toThrow(/not a PNG/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [
            { ...MASK_EDIT, bounds3857: { west: 10, south: 10, east: 5, north: 20 } },
        ])).rejects.toThrow(/degenerate/);
        // A bad edit ANYWHERE in the batch refuses the whole batch up front.
        await expect(svc.applyEdits(TEST_COURSE_ID, [
            MASK_EDIT,
            { ...STAMP_EDIT, brush: { ...STAMP_EDIT.brush, sizeM: -1 } },
        ])).rejects.toThrow(/sizeM/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [
            { ...STAMP_EDIT, brush: { ...STAMP_EDIT.brush, flow: 0 } },
        ])).rejects.toThrow(/flow/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [
            { ...STAMP_EDIT, offsetM: { dx: Number.NaN, dy: 0 } },
        ])).rejects.toThrow(/offset/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [
            { ...STAMP_EDIT, path: [] },
        ])).rejects.toThrow(/path/);
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
        expect(info.stampBakeable).toBe(false);
        expect(info.reason).toMatch(/no map|build the map/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT])).rejects.toThrow(/no map|build the map/);
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
        const result = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
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
        await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
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
        expect(info.stampBakeable).toBe(false); // source failures block stamps too
        expect(info.reason).toMatch(/ortho-orto-l2-2025\.tif.*rebuild/);
        await expect(svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT])).rejects.toThrow(/ortho-orto-l2-2025\.tif/);
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
            await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
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
        await expect(svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT])).rejects.toThrow(/ambiguous/);
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
        await expect(svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT])).rejects.toThrow(/no ortho vintage|rebuild the map/);
    } finally {
        await cleanup();
    }
});

// --- Inpaint-deps pre-flight (masks need torch, stamps never do) ------------

test('missing LaMa weights: masks not bakeable (download hint), stamps STILL bakeable', async () => {
    const { svc, lamaWeights, cleanup } = await setup({ withWeights: false });
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.stampBakeable).toBe(true); // pure pixel math — no torch
        expect(info.reason).toContain(lamaWeights);
        expect(info.reason).toMatch(/big-lama/);

        // And a stamp-only batch actually bakes (the pipeline never imports
        // torch for stamp entries).
        const result = await svc.applyEdits(TEST_COURSE_ID, [STAMP_EDIT]);
        expect(result.count).toBe(1);
    } finally {
        await cleanup();
    }
});

test('torch missing in the pipeline venv: masks blocked with the install hint, stamps unaffected', async () => {
    const { svc, cleanup } = await setup({ torchOk: () => false });
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bakeable).toBe(false);
        expect(info.stampBakeable).toBe(true);
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
                bounds3857: MASK_EDIT.bounds3857, boundsSweref: MASK_EDIT.boundsSweref,
                tool: 'sam', createdAt: '2026-07-19T04:25:26.968Z',
            }],
        }));
        await expect(svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT])).rejects.toThrow(/version-1 pixel-patch log/);
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
        const result = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT]);
        expect(result.count).toBe(1);
        expect((await readLog()).version).toBe(2);
    } finally {
        await cleanup();
    }
});

// --- External edit: square export + diff import (docs/feature-ortho-export-import.md) ---

const DOWNLOAD = (n: number) => `/ortho-patches/export/${SITE_ID}/${n}/file`;

test('the first export makes the frame the inner terrain square when the manifest has one, not the squared bounds', async () => {
    const { svc, calls, assets, sourcesDir, cleanup } = await setup();
    try {
        const manifest = { ...MANIFEST, terrain: { inner: { square3006: [529030, 6486669, 531080, 6488719], sideM: 2050 } } };
        const asset = (await assets.listBySite(SITE_ID)).find(a => a.kind === 'tile_manifest')!;
        await assets.update(asset.id, asset.version, { metaJson: JSON.stringify(manifest) });

        await svc.exportSquare(TEST_COURSE_ID);
        expect(calls[0].args).not.toContain('--bounds-wgs84');
        expect(JSON.parse(await readFile(path.join(sourcesDir, 'sim-frame.json'), 'utf8')))
            .toEqual({ extent3006: [529030, 6486669, 531080, 6488719], size: 8192 });
    } finally {
        await cleanup();
    }
});

test('exportSquare on a never-patched site exports the PRISTINE photo, creates the frame once, and numbers exports from 1', async () => {
    const { svc, calls, sourcesDir, exportsDir, readManifest, cleanup } = await setup();
    try {
        const before = await svc.info(TEST_COURSE_ID);
        expect(before.exports).toEqual([]);
        expect(before.frame).toBeNull();

        const first = await svc.exportSquare(TEST_COURSE_ID);

        // One pipeline call: no bake/replay for an empty log, the pristine
        // ortho as source, log seq 0, and the manifest bounds because the
        // frame did not exist yet.
        expect(calls).toHaveLength(1);
        const args = calls[0].args;
        expect(args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'export-ortho-square']);
        expect(argValue(args, '--ortho')).toBe(path.join(sourcesDir, `ortho-${ACTIVE}.tif`));
        expect(argValue(args, '--frame')).toBe(path.join(sourcesDir, 'sim-frame.json'));
        expect(argValue(args, '--out-dir')).toBe(path.join(exportsDir, '1'));
        expect(argValue(args, '--seq')).toBe('1');
        expect(argValue(args, '--log-seq')).toBe('0');
        expect(argValue(args, '--format')).toBe('png');
        expect(argValue(args, '--bounds-wgs84')).toBe('15.55,58.39,15.58,58.41');
        expect(args).not.toContain('--size');

        expect(first).toMatchObject({
            siteId: SITE_ID, exportSeq: 1, extent3006: FRAME.extent3006, size: 8192, logSeq: 0,
            file: 'ortho-sim-1.png', format: 'png', downloadPath: DOWNLOAD(1),
            replayed: false, patchesGeneratedAt: null,
        });
        expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(first.bytes).toBeGreaterThan(0);
        expect(first.createdAt).toBeTruthy();
        // An export never touches the sim tiles' version.
        expect((await readManifest()).patchesGeneratedAt).toBeUndefined();

        // Second export: next number, and the existing frame is left alone
        // (no bounds passed — golfpipe would refuse them against a frame).
        const second = await svc.exportSquare(TEST_COURSE_ID, 'jpg');
        expect(second).toMatchObject({ exportSeq: 2, file: 'ortho-sim-2.jpg', format: 'jpg', downloadPath: DOWNLOAD(2) });
        expect(argValue(calls[1].args, '--out-dir')).toBe(path.join(exportsDir, '2'));
        expect(argValue(calls[1].args, '--format')).toBe('jpg');
        expect(calls[1].args).not.toContain('--bounds-wgs84');

        const info = await svc.info(TEST_COURSE_ID);
        expect(info.frame).toEqual(FRAME);
        expect(info.exports).toEqual([
            { seq: 1, createdAt: first.createdAt, logSeq: 0, size: 8192, format: 'png', bytes: first.bytes, downloadPath: DOWNLOAD(1) },
            { seq: 2, createdAt: second.createdAt, logSeq: 0, size: 8192, format: 'jpg', bytes: second.bytes, downloadPath: DOWNLOAD(2) },
        ]);

        const file = await svc.exportFile(SITE_ID, 2);
        expect(file).toMatchObject({ file: 'ortho-sim-2.jpg', format: 'jpg', sha256: second.sha256 });
        expect(await readFile(file.path, 'utf8')).toContain('export 2');
        await expect(svc.exportFile(SITE_ID, 3)).rejects.toThrow(/not found/);
        await expect(svc.exportFile('../etc', 1)).rejects.toThrow(/not found/);
    } finally {
        await cleanup();
    }
});

test('exportSquare on a patched site exports the working .patched.tif at the log\'s last seq, replaying first only when it is stale', async () => {
    const { svc, calls, sourcesDir, readManifest, cleanup } = await setup();
    try {
        const applied = await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT, STAMP_EDIT]);
        const pristine = path.join(sourcesDir, `ortho-${ACTIVE}.tif`);
        const patched = path.join(sourcesDir, `ortho-${ACTIVE}.patched.tif`);
        calls.length = 0;

        // Up to date: straight to the export, nothing baked again.
        const current = await svc.exportSquare(TEST_COURSE_ID);
        expect(calls.map(c => c.args[2])).toEqual(['export-ortho-square']);
        expect(argValue(calls[0].args, '--ortho')).toBe(patched);
        expect(argValue(calls[0].args, '--log-seq')).toBe('2');
        expect(current).toMatchObject({ exportSeq: 1, logSeq: 2, replayed: false, patchesGeneratedAt: applied.patchesGeneratedAt });

        // The pristine photo is newer than the working raster (a rebuild
        // replaced it): full replay first, sim tiles rewritten, version bumped.
        const future = new Date(Date.now() + 60_000);
        await utimes(pristine, future, future);
        calls.length = 0;
        const stale = await svc.exportSquare(TEST_COURSE_ID);
        expect(calls.map(c => c.args[2])).toEqual(['apply-ortho-patches', 'export-ortho-square']);
        expect(argValue(calls[0].args, '--ortho')).toBe(pristine);
        expect(argValue(calls[0].args, '--tiles-out')).toContain('ortho-sim');
        expect(argValue(calls[1].args, '--ortho')).toBe(patched);
        expect(stale.replayed).toBe(true);
        expect(stale.exportSeq).toBe(2);
        expect(stale.patchesGeneratedAt).not.toBe(applied.patchesGeneratedAt);
        expect((await readManifest()).patchesGeneratedAt).toBe(stale.patchesGeneratedAt);

        // The working raster is gone altogether: same replay.
        await utimes(pristine, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
        await rm(patched);
        calls.length = 0;
        expect((await svc.exportSquare(TEST_COURSE_ID)).replayed).toBe(true);
        expect(calls.map(c => c.args[2])).toEqual(['apply-ortho-patches', 'export-ortho-square']);
    } finally {
        await cleanup();
    }
});

test('export numbering: a failed export leaves no directory, an unfinished one is cleared, and neither uses up a number', async () => {
    let failExport = false;
    const { svc, exportsDir, cleanup } = await setup({ fail: (cmd) => failExport && cmd === 'export-ortho-square' });
    try {
        expect((await svc.exportSquare(TEST_COURSE_ID)).exportSeq).toBe(1);

        failExport = true;
        await expect(svc.exportSquare(TEST_COURSE_ID)).rejects.toThrow(/export-ortho-square failed: replay boom/);
        expect(await Bun.file(path.join(exportsDir, '2', 'export.json')).exists()).toBe(false);
        expect((await svc.info(TEST_COURSE_ID)).exports.map(e => e.seq)).toEqual([1]);

        // A crashed attempt: image written, export.json (written last) missing.
        await mkdir(path.join(exportsDir, '2'), { recursive: true });
        await writeFile(path.join(exportsDir, '2', 'ortho-sim-2.png'), 'half an image');
        expect((await svc.info(TEST_COURSE_ID)).exports.map(e => e.seq)).toEqual([1]);
        await expect(svc.exportFile(SITE_ID, 2)).rejects.toThrow(/not found/);

        failExport = false;
        const next = await svc.exportSquare(TEST_COURSE_ID);
        expect(next.exportSeq).toBe(2);
        expect(await readFile(path.join(exportsDir, '2', 'ortho-sim-2.png'), 'utf8')).toContain('export 2');
        // Export 1 is immutable: still there, untouched.
        expect((await svc.info(TEST_COURSE_ID)).exports.map(e => e.seq)).toEqual([1, 2]);
    } finally {
        await cleanup();
    }
});

test('importEdited stores the diff as ONE raster entry, bakes that seq, bumps the sim version and deletes the upload', async () => {
    const { svc, calls, sourcesDir, patchesDir, exportsDir, readLog, readManifest, incoming, incomingLeft, cleanup } = await setup();
    try {
        await svc.applyEdits(TEST_COURSE_ID, [STAMP_EDIT]);
        await svc.exportSquare(TEST_COURSE_ID);
        await svc.exportSquare(TEST_COURSE_ID);
        calls.length = 0;

        const tmpPath = await incoming();
        const result = await svc.importEdited(TEST_COURSE_ID, { tmpPath });

        expect(result).toEqual({
            changed: true,
            count: 2,
            patchesGeneratedAt: (await readManifest()).patchesGeneratedAt as string,
            seq: 2,
            exportSeq: 2, // default: the latest export
            changedPixels: 123168,
            diffPixels: 121600,
            tolerance: 2,
            minAreaPx: 4,
            bounds3006: IMPORT_BOUNDS_3006,
            bounds3857: IMPORT_BOUNDS_3857,
            regions: 2,
        });

        // Diff first (patched raster, the export's dir, the upload, the new
        // seq, no tolerance unless asked), then the ordinary windowed bake.
        expect(calls.map(c => c.args[2])).toEqual(['import-ortho-square', 'bake-ortho-patch']);
        const imp = calls[0].args;
        expect(argValue(imp, '--ortho')).toBe(path.join(sourcesDir, `ortho-${ACTIVE}.patched.tif`));
        expect(argValue(imp, '--patches-dir')).toBe(patchesDir);
        expect(argValue(imp, '--export-dir')).toBe(path.join(exportsDir, '2'));
        expect(argValue(imp, '--image')).toBe(tmpPath);
        expect(argValue(imp, '--seq')).toBe('2');
        expect(imp).not.toContain('--tolerance');
        expect(argValues(calls[1].args, '--seq')).toEqual(['2']);
        expect(argValue(calls[1].args, '--ortho')).toBe(path.join(sourcesDir, `ortho-${ACTIVE}.tif`)); // bake: pristine

        // The log entry, exactly as golfpipe's replay reads it.
        const log = await readLog();
        expect(log.version).toBe(2);
        expect(log.patches.map(p => p.kind)).toEqual(['stamp', 'raster']);
        const { createdAt, ...entry } = log.patches[1];
        expect(entry).toEqual({
            seq: 2, kind: 'raster', file: '2.png',
            bounds3006: IMPORT_BOUNDS_3006, bounds3857: IMPORT_BOUNDS_3857,
            exportSeq: 2, changedPixels: 123168, tool: 'external',
        });
        expect(Date.parse(createdAt as string)).not.toBeNaN();
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(true);
        expect(await Bun.file(tmpPath).exists()).toBe(false);
        expect(incomingLeft()).toEqual([]);

        const info = await svc.info(TEST_COURSE_ID);
        expect(info).toMatchObject({ count: 2, lastTool: 'external', patchesGeneratedAt: result.patchesGeneratedAt });

        // An edit of the OLDER export, with a tolerance the builder chose;
        // tool edits keep numbering after a raster entry.
        calls.length = 0;
        const older = await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(), exportSeq: 1, tolerance: 12 });
        expect(older).toMatchObject({ changed: true, seq: 3, exportSeq: 1, tolerance: 12, count: 3 });
        expect(argValue(calls[0].args, '--export-dir')).toBe(path.join(exportsDir, '1'));
        expect(argValue(calls[0].args, '--tolerance')).toBe('12');
        expect((await svc.applyEdits(TEST_COURSE_ID, [MASK_EDIT])).count).toBe(4);
        expect((await readLog()).patches.map(p => [p.seq, p.kind, p.file])).toEqual([
            [1, 'stamp', undefined], [2, 'raster', '2.png'], [3, 'raster', '3.png'], [4, 'mask', '4.png'],
        ]);
    } finally {
        await cleanup();
    }
});

test('importEdited on a never-patched site reads the pristine photo for the extent and starts the log at seq 1', async () => {
    const { svc, calls, sourcesDir, readLog, incoming, cleanup } = await setup();
    try {
        await svc.exportSquare(TEST_COURSE_ID);
        calls.length = 0;
        const result = await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() });
        expect(result).toMatchObject({ changed: true, seq: 1, count: 1 });
        expect(argValue(calls[0].args, '--ortho')).toBe(path.join(sourcesDir, `ortho-${ACTIVE}.tif`));
        expect((await readLog()).patches.map(p => p.kind)).toEqual(['raster']);
    } finally {
        await cleanup();
    }
});

test('importEdited with nothing changed appends nothing, bakes nothing and leaves the sim version alone', async () => {
    let outcome: FakeImportOutcome = 'identical';
    const { svc, calls, patchesDir, readLog, incoming, incomingLeft, cleanup } = await setup({ importOutcome: () => outcome });
    try {
        const applied = await svc.applyEdits(TEST_COURSE_ID, [STAMP_EDIT]);
        await svc.exportSquare(TEST_COURSE_ID);

        for (const reason of ['identical', 'below-min-area', 'outside-ortho'] as const) {
            outcome = reason;
            calls.length = 0;
            const result = await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() });
            expect(result).toEqual({
                changed: false,
                reason,
                count: 1,
                patchesGeneratedAt: applied.patchesGeneratedAt,
                seq: null,
                exportSeq: 1,
                changedPixels: 0,
                diffPixels: reason === 'below-min-area' ? 121600 : 0,
                tolerance: 2,
                minAreaPx: 4,
                bounds3006: null, bounds3857: null, regions: null,
            });
            expect(calls.map(c => c.args[2])).toEqual(['import-ortho-square']);
        }
        expect((await readLog()).patches).toHaveLength(1);
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(false);
        expect((await svc.info(TEST_COURSE_ID)).patchesGeneratedAt).toBe(applied.patchesGeneratedAt);
        expect(incomingLeft()).toEqual([]);
    } finally {
        await cleanup();
    }
});

test('a failed import diff or bake rolls back the raster entry and its png, and always deletes the upload', async () => {
    let failing = '';
    const { svc, patchesDir, readLog, readManifest, incoming, incomingLeft, cleanup } = await setup({ fail: (cmd) => cmd === failing });
    try {
        const applied = await svc.applyEdits(TEST_COURSE_ID, [STAMP_EDIT]);
        await svc.exportSquare(TEST_COURSE_ID);

        // The bake fails AFTER golfpipe wrote 2.png and the entry was appended.
        failing = 'bake-ortho-patch';
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() }))
            .rejects.toThrow(/bake-ortho-patch failed: replay boom/);
        expect((await readLog()).patches.map(p => p.seq)).toEqual([1]);
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(false);
        expect((await readManifest()).patchesGeneratedAt).toBe(applied.patchesGeneratedAt);
        expect(incomingLeft()).toEqual([]);

        // The diff itself fails (wrong size, modified export, ...).
        failing = 'import-ortho-square';
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() }))
            .rejects.toThrow(/import-ortho-square failed: replay boom/);
        expect((await readLog()).patches.map(p => p.seq)).toEqual([1]);
        expect(await Bun.file(path.join(patchesDir, '2.png')).exists()).toBe(false);
        expect(incomingLeft()).toEqual([]);

        // And the next import takes the seq the failed ones never used.
        failing = '';
        expect((await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() })).seq).toBe(2);
    } finally {
        await cleanup();
    }
});

test('importEdited refuses a non-PNG, bad parameters, a missing export and a site never exported, before any pipeline call', async () => {
    const { svc, calls, readLog, incoming, incomingLeft, cleanup } = await setup();
    try {
        // No export yet.
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() })).rejects.toThrow(/export the photo first/);
        await svc.exportSquare(TEST_COURSE_ID);
        calls.length = 0;

        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(Buffer.from('\xff\xd8\xff\xe0 a jpeg', 'latin1')) }))
            .rejects.toBeInstanceOf(InvalidOrthoImportError);
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(new Uint8Array(0)) }))
            .rejects.toThrow(/not a PNG/);
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(), tolerance: 255 }))
            .rejects.toThrow(/tolerance/);
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(), exportSeq: 1.5 }))
            .rejects.toThrow(/exportSeq/);
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(), exportSeq: 7 }))
            .rejects.toThrow(/Export 7 .* not found/);

        expect(calls).toHaveLength(0);
        await expect(readLog()).rejects.toThrow(); // no log was ever written
        expect(incomingLeft()).toEqual([]);
    } finally {
        await cleanup();
    }
});

test('a JPEG export only imports with an explicit tolerance (golfpipe refuses it otherwise)', async () => {
    const { svc, readLog, incoming, cleanup } = await setup();
    try {
        await svc.exportSquare(TEST_COURSE_ID, 'jpg');
        await expect(svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() }))
            .rejects.toThrow(/refusing to import a JPEG/);
        await expect(readLog()).rejects.toThrow();
        const ok = await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming(), tolerance: 12 });
        expect(ok).toMatchObject({ changed: true, tolerance: 12 });
    } finally {
        await cleanup();
    }
});

test('revertLast peels a raster entry: replay with its bounds3857 as --extra-bounds, png deleted, sim tree emptied', async () => {
    const { svc, calls, patchesDir, simDir, readLog, incoming, cleanup } = await setup();
    try {
        await svc.exportSquare(TEST_COURSE_ID);
        const imported = await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() });
        await mkdir(path.join(simDir, '20', '1'), { recursive: true });
        await writeFile(path.join(simDir, '20', '1', '2.webp'), 'sim tile');
        calls.length = 0;

        const result = await svc.revertLast(TEST_COURSE_ID);
        expect(result.count).toBe(0);
        expect(result.patchesGeneratedAt).not.toBe(imported.patchesGeneratedAt);
        expect(calls).toHaveLength(1);
        expect(calls[0].args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'apply-ortho-patches']);
        const b = IMPORT_BOUNDS_3857;
        expect(argValue(calls[0].args, '--extra-bounds')).toBe(`${b.west},${b.south},${b.east},${b.north}`);
        expect((await readLog()).patches).toEqual([]);
        expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(false);
        expect(await Bun.file(path.join(simDir, '20', '1', '2.webp')).exists()).toBe(false);
        // The export it was edited from is untouched, and still importable.
        expect((await svc.info(TEST_COURSE_ID)).exports.map(e => e.seq)).toEqual([1]);
        expect((await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() })).seq).toBe(1);
    } finally {
        await cleanup();
    }
});

test('a failed revert of a raster entry restores the entry and keeps its png', async () => {
    let failNext = false;
    const { svc, patchesDir, readLog, incoming, cleanup } = await setup({ fail: () => failNext });
    try {
        await svc.exportSquare(TEST_COURSE_ID);
        await svc.importEdited(TEST_COURSE_ID, { tmpPath: await incoming() });
        failNext = true;
        await expect(svc.revertLast(TEST_COURSE_ID)).rejects.toThrow(/replay boom/);
        expect((await readLog()).patches.map(p => p.kind)).toEqual(['raster']);
        expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(true);
    } finally {
        await cleanup();
    }
});

test('exports and imports for a course without a built map explain themselves', async () => {
    const { svc, cleanup } = await setup({ withSite: false });
    try {
        await expect(svc.exportSquare(TEST_COURSE_ID)).rejects.toThrow(/no map|build the map/);
        await expect(svc.incomingImportPath(TEST_COURSE_ID)).rejects.toThrow(/no map|build the map/);
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.exports).toEqual([]);
        expect(info.frame).toBeNull();
    } finally {
        await cleanup();
    }
});
