import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Hono } from 'hono';
import { mountApiRoutes } from '../routes';
import { createTestDbWith } from '../testing/db';
import { TEST_COURSE_ID } from '../db/seeds/course';
import {
    IMPORT_BOUNDS_3006, IMPORT_BOUNDS_3857, SITE_ID, TINY_PNG, argValue, setup,
    type FakeImportOutcome,
} from '../testing/ortho-patches';
import { createOrthoPatchesApi } from './ortho-patches.api';
import { createOrthoPatchFileRoutes } from './ortho-patches.routes';
import { mount } from '@basics/core/server/mount';
import type { OrthoImportResult } from '../../shared/ortho-import';
import { ORTHO_IMPORT_MAX_BYTES } from '../../shared/ortho-import';
import { raiseBuilderBodyLimit } from '../mode';

// The raw ortho-patch routes (export image download, edited-image upload)
// and the export descriptor route over HTTP, against the real service with
// the fixture pipeline runner (testing/ortho-patches.ts).

type Fixture = Awaited<ReturnType<typeof setup>>;

/** The routes over the fixture service, with a session user as the cookie middleware would set. */
async function box(opts: { maxBytes?: number; stallMs?: number; fail?: (cmd: string) => boolean; importOutcome?: () => FakeImportOutcome } = {}) {
    const fx: Fixture = await setup({ fail: opts.fail, importOutcome: opts.importOutcome });
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('user', { id: 'user-1', username: 'tester' });
        await next();
    });
    mount(app, '/api', createOrthoPatchesApi(fx.svc));
    app.route('/api', createOrthoPatchFileRoutes(fx.svc, { maxBytes: opts.maxBytes, stallMs: opts.stallMs }));
    const post = (url: string, body: unknown) =>
        app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const put = (query: string, body: BodyInit | null, init: RequestInit = {}) =>
        app.request(`/api/ortho-patches/import/${TEST_COURSE_ID}${query}`, {
            method: 'PUT', headers: { 'content-type': 'image/png' }, body, ...init,
        });
    return { ...fx, app, post, put };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
}

describe('ortho-patch export/import routes: mounting and auth', () => {
    async function appFor(mode: 'builder' | 'serve'): Promise<Hono> {
        const ctx = await createTestDbWith({ mode });
        const app = new Hono();
        mountApiRoutes(app, ctx, { mode, dataDir: '/tmp/golf-map-test-data' });
        return app;
    }

    test('builder mode: all three behind the session (401); serve mode: absent (404)', async () => {
        const requests: Array<[string, RequestInit]> = [
            ['/api/ortho-patches/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"courseId":"x"}' }],
            ['/api/ortho-patches/export/site-a/1/file', {}],
            ['/api/ortho-patches/import/x', { method: 'PUT', body: TINY_PNG }],
        ];
        const builder = await appFor('builder');
        const serve = await appFor('serve');
        for (const [url, init] of requests) {
            expect((await builder.request(url, init)).status).toBe(401);
            expect((await serve.request(url, init)).status).toBe(404);
        }
    });

    test('builder mode raises BODY_LIMIT to the import cap; serve mode and a higher value are left alone', () => {
        const dev: Record<string, string | undefined> = { BODY_LIMIT: '67108864' };
        raiseBuilderBodyLimit(dev);
        expect(dev.BODY_LIMIT).toBe(String(ORTHO_IMPORT_MAX_BYTES));
        const unset: Record<string, string | undefined> = {};
        raiseBuilderBodyLimit(unset);
        expect(unset.BODY_LIMIT).toBe(String(400 * 1024 * 1024));
        const serve: Record<string, string | undefined> = { SERVER_MODE: 'serve', BODY_LIMIT: '268435456' };
        raiseBuilderBodyLimit(serve);
        expect(serve.BODY_LIMIT).toBe('268435456');
        const higher: Record<string, string | undefined> = { BODY_LIMIT: '1073741824' };
        raiseBuilderBodyLimit(higher);
        expect(higher.BODY_LIMIT).toBe('1073741824');
    });
});

describe('POST /api/ortho-patches/export + GET .../file', () => {
    test('exports, lists it in info, and the download path streams the image as an attachment', async () => {
        const { app, post, cleanup } = await box();
        try {
            const res = await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            expect(res.status).toBe(200);
            const exp = (await res.json()) as { exportSeq: number; downloadPath: string; sha256: string; bytes: number; file: string };
            expect(exp).toMatchObject({ exportSeq: 1, file: 'ortho-sim-1.png', downloadPath: `/ortho-patches/export/${SITE_ID}/1/file` });

            const info = (await (await app.request(`/api/ortho-patches/info?courseId=${TEST_COURSE_ID}`)).json()) as {
                exports: Array<{ seq: number; downloadPath: string }>; frame: { size: number } | null;
            };
            expect(info.exports.map(e => [e.seq, e.downloadPath])).toEqual([[1, exp.downloadPath]]);
            expect(info.frame?.size).toBe(8192);

            const file = await app.request(`/api${exp.downloadPath}`);
            expect(file.status).toBe(200);
            expect(file.headers.get('content-type')).toBe('image/png');
            expect(file.headers.get('content-disposition')).toBe('attachment; filename="ortho-sim-1.png"');
            expect(file.headers.get('x-content-sha256')).toBe(exp.sha256);
            const bytes = new Uint8Array(await file.arrayBuffer());
            expect(bytes.byteLength).toBe(exp.bytes);
            expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(exp.sha256);

            const jpg = await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID, format: 'jpg' });
            const jpgFile = await app.request(`/api${((await jpg.json()) as { downloadPath: string }).downloadPath}`);
            expect(jpgFile.headers.get('content-type')).toBe('image/jpeg');
            await jpgFile.arrayBuffer();
        } finally {
            await cleanup();
        }
    });

    test('400 on an unknown format, 404 on an unknown course, export, site or a malformed number', async () => {
        const { app, post, cleanup } = await box();
        try {
            expect((await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID, format: 'webp' })).status).toBe(400);
            expect((await post('/api/ortho-patches/export', { courseId: 'ghost' })).status).toBe(404);
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            expect((await app.request(`/api/ortho-patches/export/${SITE_ID}/2/file`)).status).toBe(404);
            expect((await app.request(`/api/ortho-patches/export/${SITE_ID}/abc/file`)).status).toBe(404);
            expect((await app.request(`/api/ortho-patches/export/${SITE_ID}/0/file`)).status).toBe(404);
            expect((await app.request('/api/ortho-patches/export/no-such-site/1/file')).status).toBe(404);
            expect((await app.request('/api/ortho-patches/export/..%2F..%2Fx/1/file')).status).toBe(404);
        } finally {
            await cleanup();
        }
    });
});

describe('PUT /api/ortho-patches/import/:courseId', () => {
    test('stores the change as a raster entry and answers with the change summary', async () => {
        const { post, put, calls, exportsDir, readLog, incomingLeft, cleanup } = await box();
        try {
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            calls.length = 0;

            const res = await put('', TINY_PNG);
            expect(res.status).toBe(200);
            const body = (await res.json()) as OrthoImportResult;
            expect(body).toMatchObject({
                changed: true, seq: 1, count: 1, exportSeq: 2, changedPixels: 123168, diffPixels: 121600,
                tolerance: 2, minAreaPx: 4, bounds3006: IMPORT_BOUNDS_3006, bounds3857: IMPORT_BOUNDS_3857, regions: 2,
            });
            expect(body.reason).toBeUndefined();
            expect(body.patchesGeneratedAt).toBeTruthy();
            expect(calls.map(c => c.args[2])).toEqual(['import-ortho-square', 'bake-ortho-patch']);
            expect(calls[0].args).not.toContain('--tolerance');
            expect((await readLog()).patches.map(p => [p.seq, p.kind, p.exportSeq])).toEqual([[1, 'raster', 2]]);
            expect(incomingLeft()).toEqual([]);

            // exportSeq + tolerance from the query; a streamed body with no content-length.
            calls.length = 0;
            const res2 = await put('?exportSeq=1&tolerance=0', streamOf([TINY_PNG.subarray(0, 5), TINY_PNG.subarray(5)]), { duplex: 'half' } as RequestInit);
            expect(res2.status).toBe(200);
            expect((await res2.json()) as OrthoImportResult).toMatchObject({ changed: true, seq: 2, exportSeq: 1, tolerance: 0 });
            expect(argValue(calls[0].args, '--export-dir')).toBe(path.join(exportsDir, '1'));
            expect(argValue(calls[0].args, '--tolerance')).toBe('0');
            expect(incomingLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('200 with changed: false and a reason when the image holds no change; nothing appended', async () => {
        const { post, put, calls, readLog, incomingLeft, cleanup } = await box({ importOutcome: () => 'identical' });
        try {
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            calls.length = 0;
            const res = await put('', TINY_PNG);
            expect(res.status).toBe(200);
            expect((await res.json()) as OrthoImportResult).toEqual({
                changed: false, reason: 'identical', count: 0, patchesGeneratedAt: null, seq: null, exportSeq: 1,
                changedPixels: 0, diffPixels: 0, tolerance: 2, minAreaPx: 4,
                bounds3006: null, bounds3857: null, regions: null,
            });
            expect(calls.map(c => c.args[2])).toEqual(['import-ortho-square']);
            await expect(readLog()).rejects.toThrow();
            expect(incomingLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('400 for a body that is not a PNG, an empty body and malformed query values, with no pipeline call', async () => {
        const { post, put, calls, incomingLeft, cleanup } = await box();
        try {
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            calls.length = 0;

            const jpeg = await put('', Buffer.from('\xff\xd8\xff\xe0 pretending to be a photo', 'latin1'));
            expect(jpeg.status).toBe(400);
            expect(((await jpeg.json()) as { error: string }).error).toMatch(/not a PNG/);
            // A body shorter than the signature that starts like one.
            expect((await put('', TINY_PNG.subarray(0, 4))).status).toBe(400);
            expect((await put('', '')).status).toBe(400);
            expect((await put('', null)).status).toBe(400);
            for (const q of ['?exportSeq=abc', '?exportSeq=0', '?exportSeq=-1', '?exportSeq=1.5', '?tolerance=255', '?tolerance=-1', '?tolerance=x']) {
                expect((await put(q, TINY_PNG)).status).toBe(400);
            }
            expect(calls).toHaveLength(0);
            expect(incomingLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('408 when the body stops arriving: says how far it got, calls no pipeline and leaves no file', async () => {
        const { post, put, calls, incomingLeft, cleanup } = await box({ stallMs: 30 });
        try {
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            calls.length = 0;
            // The PNG signature arrives, then the stream stays open and silent.
            const stuck = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(TINY_PNG.subarray(0, 12)); } });
            const res = await put('', stuck, { duplex: 'half', headers: { 'content-type': 'image/png', 'content-length': '5000' } } as RequestInit);
            expect(res.status).toBe(408);
            expect(((await res.json()) as { error: string }).error).toMatch(/upload stopped: 12 of 5000 bytes arrived/);
            expect(calls).toHaveLength(0);
            expect(incomingLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('413 above the cap, by content-length and for a streamed body', async () => {
        const { post, put, calls, incomingLeft, cleanup } = await box({ maxBytes: 100 });
        try {
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            calls.length = 0;
            const big = new Uint8Array(101);
            big.set(TINY_PNG);
            expect((await put('', big)).status).toBe(413);
            const half = big.subarray(0, 60);
            const streamed = await put('', streamOf([half, half]), { duplex: 'half' } as RequestInit);
            expect(streamed.status).toBe(413);
            expect(calls).toHaveLength(0);
            expect(incomingLeft()).toEqual([]);
            // At the cap is fine.
            expect(TINY_PNG.length).toBeLessThanOrEqual(100);
            expect((await put('', TINY_PNG)).status).toBe(200);
        } finally {
            await cleanup();
        }
    });

    test('the real cap is 400 MB', () => {
        expect(ORTHO_IMPORT_MAX_BYTES).toBe(400 * 1024 * 1024);
    });

    test('404 for an unknown course, a course never exported and an unknown export', async () => {
        const { app, post, put, calls, incomingLeft, cleanup } = await box();
        try {
            expect((await app.request('/api/ortho-patches/import/ghost', { method: 'PUT', body: TINY_PNG })).status).toBe(404);
            expect((await put('', TINY_PNG)).status).toBe(404); // no export yet
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            calls.length = 0;
            expect((await put('?exportSeq=9', TINY_PNG)).status).toBe(404);
            expect(calls).toHaveLength(0);
            expect(incomingLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('422 with golfpipe\'s message when the diff or the bake fails; entry, png and upload are gone', async () => {
        let failing = 'import-ortho-square';
        const { post, put, patchesDir, readLog, incomingLeft, cleanup } = await box({ fail: (cmd) => cmd === failing });
        try {
            await post('/api/ortho-patches/export', { courseId: TEST_COURSE_ID });
            for (failing of ['import-ortho-square', 'bake-ortho-patch']) {
                const res = await put('', TINY_PNG);
                expect(res.status).toBe(422);
                expect(((await res.json()) as { error: string }).error).toBe(`${failing} failed: replay boom`);
                expect(await Bun.file(path.join(patchesDir, '1.png')).exists()).toBe(false);
                expect(incomingLeft()).toEqual([]);
            }
            expect((await readLog()).patches).toEqual([]);
        } finally {
            await cleanup();
        }
    });
});
