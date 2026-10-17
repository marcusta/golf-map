import { test, expect, describe, afterEach } from 'bun:test';
import { di, Signal } from '@basics/core/client/core';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { COURSE_SCOPE, FeaturesService, geometryToWgs84Rings, shiftBlock, moveBlockToEdge, OVERLAY_DIFF_MAX_FEATURES, hiddenTypesKey } from '../src/draw/features.service';
import type { GeoJSONSourceDiff } from 'maplibre-gl';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import { withBatchEndpoints, recordRequests } from './fake-feature-api';
import { surfaceStackStats } from '../../shared/render/resolved-surface-stack';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { Hole } from '../../shared/api/holes.gen';
import { ZoneTypesService } from '../src/zones/zone-types.service';
import type { ZoneTypesApi } from '../../shared/api/zone-types.gen';
import type { FeatureCollection, MultiPolygon } from 'geojson';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { stackKey } from '../../shared/render/stack-key';

afterEach(() => { _reset(); di.reset(); localStorage.clear(); });

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
                layer: input.layer ?? null,
                type: input.type,
                geometry: structuredClone(input.geometry),
                sortOrder: 0,
                source: input.source ?? null,
                generated: false,
                sourceRef: input.sourceRef ?? null,
                license: input.license ?? null,
                attributes: input.attributes ?? null,
                no: rows.size + 1,
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
            if (input.attributes !== undefined) row.attributes = input.attributes ?? null;
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
        imported: async () => [],
        removeImported: async () => ({ removed: 0 }),
        async reorder(input) {
            calls.reorder++;
            const scope = [...rows.values()].filter(f => f.courseId === input.courseId
                && f.holeId === (input.holeId ?? null) && (f.layer ?? null) === (input.layer ?? null));
            const scopeIds = new Set(scope.map(f => f.id));
            const wantedIds = new Set(input.orderedIds);
            if (scopeIds.size !== wantedIds.size || [...scopeIds].some(id => !wantedIds.has(id))) {
                throw new ApiError(409, 'Reorder scope mismatch');
            }
            input.orderedIds.forEach((id, i) => { rows.get(id)!.sortOrder = i; });
            return { ok: true };
        },
    };
    withBatchEndpoints(api, rows);
    return { api, rows, calls };
}

function feature(id: string, type = 'bunker', version = 1, opts: { holeId?: string | null; layer?: 'roughs' | null; sortOrder?: number } = {}): CourseFeature {
    return {
        id, courseId: 'c1', holeId: opts.holeId ?? null, layer: opts.layer ?? null, type,
        geometry: squareGeometry(), sortOrder: opts.sortOrder ?? 0,
        source: null, generated: false, sourceRef: null, license: null, attributes: null, no: null, version,
    };
}

describe('load', () => {
    test('vegetation zones, drawn and generated, show only while a mode lifts them (Vegetation)', async () => {
        const zone = (id: string, source: string | null, generated: boolean): CourseFeature => ({
            ...feature(id, 'vegetation_zone'), source, generated, attributes: { zoneType: 'rough_tall' },
        });
        const { api } = fakeApi([
            zone('g1', 'tall-grass', true), zone('h1', null, false), feature('b1', 'bunker'),
            { ...feature('t1', 'trees'), source: 'lidar-canopy', generated: true },
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        // Default view: the zones are off the map and out of hit tests, by type — no source eyes flipped.
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['b1']);
        expect(svc.generatedGeojson.get().features.map(f => f.id)).toEqual(['t1']);
        expect(svc.isHidden(svc.store.items.get().find(f => f.id === 'h1')!)).toBe(true);
        expect(svc.hiddenSources.get().size).toBe(0);

        svc.modeHiddenTypes.set(new Set());
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['h1', 'b1']);
        expect(svc.generatedGeojson.get().features.map(f => f.id).sort()).toEqual(['g1', 't1']);

        svc.resetModeView();
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['b1']);
    });

    test('mode-hidden types leave the map and hit tests but not the user\'s own eye toggles', async () => {
        const { api } = fakeApi([feature('b1', 'bunker'), feature('r1', 'penalty_red'), feature('o1', 'oob')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.modeHiddenTypes.set(new Set(['penalty_red', 'oob']));
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['b1']);
        expect(svc.isHidden(svc.store.items.get().find(f => f.id === 'r1')!)).toBe(true);
        expect(svc.hiddenTypes.get().size).toBe(0);

        svc.modeHiddenTypes.set(new Set());
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['b1', 'r1', 'o1']);
    });

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

    // T50 regression: importing into a course whose store never loaded
    // (⋯ → Import GeoJSON without ever activating the draw tool) used to
    // refresh via reload(), which no-ops when nothing is loaded — features
    // landed in the DB but nothing rendered until a full page reload.
    test('reloadOrLoad loads an unloaded store', async () => {
        const { api, calls } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);

        await svc.reloadOrLoad('c1'); // never load()ed — must NOT no-op
        expect(calls.list).toBe(1);
        expect(svc.store.items.get().map(f => f.id)).toEqual(['a', 'b']);
    });

    test('reloadOrLoad re-fetches an already-loaded course', async () => {
        const { api, calls, rows } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        rows.set('imported', feature('imported'));
        await svc.reloadOrLoad('c1'); // loaded → bypasses the per-course cache
        expect(calls.list).toBe(2);
        expect(svc.store.items.get().map(f => f.id)).toEqual(['a', 'imported']);
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

/**
 * Counting stand-in for MapService: records every hand-drawn overlay push
 * (addOverlayLayer counts as the initial send, updateOverlayData as re-sends).
 */
function countingMap() {
    const pushes: string[] = [];
    const map = {
        ready: new Signal(true),
        map: new Signal({ setPaintProperty() {}, setFilter() {}, getSource: () => ({ type: 'geojson' }) }),
        addOverlayLayer: () => {},
        updateOverlayData: (id: string) => { pushes.push(id); },
        removeOverlayLayer: () => {},
    };
    return { map, featurePushes: () => pushes.filter(id => id === 'features').length };
}

describe('update: overlay push count (review item 2a)', () => {
    test('drag commit (patchLocal + update with the same geometry) pushes the overlay exactly once', async () => {
        const { api, rows } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        // A drag happens in Draw mode; nice mode would follow up with the resolved stack.
        svc.niceRendering.set(false);
        const { map, featurePushes } = countingMap();
        const dispose = svc.attachOverlay(map as never);
        expect(featurePushes()).toBe(0);

        const moved = squareGeometry(10, base.x + 20, base.y);
        svc.patchLocal('a', moved);
        const result = await svc.update('a', { geometry: moved });

        expect(featurePushes()).toBe(1);
        expect(result?.version).toBe(2);
        // Local geometry object kept (flatten-cache hit), server has the same shape.
        expect(svc.store.items.peek().find(f => f.id === 'a')!.geometry).toBe(moved);
        expect(rows.get('a')!.geometry).toEqual(moved);
        dispose();
    });

    test('a type change pushes the overlay exactly once', async () => {
        const { api } = fakeApi([feature('a'), feature('b')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        const { map, featurePushes } = countingMap();
        const dispose = svc.attachOverlay(map as never);
        const geometryBefore = svc.store.items.peek()[0].geometry;

        await svc.update('a', { type: 'green' });

        expect(featurePushes()).toBe(1);
        expect(svc.geojson.get().features.find(f => f.id === 'a')!.properties!.type).toBe('green');
        expect(svc.store.items.peek()[0].geometry).toBe(geometryBefore);
        dispose();
    });

    test('version comes from the server reply and the next save uses it', async () => {
        const { api, rows } = fakeApi([feature('a', 'bunker', 7)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const g1 = squareGeometry(12);
        svc.patchLocal('a', g1);
        await svc.update('a', { geometry: g1 });
        expect(svc.store.items.peek()[0].version).toBe(8);

        const g2 = squareGeometry(14);
        svc.patchLocal('a', g2);
        const second = await svc.update('a', { geometry: g2 });
        expect(second?.version).toBe(9);
        expect(rows.get('a')!.version).toBe(9);
        expect(svc.saveError.get()).toBeNull();
    });

    test('a newer local patch landing while the save is in flight is not clobbered by the reply', async () => {
        const { api } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const g1 = squareGeometry(12);
        svc.patchLocal('a', g1);
        const pending = svc.update('a', { geometry: g1 });
        const g2 = squareGeometry(16);
        svc.patchLocal('a', g2); // next drag frame before the reply
        await pending;

        const row = svc.store.items.peek()[0];
        expect(row.geometry).toBe(g2);
        expect(row.version).toBe(2);
    });

    test('version conflict still sets saveError and reloads server truth', async () => {
        const { api, rows, calls } = fakeApi([feature('a', 'bunker', 1)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        rows.get('a')!.version = 5;
        rows.get('a')!.type = 'water';

        const g = squareGeometry(30);
        svc.patchLocal('a', g);
        const result = await svc.update('a', { geometry: g });

        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');
        await Bun.sleep(0);
        expect(calls.list).toBe(2);
        const row = svc.store.items.get()[0];
        expect(row.version).toBe(5);
        expect(row.type).toBe('water');
        expect(row.geometry.rings[0].points[0].x).toBeCloseTo(base.x - 10, 6); // local patch dropped
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

describe('nice rendering', () => {
    test('shows the plain surfaces at once and swaps in the resolved stack when it arrives', async () => {
        const fairway = { ...feature('fw', 'fairway'), geometry: squareGeometry(20) };
        const green = { ...feature('gr', 'green', 1, { sortOrder: 1 }), geometry: squareGeometry(5) };
        const { api } = fakeApi([fairway, green]);
        const svc = new FeaturesService(api, createInlineSurfaceStackClient());
        await svc.load('c1');
        const sent: FeatureCollection[] = [];
        const map = {
            ready: new Signal(false),
            map: new Signal(null),
            addOverlayLayer: (id: string, data: FeatureCollection) => { if (id === 'features') sent.push(data); },
            updateOverlayData: (id: string, data: FeatureCollection) => { if (id === 'features') sent.push(data); },
            removeOverlayLayer: () => {},
        };

        const dispose = svc.attachOverlay(map as never);
        map.ready.set(true);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toBe(svc.geojson.get()); // unresolved, no blocking clip

        await Bun.sleep(0);
        expect(sent).toHaveLength(2);
        const resolvedFairway = sent[1]!.features.find(f => f.id === 'fw')!;
        expect(resolvedFairway.geometry.type).toBe('MultiPolygon');
        // The green is punched out of the fairway: an outer ring plus a hole.
        expect((resolvedFairway.geometry as MultiPolygon).coordinates[0]).toHaveLength(2);

        // Draw mode goes back to the plain collection without another resolve.
        svc.niceRendering.set(false);
        expect(sent.at(-1)).toBe(svc.geojson.get());
        dispose();
    });

    test('creates a cold-start overlay with nice paint instead of briefly defaulting to Draw paint', () => {
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        let layers: Array<{ id: string; paint?: Record<string, unknown> }> = [];
        const map = {
            ready: new Signal(false),
            map: new Signal(null),
            // Two sources (hand-drawn + generated) — collect every layer.
            addOverlayLayer: (_id: string, _data: unknown, nextLayers: Array<{ id: string; paint?: Record<string, unknown> }>) => {
                layers = [...layers, ...nextLayers];
            },
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
        };

        const dispose = svc.attachOverlay(map as never);
        expect(layers).toHaveLength(0);

        map.ready.set(true);

        const fill = layers.find(layer => layer.id === 'features-fill')!;
        const outline = layers.find(layer => layer.id === 'features-outline')!;
        const rulesOutline = layers.find(layer => layer.id === 'features-rules-outline')!;
        expect(fill.paint?.['fill-opacity']).toEqual(['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0.4]);
        expect(outline.paint?.['line-opacity']).toEqual(['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0]);
        expect(rulesOutline.paint?.['line-opacity']).toEqual(['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0]);

        dispose();
    });

    // OOB is a white boundary line, not a surface: it is filtered out of the
    // fill layer, and its line is the one stroke nice mode keeps — with no
    // fill behind it, hiding the line would erase OOB from the planning view.
    test('OOB renders as an always-visible boundary line and never as a fill', () => {
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        let layers: Array<{ id: string; filter?: unknown; paint?: Record<string, unknown> }> = [];
        const map = {
            ready: new Signal(false),
            map: new Signal(null),
            addOverlayLayer: (_id: string, _data: unknown, nextLayers: Array<{ id: string; filter?: unknown; paint?: Record<string, unknown> }>) => {
                layers = [...layers, ...nextLayers];
            },
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
        };

        const dispose = svc.attachOverlay(map as never);
        map.ready.set(true);

        const outlineOnly = ['in', ['get', 'type'], ['literal', ['oob']]];
        const fill = layers.find(layer => layer.id === 'features-fill')!;
        const oobLine = layers.find(layer => layer.id === 'features-oob-line')!;
        const oobCasing = layers.find(layer => layer.id === 'features-oob-casing')!;
        const rulesOutline = layers.find(layer => layer.id === 'features-rules-outline')!;

        expect(fill.filter).toEqual(['!', outlineOnly]);
        expect(oobLine.filter).toEqual(outlineOnly);
        expect(oobCasing.filter).toEqual(outlineOnly);
        // The penalty outlines keep their own layer, without OOB in it.
        expect(rulesOutline.filter).toEqual(['in', ['get', 'type'], ['literal', ['penalty_yellow', 'penalty_red']]]);
        // Nice mode (the cold-start default) hides every other stroke; the
        // OOB line stays at full opacity, hidden only while it is dragged.
        expect(svc.niceRendering.peek()).toBe(true);
        expect(oobLine.paint?.['line-opacity']).toEqual(['case', ['boolean', ['feature-state', 'dragging'], false], 0, 1]);
        expect(oobLine.paint?.['line-width']).toBe(2);

        dispose();
    });

    test('a mode backdrop keeps only a faint outline of its types; the mode\'s own types keep Draw\'s paint', () => {
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        const paint = new Map<string, unknown>();
        const rawMap = {
            setPaintProperty(layer: string, property: string, value: unknown) { paint.set(`${layer}/${property}`, value); },
            setFilter: () => {},
            getSource: () => ({ type: 'geojson' }),
        };
        const map = {
            ready: new Signal(true),
            map: new Signal(rawMap),
            addOverlayLayer: () => {},
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
        };
        const dispose = svc.attachOverlay(map as never);
        const dragging = (v: unknown) => ['case', ['boolean', ['feature-state', 'dragging'], false], 0, v];
        const backdrop = (inBackdrop: number, own: number) =>
            ['case', ['in', ['get', 'type'], ['literal', ['green', 'fairway']]], inBackdrop, own];

        svc.niceRendering.set(false);
        svc.modeBackdropTypes.set(new Set(['green', 'fairway']));
        expect(paint.get('features-fill/fill-opacity')).toEqual(dragging(backdrop(0, 0.86)));
        expect(paint.get('features-outline/line-opacity')).toEqual(dragging(backdrop(0.7, 1)));
        expect(paint.get('features-generated-fill/fill-opacity')).toEqual(backdrop(0, 0.86));
        expect(paint.get('features-generated-outline/line-opacity')).toEqual(backdrop(0.7, 1));

        svc.resetModeView();
        expect(paint.get('features-fill/fill-opacity')).toEqual(dragging(0.4));
        expect(paint.get('features-generated-fill/fill-opacity')).toBe(0.4);

        dispose();
    });

    test('blends the proven fill layer with the photo while all feature strokes stay hidden', () => {
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        const paintCalls: Array<{ layer: string; property: string; value: unknown }> = [];
        const rawMap = {
            setPaintProperty(layer: string, property: string, value: unknown) {
                paintCalls.push({ layer, property, value });
            },
            setFilter: () => {},
            getSource: () => ({ type: 'geojson' }),
        };
        const map = {
            ready: new Signal(true),
            map: new Signal(rawMap),
            addOverlayLayer: () => {},
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
        };

        const dispose = svc.attachOverlay(map as never);

        expect(paintCalls.slice(-5).map(call => [call.layer, call.property, call.value])).toEqual([
            ['features-fill', 'fill-opacity', ['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0.4]],
            ['features-outline', 'line-opacity', ['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0]],
            ['features-rules-outline', 'line-opacity', ['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0]],
            ['features-generated-fill', 'fill-opacity', 0.4],
            ['features-generated-outline', 'line-opacity', 0],
        ]);

        svc.niceRendering.set(false);
        expect(paintCalls.slice(-5).map(call => [call.layer, call.property, call.value])).toEqual([
            ['features-fill', 'fill-opacity', ['case', ['boolean', ['feature-state', 'dragging'], false], 0, 0.86]],
            ['features-outline', 'line-opacity', ['case', ['boolean', ['feature-state', 'dragging'], false], 0, 1]],
            ['features-rules-outline', 'line-opacity', ['case', ['boolean', ['feature-state', 'dragging'], false], 0, 1]],
            ['features-generated-fill', 'fill-opacity', 0.86],
            ['features-generated-outline', 'line-opacity', 1],
        ]);

        dispose();
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

    test('hiding a single feature deselects it, showing it again does not reselect', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'green')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.setSelection(['a', 'b']);

        svc.toggleFeatureVisibility('a');
        expect([...svc.selectedIds.get()]).toEqual(['b']);
        expect(svc.hiddenIds.get().has('a')).toBe(true);

        svc.toggleFeatureVisibility('a'); // back on
        expect(svc.hiddenIds.get().has('a')).toBe(false);
        expect([...svc.selectedIds.get()]).toEqual(['b']);
    });
});

describe('Editor layer visibility', () => {
    const overlayMap = () => ({
        ready: new Signal(false),
        map: new Signal(null),
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
    });
    const ids = (svc: FeaturesService) => svc.geojson.get().features.map(f => f.id).sort();

    test('a hole eye hides all members only in the editor and preserves individual eyes', async () => {
        const { api, calls } = fakeApi([
            feature('a', 'bunker', 1, { holeId: 'h1' }),
            feature('b', 'green', 1, { holeId: 'h1' }),
            { ...feature('generated', 'trees', 1, { holeId: 'h1' }), source: 'lidar-canopy', generated: true },
            feature('other', 'fairway', 1, { holeId: 'h2' }),
            feature('course', 'rough'),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        const editor = svc.attachOverlay(overlayMap() as never, { editor: true });
        svc.toggleFeatureVisibility('a');
        svc.setSelection(['b', 'other']);
        svc.toggleHoleVisibility('h1');
        expect(ids(svc)).toEqual(['course', 'other']);
        expect(svc.generatedGeojson.get().features).toHaveLength(0);
        expect(svc.isHidden(svc.store.item('b').peek())).toBe(true);
        expect([...svc.selectedIds.get()]).toEqual(['other']);
        svc.select('b'); // hidden members cannot reappear through stack selection
        expect(svc.selectedIds.get().size).toBe(0);
        expect(calls.update + calls.remove + calls.create).toBe(0);

        const hidden = svc.effectiveHiddenIds.get();
        svc.patchLocal('other', squareGeometry(12));
        expect(svc.effectiveHiddenIds.get()).toBe(hidden); // geometry edits retain overlay diff eligibility
        const created = await svc.create({ holeId: 'h1', type: 'bunker', geometry: squareGeometry() });
        expect(svc.isHidden(created!)).toBe(true);
        expect(svc.selectedIds.get().size).toBe(0);
        expect(ids(svc)).toEqual(['course', 'other']);
        editor();

        const planner = svc.attachOverlay(overlayMap() as never);
        expect(ids(svc)).toEqual(['b', 'course', created!.id, 'other'].sort());
        expect(svc.generatedGeojson.get().features).toHaveLength(1);
        planner();

        const again = svc.attachOverlay(overlayMap() as never, { editor: true });
        expect(ids(svc)).toEqual(['course', 'other']);
        svc.toggleHoleVisibility('h1');
        expect(ids(svc)).toContain('b');
        expect(ids(svc)).not.toContain('a');
        expect([...svc.hiddenIds.get()]).toEqual(['a']);
        svc.toggleHoleVisibility('h1');
        svc.showAll();
        expect(svc.hiddenHoleIds.get().size).toBe(0);
        expect(ids(svc)).toContain('a');
        again();
    });

    test('hides the layer only while the editor owns the overlay; the planner still draws it', async () => {
        const { api } = fakeApi([feature('r', 'rough', 1, { layer: 'roughs' }), feature('b', 'bunker')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.setSelection(['r', 'b']);

        const editor = svc.attachOverlay(overlayMap() as never, { editor: true });
        svc.toggleRoughsLayerVisibility();
        expect(ids(svc)).toEqual(['b']);
        expect(svc.isHidden(svc.store.items.peek().find(f => f.id === 'r')!)).toBe(true);
        expect([...svc.selectedIds.get()]).toEqual(['b']); // invisible → not silently editable
        editor();

        // Planner: same service, no editor flag — every layer draws.
        const planner = svc.attachOverlay(overlayMap() as never);
        expect(ids(svc)).toEqual(['b', 'r']);
        planner();

        // Back in the editor the toggle still holds.
        const again = svc.attachOverlay(overlayMap() as never, { editor: true });
        expect(ids(svc)).toEqual(['b']);
        svc.toggleRoughsLayerVisibility();
        expect(ids(svc)).toEqual(['b', 'r']);
        again();
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

    test('hidden individual features are filtered from the geojson', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'bunker')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.toggleFeatureVisibility('b');
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['a']);

        svc.toggleFeatureVisibility('b'); // back on
        expect(svc.geojson.get().features).toHaveLength(2);
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

    test('stackKey (D28): Roughs rank 0, hole rank = hole number, course-level on top', async () => {
        withHoleNumbers([{ id: 'h1', number: 1 }, { id: 'h2', number: 7 }]);
        const { api } = fakeApi([
            feature('r', 'rough', 1, { holeId: null, layer: 'roughs', sortOrder: 4 }),
            feature('a', 'fairway', 1, { holeId: null, sortOrder: 3 }),
            feature('b', 'fairway', 1, { holeId: 'h1', sortOrder: 2 }),
            feature('c', 'fairway', 1, { holeId: 'h2', sortOrder: 5 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const byId = (id: string) => svc.geojson.get().features.find(f => f.id === id)!;
        expect(byId('r').properties!.stackKey).toBe(0 * 4096 + 4);
        expect(byId('a').properties!.stackKey).toBe(1023 * 4096 + 3);
        expect(byId('b').properties!.stackKey).toBe(1 * 4096 + 2);
        expect(byId('c').properties!.stackKey).toBe(7 * 4096 + 5);
    });
});

describe('stackFor / stackTopDown (D23 ordered accessors)', () => {
    test('stackFor groups by scope and orders ascending by sortOrder', async () => {
        withHoleNumbers([{ id: 'h1', number: 1 }]);
        const { api } = fakeApi([
            feature('roughs-rough', 'rough', 1, { holeId: null, layer: 'roughs', sortOrder: 0 }),
            feature('course-top', 'path', 1, { holeId: null, sortOrder: 1 }),
            feature('course-bottom', 'rough', 1, { holeId: null, sortOrder: 0 }),
            feature('hole-feature', 'fairway', 1, { holeId: 'h1', sortOrder: 0 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        expect(svc.stackFor(COURSE_SCOPE).map(f => f.id)).toEqual(['course-bottom', 'course-top']);
        expect(svc.stackFor({ holeId: 'h1', layer: null }).map(f => f.id)).toEqual(['hole-feature']);
        expect(svc.stackFor({ holeId: null, layer: 'roughs' }).map(f => f.id)).toEqual(['roughs-rough']);
    });

    test('stackTopDown orders the whole course topmost-first: course-level, holes by descending number, Roughs last', async () => {
        withHoleNumbers([{ id: 'h1', number: 1 }, { id: 'h2', number: 2 }]);
        const { api } = fakeApi([
            feature('roughs', 'rough', 1, { holeId: null, layer: 'roughs', sortOrder: 99 }), // high local sortOrder, still bottom group
            feature('course', 'path', 1, { holeId: null, sortOrder: 0 }), // low local sortOrder, still top group
            feature('hole1', 'fairway', 1, { holeId: 'h1', sortOrder: 0 }),
            feature('hole2', 'fairway', 1, { holeId: 'h2', sortOrder: 0 }),
        ]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        expect(svc.stackTopDown.get().map(f => f.id)).toEqual(['course', 'hole2', 'hole1', 'roughs']);
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
        expect(svc.stackFor(COURSE_SCOPE).map(f => f.id)).toEqual(['b', 'a']);
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
        expect(svc.stackFor(COURSE_SCOPE).map(f => f.id)).toEqual(['c', 'a', 'b']);
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
        expect(svc.stackFor(COURSE_SCOPE).map(f => f.id)).toEqual(['a', 'b']); // reverted to server truth
    });
});

describe('imported vs generated editability', () => {
    /**
     * Wizard-imported features (fetch-hydro waters, fetch-osm roads) carry
     * provenance but are ordinary shapes: vertex editing, move/retype and
     * stack reorder must all work on them. Only the pipeline's bulk-replace
     * output (`generated: true`) is read-only.
     */
    test('provenance alone does not lock a feature', async () => {
        const water: CourseFeature = { ...feature('w1', 'water', 1, { sortOrder: 0 }), source: 'lantmateriet-hydrografi', sourceRef: 'x/1' };
        const road: CourseFeature = { ...feature('r1', 'path', 1, { sortOrder: 1 }), source: 'osm', sourceRef: 'way/9', license: 'ODbL' };
        const { api } = fakeApi([water, road]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.selectedIds.set(new Set(['w1']));
        expect(svc.editableSelected.get()?.id).toBe('w1'); // vertex handles, edge insertion, offset/simplify
        svc.selectedIds.set(new Set(['w1', 'r1']));
        expect(svc.editableSelectedFeatures.get().map(f => f.id)).toEqual(['w1', 'r1']); // move / retype / rehole
        expect(svc.generatedFeatures.get()).toEqual([]); // rendered in the editable overlay

        expect(await svc.raise(['w1'])).toBe(true);
        expect(svc.stackFor(COURSE_SCOPE).map(f => f.id)).toEqual(['r1', 'w1']);
    });

    test('generated rows stay read-only', async () => {
        const tree: CourseFeature = { ...feature('t1', 'trees', 1, { sortOrder: 0 }), source: 'lidar-canopy', generated: true };
        const { api } = fakeApi([tree, feature('b', 'bunker', 1, { sortOrder: 1 })]);
        const svc = new FeaturesService(api);
        await svc.load('c1');

        svc.selectedIds.set(new Set(['t1']));
        expect(svc.editableSelected.get()).toBeNull();
        expect(svc.editableSelectedFeatures.get()).toEqual([]);
        expect(svc.generatedFeatures.get().map(f => f.id)).toEqual(['t1']);
        expect(await svc.raise(['t1'])).toBe(false);
    });
});

describe('hasOdblFeatures (T49)', () => {
    test('true only while an ODbL-licensed feature is loaded', async () => {
        const odbl: CourseFeature = { ...feature('osm1', 'water'), source: 'osm', sourceRef: 'way/1', license: 'ODbL' };
        const { api } = fakeApi([feature('a'), odbl]);
        const svc = new FeaturesService(api);
        expect(svc.hasOdblFeatures.get()).toBe(false); // nothing loaded yet

        await svc.load('c1');
        expect(svc.hasOdblFeatures.get()).toBe(true);

        // Removing the ODbL feature drops the course's ODbL posture live.
        await svc.removeFeature('osm1');
        expect(svc.hasOdblFeatures.get()).toBe(false);
    });

    test('non-ODbL licenses do not trigger it', async () => {
        const ccby: CourseFeature = { ...feature('lm1', 'water'), source: 'lantmateriet-marktacke', license: 'CC BY 4.0' };
        const { api } = fakeApi([ccby]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        expect(svc.hasOdblFeatures.get()).toBe(false);
    });
});

describe('vegetation zones (docs/feature-vegetation-zones.md)', () => {
    /** A ZoneTypesService holding one course's table, with no network behind it. */
    function withZoneTypes(types: Array<{ key: string; name: string; color: string }>): ZoneTypesService {
        const svc = new ZoneTypesService({
            list: async () => [],
            addDefaults: async () => [],
            create: () => Promise.reject(new Error('not under test')),
            update: () => Promise.reject(new Error('not under test')),
            remove: () => Promise.reject(new Error('not under test')),
            reorder: () => Promise.reject(new Error('not under test')),
        } as unknown as ZoneTypesApi);
        svc.items.set(types.map((z, i) => ({
            id: `z${i}`, courseId: 'c1', key: z.key, name: z.name, color: z.color,
            textureIndex: 0, channel: i, sortOrder: i, items: [], variants: [], createdAt: '', updatedAt: '',
        })));
        di.set(ZoneTypesService, svc);
        return svc;
    }

    test('a new zone gets the table’s first type with the default weight/feather/noise', async () => {
        withHoleNumbers([]);
        withZoneTypes([{ key: 'rough_tall', name: 'Tall rough', color: '#8a9a3c' }]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const created = await svc.create({ type: 'vegetation_zone', geometry: squareGeometry() });
        expect(created!.attributes).toEqual({
            zoneType: 'rough_tall', zoneVariant: '', weight: 1, feather: 2, noise: 0, blend: 'replace', extraPalettes: '',
        });
    });

    test('an empty zone-type table still names a zone type (the fallback key)', async () => {
        withHoleNumbers([]);
        withZoneTypes([]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const created = await svc.create({ type: 'vegetation_zone', geometry: squareGeometry() });
        expect((created!.attributes as Record<string, unknown>).zoneType).toBe('shrub');
    });

    test('explicit attributes are forwarded untouched; other types get none', async () => {
        withHoleNumbers([]);
        withZoneTypes([{ key: 'rough_tall', name: 'Tall rough', color: '#8a9a3c' }]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');

        const zone = await svc.create({
            type: 'vegetation_zone',
            geometry: squareGeometry(),
            attributes: { zoneType: 'fern', weight: 0.4, feather: 6, noise: 1 },
        });
        expect(zone!.attributes).toEqual({ zoneType: 'fern', weight: 0.4, feather: 6, noise: 1 });

        const bunker = await svc.create({ type: 'bunker', geometry: squareGeometry() });
        expect(bunker!.attributes).toBeNull();
    });

    test('update round-trips the four keys', async () => {
        withHoleNumbers([]);
        withZoneTypes([{ key: 'shrub', name: 'Shrubs', color: '#6b8f3a' }]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');
        const zone = (await svc.create({ type: 'vegetation_zone', geometry: squareGeometry() }))!;

        const updated = await svc.update(zone.id, {
            attributes: { zoneType: 'shrub', weight: 0.25, feather: 8, noise: 2 },
        });
        expect(updated!.attributes).toEqual({ zoneType: 'shrub', weight: 0.25, feather: 8, noise: 2 });
        expect(svc.store.items.get().find(f => f.id === zone.id)!.attributes)
            .toEqual({ zoneType: 'shrub', weight: 0.25, feather: 8, noise: 2 });
    });

    test('the rendered GeoJSON carries the zone type and its colour', async () => {
        withHoleNumbers([]);
        withZoneTypes([{ key: 'shrub', name: 'Shrubs', color: '#6b8f3a' }]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');
        await svc.create({ type: 'vegetation_zone', geometry: squareGeometry() });
        await svc.create({ type: 'bunker', geometry: squareGeometry() });
        svc.modeHiddenTypes.set(new Set()); // as in Vegetation mode

        const [zone, bunker] = svc.geojson.get().features;
        expect(zone.properties!.zoneType).toBe('shrub');
        expect(zone.properties!.zoneColor).toBe('#6b8f3a');
        // A zone type the table does not know has no colour to paint with.
        expect(bunker.properties!.zoneType).toBeUndefined();
        expect(bunker.properties!.zoneColor).toBeUndefined();
    });

    test('a path carries its surface for the map; an unknown or invalid one is left out', async () => {
        withHoleNumbers([]);
        withZoneTypes([]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');
        await svc.create({ type: 'path', geometry: squareGeometry(), attributes: { surface: 'gravel' } });
        await svc.create({ type: 'path', geometry: squareGeometry() });
        await svc.create({ type: 'path', geometry: squareGeometry(), attributes: { surface: 'lava' } });
        await svc.create({ type: 'bunker', geometry: squareGeometry(), attributes: { surface: 'gravel' } });

        const [gravel, unknown, invalid, bunker] = svc.geojson.get().features;
        expect(gravel.properties!.surface).toBe('gravel');
        expect(unknown.properties!.surface).toBeUndefined();
        expect(invalid.properties!.surface).toBeUndefined();
        expect(bunker.properties!.surface).toBeUndefined();
    });

    test('a zone with a variant carries its key; the fill stays the type colour', async () => {
        withHoleNumbers([]);
        withZoneTypes([{ key: 'shrub', name: 'Shrubs', color: '#6b8f3a' }]);
        const { api } = fakeApi();
        const svc = new FeaturesService(api);
        await svc.load('c1');
        await svc.create({
            type: 'vegetation_zone', geometry: squareGeometry(),
            attributes: { zoneType: 'shrub', zoneVariant: 'dense', weight: 1, feather: 2, noise: 0 },
        });
        await svc.create({ type: 'vegetation_zone', geometry: squareGeometry() });
        svc.modeHiddenTypes.set(new Set()); // as in Vegetation mode

        const [withVariant, byDefault] = svc.geojson.get().features;
        expect(withVariant.properties!.zoneVariant).toBe('dense');
        expect(withVariant.properties!.zoneColor).toBe('#6b8f3a');
        expect(byDefault.properties!.zoneVariant).toBeUndefined();
        expect(byDefault.properties!.zoneColor).toBe('#6b8f3a');
    });
});

/** Five features on the fake server, the service loaded, overlay and requests counted. */
async function countedService(n = 5) {
    const initial = Array.from({ length: n }, (_, i) => feature(`f${i}`, 'bunker', 1, { sortOrder: i }));
    const fake = fakeApi(initial);
    const { api, log } = recordRequests(fake.api);
    const svc = new FeaturesService(api);
    await svc.load('c1');
    log.length = 0;
    const { map, featurePushes } = countingMap();
    const dispose = svc.attachOverlay(map as never);
    return { svc, rows: fake.rows, log, featurePushes, dispose };
}

describe('multi-feature ops: one push, one request (review item 3)', () => {
    test('move of 5 (updateMany, local first) pushes once and sends one updateMany', async () => {
        const { svc, rows, log, featurePushes, dispose } = await countedService();
        const items = svc.store.items.peek().map(f => ({ id: f.id, patch: { geometry: squareGeometry(10, base.x + 40, base.y) } }));

        const pending = svc.updateMany(items, { local: true });
        expect(featurePushes()).toBe(1); // local patch lands before the request
        const result = await pending;

        expect(result).toHaveLength(5);
        expect(featurePushes()).toBe(1);
        expect(log).toEqual(['updateMany']);
        for (const { id, patch } of items) {
            const row = svc.store.items.peek().find(f => f.id === id)!;
            expect(row.version).toBe(2);
            expect(row.geometry).toBe(patch.geometry); // local object kept
            expect(rows.get(id)!.geometry).toEqual(patch.geometry);
        }
        dispose();
    });

    test('delete of 5 (removeMany) pushes once and sends one removeMany', async () => {
        const { svc, rows, log, featurePushes, dispose } = await countedService();
        svc.setSelection(['f0', 'f1']);

        const ok = await svc.removeMany(svc.store.items.peek().map(f => f.id));

        expect(ok).toBe(true);
        expect(featurePushes()).toBe(1);
        expect(log).toEqual(['removeMany']);
        expect(rows.size).toBe(0);
        expect(svc.store.items.peek()).toHaveLength(0);
        expect(svc.selectedIds.peek().size).toBe(0);
        dispose();
    });

    test('retype of 3 pushes once and sends one updateMany', async () => {
        const { svc, rows, log, featurePushes, dispose } = await countedService(3);
        await svc.updateMany(['f0', 'f1', 'f2'].map(id => ({ id, patch: { type: 'green' } })), { local: true });
        expect(featurePushes()).toBe(1);
        expect(log).toEqual(['updateMany']);
        expect([...rows.values()].map(r => r.type)).toEqual(['green', 'green', 'green']);
        dispose();
    });

    test('createMany of 3 pushes once, sends one createMany, selects the new rows', async () => {
        const { svc, log, featurePushes, dispose } = await countedService(1);
        const created = await svc.createMany([0, 1, 2].map(i => ({
            courseId: 'c1', holeId: null, type: 'bunker', geometry: squareGeometry(5, base.x + i * 30, base.y),
        })));
        expect(created).toHaveLength(3);
        expect(featurePushes()).toBe(1);
        expect(log).toEqual(['createMany']);
        expect([...svc.selectedIds.peek()]).toEqual(created!.map(f => f.id));
        dispose();
    });

    test('createMany with select: false leaves the selection alone', async () => {
        const { svc, dispose } = await countedService(1);
        svc.select('f0');
        await svc.createMany([{ courseId: 'c1', holeId: null, type: 'bunker', geometry: squareGeometry(5) }], { select: false });
        expect([...svc.selectedIds.peek()]).toEqual(['f0']);
        dispose();
    });

    test('a conflict on one row rejects the whole batch: nothing written, server truth reloaded', async () => {
        const { svc, rows, dispose } = await countedService(3);
        rows.get('f1')!.version = 4; // another client saved f1
        const result = await svc.updateMany(['f0', 'f1', 'f2'].map(id => ({ id, patch: { type: 'green' } })), { local: true });
        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');
        expect([...rows.values()].map(r => r.type)).toEqual(['bunker', 'bunker', 'bunker']);
        await Bun.sleep(0);
        expect(svc.store.items.peek().map(f => f.type)).toEqual(['bunker', 'bunker', 'bunker']);
        dispose();
    });
});

describe('per-feature save queue (review item 4)', () => {
    test('3 quick geometry patches send at most 2 requests and the final geometry', async () => {
        const { svc, rows, log, dispose } = await countedService(1);
        const geoms = [12, 14, 16].map(h => squareGeometry(h));
        const saves = geoms.map(g => { svc.patchLocal('f0', g); return svc.update('f0', { geometry: g }); });
        expect(svc.store.items.peek()[0].geometry).toBe(geoms[2]); // patchLocal stays instant

        const results = await Promise.all(saves);

        expect(log.length).toBeLessThanOrEqual(2);
        expect(rows.get('f0')!.geometry).toEqual(geoms[2]);
        expect(svc.store.items.peek()[0].geometry).toBe(geoms[2]);
        expect(results.every(r => r?.id === 'f0')).toBe(true);
        expect(svc.saveError.get()).toBeNull();
        dispose();
    });

    test('with no debounce, patches arriving during an in-flight save coalesce into one follow-up', async () => {
        const { svc, rows, log, dispose } = await countedService(1);
        svc.geometryDebounceMs = 0;
        const geoms = [12, 14, 16].map(h => squareGeometry(h));
        const saves = geoms.map(g => { svc.patchLocal('f0', g); return svc.update('f0', { geometry: g }); });
        await Promise.all(saves);

        expect(log).toEqual(['update', 'update']);
        expect(rows.get('f0')!.version).toBe(3); // second request used the first reply's version
        expect(rows.get('f0')!.geometry).toEqual(geoms[2]);
        expect(svc.saveError.get()).toBeNull();
        dispose();
    });

    test('rapid un-awaited commits of mixed kinds never 409', async () => {
        const { svc, rows, dispose } = await countedService(3);
        svc.geometryDebounceMs = 0;
        const g = squareGeometry(20);
        const all = [
            svc.update('f0', { geometry: g }),
            svc.update('f0', { type: 'green' }),
            svc.updateMany(['f0', 'f1'].map(id => ({ id, patch: { holeId: 'h1' } })), { local: true }),
            svc.update('f1', { geometry: g }),
            svc.updateMany(['f0', 'f1', 'f2'].map(id => ({ id, patch: { type: 'fairway' } })), { local: true }),
            svc.removeMany(['f2']),
        ];
        await Promise.all(all);
        await svc.flush();

        expect(svc.saveError.get()).toBeNull();
        expect(rows.get('f0')).toMatchObject({ type: 'fairway', holeId: 'h1', geometry: g });
        expect(rows.get('f1')).toMatchObject({ type: 'fairway', holeId: 'h1', geometry: g });
        expect(rows.has('f2')).toBe(false);
        for (const id of ['f0', 'f1']) {
            expect(svc.store.items.peek().find(f => f.id === id)!.version).toBe(rows.get(id)!.version);
        }
        dispose();
    });

    test('a type patch goes immediately and carries a pending geometry with it', async () => {
        const { svc, rows, log, dispose } = await countedService(1);
        svc.geometryDebounceMs = 10_000;
        const g = squareGeometry(18);
        svc.patchLocal('f0', g);
        const geomSave = svc.update('f0', { geometry: g });
        const typeSave = svc.update('f0', { type: 'green' });
        await Promise.all([geomSave, typeSave]);

        expect(log).toEqual(['update']);
        expect(rows.get('f0')).toMatchObject({ type: 'green', geometry: g, version: 2 });
        dispose();
    });

    test('flush() sends a debounced patch at once and resolves when the queue is empty', async () => {
        const { svc, rows, log, dispose } = await countedService(1);
        svc.geometryDebounceMs = 10_000;
        const g = squareGeometry(22);
        svc.patchLocal('f0', g);
        void svc.update('f0', { geometry: g });
        expect(log).toEqual([]); // geometry patch waits out the debounce

        await svc.flush();

        expect(log).toEqual(['update']);
        expect(rows.get('f0')).toMatchObject({ geometry: g, version: 2 });
        dispose();
    });

    test('load() of another course flushes pending saves first', async () => {
        const { svc, rows, dispose } = await countedService(1);
        svc.geometryDebounceMs = 10_000;
        const g = squareGeometry(24);
        svc.patchLocal('f0', g);
        void svc.update('f0', { geometry: g });

        await svc.load('c2');

        expect(rows.get('f0')!.geometry).toEqual(g);
        dispose();
    });
});

/**
 * MapService stand-in that records every overlay send with its optional
 * updateData diff, the addOverlayLayer options, and every raw-map call that
 * selection could make (setFilter, setFeatureState, removeFeatureState).
 */
function recordingMap() {
    const sends: Array<{ id: string; data: { features: unknown[] }; diff?: GeoJSONSourceDiff }> = [];
    const addOpts: Array<{ id: string; opts: Record<string, unknown> | undefined }> = [];
    const rawCalls: Array<[string, ...unknown[]]> = [];
    const raw = {
        setPaintProperty() {},
        setFilter: (...args: unknown[]) => { rawCalls.push(['setFilter', ...args]); },
        setFeatureState: (target: unknown, state: unknown) => { rawCalls.push(['setFeatureState', target, state]); },
        removeFeatureState: (target: unknown, key: unknown) => { rawCalls.push(['removeFeatureState', target, key]); },
        getSource: () => ({ type: 'geojson' }),
    };
    const map = {
        ready: new Signal(true),
        map: new Signal(raw),
        addOverlayLayer: (id: string, _data: unknown, _layers: unknown, opts?: Record<string, unknown>) => { addOpts.push({ id, opts }); },
        updateOverlayData: (id: string, data: { features: unknown[] }, diff?: GeoJSONSourceDiff) => { sends.push({ id, data, diff }); },
        removeOverlayLayer: () => {},
    };
    const featureSends = () => sends.filter(s => s.id === 'features');
    return { map, sends, featureSends, addOpts, rawCalls };
}

/** n features with distinct sortOrder (unique stackKeys), loaded, Draw mode, overlay attached. */
async function diffService(n: number) {
    const initial = Array.from({ length: n }, (_, i) => feature(`f${i}`, 'bunker', 1, { sortOrder: i }));
    const fake = fakeApi(initial);
    const svc = new FeaturesService(fake.api);
    await svc.load('c1');
    svc.niceRendering.set(false);
    const rec = recordingMap();
    const dispose = svc.attachOverlay(rec.map as never);
    return { svc, ...rec, dispose };
}

describe('overlay updateData diffs (review item 2b)', () => {
    test('both feature sources promote the string id property', async () => {
        const { addOpts, dispose } = await diffService(2);
        expect(addOpts.find(a => a.id === 'features')!.opts).toMatchObject({ promoteId: 'id' });
        expect(addOpts.find(a => a.id === 'features-generated')!.opts).toMatchObject({ promoteId: 'id' });
        dispose();
    });

    test('a geometry edit of one feature out of 100 sends a one-entry diff with only the new geometry', async () => {
        const { svc, featureSends, dispose } = await diffService(100);
        const before = svc.geojson.get();
        const moved = squareGeometry(10, base.x + 30, base.y);
        svc.patchLocal('f7', moved);

        const sends = featureSends();
        expect(sends).toHaveLength(1);
        const { diff, data } = sends[0]!;
        expect(data).toBe(svc.geojson.get());
        expect(diff).toEqual({ update: [{ id: 'f7', newGeometry: svc.geojson.get().features[7]!.geometry }] });
        expect(diff!.update![0]!.newGeometry).toBe(svc.geojson.get().features[7]!.geometry);
        // Unchanged rows keep their Feature objects.
        expect(svc.geojson.get().features[3]).toBe(before.features[3]);
        dispose();
    });

    test('a type change sends the full property set and no geometry', async () => {
        const { svc, featureSends, dispose } = await diffService(10);
        svc.patchLocal('f2', svc.store.items.peek()[2]!.geometry); // no-op patch: same render signature
        expect(featureSends()).toHaveLength(0);
        await svc.update('f2', { type: 'green' });
        const diff = featureSends()[0]!.diff!;
        expect(diff.update).toHaveLength(1);
        expect(diff.update![0]!.newGeometry).toBeUndefined();
        expect(diff.update![0]!.addOrUpdateProperties).toContainEqual({ key: 'type', value: 'green' });
        expect(diff.update![0]!.addOrUpdateProperties).toContainEqual({ key: 'stackKey', value: stackKey(null, null, 2, 'green') });
        dispose();
    });

    test('create and delete send add and remove diffs', async () => {
        // The fake server numbers created rows f1, f2, ... at sortOrder 0,
        // so the loaded rows use other ids and sortOrders from 1.
        const initial = Array.from({ length: 5 }, (_, i) => feature(`k${i}`, 'bunker', 1, { sortOrder: i + 1 }));
        const svc = new FeaturesService(fakeApi(initial).api);
        await svc.load('c1');
        svc.niceRendering.set(false);
        const { map, featureSends } = recordingMap();
        const dispose = svc.attachOverlay(map as never);
        const created = await svc.create({ type: 'green', geometry: squareGeometry(5) });
        const addDiff = featureSends().at(-1)!.diff!;
        expect(addDiff.add?.map(f => f.id)).toEqual([created!.id]);

        await svc.removeFeature('k1');
        expect(featureSends().at(-1)!.diff).toEqual({ remove: ['k1'] });
        dispose();
    });

    test('more than OVERLAY_DIFF_MAX_FEATURES changed features fall back to a full setData', async () => {
        const { svc, featureSends, dispose } = await diffService(OVERLAY_DIFF_MAX_FEATURES + 5);
        const shifted = squareGeometry(10, base.x + 50, base.y);
        await svc.updateMany(svc.store.items.peek().map(f => ({ id: f.id, patch: { geometry: shifted } })), { local: true });
        const sends = featureSends();
        expect(sends).toHaveLength(1);
        expect(sends[0]!.diff).toBeUndefined();
        expect(sends[0]!.data.features).toHaveLength(OVERLAY_DIFF_MAX_FEATURES + 5);
        dispose();
    });

    test('an edited feature that shares its stackKey falls back to setData (worker reorder)', async () => {
        const initial = [feature('a', 'bunker', 1, { sortOrder: 3 }), feature('b', 'bunker', 1, { sortOrder: 3 })];
        const svc = new FeaturesService(fakeApi(initial).api);
        await svc.load('c1');
        svc.niceRendering.set(false);
        const { map, featureSends } = recordingMap();
        const dispose = svc.attachOverlay(map as never);
        svc.patchLocal('a', squareGeometry(10, base.x + 30, base.y));
        expect(featureSends()).toHaveLength(1);
        expect(featureSends()[0]!.diff).toBeUndefined();
        dispose();
    });

    test('nice mode, hidden-type toggles and reloads send full setData', async () => {
        const { svc, featureSends, dispose } = await diffService(5);
        svc.hiddenIds.set(new Set(['f4']));
        expect(featureSends()).toHaveLength(1);
        expect(featureSends().at(-1)!.diff).toBeUndefined();

        const before = featureSends().length;
        await svc.reload();
        // Reloaded rows carry new geometry objects: one full set.
        expect(featureSends()).toHaveLength(before + 1);
        expect(featureSends().at(-1)!.diff).toBeUndefined();
        svc.patchLocal('f0', squareGeometry(10, base.x + 30, base.y));
        // The edit after a reload diffs against the reloaded collection.
        expect(featureSends().at(-1)!.diff).toBeDefined();

        svc.niceRendering.set(true);
        svc.patchLocal('f1', squareGeometry(10, base.x + 40, base.y));
        expect(featureSends().at(-1)!.diff).toBeUndefined();

        // Back to Draw: the first send after nice mode must be a full set.
        svc.niceRendering.set(false);
        expect(featureSends().at(-1)!.diff).toBeUndefined();
        svc.patchLocal('f2', squareGeometry(10, base.x + 50, base.y));
        expect(featureSends().at(-1)!.diff).toBeDefined();
        dispose();
    });
});

describe('nice-mode surface stack resolve on tool switches (review item 10)', () => {
    /**
     * n disjoint features (50 m apart), loaded, overlay attached in Draw
     * mode. DrawToolService flips `niceRendering` false on activate and
     * true on deactivate; the tests drive the flag the same way. The stack
     * is resolved off the calling thread (here: the inline client, on a
     * later tick), so each step waits for it with `settle`.
     */
    async function drawSession(n: number) {
        const initial = Array.from({ length: n }, (_, i) => ({
            ...feature(`f${i}`, 'bunker', 1, { sortOrder: i }),
            geometry: squareGeometry(10, base.x + i * 50, base.y),
        }));
        const svc = new FeaturesService(fakeApi(initial).api, createInlineSurfaceStackClient());
        await svc.load('c1');
        svc.niceRendering.set(false);
        const rec = recordingMap();
        const dispose = svc.attachOverlay(rec.map as never);
        return { svc, ...rec, dispose };
    }
    const work = () => ({ resolves: surfaceStackStats.resolves, clips: surfaceStackStats.clips });
    const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

    test('switching tools back and forth with no edit resolves the stack once in total', async () => {
        const { svc, dispose } = await drawSession(6);
        const start = work();
        svc.niceRendering.set(true); // Draw -> Measure
        await settle();
        const afterFirst = work();
        expect(afterFirst.resolves - start.resolves).toBe(1);
        svc.niceRendering.set(false); // Measure -> Draw
        svc.niceRendering.set(true); // Draw -> Measure
        svc.niceRendering.set(false);
        svc.niceRendering.set(true);
        await settle();
        expect(work()).toEqual(afterFirst);
        dispose();
    });

    test('an edit followed by a switch resolves once and re-clips only the edited surface', async () => {
        const { svc, dispose } = await drawSession(6);
        svc.niceRendering.set(true);
        await settle();
        svc.niceRendering.set(false); // back in Draw, per-surface memo primed
        svc.patchLocal('f3', squareGeometry(10, base.x + 3 * 50 + 2, base.y));
        const before = work();
        svc.niceRendering.set(true);
        await settle();
        const after = work();
        expect(after.resolves - before.resolves).toBe(1);
        expect(after.clips - before.clips).toBe(1);
        dispose();
    });

    test('hiding a feature in nice mode re-sends without re-clipping', async () => {
        const { svc, featureSends, dispose } = await drawSession(6);
        svc.niceRendering.set(true);
        await settle();
        const sends = featureSends().length;
        const before = work();
        svc.hiddenIds.set(new Set(['f5']));
        await settle();
        // The plain collection at once, its resolved stack when it lands.
        expect(featureSends()).toHaveLength(sends + 2);
        expect(work().clips).toBe(before.clips);
        dispose();
    });
});

describe('selection via feature-state (review item 9)', () => {
    test('selecting sets feature-state only: no setFilter, no source data', async () => {
        const { svc, sends, rawCalls, dispose } = await diffService(5);
        const sendsBefore = sends.length;
        rawCalls.length = 0;

        svc.select('f1');
        expect(rawCalls.filter(c => c[0] === 'setFilter')).toHaveLength(0);
        expect(sends.length).toBe(sendsBefore);
        expect(rawCalls).toContainEqual(['setFeatureState', { source: 'features', id: 'f1' }, { selected: true }]);

        // Switching selection clears the previous id's state.
        rawCalls.length = 0;
        svc.select('f2');
        expect(rawCalls).toContainEqual(['removeFeatureState', { source: 'features', id: 'f1' }, 'selected']);
        expect(rawCalls).toContainEqual(['setFeatureState', { source: 'features', id: 'f2' }, { selected: true }]);
        expect(rawCalls.filter(c => c[0] === 'setFilter')).toHaveLength(0);
        expect(sends.length).toBe(sendsBefore);
        dispose();
    });

    test('multi-select adds state per id and only touches the changed ids', async () => {
        const { svc, rawCalls, dispose } = await diffService(5);
        svc.select('f1');
        rawCalls.length = 0;
        svc.selectedIds.set(new Set(['f1', 'f3']));
        const touched = rawCalls.filter(c => (c[1] as { source: string }).source === 'features');
        expect(touched).toEqual([['setFeatureState', { source: 'features', id: 'f3' }, { selected: true }]]);

        rawCalls.length = 0;
        svc.select(null);
        const cleared = rawCalls
            .filter(c => c[0] === 'removeFeatureState' && (c[1] as { source: string }).source === 'features')
            .map(c => (c[1] as { id: string }).id)
            .sort();
        expect(cleared).toEqual(['f1', 'f3']);
        dispose();
    });

    test('the selection line opacity reads the selected and dragging states', async () => {
        const { svc } = await diffService(1);
        let layers: Array<{ id: string; filter?: unknown; paint?: Record<string, unknown> }> = [];
        const map = {
            ready: new Signal(true),
            map: new Signal(null),
            addOverlayLayer: (_id: string, _data: unknown, next: typeof layers) => { layers = [...layers, ...next]; },
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
        };
        const dispose = svc.attachOverlay(map as never);
        const expected = [
            'case',
            ['boolean', ['feature-state', 'dragging'], false], 0,
            ['boolean', ['feature-state', 'selected'], false], 1,
            0,
        ];
        for (const id of ['features-selected', 'features-generated-selected']) {
            const layer = layers.find(l => l.id === id)!;
            expect(layer.filter).toBeUndefined();
            expect(layer.paint?.['line-opacity']).toEqual(expected);
        }
        dispose();
    });
});

describe('visibility keys (review item 27)', () => {
    test('toggleTypeHidden persists per course and load() restores it', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'green')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.toggleTypeHidden('bunker');
        expect([...svc.hiddenTypes.get()]).toEqual(['bunker']);
        expect(JSON.parse(localStorage.getItem(hiddenTypesKey('c1'))!)).toEqual(['bunker']);

        const fresh = new FeaturesService(api);
        await fresh.load('c1');
        expect([...fresh.hiddenTypes.get()]).toEqual(['bunker']);
        await fresh.load('c2');
        expect(fresh.hiddenTypes.get().size).toBe(0);

        svc.toggleTypeHidden('bunker');
        expect(localStorage.getItem(hiddenTypesKey('c1'))).toBeNull();
    });

    test('hiding a type drops its features from the selection', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'green')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.setSelection(['a', 'b']);
        svc.toggleTypeHidden('bunker');
        expect([...svc.selectedIds.get()]).toEqual(['b']);
    });

    test('soloType hides every other type; the second call restores the previous set', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'green'), feature('c', 'custom-type')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.toggleTypeHidden('green');

        svc.soloType('bunker');
        const hidden = svc.hiddenTypes.get();
        expect(hidden.has('bunker')).toBe(false);
        expect(hidden.has('green')).toBe(true);
        expect(hidden.has('custom-type')).toBe(true); // store-only types count too
        expect(hidden.has('water')).toBe(true); // palette types without features too

        svc.soloType('bunker');
        expect([...svc.hiddenTypes.get()]).toEqual(['green']);
    });

    test('soloType on another type while soloed switches the solo', async () => {
        const { api } = fakeApi([feature('a', 'bunker'), feature('b', 'green')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.soloType('bunker');
        svc.soloType('green');
        expect(svc.hiddenTypes.get().has('green')).toBe(false);
        expect(svc.hiddenTypes.get().has('bunker')).toBe(true);
    });

    test('hideSelected hides the selection and clears it; showAll clears every toggle', async () => {
        const { api } = fakeApi([feature('a'), feature('b'), feature('c')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.setSelection(['a', 'b']);
        svc.hideSelected();
        expect([...svc.hiddenIds.get()].sort()).toEqual(['a', 'b']);
        expect(svc.selectedIds.get().size).toBe(0);

        svc.toggleTypeHidden('green');
        svc.toggleSourceVisibility('lidar');
        svc.showAll();
        expect(svc.hiddenIds.get().size).toBe(0);
        expect(svc.hiddenTypes.get().size).toBe(0);
        expect(svc.hiddenSources.get().size).toBe(0);
        expect(localStorage.getItem(hiddenTypesKey('c1'))).toBeNull();
    });

    test('the Generated toggle hides every generated vegetation source and leaves the drawn zones', async () => {
        const zone = (id: string, source: string | null): CourseFeature => ({
            ...feature(id, 'vegetation_zone'), source, generated: source !== null, attributes: { zoneType: 'rough_tall' },
        });
        const tree: CourseFeature = { ...feature('t1', 'tree'), source: 'lidar-canopy', generated: true };
        const { api } = fakeApi([zone('h1', null), zone('g1', 'tall-grass'), zone('g2', 'creek-bank'), tree]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.modeHiddenTypes.set(new Set());   // as Vegetation mode does
        expect(svc.generatedVegetationSources.get()).toEqual(['creek-bank', 'tall-grass']);
        expect(svc.generatedVegetationShown.get()).toBe(true);

        svc.selectedIds.set(new Set(['h1', 'g1']));
        svc.setGeneratedVegetationShown(false);
        expect(svc.generatedVegetationShown.get()).toBe(false);
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['h1']);
        expect(svc.generatedGeojson.get().features.map(f => f.id)).toEqual(['t1']);   // other generated features stay
        expect([...svc.selectedIds.get()]).toEqual(['h1']);

        // one source back by its stack-panel eye: the toggle reads as shown again
        svc.toggleSourceVisibility('creek-bank');
        expect(svc.generatedVegetationShown.get()).toBe(true);
        svc.setGeneratedVegetationShown(true);
        expect(svc.hiddenSources.get().size).toBe(0);
        expect(svc.generatedGeojson.get().features.map(f => f.id).sort()).toEqual(['g1', 'g2', 't1']);
    });

    test('hideSelected with nothing selected changes nothing', async () => {
        const { api } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        const before = svc.hiddenIds.get();
        svc.hideSelected();
        expect(svc.hiddenIds.get()).toBe(before);
    });
});

describe('save status (pendingSaves, clearSaveError, reload)', () => {
    test('pendingSaves counts a debounced patch and an in-flight request, then returns to 0', async () => {
        const { api } = fakeApi([feature('a')]);
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const update = api.update;
        api.update = async input => { await gate; return update(input); };
        const svc = new FeaturesService(api);
        await svc.load('c1');
        svc.geometryDebounceMs = 10_000;
        expect(svc.pendingSaves.get()).toBe(0);

        const g = squareGeometry(15);
        svc.patchLocal('a', g);
        const save = svc.update('a', { geometry: g });
        expect(svc.pendingSaves.get()).toBe(1); // waiting out the debounce

        const flushed = svc.flush();
        await Bun.sleep(0);
        expect(svc.pendingSaves.get()).toBeGreaterThan(0); // request in flight
        release();
        await Promise.all([save, flushed]);
        expect(svc.pendingSaves.get()).toBe(0);
    });

    test('pendingSaves covers create and remove requests', async () => {
        const { api } = fakeApi([feature('a')]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        const removing = svc.removeFeature('a');
        expect(svc.pendingSaves.get()).toBe(1);
        await removing;
        expect(svc.pendingSaves.get()).toBe(0);
    });

    test('a failed save keeps saveError through the automatic re-sync; reload() clears it', async () => {
        const { api, rows } = fakeApi([feature('a', 'bunker', 1)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        rows.get('a')!.version = 2;

        await svc.update('a', { type: 'green' });
        await Bun.sleep(0);
        expect(svc.saveError.get()?.code).toBe('conflict');
        expect(svc.store.items.get()[0].version).toBe(2); // re-synced

        await svc.reload();
        expect(svc.saveError.get()).toBeNull();
    });

    test('reload() keeps saveError when the re-fetch fails', async () => {
        const { api, rows } = fakeApi([feature('a', 'bunker', 1)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        rows.get('a')!.version = 2;
        await svc.update('a', { type: 'green' });
        await Bun.sleep(0);

        api.listByCourse = () => Promise.reject(new ApiError(500, 'down'));
        await svc.reload();
        expect(svc.saveError.get()?.code).toBe('conflict');
    });

    test('clearSaveError dismisses the failure without a re-fetch', async () => {
        const { api, rows, calls } = fakeApi([feature('a', 'bunker', 1)]);
        const svc = new FeaturesService(api);
        await svc.load('c1');
        rows.get('a')!.version = 2;
        await svc.update('a', { type: 'green' });
        await Bun.sleep(0);
        const lists = calls.list;

        svc.clearSaveError();
        expect(svc.saveError.get()).toBeNull();
        expect(calls.list).toBe(lists);
    });
});
