import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService, sameScope, scopeOf } from '../src/draw/features.service';
import { UNION_ERRORS, UNION_MAX_DEVIATION_M, unionShapes } from '../src/draw/shape-union';
import { flattenRing, type FeatureGeometry } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Union in Draw: the pure `unionShapes` and the selection panel's
// `unionSelection` end-to-end against a fake API (one history entry, the
// first-selected shape survives).

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

/** A fake API that creates, updates and removes rows like the server. */
function fakeApi() {
    let n = 0;
    let rows: CourseFeature[] = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const api: CourseFeaturesApi = {
        listByCourse: async () => rows.map(row => ({ ...row })),
        listByHole: reject,
        geojsonByCourse: reject,
        create: async input => {
            n += 1;
            const scope = scopeOf({ holeId: input.holeId ?? null, layer: input.layer });
            const peers = rows.filter(row => sameScope(scopeOf(row), scope));
            const sortOrder = input.sortOrder ?? Math.max(-1, ...peers.map(row => row.sortOrder)) + 1;
            for (const peer of peers) if (peer.sortOrder >= sortOrder) peer.sortOrder++;
            const row = { attributes: null, ...input, ...scope, id: `f${n}`, version: 1, sortOrder } as CourseFeature;
            rows.push(row);
            return { ...row };
        },
        update: async ({ id, version, ...patch }) => {
            const row = rows.find(r => r.id === id)!;
            if (row.version !== version) throw new Error('version conflict');
            Object.assign(row, patch, { version: version + 1 });
            return { ...row };
        },
        remove: async ({ id }) => { rows = rows.filter(row => row.id !== id); return {} as never; },
        reorder: reject,
        imported: async () => [],
        removeImported: async () => ({ removed: 0 }),
        createMany: async ({ courseId, items }) => {
            const created: CourseFeature[] = [];
            for (const item of items) created.push(await api.create({ courseId, ...item }));
            return created.map(c => ({ ...rows.find(row => row.id === c.id)! }));
        },
        updateMany: async ({ items }) => Promise.all(items.map(item => api.update(item))),
        removeMany: async ({ items }) => {
            for (const item of items) await api.remove(item);
            return {} as never;
        },
    };
    return api;
}

function context(features: FeaturesService): ToolContext {
    const map = {
        ready: new Signal(false),
        map: new Signal(null),
        interactionMode: new Signal(DRAW_TOOL_ID),
        onClick: () => () => {},
        onMouseMove: () => () => {},
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
    };
    return {
        map: map as never,
        elevation: null as never,
        tileset: null as never,
        courseDetail: null as never,
        features,
        courseId: 'course-1',
        track: (d: () => void) => { cleanups.push(d); },
    };
}

async function loadedTool(): Promise<{ tool: DrawToolService; features: FeaturesService }> {
    di.set(ConfirmService, new ConfirmService());
    const features = new FeaturesService(fakeApi());
    await features.load('course-1');
    const tool = new DrawToolService();
    tool.activate(context(features));
    return { tool, features };
}

function square(minX: number, minY: number, size: number): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{ points: [
            { x: minX, y: minY },
            { x: minX + size, y: minY },
            { x: minX + size, y: minY + size },
            { x: minX, y: minY + size },
        ] }],
    };
}

/** A smooth B-spline blob: 12 controls on a circle. */
function blob(cx: number, cy: number, r: number): FeatureGeometry {
    const points = Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * 2 * Math.PI;
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    return { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points }] };
}

/** Area of the outer ring minus the holes, as drawn. */
function areaOf(geometry: FeatureGeometry): number {
    return geometry.rings.reduce((sum, ring, i) => {
        const pts = flattenRing(ring, 0.02, geometry.curveType);
        let a = 0;
        for (let k = 0; k < pts.length; k++) {
            const [x1, y1] = pts[k];
            const [x2, y2] = pts[(k + 1) % pts.length];
            a += x1 * y2 - x2 * y1;
        }
        return sum + (i === 0 ? 1 : -1) * Math.abs(a / 2);
    }, 0);
}

describe('unionShapes', () => {
    test('two overlapping polygons become one polygon with the union area', () => {
        const result = unionShapes([square(0, 0, 10), square(5, 0, 10)]);
        if ('error' in result) throw new Error(result.error);
        expect(result.geometry.curveType).toBeUndefined();
        expect(result.geometry.rings).toHaveLength(1);
        expect(result.geometry.rings[0].points).toHaveLength(4);
        expect(areaOf(result.geometry)).toBeCloseTo(150, 6);
    });

    test('two overlapping splines keep their own controls, with a corner where the outlines cross', () => {
        const a = blob(0, 0, 20);
        const b = blob(25, 5, 15);
        const result = unionShapes([a, b]);
        if ('error' in result) throw new Error(result.error);
        const points = result.geometry.rings[0].points;
        expect(result.geometry.curveType).toBe('bspline');
        expect(result.maxDeviation).toBeLessThanOrEqual(UNION_MAX_DEVIATION_M);
        expect(points.filter(p => p.corner)).toHaveLength(2);
        // About as many controls as the two shapes had, not a dense refit.
        expect(points.length).toBeLessThanOrEqual(a.rings[0].points.length + b.rings[0].points.length + 4);
        // The controls far from the crossings are exactly where they were drawn.
        const same = (p: { x: number; y: number }) => points.some(q => q.x === p.x && q.y === p.y);
        expect(same(a.rings[0].points[6])).toBe(true); // west side of a, away from b
        expect(same(b.rings[0].points[0])).toBe(true); // east side of b, away from a
        // Bigger than either shape, smaller than both together (they overlap).
        const area = areaOf(result.geometry);
        expect(area).toBeGreaterThan(areaOf(a));
        expect(area).toBeLessThan(areaOf(a) + areaOf(b));
    });

    test('a shape inside another leaves the outer one exactly as drawn', () => {
        const outer = blob(0, 0, 20);
        const result = unionShapes([outer, blob(2, 3, 5)]);
        if ('error' in result) throw new Error(result.error);
        expect(result.geometry.rings[0].points).toEqual(outer.rings[0].points);
    });

    test('a hole in a shape stays a hole', () => {
        const withHole: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [
                square(0, 0, 40).rings[0],
                { points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] },
            ],
        };
        const result = unionShapes([withHole, square(35, 0, 10)]);
        if ('error' in result) throw new Error(result.error);
        expect(result.geometry.rings).toHaveLength(2);
        expect(areaOf(result.geometry)).toBeCloseTo(1600 - 400 + 50, 6);
    });

    test('shapes that do not overlap, centerlines and a single shape are refused', () => {
        expect(unionShapes([square(0, 0, 10), square(100, 0, 10)])).toEqual({ error: 'disjoint' });
        expect(unionShapes([square(0, 0, 10)])).toEqual({ error: 'too-few' });
        const path: FeatureGeometry = {
            ...square(0, 0, 10),
            centerline: { points: [{ x: 0, y: 5 }, { x: 10, y: 5 }], widthM: 2 } as never,
        };
        expect(unionShapes([square(0, 0, 10), path])).toEqual({ error: 'centerline' });
    });
});

describe('DrawToolService.unionSelection', () => {
    test('the first-selected shape takes the union, the other goes, one undo puts both back', async () => {
        const { tool, features } = await loadedTool();
        const below = await features.create({ type: 'rough', holeId: null, geometry: square(5, 0, 10) });
        const middle = await features.create({ type: 'green', holeId: null, geometry: square(200, 0, 10) });
        const kept = await features.create({ type: 'fairway', holeId: null, geometry: square(0, 0, 10) });
        // Click order: the fairway first, then the rough.
        features.setSelection([kept!.id]);
        features.toggleSelected(below!.id);
        expect(tool.selectionCanUnion()).toBe(true);

        tool.unionSelection();
        await features.flush();

        const items = features.store.items.peek();
        expect(items.map(f => f.id).sort()).toEqual([kept!.id, middle!.id].sort());
        const merged = items.find(f => f.id === kept!.id)!;
        expect(merged.type).toBe('fairway');
        expect(areaOf(merged.geometry)).toBeCloseTo(150, 6);
        expect([...features.selectedIds.peek()]).toEqual([kept!.id]);

        await tool.history.undo(features);
        await features.flush();
        const order = features.stackFor({ holeId: null, layer: null });
        expect(order.map(f => f.type)).toEqual(['rough', 'green', 'fairway']);
        expect(areaOf(order[0].geometry)).toBeCloseTo(100, 6);
        expect(areaOf(order[2].geometry)).toBeCloseTo(100, 6);
        expect(tool.history.canUndo.peek()).toBe(false);

        await tool.history.redo(features);
        await features.flush();
        expect(features.stackFor({ holeId: null, layer: null }).map(f => f.type)).toEqual(['green', 'fairway']);
    });

    test('shapes that do not touch leave everything as it was and say why', async () => {
        const { tool, features } = await loadedTool();
        const a = await features.create({ type: 'green', holeId: null, geometry: square(0, 0, 10) });
        const b = await features.create({ type: 'green', holeId: null, geometry: square(100, 0, 10) });
        features.setSelection([a!.id, b!.id]);

        tool.unionSelection();
        await features.flush();

        expect(tool.actionNotice.peek()).toBe(UNION_ERRORS.disjoint);
        expect(features.store.items.peek()).toHaveLength(2);
        expect(tool.history.canUndo.peek()).toBe(false);
    });
});
