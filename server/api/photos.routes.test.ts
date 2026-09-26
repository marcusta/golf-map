import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Hono } from 'hono';
import { mountApiRoutes } from '../routes';
import { createTestDbWith, type TestContext } from '../testing/db';
import { photoInput, sha256, tmpDir } from '../testing/photos';
import { createPhotoFileRoutes } from './photos.routes';
import { pullPhotos, readPullState } from '../services/photos-pull';
import { PHOTO_MAX_BYTES, type Photo } from '../services/photos.service';

const TOKEN = 'photo-pull-token';
const SITE = 'site-a';
const VPS = 'http://vps.test';

let savedToken: string | undefined;
beforeAll(() => {
    savedToken = process.env.PUBLISH_TOKEN;
    process.env.PUBLISH_TOKEN = TOKEN;
});
afterAll(() => {
    if (savedToken === undefined) delete process.env.PUBLISH_TOKEN;
    else process.env.PUBLISH_TOKEN = savedToken;
});

interface Box {
    app: Hono;
    ctx: TestContext;
    dataDir: string;
}

/** Full `/api` mount; `authed` injects a session user as the cookie middleware would. */
async function box(mode: 'builder' | 'serve', opts: { authed?: boolean; sites?: string[]; now?: () => Date } = {}): Promise<Box> {
    const dataDir = tmpDir(`photos-${mode}`);
    const ctx = await createTestDbWith({ mode, dataDir, now: opts.now });
    for (const id of opts.sites ?? [SITE]) await ctx.sitesService.create({ id, name: id });
    const app = new Hono();
    if (opts.authed ?? true) {
        app.use('*', async (c, next) => {
            c.set('user', { id: 'user-1', username: 'tester' });
            await next();
        });
    }
    mountApiRoutes(app, ctx, { mode, dataDir });
    return { app, ctx, dataDir };
}

function createPhoto(app: Hono, body: unknown) {
    return app.request('/api/photos/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function put(app: Hono, id: string, kind: string, body: BodyInit | null, sha?: string) {
    return app.request(`/api/photos/file/${id}?kind=${kind}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', ...(sha !== undefined ? { 'x-content-sha256': sha } : {}) },
        body,
    });
}

function upload(app: Hono, id: string, kind: 'original' | 'preview', bytes: string) {
    return put(app, id, kind, bytes, sha256(bytes));
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
}

describe('photos descriptor API', () => {
    test('requires a session', async () => {
        const { app } = await box('serve', { authed: false });
        expect((await createPhoto(app, photoInput('p1', SITE))).status).toBe(401);
        expect((await app.request(`/api/photos/list?siteId=${SITE}`)).status).toBe(401);
        expect((await put(app, 'p1', 'original', 'x', sha256('x'))).status).toBe(401);
        expect((await app.request('/api/photos/file/p1?kind=preview')).status).toBe(401);
    });

    test('create, repeat, list, update, remove over HTTP in both modes', async () => {
        for (const mode of ['serve', 'builder'] as const) {
            const { app } = await box(mode);
            const res = await createPhoto(app, photoInput('p1', SITE));
            expect(res.status).toBe(200);
            const photo = (await res.json()) as Photo;
            expect(photo).toMatchObject({ id: 'p1', siteId: SITE, version: 1, tags: ['tee'] });
            expect((await (await createPhoto(app, photoInput('p1', SITE))).json()) as Photo).toEqual(photo);

            const list = (await (await app.request(`/api/photos/list?siteId=${SITE}`)).json()) as Photo[];
            expect(list.map((p) => p.id)).toEqual(['p1']);

            const upd = await app.request('/api/photos/update', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: 'p1', version: 1, note: 'n' }),
            });
            expect(upd.status).toBe(200);
            const stale = await app.request('/api/photos/update', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: 'p1', version: 1, note: 'm' }),
            });
            expect(stale.status).toBe(409);

            const rm = await app.request('/api/photos/remove', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: 'p1', version: 2 }),
            });
            expect(rm.status).toBe(200);
            expect((await app.request('/api/photos/get?id=p1')).status).toBe(404);
        }
    });

    test('create validates at the boundary: 400 for ranges, zone-less time, unsafe id; 404 for unknown site', async () => {
        const { app } = await box('serve');
        expect((await createPhoto(app, photoInput('p1', SITE, { yawDeg: 360 }))).status).toBe(400);
        expect((await createPhoto(app, photoInput('p1', SITE, { pitchDeg: 91 }))).status).toBe(400);
        expect((await createPhoto(app, photoInput('p1', SITE, { width: 0 }))).status).toBe(400);
        expect((await createPhoto(app, photoInput('p1', SITE, { capturedAt: '2026-10-02T09:14:31' }))).status).toBe(400);
        expect((await createPhoto(app, photoInput('a/b', SITE))).status).toBe(400);
        expect((await createPhoto(app, photoInput('p1', 'no-such-site'))).status).toBe(404);
        expect((await createPhoto(app, photoInput('p1', SITE, { capturedAt: '2026-10-02T09:14:31.250+02:00' }))).status).toBe(200);
    });
});

describe('PUT/GET /api/photos/file/:id', () => {
    test('stores, repeats as unchanged, 409 on a different body, GET returns the bytes', async () => {
        const { app, dataDir } = await box('serve');
        await createPhoto(app, photoInput('p1', SITE));

        const r1 = await upload(app, 'p1', 'original', 'HEIC-BYTES');
        expect(r1.status).toBe(200);
        const b1 = (await r1.json()) as { status: string; photo: Photo };
        expect(b1.status).toBe('stored');
        expect(b1.photo.originalSha256).toBe(sha256('HEIC-BYTES'));
        expect(b1.photo.originalBytes).toBe(10);
        expect(b1.photo.version).toBe(1);
        expect(readFileSync(path.join(dataDir, 'photos', SITE, 'p1.heic'), 'utf8')).toBe('HEIC-BYTES');

        const r2 = await upload(app, 'p1', 'original', 'HEIC-BYTES');
        expect(r2.status).toBe(200);
        expect(((await r2.json()) as { status: string }).status).toBe('unchanged');

        expect((await upload(app, 'p1', 'original', 'OTHER')).status).toBe(409);

        expect((await upload(app, 'p1', 'preview', 'JPEG-BYTES')).status).toBe(200);
        const get = await app.request('/api/photos/file/p1?kind=preview');
        expect(get.status).toBe(200);
        expect(get.headers.get('content-type')).toBe('image/jpeg');
        expect(get.headers.get('x-content-sha256')).toBe(sha256('JPEG-BYTES'));
        expect(await get.text()).toBe('JPEG-BYTES');
        expect((await app.request('/api/photos/file/p1?kind=original')).headers.get('content-type')).toBe('image/heic');
    });

    test('400 on hash mismatch, missing or malformed header, bad kind, empty body; 404 on unknown id', async () => {
        const { app, dataDir } = await box('serve');
        await createPhoto(app, photoInput('p1', SITE));
        expect((await put(app, 'p1', 'original', 'abc', sha256('abd'))).status).toBe(400);
        expect((await put(app, 'p1', 'original', 'abc')).status).toBe(400);
        expect((await put(app, 'p1', 'original', 'abc', 'not-hex')).status).toBe(400);
        expect((await put(app, 'p1', 'thumb', 'abc', sha256('abc'))).status).toBe(400);
        expect((await put(app, 'p1', 'original', '', sha256(''))).status).toBe(400);
        expect((await upload(app, 'ghost', 'original', 'abc')).status).toBe(404);
        expect((await app.request('/api/photos/file/p1?kind=original')).status).toBe(404);
        expect((await app.request('/api/photos/file/ghost?kind=preview')).status).toBe(404);
        // Nothing stored and no temp files left behind.
        expect(existsSync(path.join(dataDir, 'photos', SITE, 'p1.heic'))).toBe(false);
        const incoming = path.join(dataDir, 'photos', '.incoming');
        expect(existsSync(incoming) ? Array.from(new Bun.Glob('*').scanSync(incoming)) : []).toEqual([]);
    });

    test('413 above the 20 MB cap (content-length and streamed)', async () => {
        const { app } = await box('serve');
        await createPhoto(app, photoInput('p1', SITE));
        const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
        expect((await put(app, 'p1', 'original', big, sha256(big))).status).toBe(413);

        // Streamed body with no content-length, on a small cap.
        const svc = (await box('serve')).ctx.photosService;
        await svc.create(photoInput('p2', SITE));
        const small = new Hono();
        small.use('*', async (c, next) => {
            c.set('user', { id: 'user-1', username: 'tester' });
            await next();
        });
        small.route('/api', createPhotoFileRoutes(svc, { maxBytes: 16 }));
        const chunk = new Uint8Array(10);
        const res = await small.request('/api/photos/file/p2?kind=original', {
            method: 'PUT',
            headers: { 'x-content-sha256': sha256(new Uint8Array(20)) },
            body: streamOf([chunk, chunk]),
            duplex: 'half',
        } as RequestInit);
        expect(res.status).toBe(413);
        expect((await svc.get('p2')).originalSha256).toBeNull();
        const ok = await small.request('/api/photos/file/p2?kind=original', {
            method: 'PUT',
            headers: { 'x-content-sha256': sha256(new Uint8Array(16)) },
            body: new Uint8Array(16),
        });
        expect(ok.status).toBe(200);
    });
});

describe('builder pull routes (serve only, PUBLISH_TOKEN bearer)', () => {
    const bearer = { authorization: `Bearer ${TOKEN}` };

    test('mounted in serve mode behind the bearer, absent in builder mode', async () => {
        const serve = await box('serve', { authed: false });
        expect((await serve.app.request('/api/ingest/photos')).status).toBe(401);
        expect((await serve.app.request('/api/ingest/photos', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
        expect((await serve.app.request('/api/ingest/photos', { headers: bearer })).status).toBe(200);
        expect((await serve.app.request('/api/ingest/photos/file/x?kind=original')).status).toBe(401);
        expect((await serve.app.request('/api/ingest/photos/ack', { method: 'POST' })).status).toBe(401);

        const builder = await box('builder', { authed: false });
        expect((await builder.app.request('/api/ingest/photos', { headers: bearer })).status).toBe(404);
        expect((await builder.app.request('/api/ingest/photos/ack', { method: 'POST', headers: bearer })).status).toBe(404);
    });

    test('list pages by cursor, ack validates its body, bad cursor is 400', async () => {
        const { app } = await box('serve');
        for (const id of ['p1', 'p2', 'p3']) {
            await createPhoto(app, photoInput(id, SITE));
            await upload(app, id, 'original', id);
        }
        const r1 = (await (await app.request('/api/ingest/photos?since=0&limit=2', { headers: bearer })).json()) as {
            photos: Array<Photo & { cursor: string }>;
            nextCursor: string;
            hasMore: boolean;
        };
        expect(r1.photos.map((p) => p.id)).toEqual(['p1', 'p2']);
        expect(r1.hasMore).toBe(true);
        expect(r1.nextCursor).toBe(r1.photos[1].cursor);
        const r2 = (await (await app.request(`/api/ingest/photos?since=${r1.nextCursor}`, { headers: bearer })).json()) as {
            photos: Photo[];
            hasMore: boolean;
        };
        expect(r2.photos.map((p) => p.id)).toEqual(['p3']);
        expect(r2.hasMore).toBe(false);
        expect((await app.request('/api/ingest/photos?since=abc', { headers: bearer })).status).toBe(400);

        const file = await app.request('/api/ingest/photos/file/p2?kind=original', { headers: bearer });
        expect(await file.text()).toBe('p2');
        expect(file.headers.get('x-content-sha256')).toBe(sha256('p2'));

        const ackBad = await app.request('/api/ingest/photos/ack', {
            method: 'POST',
            headers: { ...bearer, 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [1] }),
        });
        expect(ackBad.status).toBe(400);
        const ack = await app.request('/api/ingest/photos/ack', {
            method: 'POST',
            headers: { ...bearer, 'content-type': 'application/json' },
            body: JSON.stringify({ ids: ['p1', 'p2'] }),
        });
        expect(await ack.json()).toEqual({ acked: 2 });
    });
});

describe('photo pull round trip (serve app to builder DB)', () => {
    async function pair(now?: () => Date) {
        const vps = await box('serve', { sites: [SITE, 'site-vps-only'], now });
        const builder = await box('builder', { sites: [SITE] });
        const fetch = async (url: string, init?: RequestInit) => vps.app.request(url, init);
        const pull = (reset = false) =>
            pullPhotos({ photos: builder.ctx.photosService, baseUrl: VPS, token: TOKEN, fetch, pageSize: 2 }, { reset });
        return { vps, builder, pull };
    }

    test('pulls rows and files, skips unknown sites, acks, keeps refined fields, reruns idempotently', async () => {
        const { vps, builder, pull } = await pair();
        const b = builder.ctx.photosService;
        await createPhoto(vps.app, photoInput('p1', SITE, { capturedAt: '2026-10-02T09:00:00Z' }));
        await createPhoto(vps.app, photoInput('p2', SITE, { capturedAt: '2026-10-02T09:05:00Z' }));
        await createPhoto(vps.app, photoInput('p3', 'site-vps-only'));
        await createPhoto(vps.app, photoInput('p4', SITE)); // no original yet: not listed
        await upload(vps.app, 'p1', 'original', 'O1');
        await upload(vps.app, 'p1', 'preview', 'P1');
        await upload(vps.app, 'p2', 'original', 'O2');
        await upload(vps.app, 'p3', 'original', 'O3');

        const r1 = await pull();
        expect(r1).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, filesDownloaded: 3, acked: 2 });
        expect(r1.skipped).toEqual([{ id: 'p3', siteId: 'site-vps-only' }]);
        expect(readPullState(builder.dataDir).cursor).toBe(r1.cursor);

        const local1 = await b.get('p1');
        expect(local1).toMatchObject({ originalSha256: sha256('O1'), previewSha256: sha256('P1'), yawDeg: 212.5 });
        expect(readFileSync(path.join(builder.dataDir, 'photos', SITE, 'p1.heic'), 'utf8')).toBe('O1');
        expect(readFileSync(path.join(builder.dataDir, 'photos', SITE, 'p1.jpg'), 'utf8')).toBe('P1');
        await expect(b.get('p4')).rejects.toThrow();

        const v = vps.ctx.photosService;
        expect((await v.get('p1')).pulledAt).not.toBeNull();
        expect((await v.get('p2')).pulledAt).not.toBeNull();
        expect((await v.get('p3')).pulledAt).toBeNull();

        // The builder refines p1's pose.
        await builder.ctx.db
            .updateTable('site_photos')
            .set({ refined_yaw_deg: 214.1, refined_pitch_deg: -1.8, refined_roll_deg: 0.2, refine_method: 'skyline', refine_residual_deg: 0.3, refined_at: '2026-10-03T10:00:00Z' })
            .where('id', '=', 'p1')
            .execute();

        // Rerun with nothing new: no downloads, no changes.
        const r2 = await pull();
        expect(r2).toMatchObject({ inserted: 0, updated: 0, unchanged: 0, filesDownloaded: 0, acked: 0, cursor: r1.cursor });

        // New on the VPS: p2's preview, a note on p1.
        await upload(vps.app, 'p2', 'preview', 'P2');
        await vps.app.request('/api/photos/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'p1', version: 1, note: 'flag left' }),
        });
        const r3 = await pull();
        expect(r3).toMatchObject({ inserted: 0, updated: 1, unchanged: 1, filesDownloaded: 1 });
        const refined = await b.get('p1');
        expect(refined).toMatchObject({ note: 'flag left', refinedYawDeg: 214.1, refineMethod: 'skyline', refinedAt: '2026-10-03T10:00:00Z', version: 2 });
        expect((await b.get('p2')).previewSha256).toBe(sha256('P2'));

        // Reset re-lists everything but downloads nothing; p3 is still skipped.
        const r4 = await pull(true);
        expect(r4).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, filesDownloaded: 0 });
        expect(r4.skipped.map((s) => s.id)).toEqual(['p3']);

        // Once the site exists here, a reset pull picks p3 up and acks it.
        await builder.ctx.sitesService.create({ id: 'site-vps-only', name: 'late' });
        const r5 = await pull(true);
        expect(r5).toMatchObject({ inserted: 1, filesDownloaded: 1, acked: 1 });
        expect(r5.skipped).toEqual([]);
        expect((await v.get('p3')).pulledAt).not.toBeNull();
    });

    test('an original deleted by retention is not fetched; the preview still is', async () => {
        let clock = new Date('2026-10-02T12:00:00Z');
        const { vps, builder, pull } = await pair(() => clock);
        await createPhoto(vps.app, photoInput('p1', SITE));
        await upload(vps.app, 'p1', 'original', 'O1');
        await upload(vps.app, 'p1', 'preview', 'P1');
        await vps.ctx.photosService.ack(['p1']);
        clock = new Date('2026-10-17T00:00:00Z');
        expect(await vps.ctx.photosService.purgePulledOriginals()).toEqual({ deleted: ['p1'] });

        const r = await pull();
        expect(r).toMatchObject({ inserted: 1, filesDownloaded: 1 });
        const local = await builder.ctx.photosService.get('p1');
        expect(local.originalSha256).toBeNull();
        expect(local.previewSha256).toBe(sha256('P1'));
    });

    test('a download whose bytes do not match the listed hash stops the pull and keeps prior progress', async () => {
        const { vps, builder, pull } = await pair();
        await createPhoto(vps.app, photoInput('p1', SITE));
        await createPhoto(vps.app, photoInput('p2', SITE));
        await upload(vps.app, 'p1', 'original', 'O1');
        await upload(vps.app, 'p2', 'original', 'O2');
        writeFileSync(path.join(vps.dataDir, 'photos', SITE, 'p2.heic'), 'TAMPERED');

        await expect(pull()).rejects.toThrow(/does not match/);
        expect((await builder.ctx.photosService.get('p1')).originalSha256).toBe(sha256('O1'));
        expect((await vps.ctx.photosService.get('p1')).pulledAt).not.toBeNull();
        expect((await vps.ctx.photosService.get('p2')).pulledAt).toBeNull();
        const saved = readPullState(builder.dataDir).cursor;
        expect(saved).toBe((await vps.ctx.photosService.listForPull('0')).photos[0].cursor);
    });
});
