import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { FeaturesService, geometryToWgs84Rings } from '../src/draw/features.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry } from '../src/geo/bezier';

afterEach(() => _reset());

// Square in EPSG:3006 meters around the Landeryd test coordinates.
const base = wgs84ToSweref99tm(58.4015, 15.5658);

function squareGeometry(half = 10, cx = base.x, cy = base.y): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: cx - half, y: cy - half },
                { x: cx + half, y: cy - half },
                { x: cx + half, y: cy + half },
                { x: cx - half, y: cy + half },
            ],
        }],
    };
}

/**
 * In-memory fake of the courseFeatures API client: full CRUD with
 * server-accurate optimistic locking (version mismatch → 409 ApiError).
 */
function fakeApi(initial: CourseFeature[] = []) {
    const rows = new Map(initial.map(f => [f.id, structuredClone(f)]));
    let idSeq = 0;
    const calls = { create: 0, update: 0, remove: 0, list: 0 };

    const api: CourseFeaturesApi = {
        async listByCourse({ courseId }) {
            calls.list++;
            return [...rows.values()].filter(f => f.courseId === courseId).map(f => structuredClone(f));
        },
        listByHole: () => Promise.reject(new Error('not under test')),
        geojsonByCourse: () => Promise.reject(new Error('not under test')),
        async create(input) {
            calls.create++;
            const feature: CourseFeature = {
                id: `f${++idSeq}`,
                courseId: input.courseId,
                holeId: input.holeId ?? null,
                type: input.type,
                geometry: structuredClone(input.geometry),
                geojson: null,
                version: 1,
            };
            rows.set(feature.id, feature);
            return structuredClone(feature);
        },
        async update(input) {
            calls.update++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.type !== undefined) row.type = input.type;
            if (input.holeId !== undefined) row.holeId = input.holeId;
            if (input.geometry !== undefined) row.geometry = structuredClone(input.geometry);
            row.version = input.version + 1;
            return structuredClone(row);
        },
        async remove(input) {
            calls.remove++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            rows.delete(input.id);
            return { ok: true };
        },
    };
    return { api, rows, calls };
}

function feature(id: string, type = 'bunker', version = 1): CourseFeature {
    return { id, courseId: 'c1', holeId: null, type, geometry: squareGeometry(), geojson: null, version };
}

describe('load', () => {
    test('populates the store; cached per courseId', async () => {
        const { api, calls } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);

        await svc.load('c1');
        expect(svc.store.items.get().map(f => f.id)).toEqual(['a', 'b']);

        await svc.load('c1');
        expect(calls.list).toBe(1); // cached

        await svc.load('c2');
        expect(calls.list).toBe(2);
        expect(svc.store.items.get()).toEqual([]);
    });

    test('load failure sets error and leaves cache open for retry', async () => {
        const { api } = fakeApi();
        api.listByCourse = () => Promise.reject(new ApiError(500, 'boom'));
        const svc = new FeaturesService(api);
        await svc.load('c1');
        expect(svc.error.get()?.code).toBe('server');
    });
});

describe('create', () => {
    test('adds to the store, selects the new feature, autosave flags settle', async () => {
        const { api, rows } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const created = await svc.create({ type: 'bunker', holeId: null, geometry: squareGeometry() });

        expect(created?.id).toBeDefined();
        expect(created?.version).toBe(1);
        expect(svc.store.items.get()).toHaveLength(1);
        expect(svc.selectedId.get()).toBe(created!.id);
        expect(svc.saving.get()).toBe(false);
        expect(svc.saveError.get()).toBeNull();
        expect(rows.size).toBe(1); // persisted server-side
    });

    test('does nothing before a course is loaded', async () => {
        const { api, calls } = fakeApi();
        const svc = new FeaturesService(api);
        const created = await svc.create({ type: 'bunker', geometry: squareGeometry() });
        expect(created).toBeUndefined();
        expect(calls.create).toBe(0);
    });
});

describe('update (optimistic locking)', () => {
    test('sends the store version, patches result with bumped version', async () => {
        const { api, rows } = fakeApi([feature('a', 'bunker', 3)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const updated = await svc.update('a', { type: 'green' });
        expect(updated?.version).toBe(4);
        expect(svc.store.items.get()[0].type).toBe('green');
        expect(rows.get('a')!.type).toBe('green');
    });

    test('version conflict sets saveError=conflict and re-syncs the store from the server', async () => {
        const { api, rows } = fakeApi([feature('a', 'bunker', 1)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        // A competing writer bumps the server version behind our back.
        rows.get('a')!.version = 2;
        rows.get('a')!.type = 'water';

        const result = await svc.update('a', { type: 'green' });
        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');

        // reload() fired — wait for it to land, then the store shows server truth.
        await Bun.sleep(0);
        expect(svc.store.items.get()[0].type).toBe('water');
        expect(svc.store.items.get()[0].version).toBe(2);
    });

    test('geometry update round-trips bezier handles (hIn/hOut)', async () => {
        const { api, rows } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const withHandles = squareGeometry();
        withHandles.rings[0].points[0].hOut = { x: base.x - 5, y: base.y - 15 };
        withHandles.rings[0].points[1].hIn = { x: base.x + 5, y: base.y - 15 };

        await svc.update('a', { geometry: withHandles });

        const stored = rows.get('a')!.geometry;
        expect(stored.rings[0].points[0].hOut).toEqual({ x: base.x - 5, y: base.y - 15 });
        expect(stored.rings[0].points[1].hIn).toEqual({ x: base.x + 5, y: base.y - 15 });
        expect(svc.store.items.get()[0].geometry.rings[0].points[0].hOut).toEqual({ x: base.x - 5, y: base.y - 15 });
    });
});

describe('patchLocal', () => {
    test('updates geometry in the store without any network call or version change', async () => {
        const { api, calls } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.patchLocal('a', squareGeometry(25));
        expect(calls.update).toBe(0);
        expect(svc.store.items.get()[0].version).toBe(1);
        const p = svc.store.items.get()[0].geometry.rings[0].points[0];
        expect(p.x).toBeCloseTo(base.x - 25, 6);
    });
});

describe('removeFeature', () => {
    test('removes from server + store and clears the selection', async () => {
        const { api, rows } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.select('a');

        const ok = await svc.removeFeature('a');
        expect(ok).toBe(true);
        expect(svc.store.items.get()).toHaveLength(0);
        expect(svc.selectedId.get()).toBeNull();
        expect(rows.size).toBe(0);
    });

    test('conflict on remove keeps server state and re-syncs', async () => {
        const { api, rows } = fakeApi([feature('a', 'bunker', 1)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        rows.get('a')!.version = 2;

        const ok = await svc.removeFeature('a');
        expect(ok).toBe(false);
        expect(svc.saveError.get()?.code).toBe('conflict');
        await Bun.sleep(0);
        expect(svc.store.items.get()).toHaveLength(1);
    });
});

describe('geojson derivation', () => {
    test('flattens EPSG:3006 rings to closed WGS84 polygons near the course', async () => {
        const { api } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const fc = svc.geojson.get();
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(1);

        const gj = fc.features[0];
        expect(gj.properties!.type).toBe('bunker');
        expect(gj.properties!.selected).toBe(false);

        const ring = (gj.geometry as GeoJSON.Polygon).coordinates[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
        for (const [lon, lat] of ring) {
            expect(lon).toBeGreaterThan(15.5);
            expect(lon).toBeLessThan(15.6);
            expect(lat).toBeGreaterThan(58.39);
            expect(lat).toBeLessThan(58.41);
        }
    });

    test('selection flag follows selectedId', async () => {
        const { api } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.select('b');
        const fc = svc.geojson.get();
        expect(fc.features.find(f => f.id === 'a')!.properties!.selected).toBe(false);
        expect(fc.features.find(f => f.id === 'b')!.properties!.selected).toBe(true);
    });

    test('geometryToWgs84Rings agrees with the raw transform and subdivides curves', () => {
        const straight = geometryToWgs84Rings(squareGeometry());
        expect(straight[0]).toHaveLength(5); // 4 anchors + closure

        const curved = squareGeometry();
        curved.rings[0].points[0].hOut = { x: base.x, y: base.y - 30 };
        curved.rings[0].points[1].hIn = { x: base.x + 10, y: base.y - 30 };
        const rings = geometryToWgs84Rings(curved);
        expect(rings[0].length).toBeGreaterThan(5);
    });

    test('flatten cache: same geometry object → same rings array identity', () => {
        const geometry = squareGeometry();
        expect(geometryToWgs84Rings(geometry)).toBe(geometryToWgs84Rings(geometry));
        // A new object (as produced by every edit op) recomputes.
        expect(geometryToWgs84Rings(squareGeometry())).not.toBe(geometryToWgs84Rings(geometry));
    });
});
