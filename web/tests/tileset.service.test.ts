import { test, expect, afterEach } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import {
    TilesetService,
    parseTileManifest,
    deriveTileVersion,
} from '../src/map/tileset.service';
import type { AssetsApi, CourseAsset } from '../../shared/api/assets.gen';

afterEach(() => _reset());

const MANIFEST_JSON = JSON.stringify({
    courseId: 'c1',
    bounds: { west: 15.6954, south: 58.3431, east: 15.7489, north: 58.3712 },
    layers: {
        ortho: { minzoom: 14, maxzoom: 20 },
        terrain: { minzoom: 12, maxzoom: 17 },
    },
    elevation: { min: 53.28, max: 98.5 },
    generatedAt: '2026-07-04T08:28:59Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
});

function asset(courseId: string, kind: CourseAsset['kind'], metaJson: string | null): CourseAsset {
    return {
        id: `a-${kind}`,
        courseId,
        kind,
        filename: `tiles/${courseId}/manifest.json`,
        metaJson,
        version: 1,
        createdAt: '2026-07-04T00:00:00Z',
        updatedAt: '2026-07-04T00:00:00Z',
    };
}

function fakeAssetsApi(assetsByCourse: Record<string, CourseAsset[]>) {
    const reject = () => Promise.reject(new Error('not under test'));
    let listCalls = 0;
    const assetsApi: AssetsApi = {
        listByCourse: async ({ courseId }) => {
            listCalls++;
            return assetsByCourse[courseId] ?? [];
        },
        get: reject,
        register: reject,
        update: reject,
        remove: reject,
    };
    return { assetsApi, listCalls: () => listCalls };
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

test('load resolves manifest, bounds, hasTiles and tileVersion', async () => {
    const { assetsApi } = fakeAssetsApi({
        c1: [asset('c1', 'ortho_cog', null), asset('c1', 'tile_manifest', MANIFEST_JSON)],
    });
    const svc = new TilesetService(assetsApi);

    await svc.load('c1');

    expect(svc.hasTiles.get()).toBe(true);
    expect(svc.courseId.get()).toBe('c1');
    expect(svc.bounds.get()?.west).toBeCloseTo(15.6954);
    expect(svc.tileVersion.get()).toBe('20260704T082859Z');
    expect(svc.manifest.get()?.layers.terrain.maxzoom).toBe(17);
    expect(svc.error.get()).toBeNull();
});

test('course without tile_manifest loads gracefully with hasTiles false', async () => {
    const { assetsApi } = fakeAssetsApi({ c2: [asset('c2', 'svg_source', null)] });
    const svc = new TilesetService(assetsApi);

    await svc.load('c2');

    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.manifest.get()).toBeNull();
    expect(svc.bounds.get()).toBeNull();
    expect(svc.tileVersion.get()).toBeNull();
    expect(svc.courseId.get()).toBe('c2'); // loaded — just no tiles
    expect(svc.error.get()).toBeNull();
});

test('manifest asset with malformed metaJson is treated as no tiles', async () => {
    const { assetsApi } = fakeAssetsApi({ c3: [asset('c3', 'tile_manifest', '{broken')] });
    const svc = new TilesetService(assetsApi);

    await svc.load('c3');

    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.courseId.get()).toBe('c3');
    expect(svc.error.get()).toBeNull();
});

test('load is cached per courseId; a new id refetches and replaces signals', async () => {
    const { assetsApi, listCalls } = fakeAssetsApi({
        c1: [asset('c1', 'tile_manifest', MANIFEST_JSON)],
        c2: [],
    });
    const svc = new TilesetService(assetsApi);

    await svc.load('c1');
    await svc.load('c1');
    expect(listCalls()).toBe(1);

    await svc.load('c2');
    expect(listCalls()).toBe(2);
    expect(svc.hasTiles.get()).toBe(false);
    expect(svc.courseId.get()).toBe('c2');

    await svc.load('c1'); // back again — refetched, signals restored
    expect(listCalls()).toBe(3);
    expect(svc.hasTiles.get()).toBe(true);
});

test('load failure sets error, keeps courseId unset, and is not cached', async () => {
    let fail = true;
    const assetsApi = {
        ...fakeAssetsApi({}).assetsApi,
        listByCourse: async ({ courseId }: { courseId: string }) => {
            if (fail) throw new Error('boom');
            return [asset(courseId, 'tile_manifest', MANIFEST_JSON)];
        },
    };
    const svc = new TilesetService(assetsApi);

    await svc.load('c1');
    expect(svc.error.get()).not.toBeNull();
    expect(svc.courseId.get()).toBeNull();
    expect(svc.hasTiles.get()).toBe(false);

    fail = false;
    await svc.load('c1'); // retry hits the API again
    expect(svc.error.get()).toBeNull();
    expect(svc.hasTiles.get()).toBe(true);
});
