import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID, planSurrounds, type SurroundSource } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { mergedSurroundGeometries, offsetGeometry } from '../src/draw/draw-state';
import { flattenRing, type FeatureGeometry } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// T41 — surround chains + merged surrounds. The chain walk and the merge
// are pure (planSurrounds / mergedSurroundGeometries); the service test
// drives autoSurroundSelection end-to-end against the fake-API harness
// (same shape as draw-stamp.test.ts) to pin the ONE-history-entry and
// selection contracts.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

/** A create-echoing fake API: assigns fresh ids and mirrors the input back. */
function fakeApi() {
    let n = 0;
    const reject = () => Promise.reject(new Error('not under test'));
    const api: CourseFeaturesApi = {
        listByCourse: async () => [],
        listByHole: reject,
        geojsonByCourse: reject,
        create: async input => {
            n += 1;
            return { id: `f${n}`, version: 1, geojson: null, ...input } as CourseFeature;
        },
        update: reject,
        remove: async () => ({}) as never,
        reorder: reject,
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

/** Axis-aligned square as a straight-segment geometry. */
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

function bboxOf(geometry: FeatureGeometry): { minX: number; minY: number; maxX: number; maxY: number } {
    const flat = geometry.rings.flatMap(r => flattenRing(r, 0.25, geometry.curveType));
    const xs = flat.map(([x]) => x);
    const ys = flat.map(([, y]) => y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

describe('planSurrounds (T41 chain)', () => {
    test('chain walks the pairings to exhaustion with correct types and holeId', () => {
        const source: SurroundSource = { type: 'green', holeId: 'hole-7', geometry: square(100, 100, 20) };
        const plan = planSurrounds([source], true);
        // green → fairway(+0.5) → semi_rough(+1) → rough(+5) → deep_rough(+8)
        expect(plan.map(c => c.type)).toEqual(['fairway', 'semi_rough', 'rough', 'deep_rough']);
        expect(plan.every(c => c.holeId === 'hole-7')).toBe(true);
        // Each ring expands the PREVIOUS ring by that step's amount:
        // cumulative half-width growth 0.5, 1.5, 6.5, 14.5 m.
        const grow = [0.5, 1.5, 6.5, 14.5];
        plan.forEach((c, i) => {
            const bbox = bboxOf(c.geometry);
            expect(bbox.minX).toBeCloseTo(100 - grow[i], 6);
            expect(bbox.maxX).toBeCloseTo(120 + grow[i], 6);
        });
    });

    test('plain (non-chain) plan emits exactly one level', () => {
        const plan = planSurrounds([{ type: 'green', holeId: null, geometry: square(0, 0, 10) }], false);
        expect(plan.map(c => c.type)).toEqual(['fairway']);
    });

    test('a mid-chain collapse truncates cleanly, keeping the earlier rings', () => {
        let calls = 0;
        const failingSecond = (geometry: FeatureGeometry, distance: number) => {
            calls += 1;
            return calls >= 2 ? null : offsetGeometry(geometry, distance);
        };
        const plan = planSurrounds(
            [{ type: 'green', holeId: null, geometry: square(0, 0, 10) }],
            true,
            failingSecond,
        );
        // fairway succeeded; the semi_rough step collapsed → chain stops there.
        expect(plan.map(c => c.type)).toEqual(['fairway']);
    });

    test('a collapse at the first step yields an empty plan', () => {
        const degenerate: FeatureGeometry = { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] };
        expect(planSurrounds([{ type: 'green', holeId: null, geometry: degenerate }], true)).toEqual([]);
    });
});

describe('mergedSurroundGeometries (T41 merge)', () => {
    test('two overlapping outlines union into ONE straight-segment ring', () => {
        const merged = mergedSurroundGeometries([square(0, 0, 10), square(5, 5, 10)], 1);
        expect(merged).toHaveLength(1);
        expect(merged[0].rings).toHaveLength(1);
        // Straight-segment bezier convention: plain corner anchors, no handles.
        expect(merged[0].curveType).toBeUndefined();
        for (const p of merged[0].rings[0].points) {
            expect(p.hIn).toBeUndefined();
            expect(p.hOut).toBeUndefined();
        }
        // Union bbox (0..15) expanded by the offset distance.
        const bbox = bboxOf(merged[0]);
        expect(bbox.minX).toBeCloseTo(-1, 6);
        expect(bbox.minY).toBeCloseTo(-1, 6);
        expect(bbox.maxX).toBeCloseTo(16, 6);
        expect(bbox.maxY).toBeCloseTo(16, 6);
    });

    test('disjoint outlines yield one geometry per disjoint polygon', () => {
        const merged = mergedSurroundGeometries([square(0, 0, 10), square(100, 100, 10)], 1);
        expect(merged).toHaveLength(2);
    });

    test('interior rings survive as holes and offset the opposite way', () => {
        const withHole: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [
                square(0, 0, 40).rings[0],
                { points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] },
            ],
        };
        const merged = mergedSurroundGeometries([withHole, square(35, 0, 10)], 2);
        expect(merged).toHaveLength(1);
        expect(merged[0].rings).toHaveLength(2);
        // The hole SHRINKS when the surround expands (mirror offsetGeometry).
        const hole = merged[0].rings[1];
        const xs = hole.points.map(p => p.x);
        expect(Math.min(...xs)).toBeCloseTo(12, 6);
        expect(Math.max(...xs)).toBeCloseTo(28, 6);
    });

    test('degenerate sources contribute nothing', () => {
        expect(mergedSurroundGeometries([], 1)).toEqual([]);
        const degenerate: FeatureGeometry = { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] };
        expect(mergedSurroundGeometries([degenerate], 1)).toEqual([]);
    });
});

describe('DrawToolService.autoSurroundSelection (T41)', () => {
    test('Shift-chain creates all rings in ONE history entry, selection = new rings', async () => {
        const { tool, features } = await loadedTool();
        const green = await features.create({ type: 'green', holeId: 'hole-7', geometry: square(100, 100, 20) });
        features.setSelection([green!.id]);

        await tool.autoSurroundSelection(true);

        const items = features.store.items.peek();
        expect(items.map(f => f.type)).toEqual(['green', 'fairway', 'semi_rough', 'rough', 'deep_rough']);
        expect(items.slice(1).every(f => f.holeId === 'hole-7')).toBe(true);
        const newIds = items.slice(1).map(f => f.id);
        expect([...features.selectedIds.peek()]).toEqual(newIds);
        // ONE history entry: a single undo removes the entire chain.
        await tool.history.undo(features);
        expect(features.store.items.peek().map(f => f.type)).toEqual(['green']);
        expect(tool.history.canUndo.peek()).toBe(false);
    });

    test('two overlapping fairways yield ONE merged semi_rough', async () => {
        const { tool, features } = await loadedTool();
        const a = await features.create({ type: 'fairway', holeId: 'h1', geometry: square(0, 0, 10) });
        const b = await features.create({ type: 'fairway', holeId: 'h1', geometry: square(5, 5, 10) });
        features.setSelection([a!.id, b!.id]);

        await tool.autoSurroundSelection();

        const created = features.store.items.peek().filter(f => f.type === 'semi_rough');
        expect(created).toHaveLength(1);
        expect(created[0].holeId).toBe('h1');
        const bbox = bboxOf(created[0].geometry);
        expect(bbox.minX).toBeCloseTo(-1, 6);
        expect(bbox.maxX).toBeCloseTo(16, 6);
    });

    test('disjoint sources yield two surrounds; mixed holeIds fall back to null', async () => {
        const { tool, features } = await loadedTool();
        const a = await features.create({ type: 'fairway', holeId: 'h1', geometry: square(0, 0, 10) });
        const b = await features.create({ type: 'fairway', holeId: 'h2', geometry: square(100, 100, 10) });
        features.setSelection([a!.id, b!.id]);

        await tool.autoSurroundSelection();

        const created = features.store.items.peek().filter(f => f.type === 'semi_rough');
        expect(created).toHaveLength(2);
        expect(created.every(f => f.holeId === null)).toBe(true);
        // Still ONE history entry for both rings.
        await tool.history.undo(features);
        expect(features.store.items.peek().filter(f => f.type === 'semi_rough')).toHaveLength(0);
    });

    test('chain + merge compose: merged semi_rough keeps chaining outward', async () => {
        const { tool, features } = await loadedTool();
        const a = await features.create({ type: 'fairway', holeId: 'h1', geometry: square(0, 0, 10) });
        const b = await features.create({ type: 'fairway', holeId: 'h1', geometry: square(5, 5, 10) });
        features.setSelection([a!.id, b!.id]);

        await tool.autoSurroundSelection(true);

        const types = features.store.items.peek().map(f => f.type);
        // fairway ×2 sources → ONE semi_rough → rough → deep_rough.
        expect(types).toEqual(['fairway', 'fairway', 'semi_rough', 'rough', 'deep_rough']);
        await tool.history.undo(features);
        expect(features.store.items.peek().map(f => f.type)).toEqual(['fairway', 'fairway']);
    });

    test('selection with no pairing sets the notice and creates nothing', async () => {
        const { tool, features } = await loadedTool();
        const bunker = await features.create({ type: 'bunker', holeId: null, geometry: square(0, 0, 5) });
        features.setSelection([bunker!.id]);

        await tool.autoSurroundSelection(true);

        expect(features.store.items.peek()).toHaveLength(1);
        expect(tool.actionNotice.peek()).toBe('No surround pairing for the selected type(s).');
    });

    test('surround pairing exposes the chain terminal for the button hint', async () => {
        const { tool, features } = await loadedTool();
        const green = await features.create({ type: 'green', holeId: null, geometry: square(0, 0, 10) });
        features.setSelection([green!.id]);
        expect(tool.selectionSurroundPairing()).toEqual({ targetType: 'fairway', expandAmount: 0.5, chainEnd: 'deep_rough' });

        const rough = await features.create({ type: 'rough', holeId: null, geometry: square(50, 50, 10) });
        features.setSelection([rough!.id]);
        // rough → deep_rough is the last link: chainEnd === targetType (no hint).
        expect(tool.selectionSurroundPairing()).toEqual({ targetType: 'deep_rough', expandAmount: 8, chainEnd: 'deep_rough' });
    });
});
