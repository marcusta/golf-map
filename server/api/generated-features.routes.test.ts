import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { mountApiRoutes } from '../routes';
import type { TestContext } from '../testing/db';

const PATH = `/api/courses/${TEST_COURSE_ID}/features/generated`;

function ring(cx: number, cy: number, half: number): number[][] {
    return [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]];
}

function tree(cx: number, cy: number, source = 'lidar-canopy') {
    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring(cx, cy, 4)] },
        properties: { type: 'trees', source, source_ref: `blob/${cx}`, license: 'CC0', heightMaxM: 17.5, areaM2: 64 },
    };
}

function body(features: unknown[], crs?: unknown) {
    return { type: 'FeatureCollection', ...(crs !== undefined ? { crs } : {}), features };
}

/**
 * Full `/api` mount on a bare Hono app. `authed` injects a session user the
 * way the framework's cookie middleware would, so `requireAuth()` passes.
 */
async function appFor(authed: boolean): Promise<{ app: Hono; ctx: TestContext }> {
    const ctx = await createTestDb(seedCourse);
    const app = new Hono();
    if (authed) {
        app.use('*', async (c, next) => {
            c.set('user', { id: 'user-1', username: 'tester' });
            await next();
        });
    }
    mountApiRoutes(app, ctx, { mode: 'builder', dataDir: '/tmp/golf-map-generated-features-test' });
    return { app, ctx };
}

function put(app: Hono, url: string, json: unknown, raw?: string) {
    return app.request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(json),
    });
}

describe('PUT /api/courses/:courseId/features/generated', () => {
    test('401 without a session', async () => {
        const { app } = await appFor(false);
        const res = await put(app, `${PATH}?source=lidar-canopy`, body([tree(0, 0)]));
        expect(res.status).toBe(401);
    });

    test('200 with { deleted, inserted }; a second call replaces the first', async () => {
        const { app, ctx } = await appFor(true);

        const first = await put(app, `${PATH}?source=lidar-canopy`, body([tree(0, 0), tree(20, 0)]));
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ deleted: 0, inserted: 2 });

        const second = await put(
            app,
            `${PATH}?source=lidar-canopy`,
            body([tree(40, 0)], { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } }),
        );
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ deleted: 2, inserted: 1 });

        const list = await app.request(`/api/features?courseId=${TEST_COURSE_ID}`);
        const features = (await list.json()) as Array<{ source: string | null; attributes: unknown; holeId: string | null }>;
        const lidar = features.filter((f) => f.source === 'lidar-canopy');
        expect(lidar).toHaveLength(1);
        expect(lidar[0].holeId).toBeNull();
        expect(lidar[0].attributes).toEqual({ heightMaxM: 17.5, areaM2: 64 });
        expect(features.length).toBe((await ctx.courseFeaturesService.listByCourse(TEST_COURSE_ID)).length);
    });

    test('400 cases: missing/blank source, source mismatch, wrong crs, non-Polygon, malformed JSON', async () => {
        const { app } = await appFor(true);

        const cases: Array<[string, unknown, string | undefined, RegExp]> = [
            [PATH, body([tree(0, 0)]), undefined, /source/],
            [`${PATH}?source=%20`, body([tree(0, 0)]), undefined, /source/],
            [`${PATH}?source=lidar-canopy`, body([tree(0, 0, 'osm')]), undefined, /source/],
            [`${PATH}?source=lidar-canopy`, body([tree(0, 0)], { type: 'name', properties: { name: 'EPSG:4326' } }), undefined, /crs/],
            [`${PATH}?source=lidar-canopy`, body([{ ...tree(0, 0), geometry: { type: 'Point', coordinates: [0, 0] } }]), undefined, /Polygon/],
            [`${PATH}?source=lidar-canopy`, null, '{not json', /JSON/],
            [`${PATH}?source=lidar-canopy`, { type: 'Feature' }, undefined, /FeatureCollection/],
        ];
        for (const [url, json, raw, msg] of cases) {
            const res = await put(app, url, json, raw);
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error: string }).error).toMatch(msg);
        }
        // None of the rejected calls wrote anything.
        const list = await app.request(`/api/features?courseId=${TEST_COURSE_ID}`);
        expect(((await list.json()) as Array<{ source: string | null }>).filter((f) => f.source !== null)).toHaveLength(0);
    });

    test('404 for an unknown course', async () => {
        const { app } = await appFor(true);
        const res = await put(app, '/api/courses/nope/features/generated?source=lidar-canopy', body([]));
        expect(res.status).toBe(404);
    });
});

describe('attributes on the feature create/update API', () => {
    test('create -> read -> update round-trip, null clears, nested value is a 400', async () => {
        const { app } = await appFor(true);
        const geometry = { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }] };

        const created = await app.request('/api/features/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry, attributes: { heightMaxM: 12, species: 'birch' } }),
        });
        expect(created.status).toBe(200);
        const feature = (await created.json()) as { id: string; version: number; attributes: unknown };
        expect(feature.attributes).toEqual({ heightMaxM: 12, species: 'birch' });

        // Clients that omit attributes still work and read back null.
        const plain = await app.request('/api/features/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry }),
        });
        expect(plain.status).toBe(200);
        expect(((await plain.json()) as { attributes: unknown }).attributes).toBeNull();

        const updated = await app.request('/api/features/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: feature.id, version: feature.version, attributes: { heightMaxM: 14 } }),
        });
        expect(updated.status).toBe(200);
        expect(((await updated.json()) as { attributes: unknown }).attributes).toEqual({ heightMaxM: 14 });

        const cleared = await app.request('/api/features/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: feature.id, version: feature.version + 1, attributes: null }),
        });
        expect(((await cleared.json()) as { attributes: unknown }).attributes).toBeNull();

        const nested = await app.request('/api/features/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry, attributes: { nested: { a: 1 } } }),
        });
        expect(nested.status).toBe(400);
    });
});
