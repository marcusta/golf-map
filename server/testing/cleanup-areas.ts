import { Hono } from 'hono';
import { mount } from '@basics/core/server/mount';
import { createCleanupAreasApi } from '../api/cleanup-areas.api';
import type { CleanupAreasService } from '../services/cleanup-areas.service';

/** Real HTTP routes with the user normally supplied by session middleware. */
export function cleanupAreasTestApp(service: CleanupAreasService) {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id: 'test-user', username: 'tester' }); await next(); });
    mount(app, '/api', createCleanupAreasApi(service));
    return app;
}
