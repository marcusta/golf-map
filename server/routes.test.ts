import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Hono } from 'hono';
import { createTestDb as createRawDb } from '@basics/core/server/testing';
import { createServices } from './services/index';
import type { Database } from './db/schema';
import { mountApiRoutes } from './routes';

const migrationFolder = path.join(import.meta.dir, 'db/migrations');

async function appFor(mode: 'builder' | 'serve'): Promise<Hono> {
    const db = await createRawDb<Database>(migrationFolder);
    const services = createServices(db, { mode, dataDir: '/tmp/golf-map-routes-test' });
    const app = new Hono();
    mountApiRoutes(app, services, { mode, dataDir: '/tmp/golf-map-routes-test' });
    return app;
}

describe('mode-split API mounting (W1)', () => {
    test('serve mode: runtime APIs answer, meta reports mode, builder routes 404', async () => {
        const app = await appFor('serve');

        const meta = await app.request('/api/meta');
        expect(meta.status).toBe(200);
        expect(await meta.json()).toMatchObject({ name: 'golf-map', mode: 'serve' });

        // Builder-only routes are not mounted → 404 (not 401).
        const build = await app.request('/api/mapbuild/latest?courseId=x');
        expect(build.status).toBe(404);
        const publish = await app.request('/api/publish/status');
        expect(publish.status).toBe(404);

        // Ingest route IS mounted → 401 without a token (not 404).
        const ingest = await app.request('/api/ingest/site', { method: 'POST' });
        expect(ingest.status).toBe(401);
    });

    test('builder mode: builder routes mounted (401 unauth), ingest route absent (404)', async () => {
        const app = await appFor('builder');

        const meta = await app.request('/api/meta');
        expect(await meta.json()).toMatchObject({ mode: 'builder' });

        // Builder routes mounted → auth guard yields 401 (proves they are present).
        const build = await app.request('/api/mapbuild/latest?courseId=x');
        expect(build.status).toBe(401);
        const publish = await app.request('/api/publish/status');
        expect(publish.status).toBe(401);

        // Ingest route not mounted in builder mode → 404.
        const ingest = await app.request('/api/ingest/site', { method: 'POST' });
        expect(ingest.status).toBe(404);
    });
});
