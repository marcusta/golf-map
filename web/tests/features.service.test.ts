import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { FeaturesService, geometryToWgs84Rings, shiftBlock, moveBlockToEdge } from '../src/draw/features.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { Hole } from '../../shared/api/holes.gen';

afterEach(() => { _reset(); di.reset(); });

/** Registers a CourseDetailService with the given holes' numbers for stackKey (D24) tests. */
function withHoleNumbers(holes: Array<{ id: string; number: number }>): void {
    const svc = new CourseDetailService();
    svc.holeStore.set(holes.map(h => ({
        ...h, courseId: 'c1', par: 4, strokeIndex: null, notes: null, savedRegionJson: null,
        version: 1, createdAt: '', updatedAt: '',
    } satisfies Hole)));
    di.set(CourseDetailService, svc);
}

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
    const calls = { create: 0, update: 0, remove: 0, list: 0, reorder: 0 };

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
                sortOrder: 0,
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
        async reorder(input) {
            calls.reorder++;
            const scope = [...rows.values()].filter(f => f.courseId === input.courseId && f.holeId === (input.holeId ?? null));
            const scopeIds = new Set(scope.map(f => f.id));
            const wantedIds = new Set(input.orderedIds);
            if (scopeIds.size !== wantedIds.size || [...scopeIds].some(id => !wantedIds.has(id))) {
                throw new ApiError(409, 'Reorder scope mismatch');
            }
            input.orderedIds.forEach((id, i) => { rows.get(id)!.sortOrder = i; });
            return { ok: true };
        },
    };
    return { api, rows, calls };
}

function feature(id: string, type = 'bunker', version = 1, opts: { holeId?: string | null; sortOrder?: number } = {}): CourseFeature {
    return {
        id, courseId: 'c1', holeId: opts.holeId ?? null, type,
        geometry: squareGeometry(), geojson: null, sortOrder: opts.sortOrder ?? 0, version,
    };
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
        expect([...svc.selectedIds.get()]).toEqual([created!.id]);
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
        expect(svc.selectedIds.get().size).toBe(0);
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

describe('multi-select', () => {
    test('select replaces, toggleSelected adds/removes, setSelection replaces wholesale', async () => {
        const { api } = fakeApi([feature('a'), feature('b'), feature('c')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.select('a');
        expect([...svc.selectedIds.get()]).toEqual(['a']);

        svc.toggleSelected('b');
        expect([...svc.selectedIds.get()].sort()).toEqual(['a', 'b']);
        svc.toggleSelected('a');
        expect([...svc.selectedIds.get()]).toEqual(['b']);

        svc.setSelection(['a', 'c']);
        expect([...svc.selectedIds.get()].sort()).toEqual(['a', 'c']);

        svc.select(null);
        expect(svc.selectedIds.get().size).toBe(0);
    });

    test('`selected` is the feature only when EXACTLY one is selected', async () => {
        const { api } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.select('a');
        expect(svc.selected.get()?.id).toBe('a');
        expect(svc.selectedFeatures.get().map(f => f.id)).toEqual(['a']);

        svc.toggleSelected('b');
        expect(svc.selected.get()).toBeNull(); // multi → no single target
        expect(svc.selectedFeatures.get().map(f => f.id).sort()).toEqual(['a', 'b']);
    });

    test('removeFeature drops only the removed id from a multi-selection', async () => {
        const { api } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.setSelection(['a', 'b']);

        await svc.removeFeature('a');
        expect([...svc.selectedIds.get()]).toEqual(['b']);
    });

    test('hiding a type deselects features of that type', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'green')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.setSelection(['a', 'b']);

        svc.toggleTypeVisibility('bunker');
        expect([...svc.selectedIds.get()]).toEqual(['b']);
        expect(svc.hiddenTypes.get().has('bunker')).toBe(true);
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

        const ring = (gj.geometry as GeoJSON.Polygon).coordinates[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
        for (const [lon, lat] of ring) {
            expect(lon).toBeGreaterThan(15.5);
            expect(lon).toBeLessThan(15.6);
            expect(lat).toBeGreaterThan(58.39);
            expect(lat).toBeLessThan(58.41);
        }
    });

    test('selection does NOT rebuild the geojson (highlight is a layer filter)', async () => {
        // The FeatureCollection is ~20 MB for a full course and every
        // rebuild re-sends it to the MapLibre worker (~250 ms). Selection
        // must therefore never invalidate it — the features-selected layer
        // filter (attachOverlay) carries the highlight instead.
        const { api } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const before = svc.geojson.get();
        svc.select('b');
        expect(svc.geojson.get()).toBe(before); // identical object — no recompute
        expect(before.features[0].properties).not.toHaveProperty('selected');
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

    test('hidden types are filtered from the geojson (visibility toggles)', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'rough'), feature('c', 'rough')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.toggleTypeVisibility('rough');
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['a']);

        svc.toggleTypeVisibility('rough'); // back on
        expect(svc.geojson.get().features).toHaveLength(3);
    });

    test('patchLocal rebuilds the geojson with the moved coordinates', async () => {
        const { api } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const before = svc.geojson.get();
        const ringOfB = (fc: GeoJSON.FeatureCollection) =>
            (fc.features.find(f => f.id === 'b')!.geometry as GeoJSON.Polygon).coordinates[0];
        const beforeRingA = (before.features.find(f => f.id === 'a')!.geometry as GeoJSON.Polygon).coordinates[0];

        svc.patchLocal('b', squareGeometry(10, base.x + 20, base.y));
        const after = svc.geojson.get();

        expect(after).not.toBe(before); // store change → recompute
        expect(ringOfB(after)).not.toEqual(ringOfB(before)); // b moved east
        expect(ringOfB(after)[0][0]).toBeGreaterThan(ringOfB(before)[0][0]);
        // Untouched feature hits the identity flatten cache — same array.
        expect((after.features.find(f => f.id === 'a')!.geometry as GeoJSON.Polygon).coordinates[0]).toBe(beforeRingA);
    });

    test('setDragging is a safe no-op without an attached overlay', async () => {
        const { api } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        expect(() => svc.setDragging(['a'], true)).not.toThrow();
        expect(() => svc.setDragging(['a'], false)).not.toThrow();
    });

    test('flatten cache: same geometry object → same rings array identity', () => {
        const geometry = squareGeometry();
        expect(geometryToWgs84Rings(geometry)).toBe(geometryToWgs84Rings(geometry));
        // A new object (as produced by every edit op) recomputes.
        expect(geometryToWgs84Rings(squareGeometry())).not.toBe(geometryToWgs84Rings(geometry));
    });

    test('stackKey (D24): course-level rank 0, hole rank = hole number', async () => {
        withHoleNumbers([{ id: 'h1', number: 1 }, { id: 'h2', number: 7 }]);
        const { api } = fakeApi([
            feature('a', 'fairway', 1, { holeId: null, sortOrder: 3 }),
            feature('b', 'fairway', 1, { holeId: 'h1', sortOrder: 2 }),
            feature('c', 'fairway', 1, { holeId: 'h2', sortOrder: 5 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const byId = (id: string) => svc.geojson.get().features.find(f => f.id === id)!;
        expect(byId('a').properties!.stackKey).toBe(0 * 4096 + 3);
        expect(byId('b').properties!.stackKey).toBe(1 * 4096 + 2);
        expect(byId('c').properties!.stackKey).toBe(7 * 4096 + 5);
    });
});

describe('stackFor / stackTopDown (D23 ordered accessors)', () => {
    test('stackFor groups by holeId and orders ascending by sortOrder', async () => {
        withHoleNumbers([{ id: 'h1', number: 1 }]);
        const { api } = fakeApi([
            feature('course-top', 'path', 1, { holeId: null, sortOrder: 1 }),
            feature('course-bottom', 'rough', 1, { holeId: null, sortOrder: 0 }),
            feature('hole-feature', 'fairway', 1, { holeId: 'h1', sortOrder: 0 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        expect(svc.stackFor(null).map(f => f.id)).toEqual(['course-bottom', 'course-top']);
        expect(svc.stackFor('h1').map(f => f.id)).toEqual(['hole-feature']);
    });

    test('stackTopDown orders the whole course topmost-first: hole groups above course-level, higher hole number above lower', async () => {
        withHoleNumbers([{ id: 'h1', number: 1 }, { id: 'h2', number: 2 }]);
        const { api } = fakeApi([
            feature('course', 'rough', 1, { holeId: null, sortOrder: 99 }), // high local sortOrder, still bottom group
            feature('hole1', 'fairway', 1, { holeId: 'h1', sortOrder: 0 }),
            feature('hole2', 'fairway', 1, { holeId: 'h2', sortOrder: 0 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        expect(svc.stackTopDown.get().map(f => f.id)).toEqual(['hole2', 'hole1', 'course']);
    });
});

describe('shiftBlock / moveBlockToEdge (pure D27 reorder helpers)', () => {
    test('shiftBlock raises (dir=1) a single id past its neighbor, no-op at the top edge', () => {
        expect(shiftBlock(['a', 'b', 'c'], new Set(['a']), 1)).toEqual(['b', 'a', 'c']);
        expect(shiftBlock(['a', 'b', 'c'], new Set(['c']), 1)).toEqual(['a', 'b', 'c']); // already top
    });

    test('shiftBlock lowers (dir=-1) a single id past its neighbor, no-op at the bottom edge', () => {
        expect(shiftBlock(['a', 'b', 'c'], new Set(['c']), -1)).toEqual(['a', 'c', 'b']);
        expect(shiftBlock(['a', 'b', 'c'], new Set(['a']), -1)).toEqual(['a', 'b', 'c']); // already bottom
    });

    test('shiftBlock moves a multi-id block as a unit, preserving relative order', () => {
        expect(shiftBlock(['a', 'b', 'c', 'd'], new Set(['a', 'b']), 1)).toEqual(['c', 'a', 'b', 'd']);
        expect(shiftBlock(['a', 'b', 'c', 'd'], new Set(['c', 'd']), -1)).toEqual(['a', 'c', 'd', 'b']);
    });

    test('moveBlockToEdge moves the block to the top/bottom, preserving relative order', () => {
        expect(moveBlockToEdge(['a', 'b', 'c', 'd'], new Set(['b', 'd']), 'top')).toEqual(['a', 'c', 'b', 'd']);
        expect(moveBlockToEdge(['a', 'b', 'c', 'd'], new Set(['b', 'd']), 'bottom')).toEqual(['b', 'd', 'a', 'c']);
    });
});

describe('raise/lower/raiseToTop/lowerToBottom (D27 reorder ops)', () => {
    test('raise persists via the reorder endpoint and patches local sortOrder', async () => {
        const { api, rows } = fakeApi([
            feature('a', 'rough', 1, { sortOrder: 0 }),
            feature('b', 'fairway', 1, { sortOrder: 1 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const ok = await svc.raise(['a']);
        expect(ok).toBe(true);
        expect(svc.stackFor(null).map(f => f.id)).toEqual(['b', 'a']);
        expect(rows.get('a')!.sortOrder).toBe(1);
        expect(rows.get('b')!.sortOrder).toBe(0);
    });

    test('lowerToBottom moves the id to the bottom of its group', async () => {
        const { api } = fakeApi([
            feature('a', 'rough', 1, { sortOrder: 0 }),
            feature('b', 'fairway', 1, { sortOrder: 1 }),
            feature('c', 'bunker', 1, { sortOrder: 2 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        await svc.lowerToBottom(['c']);
        expect(svc.stackFor(null).map(f => f.id)).toEqual(['c', 'a', 'b']);
    });

    test('raiseToTop is a no-op (and does not call the endpoint) when already at the top', async () => {
        const { api, calls } = fakeApi([
            feature('a', 'rough', 1, { sortOrder: 0 }),
            feature('b', 'fairway', 1, { sortOrder: 1 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const ok = await svc.raiseToTop(['b']);
        expect(ok).toBe(true);
        expect(calls.reorder).toBe(0);
    });

    test('mixed-group ids are rejected without any local or server change', async () => {
        const { api, calls } = fakeApi([
            feature('a', 'rough', 1, { holeId: null, sortOrder: 0 }),
            feature('b', 'fairway', 1, { holeId: 'h1', sortOrder: 0 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const ok = await svc.raise(['a', 'b']);
        expect(ok).toBe(false);
        expect(calls.reorder).toBe(0);
        expect(svc.store.items.get().find(f => f.id === 'a')!.sortOrder).toBe(0);
    });

    test('server failure reverts the optimistic patch via reload()', async () => {
        const { api } = fakeApi([
            feature('a', 'rough', 1, { sortOrder: 0 }),
            feature('b', 'fairway', 1, { sortOrder: 1 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        api.reorder = () => Promise.reject(new ApiError(409, 'conflict'));

        const ok = await svc.raise(['a']);
        expect(ok).toBe(false);
        expect(svc.saveError.get()?.code).toBe('conflict');

        await Bun.sleep(0); // reload() fires async
        expect(svc.stackFor(null).map(f => f.id)).toEqual(['a', 'b']); // reverted to server truth
    });
});
