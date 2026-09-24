import { Hono } from 'hono';
import type { Context } from 'hono';
import * as path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { requireAuth, NotFoundError } from '@basics/core/server/auth';
import { log } from '@basics/core/server/logger';
import { getTraceId } from '@basics/core/server/request-id';
import {
    InvalidPhotoError,
    PHOTO_CONTENT_TYPE,
    PHOTO_MAX_BYTES,
    PhotoFileConflictError,
    isPhotoKind,
    isSha256Hex,
    type PhotosService,
} from '../services/photos.service';
import { requirePublishToken } from './publish-token';

/** Maps service errors to status codes; anything else is a logged 500. */
function errorResponse(c: Context, err: unknown, msg: string): Response {
    if (err instanceof InvalidPhotoError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof PhotoFileConflictError) return c.json({ error: err.message }, 409);
    log.error({
        msg,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        traceId: getTraceId(c),
    });
    return c.json({ error: 'Internal server error' }, 500);
}

/** Streams a stored photo file with its hash in `X-Content-SHA256`. */
async function sendFile(c: Context, svc: PhotosService): Promise<Response> {
    const kind = c.req.query('kind');
    if (!isPhotoKind(kind)) return c.json({ error: 'kind must be original or preview' }, 400);
    try {
        const file = await svc.fileFor(c.req.param('id') ?? '', kind);
        return new Response(Bun.file(file.path), {
            headers: {
                'content-type': PHOTO_CONTENT_TYPE[kind],
                'x-content-sha256': file.sha256,
                'cache-control': 'private, max-age=31536000, immutable',
            },
        });
    } catch (err) {
        return errorResponse(c, err, 'photo file read failed');
    }
}

export interface PhotoFileRoutesOptions {
    /** Upload cap per file. Defaults to 20 MB. */
    maxBytes?: number;
}

/**
 * Photo file routes, cookie session, both modes (docs/feature-reference-photos.md §5.2).
 *
 * `PUT /api/photos/file/:id?kind=original|preview`, raw body, header
 * `X-Content-SHA256: <hex>`. The body streams to `data/photos/.incoming/`
 * while it is hashed, then renames into `data/photos/<siteId>/<id>.heic|.jpg`.
 *
 * - 200 `{ status: 'stored' | 'unchanged', photo }`
 * - 400 bad kind, missing or malformed header, body hash mismatch, empty body
 * - 404 unknown photo id
 * - 409 the kind already has a file with a different hash
 * - 413 body over the cap (20 MB)
 *
 * `GET /api/photos/file/:id?kind=preview|original` returns the file.
 *
 * The app-wide `BODY_LIMIT` must be above the cap for uploads to reach this
 * route (`start:vps` sets 256 MB, `dev:server` 64 MB).
 */
export function createPhotoFileRoutes(svc: PhotosService, opts: PhotoFileRoutesOptions = {}): Hono {
    const maxBytes = opts.maxBytes ?? PHOTO_MAX_BYTES;
    const app = new Hono();

    app.put('/photos/file/:id', requireAuth(), async (c) => {
        const id = c.req.param('id');
        const kind = c.req.query('kind');
        if (!isPhotoKind(kind)) return c.json({ error: 'kind must be original or preview' }, 400);
        const declared = c.req.header('x-content-sha256') ?? '';
        if (!isSha256Hex(declared)) return c.json({ error: 'X-Content-SHA256 header with a hex sha256 is required' }, 400);
        const declaredLength = Number(c.req.header('content-length') ?? '0');
        if (declaredLength > maxBytes) return c.json({ error: `Body exceeds ${maxBytes} bytes` }, 413);
        const body = c.req.raw.body;
        if (!body) return c.json({ error: 'Empty body' }, 400);

        const incoming = path.join(svc.dataDir, 'photos', '.incoming');
        mkdirSync(incoming, { recursive: true });
        const tmpPath = path.join(incoming, `${id}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

        // Hand-pumped FileSink, as in ingest.routes.ts (Bun.write(Response)
        // hangs on Bun 1.3.6). Hashes and counts while writing.
        const hasher = new Bun.CryptoHasher('sha256');
        let bytes = 0;
        try {
            const sink = Bun.file(tmpPath).writer();
            const reader = body.getReader();
            let tooLarge = false;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) {
                    tooLarge = true;
                    await reader.cancel().catch(() => {});
                    break;
                }
                hasher.update(value);
                sink.write(value);
            }
            await sink.end();
            if (tooLarge) {
                rmSync(tmpPath, { force: true });
                return c.json({ error: `Body exceeds ${maxBytes} bytes` }, 413);
            }
            if (bytes === 0) {
                rmSync(tmpPath, { force: true });
                return c.json({ error: 'Empty body' }, 400);
            }
            const result = await svc.storeUploadedFile(id, kind, {
                tmpPath,
                sha256: hasher.digest('hex'),
                bytes,
                declaredSha256: declared,
            });
            return c.json(result);
        } catch (err) {
            rmSync(tmpPath, { force: true });
            return errorResponse(c, err, 'photo upload failed');
        }
    });

    app.get('/photos/file/:id', requireAuth(), (c) => sendFile(c, svc));

    return app;
}

/**
 * Builder pull routes, `PUBLISH_TOKEN` bearer, serve mode only (§5.2, §5.3).
 *
 * - `GET /api/ingest/photos?since=<cursor>&limit=<n>` → `{ photos, nextCursor, hasMore }`.
 *   Photos whose original has arrived, in cursor order. The cursor is the
 *   decimal `upload_seq` (see `PhotosService.listForPull`); absent or "0"
 *   starts from the beginning. `limit` defaults to 100, max 500.
 * - `GET /api/ingest/photos/file/:id?kind=original|preview` streams a file.
 * - `POST /api/ingest/photos/ack` `{ ids: string[] }` → `{ acked }`, sets `pulledAt`.
 */
export function createPhotoPullRoutes(svc: PhotosService): Hono {
    const app = new Hono();
    const guard = requirePublishToken();

    app.get('/ingest/photos', guard, async (c) => {
        const limitRaw = c.req.query('limit');
        const limit = limitRaw === undefined ? 100 : Number(limitRaw);
        if (!Number.isFinite(limit) || limit < 1) return c.json({ error: 'limit must be a positive number' }, 400);
        try {
            return c.json(await svc.listForPull(c.req.query('since'), limit));
        } catch (err) {
            return errorResponse(c, err, 'photo pull list failed');
        }
    });

    app.get('/ingest/photos/file/:id', guard, (c) => sendFile(c, svc));

    app.post('/ingest/photos/ack', guard, async (c) => {
        const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
        const ids = body?.ids;
        if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string')) {
            return c.json({ error: 'Body must be { ids: string[] }' }, 400);
        }
        try {
            return c.json(await svc.ack(ids as string[]));
        } catch (err) {
            return errorResponse(c, err, 'photo ack failed');
        }
    });

    return app;
}
