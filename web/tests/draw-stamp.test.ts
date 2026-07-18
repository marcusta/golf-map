import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { translateGeometry } from '../src/draw/draw-state';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// T42 — stamp / duplicate-drag. The gesture wiring needs a live MaplibreMap,
// so these tests exercise the drop-commit primitive (`stampClones`) directly:
// it is what both the Alt-duplicate-drag and each repeat stamp funnel through.

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
        remove: async () => ({}) as never, // any non-undefined = success
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

const square: FeatureGeometry = {
    crs: 'EPSG:3006',
    curveType: 'bspline',
    rings: [{ points: [
        { x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 },
    ] }],
};

function source(id: string, holeId: string | null): { id: string; type: string; holeId: string | null; geometry: FeatureGeometry } {
    return { id, type: 'bunker', holeId, geometry: square };
}

describe('DrawToolService stampClones (T42)', () => {
    test('clones are the source geometry translated by (dx, dy)', async () => {
        const { tool } = await loadedTool();
        const created = await tool.stampClones([source('src', null)], 7, -3);
        expect(created).not.toBeNull();
        expect(created!).toHaveLength(1);
        expect(created![0].geometry).toEqual(translateGeometry(square, 7, -3));
        // The source geometry is not mutated by the clone (translate copies).
        expect(square.rings[0].points[0]).toEqual({ x: 100, y: 100 });
    });

    test('a multi-feature duplicate lands as ONE history entry, clones selected', async () => {
        const { tool, features } = await loadedTool();
        const created = await tool.stampClones([source('a', null), source('b', null)], 10, 10);
        expect(created!).toHaveLength(2);
        expect(features.store.items.peek()).toHaveLength(2);
        expect([...features.selectedIds.peek()]).toEqual(created!.map(c => c.id));
        expect(tool.history.canUndo.peek()).toBe(true);
    });

    test('stamps inherit the source holeId', async () => {
        const { tool } = await loadedTool();
        const created = await tool.stampClones([source('src', 'hole-3')], 5, 5);
        expect(created![0].holeId).toBe('hole-3');
    });

    test('undo peels one stamp at a time, then the original clone batch', async () => {
        const { tool, features } = await loadedTool();
        // Original duplicate-drag: a 1-feature clone batch (one entry).
        const batch = await tool.stampClones([source('src', null)], 5, 5);
        // Two repeat stamps of that clone as its own template — one entry each.
        const template = source(batch![0].id, batch![0].holeId);
        await tool.stampClones([template], 3, 3);
        await tool.stampClones([template], 6, 6);
        expect(features.store.items.peek()).toHaveLength(3);

        await tool.history.undo(features); // second stamp
        expect(features.store.items.peek()).toHaveLength(2);
        await tool.history.undo(features); // first stamp
        expect(features.store.items.peek()).toHaveLength(1);
        await tool.history.undo(features); // original clone batch
        expect(features.store.items.peek()).toHaveLength(0);
        expect(tool.history.canUndo.peek()).toBe(false);
    });

    test('stampClones with no sources is a no-op', async () => {
        const { tool, features } = await loadedTool();
        const created = await tool.stampClones([], 5, 5);
        expect(created).toBeNull();
        expect(features.store.items.peek()).toHaveLength(0);
        expect(tool.history.canUndo.peek()).toBe(false);
    });
});
