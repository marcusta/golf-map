import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { NotFoundError } from '@basics/core/server/auth';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { createTestDbWith, type TestContext } from '../testing/db';
import { photoInput, sha256, storeFile, tmpDir } from '../testing/photos';
import { wgs84ToSweref99tm } from './geo';
import {
    InvalidPhotoError,
    PhotoFileConflictError,
    PhotoHashMismatchError,
    PhotosService,
    parseCursor,
} from './photos.service';

const SITE = 'site-photos';

async function setup(now?: () => Date): Promise<{ ctx: TestContext; svc: PhotosService; dataDir: string }> {
    const dataDir = tmpDir('photos-svc');
    const ctx = await createTestDbWith({ dataDir, now });
    await ctx.sitesService.create({ id: SITE, name: 'Photo site' });
    return { ctx, svc: ctx.photosService, dataDir };
}

describe('PhotosService create/list/update/remove', () => {
    test('create stores the pose, derives SWEREF 99 TM, applies defaults', async () => {
        const { svc } = await setup();
        const p = await svc.create(photoInput('p1', SITE, { hole: 3 }));
        const { x, y } = wgs84ToSweref99tm(59.33, 18.06);
        expect(p.x3006).toBeCloseTo(x, 6);
        expect(p.y3006).toBeCloseTo(y, 6);
        expect(p.attitudeQuat).toEqual({ w: 1, x: 0, y: 0, z: 0 });
        expect(p.tags).toEqual(['tee']);
        expect(p.eyeHeightM).toBe(1.5);
        expect(p.lens).toBe('wide');
        expect(p.hole).toBe(3);
        expect(p.version).toBe(1);
        expect(p.originalSha256).toBeNull();
        expect(p.pulledAt).toBeNull();
        expect(p.refinedYawDeg).toBeNull();
    });

    test('create is idempotent by id: a repeat returns the stored row unchanged', async () => {
        const { svc } = await setup();
        const first = await svc.create(photoInput('p1', SITE));
        const again = await svc.create(photoInput('p1', SITE, { yawDeg: 10, note: 'different' }));
        expect(again).toEqual(first);
        expect((await svc.listBySite(SITE)).length).toBe(1);
    });

    test('create rejects an unknown site and out-of-range input', async () => {
        const { svc } = await setup();
        await expect(svc.create(photoInput('p1', 'nope'))).rejects.toBeInstanceOf(NotFoundError);
        await expect(svc.create(photoInput('p2', SITE, { yawDeg: 360 }))).rejects.toBeInstanceOf(InvalidPhotoError);
        await expect(svc.create(photoInput('p3', SITE, { rollDeg: -180 }))).rejects.toBeInstanceOf(InvalidPhotoError);
        await expect(svc.create(photoInput('p4', SITE, { hfovDeg: 0 }))).rejects.toBeInstanceOf(InvalidPhotoError);
        await expect(svc.create(photoInput('../x', SITE))).rejects.toBeInstanceOf(InvalidPhotoError);
    });

    test('listBySite returns newest capture first', async () => {
        const { svc } = await setup();
        await svc.create(photoInput('a', SITE, { capturedAt: '2026-10-01T08:00:00Z' }));
        await svc.create(photoInput('b', SITE, { capturedAt: '2026-10-03T08:00:00Z' }));
        await svc.create(photoInput('c', SITE, { capturedAt: '2026-10-02T08:00:00Z' }));
        expect((await svc.listBySite(SITE)).map((p) => p.id)).toEqual(['b', 'c', 'a']);
        expect(await svc.listBySite('other')).toEqual([]);
    });

    test('update edits tags/note/hole under version locking', async () => {
        const { svc } = await setup();
        await svc.create(photoInput('p1', SITE));
        const u = await svc.update('p1', 1, { tags: ['green', 'skyline'], note: 'pins back', hole: 7 });
        expect(u).toMatchObject({ tags: ['green', 'skyline'], note: 'pins back', hole: 7, version: 2 });
        await expect(svc.update('p1', 1, { note: 'stale' })).rejects.toBeInstanceOf(VersionConflictError);
        await expect(svc.update('missing', 1, {})).rejects.toBeInstanceOf(NotFoundError);
    });

    test('remove deletes the row and both files', async () => {
        const { svc } = await setup();
        await svc.create(photoInput('p1', SITE));
        await storeFile(svc, 'p1', 'original', 'HEIC');
        await storeFile(svc, 'p1', 'preview', 'JPEG');
        const photo = await svc.get('p1');
        expect(existsSync(svc.filePath(photo, 'original'))).toBe(true);
        expect(existsSync(svc.filePath(photo, 'preview'))).toBe(true);

        await expect(svc.remove('p1', 99)).rejects.toBeInstanceOf(VersionConflictError);
        await svc.remove('p1', photo.version);
        await expect(svc.get('p1')).rejects.toBeInstanceOf(NotFoundError);
        expect(existsSync(svc.filePath(photo, 'original'))).toBe(false);
        expect(existsSync(svc.filePath(photo, 'preview'))).toBe(false);
    });
});

describe('PhotosService file storage', () => {
    test('stores into data/photos/<siteId>/<id>.heic|.jpg without bumping version', async () => {
        const { svc, dataDir } = await setup(() => new Date('2026-10-02T10:00:00Z'));
        await svc.create(photoInput('p1', SITE));
        const r = await storeFile(svc, 'p1', 'original', 'HEICDATA');
        expect(r.status).toBe('stored');
        expect(r.photo).toMatchObject({
            originalSha256: sha256('HEICDATA'),
            originalBytes: 8,
            originalUploadedAt: '2026-10-02T10:00:00.000Z',
            version: 1,
        });
        expect(existsSync(path.join(dataDir, 'photos', SITE, 'p1.heic'))).toBe(true);
        await storeFile(svc, 'p1', 'preview', 'JPG');
        expect(existsSync(path.join(dataDir, 'photos', SITE, 'p1.jpg'))).toBe(true);
    });

    test('same hash again is unchanged, a different hash is a conflict, a bad declared hash is a mismatch', async () => {
        const { svc } = await setup();
        await svc.create(photoInput('p1', SITE));
        await storeFile(svc, 'p1', 'original', 'A');
        expect((await storeFile(svc, 'p1', 'original', 'A')).status).toBe('unchanged');
        await expect(storeFile(svc, 'p1', 'original', 'B')).rejects.toBeInstanceOf(PhotoFileConflictError);

        const tmpPath = path.join(tmpDir('mismatch'), 'body');
        writeFileSync(tmpPath, 'C');
        await expect(
            svc.storeUploadedFile('p1', 'preview', { tmpPath, sha256: sha256('C'), bytes: 1, declaredSha256: sha256('D') }),
        ).rejects.toBeInstanceOf(PhotoHashMismatchError);
        expect(existsSync(tmpPath)).toBe(false);
    });

    test('unknown id is NotFound', async () => {
        const { svc } = await setup();
        await expect(storeFile(svc, 'ghost', 'original', 'A')).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('PhotosService pull list, ack, retention', () => {
    test('only photos with an original are listed, in upload order, paged by cursor', async () => {
        const { svc } = await setup();
        for (const id of ['a', 'b', 'c', 'd']) await svc.create(photoInput(id, SITE));
        await storeFile(svc, 'c', 'original', 'c');
        await storeFile(svc, 'a', 'original', 'a');
        await storeFile(svc, 'd', 'preview', 'd'); // preview alone does not list
        await storeFile(svc, 'b', 'original', 'b');

        const p1 = await svc.listForPull('0', 2);
        expect(p1.photos.map((p) => p.id)).toEqual(['c', 'a']);
        expect(p1.hasMore).toBe(true);
        const p2 = await svc.listForPull(p1.nextCursor, 2);
        expect(p2.photos.map((p) => p.id)).toEqual(['b']);
        expect(p2.hasMore).toBe(false);
        const p3 = await svc.listForPull(p2.nextCursor, 2);
        expect(p3).toEqual({ photos: [], nextCursor: p2.nextCursor, hasMore: false });

        // A preview arriving after the original, and a metadata edit, re-list the photo.
        await storeFile(svc, 'c', 'preview', 'cp');
        await svc.update('a', 1, { note: 'edited' });
        const p4 = await svc.listForPull(p2.nextCursor);
        expect(p4.photos.map((p) => p.id)).toEqual(['c', 'a']);
        expect(Number(p4.photos[0].cursor)).toBeGreaterThan(Number(p2.nextCursor));
    });

    test('parseCursor accepts decimal strings and rejects anything else', () => {
        expect(parseCursor(undefined)).toBe(0);
        expect(parseCursor('')).toBe(0);
        expect(parseCursor('42')).toBe(42);
        expect(() => parseCursor('-1')).toThrow(InvalidPhotoError);
        expect(() => parseCursor('2026-10-02T00:00:00Z')).toThrow(InvalidPhotoError);
    });

    test('ack sets pulledAt once; retention deletes the original 14 days later and keeps row and preview', async () => {
        let clock = new Date('2026-10-02T12:00:00Z');
        const { svc } = await setup(() => clock);
        await svc.create(photoInput('p1', SITE));
        await svc.create(photoInput('p2', SITE));
        await storeFile(svc, 'p1', 'original', 'O1');
        await storeFile(svc, 'p1', 'preview', 'P1');
        await storeFile(svc, 'p2', 'original', 'O2');

        expect(await svc.ack(['p1', 'ghost'])).toEqual({ acked: 1 });
        clock = new Date('2026-10-05T12:00:00Z');
        expect(await svc.ack(['p1'])).toEqual({ acked: 0 }); // first pull wins
        expect((await svc.get('p1')).pulledAt).toBe('2026-10-02T12:00:00.000Z');

        // 13 days 23 h after the ack: nothing yet.
        clock = new Date('2026-10-16T11:00:00Z');
        expect(await svc.purgePulledOriginals()).toEqual({ deleted: [] });

        clock = new Date('2026-10-16T12:00:00Z');
        expect(await svc.purgePulledOriginals()).toEqual({ deleted: ['p1'] });
        const p1 = await svc.get('p1');
        expect(p1.originalDeletedAt).toBe('2026-10-16T12:00:00.000Z');
        expect(p1.originalSha256).toBe(sha256('O1'));
        expect(existsSync(svc.filePath(p1, 'original'))).toBe(false);
        expect(existsSync(svc.filePath(p1, 'preview'))).toBe(true);
        await expect(svc.fileFor('p1', 'original')).rejects.toBeInstanceOf(NotFoundError);
        expect((await svc.fileFor('p1', 'preview')).sha256).toBe(sha256('P1'));

        // p2 was never acked: its original stays. A second run is a no-op.
        expect(existsSync(svc.filePath(await svc.get('p2'), 'original'))).toBe(true);
        expect(await svc.purgePulledOriginals()).toEqual({ deleted: [] });
    });
});
