import { Hono } from 'hono';
import type { Context } from 'hono';
import { rmSync } from 'node:fs';
import { requireAuth, NotFoundError } from '@basics/core/server/auth';
import { log } from '@basics/core/server/logger';
import { getTraceId } from '@basics/core/server/request-id';
import {
    InvalidPhotoImportError,
    InvalidPixelPatchError,
    PhotoPipelineError,
    importImageKind,
    type CleanedPhotoService,
} from '../services/cleaned-photo.service';
import { CLEANED_IMPORT_MAX_BYTES } from '../../shared/cleaned-photo';

/**
 * Bun.serve closes a connection that carries no bytes for 10 s (its default
 * `idleTimeout`), and an export encode or an import keeps the request silent
 * for longer than that. Bun hands its server to Hono as `c.env`;
 * `timeout(request, 0)` lifts the limit for this one request. Absent under
 * `app.request()` in tests, where there is no socket.
 */
export function liftIdleTimeout(c: Context): void {
    const server = c.env as { timeout?: (req: Request, seconds: number) => void } | undefined;
    if (typeof server?.timeout === 'function') server.timeout(c.req.raw, 0);
}

/** Maps service errors to status codes; anything else is a logged 500. */
function errorResponse(c: Context, err: unknown, msg: string): Response {
    if (err instanceof InvalidPhotoImportError || err instanceof InvalidPixelPatchError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    // golfpipe refused the image (another pixel size, an unreadable file):
    // its message is the answer.
    if (err instanceof PhotoPipelineError) return c.json({ error: err.message }, 422);
    log.error({
        msg,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        traceId: getTraceId(c),
    });
    return c.json({ error: 'Internal server error' }, 500);
}

export interface CleanedPhotoFileRoutesOptions {
    /** Upload cap. Defaults to 400 MB. */
    maxBytes?: number;
    /** How long the upload may bring no bytes before it is given up. Defaults to 30 s. */
    stallMs?: number;
}

const STALLED = Symbol('stalled');

/** The next chunk, or STALLED when none comes within `ms`. */
function readOrStall<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>> | typeof STALLED> {
    let timer: ReturnType<typeof setTimeout>;
    const stall = new Promise<typeof STALLED>((resolve) => { timer = setTimeout(() => resolve(STALLED), ms); });
    return Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
}

/**
 * The cleaned photo's raw routes, cookie session, builder mode only.
 * Response types: `shared/cleaned-photo.ts`.
 *
 * `GET /api/cleaned-photo/:courseId/export.png` streams the cleaned photo as
 * a PNG attachment (`<course>-cleaned-8192.png`). The photo is made from the
 * pristine one first when the site has never been cleaned; the PNG is
 * re-encoded only when the photo changed since the last download.
 *
 * - 404 unknown course, or a course without a built map
 *
 * `PUT /api/cleaned-photo/:courseId/import`, raw body: any PNG, JPEG or TIFF
 * of the photo's pixel size. It becomes the cleaned photo, whatever it shows.
 * The body streams to `sources/<siteId>/cleaned-work/` and is deleted
 * whatever happens.
 *
 * - 200 `CleanedImportResult` (`changed: false` when the image is the photo as it was)
 * - 400 empty body, or a body that is not a PNG, JPEG or TIFF
 * - 404 unknown course, course without a built map
 * - 408 the upload brought no bytes for 30 s (`error` says how far it got)
 * - 413 body over the cap (400 MB)
 * - 422 golfpipe refused the image, e.g. another pixel size (`error` has its message)
 *
 * The app-wide `BODY_LIMIT` must be at least the cap; `env-builder.ts` raises
 * it in builder mode.
 *
 * `GET /api/cleaned-photo/:courseId/pixels.rgb` streams the photo's pixels as
 * raw RGB bytes (3 per pixel, row by row; `x-photo-size` is the side in
 * pixels): what the Clean tool loads into its pixel engine. Made from the
 * pristine photo first like the PNG.
 *
 * `PUT /api/cleaned-photo/:courseId/pixels?x=&y=&w=&h=[&snapshot=1]`, raw
 * body of `w * h * 4` RGBA bytes: writes that rectangle into the photo and
 * retiles under it (one stroke of the Clean tool). `snapshot=1` keeps the
 * photo from before as an undo step.
 *
 * - 200 `CleanedPhotoResult` (`undoDepth`, `patchesGeneratedAt`)
 * - 400 a rectangle outside the photo, or a body of another length
 * - 404 unknown course, course without a built map
 */
export function createCleanedPhotoFileRoutes(svc: CleanedPhotoService, opts: CleanedPhotoFileRoutesOptions = {}): Hono {
    const maxBytes = opts.maxBytes ?? CLEANED_IMPORT_MAX_BYTES;
    const stallMs = opts.stallMs ?? 30_000;
    const app = new Hono();

    app.get('/cleaned-photo/:courseId/export.png', requireAuth(), async (c) => {
        liftIdleTimeout(c);
        try {
            const file = await svc.exportImage(c.req.param('courseId'));
            return new Response(Bun.file(file.path), {
                headers: {
                    'content-type': 'image/png',
                    'content-length': String(file.bytes),
                    'content-disposition': `attachment; filename="${file.file}"`,
                    'cache-control': 'private, no-cache',
                },
            });
        } catch (err) {
            return errorResponse(c, err, 'cleaned photo export failed');
        }
    });

    app.get('/cleaned-photo/:courseId/pixels.rgb', requireAuth(), async (c) => {
        liftIdleTimeout(c);
        try {
            const file = await svc.pixelsFile(c.req.param('courseId'));
            return new Response(Bun.file(file.path), {
                headers: {
                    'content-type': 'application/octet-stream',
                    'content-length': String(file.bytes),
                    'x-photo-size': String(file.size),
                    'cache-control': 'private, no-store',
                },
            });
        } catch (err) {
            return errorResponse(c, err, 'cleaned photo pixels failed');
        }
    });

    app.put('/cleaned-photo/:courseId/pixels', requireAuth(), async (c) => {
        liftIdleTimeout(c);
        try {
            const n = (name: string) => Number(c.req.query(name) ?? NaN);
            const rgba = new Uint8Array(await c.req.arrayBuffer());
            return c.json(await svc.writePixels(
                c.req.param('courseId'),
                { x: n('x'), y: n('y'), w: n('w'), h: n('h'), rgba },
                { snapshot: c.req.query('snapshot') === '1' },
            ));
        } catch (err) {
            return errorResponse(c, err, 'cleaned photo pixel write failed');
        }
    });

    app.put('/cleaned-photo/:courseId/import', requireAuth(), async (c) => {
        const declaredLength = Number(c.req.header('content-length') ?? '0');
        if (declaredLength > maxBytes) return c.json({ error: `Body exceeds ${maxBytes} bytes` }, 413);
        const body = c.req.raw.body;
        if (!body) return c.json({ error: 'Empty body' }, 400);
        liftIdleTimeout(c);

        let tmpPath: string;
        try {
            tmpPath = await svc.incomingImportPath(c.req.param('courseId'));
        } catch (err) {
            return errorResponse(c, err, 'cleaned photo import failed');
        }

        // Hand-pumped FileSink, as in photos.routes.ts (Bun.write(Response)
        // hangs on Bun 1.3.6). Counts while writing and checks the image
        // signature on the first bytes, so a wrong file stops at once.
        let handedOver = false;
        try {
            const sink = Bun.file(tmpPath).writer();
            const reader = body.getReader();
            let bytes = 0;
            let head = Buffer.alloc(0);
            let checked = false;
            let refusal: { error: string; status: 400 | 408 | 413 } | null = null;
            for (;;) {
                // A body that stops arriving would otherwise hold the request,
                // silent, until the app-wide timeout answers 504 minutes later.
                const next = await readOrStall(reader, stallMs);
                if (next === STALLED) {
                    const of = declaredLength > 0 ? ` of ${declaredLength}` : '';
                    refusal = {
                        error: `The upload stopped: ${bytes}${of} bytes arrived, then nothing for ${Math.round(stallMs / 1000)} s. `
                            + 'Pick the file again once the image editor has finished saving it.',
                        status: 408,
                    };
                    await reader.cancel().catch(() => {});
                    break;
                }
                const { done, value } = next;
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) {
                    refusal = { error: `Body exceeds ${maxBytes} bytes`, status: 413 };
                } else if (!checked) {
                    head = Buffer.concat([head, value.subarray(0, 8 - head.length)]);
                    if (head.length >= 8) {
                        checked = true;
                        if (!importImageKind(head)) {
                            refusal = { error: 'The uploaded file is not a PNG, JPEG or TIFF image', status: 400 };
                        }
                    }
                }
                if (refusal) {
                    await reader.cancel().catch(() => {});
                    break;
                }
                sink.write(value);
            }
            await sink.end();
            if (!refusal && bytes === 0) refusal = { error: 'Empty body', status: 400 };
            if (!refusal && !checked) refusal = { error: 'The uploaded file is not a PNG, JPEG or TIFF image', status: 400 };
            if (refusal) return c.json({ error: refusal.error }, refusal.status);

            handedOver = true; // importImage deletes the file from here on
            return c.json(await svc.importImage(c.req.param('courseId'), tmpPath));
        } catch (err) {
            return errorResponse(c, err, 'cleaned photo import failed');
        } finally {
            if (!handedOver) rmSync(tmpPath, { force: true });
        }
    });

    return app;
}
