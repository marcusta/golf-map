import { test, expect, describe, afterEach } from 'bun:test';
import { di, Signal } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import {
    isGeneratedFeature,
    isEditableFeature,
    generatedBadgeLabel,
    generatedHeightLabel,
    generatedGroupLabel,
    groupStackRows,
    groupRowKey,
} from '../src/draw/generated-features';
import { FeaturesService, GENERATED_OVERLAY_ID, FEATURES_OVERLAY_ID } from '../src/draw/features.service';
import { containingTopDown } from '../src/draw/draw-tool.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry } from '../src/geo/bezier';

afterEach(() => { _reset(); di.reset(); });

const base = wgs84ToSweref99tm(58.4015, 15.5658);

/** Closed `n`-gon (EPSG:3006) of radius `r` around (cx, cy). */
function polygon(n: number, r: number, cx: number, cy: number): FeatureGeometry {
    const points = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return { crs: 'EPSG:3006', rings: [{ points }] };
}

function feature(id: string, opts: Partial<CourseFeature> = {}): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, type: 'bunker',
        geometry: polygon(4, 10, base.x, base.y), geojson: null, sortOrder: 0,
        source: null, sourceRef: null, license: null, attributes: null, version: 1,
        ...opts,
    };
}

function tree(id: string, sortOrder: number, extra: Partial<CourseFeature> = {}): CourseFeature {
    return feature(id, {
        type: 'trees', sortOrder, source: 'lidar-canopy',
        attributes: { heightMaxM: 17.2, heightP90M: 13.4, heightMeanM: 9.1, areaM2: 88 } as never,
        ...extra,
    });
}

/** Synthetic lidar canopy set: `count` polygons with `verts` vertices each, spread on a grid. */
function canopy(count: number, verts: number): CourseFeature[] {
    const out: CourseFeature[] = [];
    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
        const cx = base.x + (i % cols) * 25;
        const cy = base.y + Math.floor(i / cols) * 25;
        out.push(tree(`t${i}`, i, { geometry: polygon(verts, 6, cx, cy) }));
    }
    return out;
}

function listOnlyApi(rows: CourseFeature[]): CourseFeaturesApi {
    return {
        listByCourse: async () => rows.map(r => structuredClone(r)),
        listByHole: () => Promise.reject(new Error('not under test')),
        geojsonByCourse: () => Promise.reject(new Error('not under test')),
        create: () => Promise.reject(new Error('not under test')),
        update: () => Promise.reject(new Error('not under test')),
        remove: async () => ({ ok: true }),
        reorder: () => Promise.reject(new Error('not under test')),
    };
}

function withNoHoles(): void {
    const svc = new CourseDetailService();
    svc.holeStore.set([]);
    di.set(CourseDetailService, svc);
}

describe('generated / editable predicate', () => {
    test('non-null source is generated, null source is editable', () => {
        expect(isGeneratedFeature({ source: 'lidar-canopy' })).toBe(true);
        expect(isGeneratedFeature({ source: 'osm' })).toBe(true);
        expect(isGeneratedFeature({ source: null })).toBe(false);
        expect(isGeneratedFeature({ source: '' })).toBe(false);
        expect(isEditableFeature({ source: null })).toBe(true);
        expect(isEditableFeature({ source: 'lidar-canopy' })).toBe(false);
    });

    test('badge + height labels', () => {
        const t = tree('a', 0);
        expect(generatedBadgeLabel(t)).toBe('Generated from lidar');
        expect(generatedHeightLabel(t)).toBe('Height ~13 m');
        expect(generatedHeightLabel(tree('b', 0, { attributes: { areaM2: 3 } as never }))).toBeNull();
        expect(generatedHeightLabel(feature('c'))).toBeNull();
        expect(generatedBadgeLabel(feature('c'))).toBeNull();
        expect(generatedGroupLabel('trees', 'lidar-canopy')).toBe('Trees (lidar)');
    });
});

describe('stack grouping', () => {
    test('collapses generated rows of one source/type into a single group row at the topmost member', () => {
        const topDown = [feature('h2', { sortOrder: 5 }), tree('t3', 4), tree('t2', 3), feature('h1', { sortOrder: 2 }), tree('t1', 1)];
        const rows = groupStackRows(topDown, new Set());
        expect(rows.map(r => r.kind === 'group' ? `${r.key}:${r.count}` : r.key)).toEqual([
            'h2', `${groupRowKey('lidar-canopy', 'trees')}:3`, 'h1',
        ]);
        const group = rows[1]!;
        expect(group.kind === 'group' && group.ids).toEqual(['t3', 't2', 't1']);
    });

    test('lists only the selected generated feature under its group row', () => {
        const topDown = [tree('t3', 3), tree('t2', 2), feature('h1', { sortOrder: 1 }), tree('t1', 0)];
        const rows = groupStackRows(topDown, new Set(['t1']));
        expect(rows.map(r => r.key)).toEqual([groupRowKey('lidar-canopy', 'trees'), 't1', 'h1']);
    });

    test('2200 trees produce one row, not 2200', () => {
        const rows = groupStackRows(canopy(2200, 8).reverse(), new Set());
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind === 'group' && rows[0].count).toBe(2200);
    });
});

describe('FeaturesService generated set', () => {
    test('editableSelected is null for a generated selection; delete still works', async () => {
        withNoHoles();
        const svc = new FeaturesService(listOnlyApi([feature('h1'), tree('t1', 1)]));
        await svc.load('c1');
        svc.select('t1');
        expect(svc.selected.get()?.id).toBe('t1');
        expect(svc.editableSelected.get()).toBeNull();
        expect(svc.editableSelectedFeatures.get()).toEqual([]);
        svc.setSelection(['h1', 't1']);
        expect(svc.editableSelectedFeatures.get().map(f => f.id)).toEqual(['h1']);
        expect(await svc.removeFeature('t1')).toBe(true);
        expect(svc.store.items.get().map(f => f.id)).toEqual(['h1']);
    });

    test('reorder refuses generated rows', async () => {
        withNoHoles();
        const svc = new FeaturesService(listOnlyApi([feature('h1'), tree('t1', 1)]));
        await svc.load('c1');
        expect(await svc.raise(['t1'])).toBe(false);
    });

    test('hidden source drops from generatedGeojson, selection and hit-testing', async () => {
        withNoHoles();
        const svc = new FeaturesService(listOnlyApi([feature('h1'), tree('t1', 1)]));
        await svc.load('c1');
        svc.select('t1');
        svc.toggleSourceVisibility('lidar-canopy');
        expect(svc.selectedIds.get().size).toBe(0);
        expect(svc.generatedGeojson.get().features).toHaveLength(0);
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['h1']);
        const hits = containingTopDown(svc.stackTopDown.get(), new Set(), base, new Set(), svc.hiddenSources.get());
        expect(hits.map(f => f.id)).toEqual(['h1']);
        svc.toggleSourceVisibility('lidar-canopy');
        expect(svc.generatedGeojson.get().features).toHaveLength(1);
    });

    test('generated features are split out of the hand-drawn collection and cached across hand-drawn edits', async () => {
        withNoHoles();
        const trees = canopy(2200, 28); // ~61.6k vertices
        const svc = new FeaturesService(listOnlyApi([feature('h1'), ...trees]));
        // Computeds are eager: the generated collection is built inside load().
        const t0 = performance.now();
        await svc.load('c1');
        const buildMs = performance.now() - t0;
        const gen0 = svc.generatedGeojson.get();
        expect(gen0.features).toHaveLength(2200);
        expect(svc.geojson.get().features.map(f => f.id)).toEqual(['h1']);
        const rebuildsAfterLoad = svc.generatedRebuilds;

        // 50 hand-drawn vertex drags: generated collection identity must hold.
        const t1 = performance.now();
        for (let i = 0; i < 50; i++) {
            svc.patchLocal('h1', polygon(4, 10 + i, base.x, base.y));
            expect(svc.generatedGeojson.get()).toBe(gen0);
        }
        const editMs = performance.now() - t1;
        expect(svc.generatedRebuilds).toBe(rebuildsAfterLoad);

        // Deleting a tree changes the set: one rebuild.
        const t2 = performance.now();
        await svc.removeFeature('t7');
        const rebuildMs = performance.now() - t2;
        const gen1 = svc.generatedGeojson.get();
        expect(gen1).not.toBe(gen0);
        expect(gen1.features).toHaveLength(2199);
        expect(svc.generatedRebuilds).toBe(rebuildsAfterLoad + 1);

        // Numbers for the report (not asserted tightly — machine dependent).
        console.log(`[perf] load+build ${buildMs.toFixed(0)} ms for 2200 x 28 verts; 50 hand-drawn edits ${editMs.toFixed(1)} ms total (generated untouched); delete-triggered rebuild ${rebuildMs.toFixed(0)} ms`);
        expect(editMs).toBeLessThan(buildMs + 500);
    });

    test('attachOverlay sends the generated source only when the set changes', async () => {
        withNoHoles();
        const svc = new FeaturesService(listOnlyApi([feature('h1'), ...canopy(20, 8)]));
        await svc.load('c1');
        const updates: string[] = [];
        const added: string[] = [];
        const map = {
            ready: new Signal(true),
            map: new Signal({ setPaintProperty() {}, setFilter() {}, getSource: () => ({ type: 'geojson' }) }),
            addOverlayLayer: (id: string) => { added.push(id); },
            updateOverlayData: (id: string) => { updates.push(id); },
            removeOverlayLayer: () => {},
        };
        const dispose = svc.attachOverlay(map as never);
        expect(added).toEqual([FEATURES_OVERLAY_ID, GENERATED_OVERLAY_ID]);

        svc.patchLocal('h1', polygon(4, 12, base.x, base.y));
        svc.patchLocal('h1', polygon(4, 14, base.x, base.y));
        expect(updates.filter(id => id === FEATURES_OVERLAY_ID)).toHaveLength(2);
        expect(updates.filter(id => id === GENERATED_OVERLAY_ID)).toHaveLength(0);

        await svc.removeFeature('t3');
        expect(updates.filter(id => id === GENERATED_OVERLAY_ID)).toHaveLength(1);
        dispose();
    });
});
