import { test, expect, afterEach } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import {
    TilesetService,
    parseTileManifest,
    deriveTileVersion,
} from '../src/map/tileset.service';
import type { AssetsApi, CourseAsset } from '../../shared/api/assets.gen';
import type { CoursesApi, Course } from '../../shared/api/courses.gen';

afterEach(() => _reset());

const MANIFEST_JSON = JSON.stringify({
    bounds: { west: 15.6954, south: 58.3431, east: 15.7489, north: 58.3712 },
    layers: {
        ortho: { minzoom: 14, maxzoom: 20 },
        terrain: { minzoom: 12, maxzoom: 17 },
    },
    elevation: { min: 53.28, max: 98.5 },
    generatedAt: '2026-07-04T08:28:59Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
});

function asset(siteId: string, kind: CourseAsset['kind'], metaJson: string | null): CourseAsset {
    return {
        id: `a-${kind}`,
        courseId: 'owner',
        siteId,
        kind,
        filename: `tiles/${siteId}/manifest.json`,
        metaJson,
        version: 1,
        createdAt: '2026-07-04T00:00:00Z',
        updatedAt: '2026-07-04T00:00:00Z',
    };
}

function courseStub(id: string, siteId: string | null): Course {
    return {
        id, name: 'c', status: 'draft', revision: 0, crs: 'EPSG:3006',
        georeferenceJson: null, homeLat: null, homeLon: null, notes: null,
        siteId, version: 1, createdAt: '', updatedAt: '',
    };
}

/**
 * Fakes the course → site → assets resolution TilesetService now performs.
 * `courses` maps courseId → siteId; `assetsBySite` maps siteId → assets.
 * `courseCalls` counts course fetches (the per-courseId cache key).
 */
function fakeApis(courses: Record<string, string | null>, assetsBySite: Record<string, CourseAsset[]>) {
    const reject = () => Promise.reject(new Error('not under test'));
    let courseCalls = 0;
    const coursesApi = {
        get: async ({ id }: { id: string }) => {
            courseCalls++;
            if (!(id in courses)) throw new Error('no course');
            return courseStub(id, courses[id]);
        },
    } as unknown as CoursesApi;
    const assetsApi = {
        listBySite: async ({ siteId }: { siteId: string }) => assetsBySite[siteId] ?? [],
        listByCourse: reject,
        get: reject, register: reject, update: reject, remove: reject,
    } as unknown as AssetsApi;
    return { coursesApi, assetsApi, courseCalls: () => courseCalls };
}

// ── parseTileManifest ─────────────────────────────────────────────────────

test('parseTileManifest parses a real manifest', () => {
    const m = parseTileManifest(MANIFEST_JSON)!;
    expect(m.bounds).toEqual({ west: 15.6954, south: 58.3431, east: 15.7489, north: 58.3712 });
    expect(m.layers.ortho).toEqual({ minzoom: 14, maxzoom: 20 });
    expect(m.layers.terrain).toEqual({ minzoom: 12, maxzoom: 17 });
    expect(m.elevation).toEqual({ min: 53.28, max: 98.5 });
    expect(m.generatedAt).toBe('2026-07-04T08:28:59Z');
    expect(m.attribution).toBe('© Lantmäteriet, CC BY 4.0');
});

test('parseTileManifest returns null for null, invalid JSON, and missing fields', () => {
    expect(parseTileManifest(null)).toBeNull();
    expect(parseTileManifest(undefined)).toBeNull();
    expect(parseTileManifest('')).toBeNull();
    expect(parseTileManifest('not json{')).toBeNull();
    expect(parseTileManifest('42')).toBeNull();
    expect(parseTileManifest('{}')).toBeNull();
    expect(parseTileManifest(JSON.stringify({ bounds: { west: 1 } }))).toBeNull();
    // missing generatedAt → unusable (no cache version derivable)
    const noGeneratedAt = JSON.parse(MANIFEST_JSON);
    delete noGeneratedAt.generatedAt;
    expect(parseTileManifest(JSON.stringify(noGeneratedAt))).toBeNull();
});

// ── deriveTileVersion ─────────────────────────────────────────────────────

test('deriveTileVersion compacts generatedAt to URL-safe chars', () => {
    expect(deriveTileVersion('2026-07-04T08:28:59Z')).toBe('20260704T082859Z');
});

test('deriveTileVersion differs for different timestamps', () => {
    expect(deriveTileVersion('2026-07-04T08:28:59Z'))
        .not.toBe(deriveTileVersion('2026-07-04T08:29:00Z'));
});

// ── TilesetService ────────────────────────────────────────────────────────

test('load resolves manifest, bounds, hasTiles, tileVersion and mapKey (via site)', async () => {
    const { assetsApi, coursesApi } = fakeApis(
        { c1: 's1' },
        { s1: [asset('s1', 'ortho_cog', null), asset('s1', 'tile_manifest', MANIFEST_JSON)] },
    );
    const svc = new TilesetService(assetsApi, coursesApi);

    await svc.load('c1');

    expect(svc.hasTiles.get()).toBe(true);
    expect(svc.courseId.get()).toBe('c1');
    expect(svc.mapKey.get()).toBe('s1');
    expect(svc.bounds.get()?.west).toBeCloseTo(15.6954);
    expect(svc.tileVersion.get()).toBe('20260704T082859Z');
    expect(svc.manifest.get()?.layers.terrain.maxzoom).toBe(17);
    expect(svc.error.get()).toBeNull();
});

test('course with no site loads gracefully with hasTiles false and null mapKey', async () => {
    const { assetsApi, coursesApi } = fakeApis({ c2: null }, {});
    const svc = new TilesetService(assetsApi, coursesApi);

    await svc.load('c2');

    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.manifest.get()).toBeNull();
    expect(svc.mapKey.get()).toBeNull();
    expect(svc.courseId.get()).toBe('c2'); // loaded — just no map
    expect(svc.error.get()).toBeNull();
});

test('site without tile_manifest loads gracefully with hasTiles false', async () => {
    const { assetsApi, coursesApi } = fakeApis({ c2: 's2' }, { s2: [asset('s2', 'svg_source', null)] });
    const svc = new TilesetService(assetsApi, coursesApi);

    await svc.load('c2');

    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.mapKey.get()).toBe('s2');
    expect(svc.courseId.get()).toBe('c2');
    expect(svc.error.get()).toBeNull();
});

test('manifest asset with malformed metaJson is treated as no tiles', async () => {
    const { assetsApi, coursesApi } = fakeApis({ c3: 's3' }, { s3: [asset('s3', 'tile_manifest', '{broken')] });
    const svc = new TilesetService(assetsApi, coursesApi);

    await svc.load('c3');

    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.courseId.get()).toBe('c3');
    expect(svc.error.get()).toBeNull();
});

test('load is cached per courseId; a new id refetches and replaces signals', async () => {
    const { assetsApi, coursesApi, courseCalls } = fakeApis(
        { c1: 's1', c2: 's2' },
        { s1: [asset('s1', 'tile_manifest', MANIFEST_JSON)], s2: [] },
    );
    const svc = new TilesetService(assetsApi, coursesApi);

    await svc.load('c1');
    await svc.load('c1');
    expect(courseCalls()).toBe(1);

    await svc.load('c2');
    expect(courseCalls()).toBe(2);
    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.courseId.get()).toBe('c2');

    await svc.load('c1'); // back again — refetched, signals restored
    expect(courseCalls()).toBe(3);
    expect(svc.hasTiles.get()).toBe(true);
});

test('load failure sets error, keeps courseId unset, and is not cached', async () => {
    let fail = true;
    const coursesApi = {
        get: async ({ id }: { id: string }) => {
            if (fail) throw new Error('boom');
            return courseStub(id, 's1');
        },
    } as unknown as CoursesApi;
    const assetsApi = {
        listBySite: async () => [asset('s1', 'tile_manifest', MANIFEST_JSON)],
        listByCourse: () => Promise.reject(new Error('x')),
        get: () => Promise.reject(new Error('x')), register: () => Promise.reject(new Error('x')),
        update: () => Promise.reject(new Error('x')), remove: () => Promise.reject(new Error('x')),
    } as unknown as AssetsApi;
    const svc = new TilesetService(assetsApi, coursesApi);

    await svc.load('c1');
    expect(svc.error.get()).not.toBeNull();
    expect(svc.courseId.get()).toBeNull();
    expect(svc.hasTiles.get()).toBe(false);

    fail = false;
    await svc.load('c1'); // retry hits the API again
    expect(svc.error.get()).toBeNull();
    expect(svc.hasTiles.get()).toBe(true);
});
