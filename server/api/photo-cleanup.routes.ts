import { Hono } from 'hono';
import { requireAuth, NotFoundError } from '@basics/core/server/auth';
import { PHOTO_CLEANUP_IMAGES, type PhotoCleanupImage, type PhotoCleanupService } from '../services/photo-cleanup.service';

/**
 * `GET /api/photo-cleanup/:courseId/:jobId/:hole/:kind.png`: one cleaned
 * hole's review image (`review` = before and after side by side, `photo`,
 * `filled`, `detect` with the targets outlined, `overlay` with the surfaces
 * and scope). Cookie session, builder mode only. 404 when the run or the
 * image is not there.
 */
export function createPhotoCleanupFileRoutes(svc: PhotoCleanupService): Hono {
    const app = new Hono();
    app.get('/photo-cleanup/:courseId/:jobId/:hole/:file', requireAuth(), async (c) => {
        const kind = c.req.param('file').replace(/\.png$/, '') as PhotoCleanupImage;
        const hole = Number(c.req.param('hole'));
        if (!PHOTO_CLEANUP_IMAGES.includes(kind) || !Number.isInteger(hole)) return c.json({ error: 'Not found' }, 404);
        try {
            const file = await svc.image(c.req.param('courseId'), c.req.param('jobId'), hole, kind);
            return new Response(Bun.file(file), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
        } catch (err) {
            if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
            throw err;
        }
    });
    return app;
}
