/**
 * Serve-mode static hosting, assembled the way main.ts assembles it: API
 * routes, then tile routes, then the static/SPA fallback last. The mount order
 * is half the behaviour being tested — a fallback that swallowed /api would
 * look fine in isolation.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { createTestDb as createRawDb } from '@basics/core/server/testing';
import type { Database } from '../db/schema';
import { createServices } from './index';
import { mountApiRoutes } from '../routes';
import { createTileRoutes } from './tiles';
import { createStaticRoutes, resolveStaticFile, isMobileRoute } from './static';

const migrationFolder = path.join(import.meta.dir, '../db/migrations');

/** A minimal `web/dist`: the two html entries plus one hashed asset. */
function fakeDist(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'golf-dist-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>desktop</title>');
    writeFileSync(path.join(dir, 'mobile.html'), '<!doctype html><title>mobile</title>');
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'assets', 'main-abc123.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'favicon.ico'), 'icon');
    return dir;
}

/** The serve-mode app exactly as main.ts composes it. */
async function serveApp(distDir: string): Promise<Hono> {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'golf-data-'));
    const db = await createRawDb<Database>(migrationFolder);
    const services = createServices(db, { mode: 'serve', dataDir });
    const app = new Hono();
    mountApiRoutes(app, services, { mode: 'serve', dataDir });
    app.route('/', createTileRoutes(services.assetsService));
    app.route('/', createStaticRoutes(distDir));
    return app;
}

const HTML = { accept: 'text/html,application/xhtml+xml' };

describe('serve-mode static hosting', () => {
    test('serves real files with the right type and cache policy', async () => {
        const app = await serveApp(fakeDist());

        const js = await app.request('/assets/main-abc123.js');
        expect(js.status).toBe(200);
        expect(js.headers.get('content-type')).toContain('text/javascript');
        // Hashed filenames never change in place.
        expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(await js.text()).toBe('console.log(1)');

        const icon = await app.request('/favicon.ico');
        expect(icon.status).toBe(200);
        expect(icon.headers.get('cache-control')).toBe('no-cache');
    });

    test('the desktop entry answers / and its deep pushState routes', async () => {
        const app = await serveApp(fakeDist());

        for (const url of ['/', '/course/abc', '/planner', '/new']) {
            const res = await app.request(url, { headers: HTML });
            expect(res.status).toBe(200);
            expect(await res.text()).toContain('desktop');
            // Never cache the document: it names the hashed bundles.
            expect(res.headers.get('cache-control')).toBe('no-cache');
        }
    });

    test('/m and /m/* fall back to the mobile entry instead', async () => {
        const app = await serveApp(fakeDist());

        for (const url of ['/m', '/m/', '/m/course/abc/hole/3']) {
            const res = await app.request(url, { headers: HTML });
            expect(res.status).toBe(200);
            expect(await res.text()).toContain('mobile');
        }

        // A path that merely starts with the letter m is NOT the mobile app.
        const res = await app.request('/manage', { headers: HTML });
        expect(await res.text()).toContain('desktop');
    });

    test('/api and /tiles keep priority over the fallback', async () => {
        const app = await serveApp(fakeDist());

        const meta = await app.request('/api/meta', { headers: HTML });
        expect(meta.status).toBe(200);
        expect(await meta.json()).toMatchObject({ mode: 'serve' });

        // An unmounted builder API must still 404 as JSON, not render the app.
        const build = await app.request('/api/mapbuild/latest?courseId=x', { headers: HTML });
        expect(build.status).toBe(404);
        expect(build.headers.get('content-type') ?? '').not.toContain('text/html');

        // Tile routes answer (400 for a bad layer proves the route matched).
        const tile = await app.request('/tiles/site-1/nope/1/1/1.png', { headers: HTML });
        expect(tile.status).toBe(400);

        // A missing tile 404s from the tile route, not the SPA fallback.
        const missing = await app.request('/tiles/site-1/ortho/1/1/1.png', { headers: HTML });
        expect(missing.status).toBe(404);
        expect(missing.headers.get('content-type') ?? '').not.toContain('text/html');
    });

    test('a missing asset 404s rather than returning the app shell', async () => {
        const app = await serveApp(fakeDist());

        // Returning index.html here would surface as "Unexpected token '<'" in
        // the console — a deploy mistake disguised as a syntax error.
        for (const url of ['/assets/gone-000.js', '/logo.png', '/styles.css']) {
            const res = await app.request(url, { headers: HTML });
            expect(res.status).toBe(404);
        }
    });

    test('an un-built dist explains itself instead of crashing', async () => {
        const app = await serveApp(path.join(os.tmpdir(), 'golf-dist-does-not-exist'));

        const res = await app.request('/', { headers: HTML });
        expect(res.status).toBe(503);
        expect(await res.text()).toMatch(/bun run build/);

        // The API is unaffected — a missing web build must not take the box down.
        expect((await app.request('/api/meta')).status).toBe(200);
    });

    test('path traversal cannot escape the dist root', async () => {
        const dist = fakeDist();
        const secret = path.join(path.dirname(dist), 'secret.txt');
        writeFileSync(secret, 'topsecret');
        const app = await serveApp(dist);

        expect(resolveStaticFile(dist, '/../secret.txt')).toBe(null);
        expect(resolveStaticFile(dist, '/%2e%2e/secret.txt')).toBe(null);
        expect(resolveStaticFile(dist, '/assets/../../secret.txt')).toBe(null);
        // Still resolves the legitimate ones.
        expect(resolveStaticFile(dist, '/assets/main-abc123.js')).toBe(path.join(dist, 'assets', 'main-abc123.js'));

        const res = await app.request('/../secret.txt');
        expect(await res.text()).not.toContain('topsecret');
    });

    test('the mobile prefix matches the dev-server rule', () => {
        // Must agree with web/vite.config.ts `mobileSpaFallback`, which the
        // mobile app's pushState routes are written against.
        expect(isMobileRoute('/m')).toBe(true);
        expect(isMobileRoute('/m/')).toBe(true);
        expect(isMobileRoute('/m/course/1')).toBe(true);
        expect(isMobileRoute('/manage')).toBe(false);
        expect(isMobileRoute('/')).toBe(false);
    });
});
