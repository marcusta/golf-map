import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mountApiRoutes } from '../routes';
import { createTestDbWith } from '../testing/db';
import { TEST_COURSE_ID } from '../db/seeds/course';
import { ACTIVE, CHANGE_BOUNDS_3006, TINY_PNG, setup } from '../testing/cleaned-photo';
import { createCleanedPhotoApi } from './cleaned-photo.api';
import { createCleanedPhotoFileRoutes } from './cleaned-photo.routes';
import { mount } from '@basics/core/server/mount';
import type { CleanedImportResult } from '../../shared/cleaned-photo';
import { CLEANED_IMPORT_MAX_BYTES } from '../../shared/cleaned-photo';
import { raiseBuilderBodyLimit } from '../mode';

// The cleaned photo's raw routes (PNG download, image upload) and descriptor
// routes over HTTP, against the real service with the fixture pipeline runner
// (testing/cleaned-photo.ts).

type Fixture = Awaited<ReturnType<typeof setup>>;

/** The routes over the fixture service, with a session user as the cookie middleware would set. */
async function box(opts: { maxBytes?: number; stallMs?: number; fail?: (cmd: string) => boolean; importChanges?: () => boolean } = {}) {
    const fx: Fixture = await setup({ fail: opts.fail, importChanges: opts.importChanges });
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('user', { id: 'user-1', username: 'tester' });
        await next();
    });
    mount(app, '/api', createCleanedPhotoApi(fx.svc));
    app.route('/api', createCleanedPhotoFileRoutes(fx.svc, { maxBytes: opts.maxBytes, stallMs: opts.stallMs }));
    const put = (body: BodyInit | null, init: RequestInit = {}) =>
        app.request(`/api/cleaned-photo/${TEST_COURSE_ID}/import`, {
            method: 'PUT', headers: { 'content-type': 'image/png' }, body, ...init,
        });
    return { ...fx, app, put };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
}

describe('cleaned-photo routes: mounting and auth', () => {
    async function appFor(mode: 'builder' | 'serve'): Promise<Hono> {
        const ctx = await createTestDbWith({ mode });
        const app = new Hono();
        mountApiRoutes(app, ctx, { mode, dataDir: '/tmp/golf-map-test-data' });
        return app;
    }
    const requests: Array<[string, string]> = [
        ['GET', `/api/cleaned-photo/${TEST_COURSE_ID}/export.png`],
        ['PUT', `/api/cleaned-photo/${TEST_COURSE_ID}/import`],
        ['GET', `/api/cleaned-photo/info?courseId=${TEST_COURSE_ID}`],
        ['GET', `/api/cleaned-photo/${TEST_COURSE_ID}/pixels.rgb`],
        ['PUT', `/api/cleaned-photo/${TEST_COURSE_ID}/pixels?x=0&y=0&w=1&h=1`],
        ['POST', '/api/cleaned-photo/undo'],
        ['GET', `/api/cleanup-areas?courseId=${TEST_COURSE_ID}`],
        ['POST', '/api/cleanup-areas'],
        ['GET', `/api/cleanup-areas/export?courseId=${TEST_COURSE_ID}`],
    ];

    test('builder mode: all behind the session (401); serve mode: absent (404)', async () => {
        const builder = await appFor('builder');
        const serve = await appFor('serve');
        for (const [method, url] of requests) {
            const init = { method, body: method === 'GET' ? undefined : TINY_PNG };
            expect([url, (await builder.request(url, init)).status]).toEqual([url, 401]);
            expect([url, (await serve.request(url, init)).status]).toEqual([url, 404]);
        }
    });

    test('builder mode lifts the body limit to the import cap, and never lowers a higher one', () => {
        const env: Record<string, string | undefined> = { BODY_LIMIT: '67108864' };
        raiseBuilderBodyLimit(env);
        expect(env.BODY_LIMIT).toBe(String(CLEANED_IMPORT_MAX_BYTES));
        const high = { BODY_LIMIT: String(CLEANED_IMPORT_MAX_BYTES * 2) };
        raiseBuilderBodyLimit(high);
        expect(high.BODY_LIMIT).toBe(String(CLEANED_IMPORT_MAX_BYTES * 2));
        const serve = { SERVER_MODE: 'serve', BODY_LIMIT: '1000' };
        raiseBuilderBodyLimit(serve);
        expect(serve.BODY_LIMIT).toBe('1000');
    });
});

describe('cleaned-photo routes', () => {
    test('GET export.png downloads the photo as an attachment named after the course, with nothing cleaned first', async () => {
        const { app, cleanup } = await box();
        try {
            const res = await app.request(`/api/cleaned-photo/${TEST_COURSE_ID}/export.png`);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('image/png');
            expect(res.headers.get('content-disposition')).toBe('attachment; filename="linkan-cleaned-8192.png"');
            expect(await res.text()).toBe(`png of photo of ortho-${ACTIVE}.tif`);
            expect((await app.request('/api/cleaned-photo/no-such-course/export.png')).status).toBe(404);
        } finally {
            await cleanup();
        }
    });

    test('GET pixels.rgb streams the raw photo; PUT pixels writes a rectangle into it', async () => {
        const { app, photo, snapshots, cleanup } = await box();
        try {
            const res = await app.request(`/api/cleaned-photo/${TEST_COURSE_ID}/pixels.rgb`);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('application/octet-stream');
            expect(res.headers.get('x-photo-size')).toBe('8192');
            expect(await res.text()).toBe(`rgb of photo of ortho-${ACTIVE}.tif`);

            const url = `/api/cleaned-photo/${TEST_COURSE_ID}/pixels`;
            const write = (query: string, bytes: number) => app.request(`${url}?${query}`, { method: 'PUT', body: new Uint8Array(bytes) });
            const first = await write('x=10&y=20&w=3&h=2&snapshot=1', 24);
            expect(first.status).toBe(200);
            expect(((await first.json()) as { undoDepth: number }).undoDepth).toBe(1);
            expect((await write('x=11&y=20&w=3&h=2', 24)).status).toBe(200);
            expect(await photo()).toBe(`photo of ortho-${ACTIVE}.tif +3x2@10,20 +3x2@11,20`);
            // One undo step for the session, not one per stroke.
            expect(snapshots()).toEqual(['1.tif']);

            expect((await write('x=8191&y=0&w=3&h=2', 24)).status).toBe(400);
            expect((await write('x=0&y=0&w=3&h=2', 5)).status).toBe(400);
            expect((await write('y=0&w=3&h=2', 24)).status).toBe(400);
            expect((await app.request('/api/cleaned-photo/no-such-course/pixels.rgb')).status).toBe(404);
        } finally {
            await cleanup();
        }
    });

    test('PUT import replaces the photo with the body and answers what changed; undo and info see it', async () => {
        const { app, put, photo, workLeft, cleanup } = await box();
        try {
            const res = await put(TINY_PNG);
            expect(res.status).toBe(200);
            const body = await res.json() as CleanedImportResult;
            expect(body).toMatchObject({ changed: true, changedPixels: 5000, bounds3006: CHANGE_BOUNDS_3006, size: 8192, undoDepth: 1 });
            expect(await photo()).toBe(`image .png of ${TINY_PNG.length} bytes`);
            expect(workLeft()).toEqual([]);

            // A streamed body (no content-length), in chunks smaller than the signature.
            const streamed = await put(streamOf([TINY_PNG.subarray(0, 5), TINY_PNG.subarray(5)]), { duplex: 'half' } as RequestInit);
            expect(streamed.status).toBe(200);

            const info = await (await app.request(`/api/cleaned-photo/info?courseId=${TEST_COURSE_ID}`)).json() as { undoDepth: number; exists: boolean };
            expect([info.exists, info.undoDepth]).toEqual([true, 2]);
            const undo = await app.request('/api/cleaned-photo/undo', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ courseId: TEST_COURSE_ID }),
            });
            expect(((await undo.json()) as { undoDepth: number }).undoDepth).toBe(1);
        } finally {
            await cleanup();
        }
    });

    test('200 with changed false for an image that is the photo as it was', async () => {
        const { put, cleanup } = await box({ importChanges: () => false });
        try {
            const body = await (await put(TINY_PNG)).json() as CleanedImportResult;
            expect(body).toMatchObject({ changed: false, changedPixels: 0, bounds3006: null, undoDepth: 0 });
        } finally {
            await cleanup();
        }
    });

    test('400 for a body that is not an image or is empty, with no pipeline call and nothing left behind', async () => {
        const { put, calls, workLeft, cleanup } = await box();
        try {
            const text = await put(Buffer.from('just some text, long enough'));
            expect(text.status).toBe(400);
            expect(((await text.json()) as { error: string }).error).toMatch(/not a PNG, JPEG or TIFF/);
            // Shorter than a signature.
            expect((await put(TINY_PNG.subarray(0, 4))).status).toBe(400);
            expect((await put('')).status).toBe(400);
            expect((await put(null)).status).toBe(400);
            expect(calls).toHaveLength(0);
            expect(workLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('408 when the body stops arriving: says how far it got and leaves nothing behind', async () => {
        const { put, calls, workLeft, cleanup } = await box({ stallMs: 30 });
        try {
            // The signature arrives, then the stream stays open and silent.
            const stuck = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(TINY_PNG.subarray(0, 12)); } });
            const res = await put(stuck, { duplex: 'half', headers: { 'content-type': 'image/png', 'content-length': '5000' } } as RequestInit);
            expect(res.status).toBe(408);
            expect(((await res.json()) as { error: string }).error).toMatch(/upload stopped: 12 of 5000 bytes arrived/);
            expect(calls).toHaveLength(0);
            expect(workLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('413 above the cap, by content-length and for a streamed body', async () => {
        const { put, calls, workLeft, cleanup } = await box({ maxBytes: 100 });
        try {
            const big = Buffer.concat([TINY_PNG, Buffer.alloc(200)]);
            expect((await put(big)).status).toBe(413);
            const half = big.subarray(0, 140);
            expect((await put(streamOf([half, half]), { duplex: 'half' } as RequestInit)).status).toBe(413);
            expect(calls).toHaveLength(0);
            expect(workLeft()).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('422 with the pipeline\'s own words when it refuses the image; 404 for an unknown course', async () => {
        const { app, put, cleanup } = await box({ fail: c => c === 'cleaned-replace' });
        try {
            const res = await put(TINY_PNG);
            expect(res.status).toBe(422);
            expect(((await res.json()) as { error: string }).error).toMatch(/cleaned-replace failed: .*pipeline boom/s);
            const unknown = await app.request('/api/cleaned-photo/no-such-course/import', { method: 'PUT', body: TINY_PNG });
            expect(unknown.status).toBe(404);
        } finally {
            await cleanup();
        }
    });
});
