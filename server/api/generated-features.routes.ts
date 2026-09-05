import { Hono } from 'hono';
import { requireAuth, NotFoundError } from '@basics/core/server/auth';
import { log } from '@basics/core/server/logger';
import { getTraceId } from '@basics/core/server/request-id';
import {
    InvalidFeatureError,
    type CourseFeaturesService,
    type GeneratedFeatureCollection,
} from '../services/course-features.service';

/**
 * `PUT /api/courses/:courseId/features/generated?source=<source>`
 *
 * Pipeline entry point: replaces every feature of the course whose `source`
 * equals the query `source` with the GeoJSON FeatureCollection in the body
 * (EPSG:3006 Polygons; see `CourseFeaturesService.replaceGenerated` and
 * server/AGENTS.md for the property contract). Responds `{ deleted, inserted }`.
 *
 * Hand-mounted (not a `mount()` descriptor) because the descriptor path only
 * merges query params for GET and has no 400 mapping for bad bodies.
 *
 * Body size is governed by the app-wide `BODY_LIMIT` (framework `bodyLimit`
 * middleware, default 1 MB). `dev:server` and `start:vps` raise it well past
 * the ~20 MB a full canopy export needs.
 */
export function createGeneratedFeaturesRoutes(svc: CourseFeaturesService): Hono {
    const app = new Hono();

    app.put('/courses/:courseId/features/generated', requireAuth(), async (c) => {
        const courseId = c.req.param('courseId');
        const source = c.req.query('source') ?? '';
        if (source.trim().length === 0) {
            return c.json({ error: 'source query parameter is required and must be non-empty' }, 400);
        }
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Body must be JSON' }, 400);
        }
        try {
            const result = await svc.replaceGenerated(courseId, source, body as GeneratedFeatureCollection);
            return c.json(result);
        } catch (err) {
            if (err instanceof InvalidFeatureError) return c.json({ error: err.message }, 400);
            if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
            log.error({
                msg: 'replace generated features failed',
                courseId,
                source,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                traceId: getTraceId(c),
            });
            return c.json({ error: 'Internal server error' }, 500);
        }
    });

    return app;
}
