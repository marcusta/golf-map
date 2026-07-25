import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { log } from '@basics/core/server/logger';
import type { IngestService } from '../services/ingest.service';
import { IngestBlockedError } from '../services/ingest.service';

/**
 * Bearer-token guard for the ingest endpoint. Unlike the rest of the API this
 * is machine-to-machine (the builder's publish CLI), so it uses a shared
 * `PUBLISH_TOKEN` bearer rather than a cookie session. A missing/blank env var
 * means the endpoint is closed (every request 401s).
 */
function requirePublishToken(): MiddlewareHandler {
    return async (c, next) => {
        const expected = process.env.PUBLISH_TOKEN ?? '';
        const header = c.req.header('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!expected || !tokensMatch(presented, expected)) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        await next();
    };
}

/** Constant-time token comparison (length-safe). */
function tokensMatch(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

/**
 * Serve-mode ingest routes (§8). Mounted ONLY in serve mode by `main.ts`; in
 * builder mode the path is absent and 404s. Streams the tar.zst POST body to a
 * temp file under `data/incoming/`, hands it to the ingest service, and returns
 * the ingest report.
 *
 * Usage from main.ts:
 *   app.route('/api', createIngestRoutes(ingestService, dataDir));
 */
export function createIngestRoutes(ingestService: IngestService, dataDir: string): Hono {
    const app = new Hono();

    app.post('/ingest/site', requirePublishToken(), async (c) => {
        const incoming = path.join(dataDir, 'incoming');
        mkdirSync(incoming, { recursive: true });
        const tmpPath = path.join(incoming, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.zst`);

        try {
            // Stream the request body straight to disk (bundles are ~60–80 MB).
            await Bun.write(tmpPath, new Response(c.req.raw.body));
            const report = await ingestService.ingestArchive(tmpPath);
            return c.json(report);
        } catch (err) {
            if (err instanceof IngestBlockedError) {
                return c.json({ error: err.message, detail: err.detail }, 409);
            }
            log.error({
                msg: 'ingest failed',
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
            return c.json({ error: err instanceof Error ? err.message : 'Ingest failed' }, 500);
        } finally {
            rmSync(tmpPath, { force: true });
        }
    });

    return app;
}
