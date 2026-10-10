import { test, expect } from 'bun:test';
import { utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { TEST_COURSE_ID } from '../db/seeds/course';
import {
    ACTIVE, CHANGE_BOUNDS_3006, MANIFEST, SITE_ID, SQUARE, TINY_PNG, argValue, setup,
} from '../testing/cleaned-photo';
import {
    InvalidPhotoImportError, InvalidPixelPatchError, MAX_UNDO, PhotoPipelineError, importImageKind,
    type PixelPatch,
} from './cleaned-photo.service';

// The cleaned photo: one 8192 px file per site, edited in place. Against the
// real service and a migrated DB; golfpipe is the fixture's stand-in, which
// keeps the photo as text so each test reads what happened to it.

/** One stroke's worth of pixels: a 4 x 2 rectangle at 100, 200. */
const STROKE: PixelPatch = { x: 100, y: 200, w: 4, h: 2, rgba: new Uint8Array(4 * 2 * 4).fill(7) };
/** A write that starts an editing session: the photo from before is kept. */
const SESSION = { snapshot: true };

const commands = (calls: Array<{ args: string[] }>) => calls.map(c => c.args[2]);

test('before anything is cleaned: no photo, nothing to undo, and where the photo lies', async () => {
    const { svc, calls, cleanup } = await setup();
    try {
        expect(await svc.info(TEST_COURSE_ID)).toEqual({
            exists: false, undoDepth: 0, size: 8192,
            bounds3006: { west: SQUARE[0], south: SQUARE[1], east: SQUARE[2], north: SQUARE[3] },
            patchesGeneratedAt: null,
        });
        expect(calls).toHaveLength(0);
    } finally {
        await cleanup();
    }
});

test('a course without a built map cannot be cleaned, and says why', async () => {
    const { svc, cleanup } = await setup({ withSite: false });
    try {
        const info = await svc.info(TEST_COURSE_ID);
        expect(info.bounds3006).toBeNull();
        expect(info.reason).toMatch(/has no map/);
        await expect(svc.writePixels(TEST_COURSE_ID, STROKE)).rejects.toThrow(/has no map/);
        await expect(svc.pixelsFile(TEST_COURSE_ID)).rejects.toThrow(/has no map/);
        await expect(svc.exportImage(TEST_COURSE_ID)).rejects.toThrow(/has no map/);
    } finally {
        await cleanup();
    }
});

test('the first write makes the photo on the inner terrain square from the pristine photo, then puts the pixels into it', async () => {
    const { svc, calls, sourcesDir, cleanedPath, dataDir, photo, snapshots, workLeft, readManifest, assets, cleanup } = await setup();
    try {
        const result = await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);

        expect(commands(calls)).toEqual(['cleaned-init', 'cleaned-patch']);
        const init = calls[0].args;
        expect(argValue(init, '--ortho')).toBe(path.join(sourcesDir, `ortho-${ACTIVE}.tif`));
        expect(argValue(init, '--square-3006')).toBe(SQUARE.join(','));
        expect(argValue(init, '--out')).toBe(cleanedPath);
        expect(argValue(init, '--size')).toBe('8192');

        const patch = calls[1];
        expect(argValue(patch.args, '--cleaned')).toBe(cleanedPath);
        expect(argValue(patch.args, '--tiles-out')).toBe(path.join(dataDir, 'tiles', SITE_ID, 'ortho-sim'));
        expect(argValue(patch.args, '--pristine-tiles')).toBe(path.join(dataDir, 'tiles', SITE_ID, 'ortho'));
        expect([argValue(patch.args, '--minzoom'), argValue(patch.args, '--maxzoom')]).toEqual(['14', '20']);
        // The rectangle and its bytes as the pipeline saw them.
        expect(patch.patches).toEqual({
            entries: [{ x: 100, y: 200, w: 4, h: 2, file: '0.rgba' }],
            files: ['0.rgba', 'patches.json'],
            bytes: [32],
        });

        expect(await photo()).toBe(`photo of ortho-${ACTIVE}.tif +4x2@100,200`);
        // The photo from before the session is the one thing kept; the patch is gone.
        expect(snapshots()).toEqual(['1.tif']);
        expect(workLeft()).toEqual([]);
        expect(result.undoDepth).toBe(1);

        // Only the cleaned layer's version moved, on disk and in the asset.
        const onDisk = await readManifest();
        expect(onDisk.patchesGeneratedAt).toBe(result.patchesGeneratedAt);
        expect(onDisk.generatedAt).toBe(MANIFEST.generatedAt);
        const asset = (await assets.listBySite(SITE_ID)).find(a => a.kind === 'tile_manifest')!;
        expect(JSON.parse(asset.metaJson!).patchesGeneratedAt).toBe(result.patchesGeneratedAt);

        const info = await svc.info(TEST_COURSE_ID);
        expect([info.exists, info.undoDepth, info.patchesGeneratedAt]).toEqual([true, 1, result.patchesGeneratedAt]);

        // The session's later strokes reuse the photo and add no undo step.
        const second = await svc.writePixels(TEST_COURSE_ID, STROKE);
        expect(commands(calls).slice(2)).toEqual(['cleaned-patch']);
        expect(second.undoDepth).toBe(1);
        expect(snapshots()).toEqual(['1.tif']);
        expect(Date.parse(second.patchesGeneratedAt)).toBeGreaterThan(Date.parse(result.patchesGeneratedAt));
    } finally {
        await cleanup();
    }
});

test('the pixels are the photo as raw RGB, made on first use and written again only after a change', async () => {
    const { svc, calls, workDir, cleanedPath, cleanup } = await setup();
    try {
        const first = await svc.pixelsFile(TEST_COURSE_ID);
        expect(commands(calls)).toEqual(['cleaned-init', 'cleaned-export']);
        expect(argValue(calls[1].args, '--cleaned')).toBe(cleanedPath);
        expect(argValue(calls[1].args, '--format')).toBe('rgb');
        expect(first.path).toBe(path.join(workDir, 'cleaned-pixels.rgb'));
        expect(first.size).toBe(8192);
        expect(await Bun.file(first.path).text()).toBe(`rgb of photo of ortho-${ACTIVE}.tif`);

        calls.length = 0;
        await svc.pixelsFile(TEST_COURSE_ID);
        expect(calls).toHaveLength(0);

        await svc.writePixels(TEST_COURSE_ID, STROKE);
        const old = new Date(Date.now() - 3600_000);
        await utimes(first.path, old, old);
        calls.length = 0;
        const again = await svc.pixelsFile(TEST_COURSE_ID);
        expect(commands(calls)).toEqual(['cleaned-export']);
        expect(await Bun.file(again.path).text()).toBe(`rgb of photo of ortho-${ACTIVE}.tif +4x2@100,200`);
    } finally {
        await cleanup();
    }
});

test('a site cleaned under the old patch log starts from its working raster, unless a rebuild made that stale', async () => {
    const current = await setup();
    const stale = await setup();
    try {
        const legacy = (dir: string) => path.join(dir, `ortho-${ACTIVE}.patched.tif`);
        await writeFile(legacy(current.sourcesDir), 'patched');
        await current.svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        expect(argValue(current.calls[0].args, '--ortho')).toBe(legacy(current.sourcesDir));

        await writeFile(legacy(stale.sourcesDir), 'patched');
        const old = new Date(Date.now() - 3600_000);
        await utimes(legacy(stale.sourcesDir), old, old);
        await stale.svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        expect(argValue(stale.calls[0].args, '--ortho')).toBe(path.join(stale.sourcesDir, `ortho-${ACTIVE}.tif`));
    } finally {
        await current.cleanup();
        await stale.cleanup();
    }
});

test('a site built before the manifest carried the square gets the same square the GSPro exports derive', async () => {
    const { terrain: _terrain, ...legacy } = MANIFEST;
    const { svc, calls, cleanup } = await setup({ manifest: legacy });
    try {
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        const [e0, n0, e1, n1] = argValue(calls[0].args, '--square-3006')!.split(',').map(Number);
        // A true square on the 10 m side step, on whole metres.
        expect(e1 - e0).toBe(n1 - n0);
        expect((e1 - e0) % 10).toBe(0);
        expect([e0, n0].every(Number.isInteger)).toBe(true);
    } finally {
        await cleanup();
    }
});

test('a failed write leaves the photo as it was: no undo step, no version bump, nothing left behind', async () => {
    let failing = false;
    const { svc, photo, snapshots, workLeft, readManifest, cleanup } = await setup({ fail: c => failing && c === 'cleaned-patch' });
    try {
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        const before = await photo();
        const version = (await readManifest()).patchesGeneratedAt;

        failing = true;
        const err = await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PhotoPipelineError);
        expect((err as Error).message).toMatch(/cleaned-patch failed: .*pipeline boom/s);
        expect(await photo()).toBe(before);
        expect(snapshots()).toEqual(['1.tif']);
        expect(workLeft()).toEqual([]);
        expect((await readManifest()).patchesGeneratedAt).toBe(version);
    } finally {
        await cleanup();
    }
});

test('a patch is checked before anything is touched', async () => {
    const { svc, calls, photo, cleanup } = await setup();
    try {
        const bad = (patch: Partial<PixelPatch>) => svc.writePixels(TEST_COURSE_ID, { ...STROKE, ...patch }).catch((e: unknown) => e);
        expect(await bad({ x: 8190 })).toBeInstanceOf(InvalidPixelPatchError);
        expect(await bad({ y: -1 })).toBeInstanceOf(InvalidPixelPatchError);
        expect(await bad({ w: 0 })).toBeInstanceOf(InvalidPixelPatchError);
        expect(await bad({ x: 1.5 })).toBeInstanceOf(InvalidPixelPatchError);
        expect(((await bad({ rgba: new Uint8Array(5) })) as Error).message).toMatch(/5 bytes is not 4 x 2 RGBA pixels/);
        expect(calls).toHaveLength(0);
        expect(await photo()).toBeNull();
    } finally {
        await cleanup();
    }
});

test('undo steps back one change at a time, to the photo as it was before each', async () => {
    const { svc, calls, photo, snapshots, historyDir, cleanedPath, readManifest, cleanup } = await setup();
    try {
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        const afterFirst = await photo();
        const second = await svc.writePixels(TEST_COURSE_ID, { ...STROKE, x: 2 }, SESSION);
        expect(await photo()).toBe(`${afterFirst} +4x2@2,200`);
        calls.length = 0;

        const undone = await svc.undo(TEST_COURSE_ID);
        expect(commands(calls)).toEqual(['cleaned-replace']);
        expect(argValue(calls[0].args, '--cleaned')).toBe(cleanedPath);
        expect(argValue(calls[0].args, '--image')).toBe(path.join(historyDir, '2.tif'));
        expect(argValue(calls[0].args, '--tiles-out')).toBeTruthy();
        expect(await photo()).toBe(afterFirst);
        expect(snapshots()).toEqual(['1.tif']);
        expect(undone.undoDepth).toBe(1);
        expect(Date.parse(undone.patchesGeneratedAt)).toBeGreaterThan(Date.parse(second.patchesGeneratedAt));

        expect((await svc.undo(TEST_COURSE_ID)).undoDepth).toBe(0);
        expect(await photo()).toBe(`photo of ortho-${ACTIVE}.tif`);

        // Nothing left: no pipeline call, the version stays.
        calls.length = 0;
        const version = (await readManifest()).patchesGeneratedAt;
        expect(await svc.undo(TEST_COURSE_ID)).toEqual({ undoDepth: 0, patchesGeneratedAt: version as string });
        expect(calls).toHaveLength(0);
    } finally {
        await cleanup();
    }
});

test(`only the last ${MAX_UNDO} changes can be undone`, async () => {
    const { svc, snapshots, cleanup } = await setup();
    try {
        let last = 0;
        for (let i = 0; i < MAX_UNDO + 2; i++) last = (await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION)).undoDepth;
        expect(last).toBe(MAX_UNDO);
        expect(snapshots()).toEqual(['3.tif', '4.tif', '5.tif', '6.tif', '7.tif']);
        // Numbering carries on from the newest, so an undo never meets a reused name.
        await svc.undo(TEST_COURSE_ID);
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        expect(snapshots()).toEqual(['3.tif', '4.tif', '5.tif', '6.tif', '7.tif']);
    } finally {
        await cleanup();
    }
});

test('an import makes any image of the size the photo, with nothing exported first', async () => {
    const { svc, calls, incoming, photo, snapshots, workLeft, cleanedPath, readManifest, cleanup } = await setup();
    try {
        const tmpPath = await incoming();
        const result = await svc.importImage(TEST_COURSE_ID, tmpPath);

        // The photo did not exist: it is made first, then replaced.
        expect(commands(calls)).toEqual(['cleaned-init', 'cleaned-replace']);
        const replace = calls[1].args;
        expect(argValue(replace, '--cleaned')).toBe(cleanedPath);
        expect(argValue(replace, '--image')).toBe(`${tmpPath}.png`);
        expect(argValue(replace, '--tiles-out')).toBeTruthy();

        expect(result).toEqual({
            changed: true, changedPixels: 5000, bounds3006: CHANGE_BOUNDS_3006, size: 8192,
            undoDepth: 1, patchesGeneratedAt: (await readManifest()).patchesGeneratedAt as string,
        });
        expect(await photo()).toBe(`image .png of ${TINY_PNG.length} bytes`);
        expect(snapshots()).toEqual(['1.tif']);
        expect(workLeft()).toEqual([]);

        // Undo covers an import like any other change.
        await svc.undo(TEST_COURSE_ID);
        expect(await photo()).toBe(`photo of ortho-${ACTIVE}.tif`);
    } finally {
        await cleanup();
    }
});

test('an image that is the photo as it already was changes nothing', async () => {
    const { svc, incoming, photo, snapshots, workLeft, readManifest, cleanup } = await setup({ importChanges: () => false });
    try {
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        const before = await photo();
        const version = (await readManifest()).patchesGeneratedAt as string;

        const result = await svc.importImage(TEST_COURSE_ID, await incoming());
        expect(result).toEqual({ changed: false, changedPixels: 0, bounds3006: null, size: 8192, undoDepth: 1, patchesGeneratedAt: version });
        expect(await photo()).toBe(before);
        expect(snapshots()).toEqual(['1.tif']);
        expect(workLeft()).toEqual([]);
    } finally {
        await cleanup();
    }
});

test('JPEG and TIFF imports are handed over under their own kind; anything else is refused before the pipeline', async () => {
    const { svc, calls, incoming, workLeft, cleanup } = await setup();
    try {
        const jpeg = await incoming(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]));
        await svc.importImage(TEST_COURSE_ID, jpeg);
        expect(argValue(calls[calls.length - 1].args, '--image')).toBe(`${jpeg}.jpg`);
        const tiff = await incoming(Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 9]));
        await svc.importImage(TEST_COURSE_ID, tiff);
        expect(argValue(calls[calls.length - 1].args, '--image')).toBe(`${tiff}.tif`);

        calls.length = 0;
        const junk = await svc.importImage(TEST_COURSE_ID, await incoming(Buffer.from('GIF89a not a photo'))).catch(e => e);
        expect(junk).toBeInstanceOf(InvalidPhotoImportError);
        expect((junk as Error).message).toMatch(/not a PNG, JPEG or TIFF/);
        expect(await svc.importImage(TEST_COURSE_ID, path.join(workLeft()[0] ?? 'x', 'missing')).catch(e => e)).toBeInstanceOf(InvalidPhotoImportError);
        expect(calls).toHaveLength(0);
        expect(workLeft()).toEqual([]);

        expect(importImageKind(TINY_PNG)).toBe('png');
        expect(importImageKind(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tif');
        expect(importImageKind(Buffer.from([0x89, 0x50]))).toBeNull();
    } finally {
        await cleanup();
    }
});

test('an import the pipeline refuses leaves the photo and the undo history as they were', async () => {
    let failing = false;
    const { svc, incoming, photo, snapshots, workLeft, cleanup } = await setup({ fail: c => failing && c === 'cleaned-replace' });
    try {
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        const before = await photo();
        failing = true;
        const err = await svc.importImage(TEST_COURSE_ID, await incoming()).catch(e => e);
        expect(err).toBeInstanceOf(PhotoPipelineError);
        expect(await photo()).toBe(before);
        expect(snapshots()).toEqual(['1.tif']);
        expect(workLeft()).toEqual([]);
    } finally {
        await cleanup();
    }
});

test('the export is the photo as a PNG, made on first use and re-encoded only after a change', async () => {
    const { svc, calls, workDir, cleanedPath, readManifest, cleanup } = await setup();
    try {
        const first = await svc.exportImage(TEST_COURSE_ID);
        // No photo yet: it is made from the pristine one, so an export needs no cleaning first.
        expect(commands(calls)).toEqual(['cleaned-init', 'cleaned-export']);
        expect(argValue(calls[1].args, '--cleaned')).toBe(cleanedPath);
        expect(argValue(calls[1].args, '--format')).toBe('png');
        expect(first.path).toBe(path.join(workDir, 'cleaned-export.png'));
        expect(first.file).toBe('linkan-cleaned-8192.png');
        expect(await Bun.file(first.path).text()).toBe(`png of photo of ortho-${ACTIVE}.tif`);
        expect(first.bytes).toBe((await Bun.file(first.path).text()).length);
        // An export changes no tile.
        expect((await readManifest()).patchesGeneratedAt).toBeUndefined();

        calls.length = 0;
        await svc.exportImage(TEST_COURSE_ID);
        expect(calls).toHaveLength(0);

        // The photo changes: the kept PNG is older than it and is made again.
        await svc.writePixels(TEST_COURSE_ID, STROKE, SESSION);
        const old = new Date(Date.now() - 3600_000);
        await utimes(first.path, old, old);
        calls.length = 0;
        const again = await svc.exportImage(TEST_COURSE_ID);
        expect(commands(calls)).toEqual(['cleaned-export']);
        expect(await Bun.file(again.path).text()).toBe(`png of photo of ortho-${ACTIVE}.tif +4x2@100,200`);
    } finally {
        await cleanup();
    }
});

test('changes to one photo run one at a time, in the order they came', async () => {
    const { svc, photo, cleanup } = await setup();
    try {
        await Promise.all([
            svc.writePixels(TEST_COURSE_ID, STROKE, SESSION),
            svc.writePixels(TEST_COURSE_ID, { ...STROKE, x: 2 }, SESSION),
            svc.writePixels(TEST_COURSE_ID, { ...STROKE, x: 3 }),
        ]);
        expect(await photo()).toBe(`photo of ortho-${ACTIVE}.tif +4x2@100,200 +4x2@2,200 +4x2@3,200`);
    } finally {
        await cleanup();
    }
});
