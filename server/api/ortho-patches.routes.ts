import { Hono } from 'hono';
import type { Context } from 'hono';
import { rmSync } from 'node:fs';
import { requireAuth, NotFoundError } from '@basics/core/server/auth';
import { log } from '@basics/core/server/logger';
import { getTraceId } from '@basics/core/server/request-id';
import {
    InvalidOrthoImportError,
    OrthoPipelineError,
    type OrthoPatchesService,
} from '../services/ortho-patches.service';
import { ORTHO_IMPORT_MAX_BYTES } from '../../shared/ortho-import';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const EXPORT_CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg' } as const;

/**
 * Bun.serve closes a connection that carries no bytes for 10 s (its default
 * `idleTimeout`), and an export or an import bake keeps the request silent
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
    if (err instanceof InvalidOrthoImportError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    // golfpipe refused the image (wrong size, JPEG without a tolerance, an
    // export that was modified) or the bake failed: its message is the answer.
    if (err instanceof OrthoPipelineError) return c.json({ error: err.message }, 422);
    log.error({
        msg,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        traceId: getTraceId(c),
    });
    return c.json({ error: 'Internal server error' }, 500);
}

/** A whole number from a query value; `undefined` when absent, `NaN` when malformed. */
function intQuery(raw: string | undefined): number | undefined {
    if (raw === undefined || raw === '') return undefined;
    return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

export interface OrthoPatchFileRoutesOptions {
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
 * Raw ortho-patch routes, cookie session, builder mode only
 * (docs/feature-ortho-export-import.md §5). Response types:
 * `shared/ortho-import.ts`.
 *
 * `GET /api/ortho-patches/export/:siteId/:seq/file` streams the export image
 * as an attachment (`ortho-sim-<seq>.png|jpg`), its hash in `X-Content-SHA256`.
 *
 * - 404 unknown site or export
 *
 * `PUT /api/ortho-patches/import/:courseId?exportSeq=<n>&tolerance=<t>`, raw
 * body: the edited PNG. `exportSeq` defaults to the latest export;
 * `tolerance` (0..254) only when the builder chose one. The body streams to
 * `sources/<siteId>/patches/.incoming/` and is deleted whatever happens.
 *
 * - 200 `OrthoImportResult` (`changed: false` when the image holds no change)
 * - 400 malformed query, empty body, body that is not a PNG
 * - 404 unknown course, course without a built map, no such export
 * - 408 the upload brought no bytes for 30 s (`error` says how far it got)
 * - 413 body over the cap (400 MB)
 * - 422 golfpipe refused the image or the bake failed (`error` has its message)
 *
 * The app-wide `BODY_LIMIT` must be at least the cap; `env-builder.ts` raises
 * it in builder mode.
 */
export function createOrthoPatchFileRoutes(svc: OrthoPatchesService, opts: OrthoPatchFileRoutesOptions = {}): Hono {
    const maxBytes = opts.maxBytes ?? ORTHO_IMPORT_MAX_BYTES;
    const stallMs = opts.stallMs ?? 30_000;
    const app = new Hono();

    app.get('/ortho-patches/export/:siteId/:seq/file', requireAuth(), async (c) => {
        try {
            const seq = intQuery(c.req.param('seq'));
            const file = await svc.exportFile(c.req.param('siteId'), seq ?? Number.NaN);
            return new Response(Bun.file(file.path), {
                headers: {
                    'content-type': EXPORT_CONTENT_TYPE[file.format],
                    'content-disposition': `attachment; filename="${file.file}"`,
                    'x-content-sha256': file.sha256,
                    'cache-control': 'private, no-cache',
                },
            });
        } catch (err) {
            return errorResponse(c, err, 'ortho export download failed');
        }
    });

    app.put('/ortho-patches/import/:courseId', requireAuth(), async (c) => {
        const exportSeq = intQuery(c.req.query('exportSeq'));
        if (Number.isNaN(exportSeq) || exportSeq === 0) return c.json({ error: 'exportSeq must be a whole number, 1 or higher' }, 400);
        const tolerance = intQuery(c.req.query('tolerance'));
        if (Number.isNaN(tolerance) || (tolerance ?? 0) > 254) return c.json({ error: 'tolerance must be a whole number from 0 to 254' }, 400);
        const declaredLength = Number(c.req.header('content-length') ?? '0');
        if (declaredLength > maxBytes) return c.json({ error: `Body exceeds ${maxBytes} bytes` }, 413);
        const body = c.req.raw.body;
        if (!body) return c.json({ error: 'Empty body' }, 400);
        liftIdleTimeout(c);

        let tmpPath: string;
        try {
            tmpPath = await svc.incomingImportPath(c.req.param('courseId'));
        } catch (err) {
            return errorResponse(c, err, 'ortho import failed');
        }

        // Hand-pumped FileSink, as in photos.routes.ts (Bun.write(Response)
        // hangs on Bun 1.3.6). Counts while writing and checks the PNG
        // signature on the first bytes, so a wrong file stops at once.
        let handedOver = false;
        try {
            const sink = Bun.file(tmpPath).writer();
            const reader = body.getReader();
            let bytes = 0;
            let head = Buffer.alloc(0);
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
                } else if (head.length < PNG_SIGNATURE.length) {
                    head = Buffer.concat([head, value.subarray(0, PNG_SIGNATURE.length - head.length)]);
                    if (!head.equals(PNG_SIGNATURE.subarray(0, head.length))) {
                        refusal = { error: 'The uploaded image is not a PNG — save the edit as PNG', status: 400 };
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
            if (refusal) return c.json({ error: refusal.error }, refusal.status);

            handedOver = true; // importEdited deletes the file from here on
            return c.json(await svc.importEdited(c.req.param('courseId'), { tmpPath, exportSeq, tolerance }));
        } catch (err) {
            return errorResponse(c, err, 'ortho import failed');
        } finally {
            if (!handedOver) rmSync(tmpPath, { force: true });
        }
    });

    return app;
}
