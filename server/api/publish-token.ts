import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token guard for the builder-to-VPS routes (publish ingest, photo
 * pull). Machine-to-machine, so it uses the shared `PUBLISH_TOKEN` bearer
 * rather than a cookie session. A missing/blank env var means the routes are
 * closed (every request 401s).
 */
export function requirePublishToken(): MiddlewareHandler {
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
