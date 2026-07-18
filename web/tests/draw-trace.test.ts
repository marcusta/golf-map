import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { TraceGesture, TRACE_CLICK_DECAY_PX, TRACE_SAMPLE_PX } from '../src/draw/draw-state';
import type { Point } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// T40 — freehand trace → spline fit. The pointer wiring needs a live
// MaplibreMap, so (as with draw-stamp.test.ts) these tests exercise the pure
// gesture state (`TraceGesture`: sampling gate + click decay) and the commit
// seam (`commitTrace`: fit → closeDraft funnel) directly.

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

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Circular stroke in EPSG:3006 meters (open sequence, no closing dup). */
function circleStroke(cx: number, cy: number, r: number, n: number): Point[] {
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    return pts;
}

describe('TraceGesture (decay-to-click + sampling)', () => {
    const p = (x: number, y: number): Point => ({ x, y });

    test('a sub-threshold press-drag decays to a plain click', () => {
        const g = new TraceGesture({ x: 100, y: 100 }, p(1000, 2000));
        g.sample({ x: 102, y: 101 }, p(1000.4, 2000.2));
        g.sample({ x: 101, y: 103 }, p(1000.2, 2000.6));
        expect(g.moved).toBe(false); // never strayed ≥ TRACE_CLICK_DECAY_PX
    });

    test('straying past the decay threshold arms the trace — and latches', () => {
        const g = new TraceGesture({ x: 100, y: 100 }, p(1000, 2000));
        g.sample({ x: 100 + TRACE_CLICK_DECAY_PX + 15, y: 100 }, p(1004, 2000));
        expect(g.moved).toBe(true);
        // Returning to the start (a closed loop!) must NOT reset the flag —
        // start→end distance is ~0 on exactly the strokes we want to keep.
        g.sample({ x: 101, y: 100 }, p(1000.2, 2000));
        expect(g.moved).toBe(true);
    });

    test('samples closer than TRACE_SAMPLE_PX to the last kept one are dropped', () => {
        const g = new TraceGesture({ x: 100, y: 100 }, p(1000, 2000));
        expect(g.sample({ x: 100 + TRACE_SAMPLE_PX - 1, y: 100 }, p(1000.4, 2000))).toBe(false);
        expect(g.points).toHaveLength(1);
        expect(g.sample({ x: 100 + TRACE_SAMPLE_PX, y: 100 }, p(1000.6, 2000))).toBe(true);
        expect(g.points).toHaveLength(2);
        // Spacing is measured from the last KEPT sample, not the raw last move.
        expect(g.sample({ x: 100 + TRACE_SAMPLE_PX + 1, y: 100 }, p(1000.8, 2000))).toBe(false);
        expect(g.points).toHaveLength(2);
    });

    test('finish appends the release point once', () => {
        const g = new TraceGesture({ x: 0, y: 0 }, p(1000, 2000));
        g.sample({ x: 10, y: 0 }, p(1002, 2000));
        const stroke = g.finish(p(1004, 2000));
        expect(stroke).toHaveLength(3);
        // A release exactly on the last sample is not duplicated.
        expect(g.finish(p(1004, 2000))).toHaveLength(3);
    });
});

describe('DrawToolService commitTrace (T40)', () => {
    test('a traced stroke lands as one editable b-spline feature of the armed type', async () => {
        const { tool, features } = await loadedTool();
        tool.drawType.set('green');
        tool.state.arm();
        const ok = tool.commitTrace(circleStroke(538_000, 6_398_000, 12, 150));
        expect(ok).toBe(true);
        await tick();

        const items = features.store.items.peek();
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('green');
        expect(items[0].geometry.crs).toBe('EPSG:3006');
        expect(items[0].geometry.curveType).toBe('bspline');
        const controls = items[0].geometry.rings[0].points;
        expect(controls.length).toBeGreaterThanOrEqual(8);
        expect(controls.length).toBeLessThanOrEqual(20);
        // All smooth in v1: no corner flags, no handles.
        expect(controls.every(c => !c.corner && !c.hIn && !c.hOut)).toBe(true);
    });

    test('commit stays armed (chain-draw) with a cleared draft', async () => {
        const { tool } = await loadedTool();
        tool.state.arm();
        tool.commitTrace(circleStroke(538_000, 6_398_000, 10, 120));
        await tick();
        expect(tool.state.mode.peek()).toBe('draw');
        expect(tool.state.draft.peek()).toHaveLength(0);
    });

    test('ONE history entry: a single undo removes the traced feature', async () => {
        const { tool, features } = await loadedTool();
        tool.state.arm();
        tool.commitTrace(circleStroke(538_000, 6_398_000, 10, 120));
        await tick();
        expect(features.store.items.peek()).toHaveLength(1);
        await tool.history.undo(features);
        expect(features.store.items.peek()).toHaveLength(0);
        expect(tool.history.canUndo.peek()).toBe(false);
    });

    test('a degenerate stroke (< 3 distinct points) is discarded', async () => {
        const { tool, features } = await loadedTool();
        tool.state.arm();
        const ok = tool.commitTrace([{ x: 538_000, y: 6_398_000 }, { x: 538_001, y: 6_398_000 }]);
        expect(ok).toBe(false);
        await tick();
        expect(features.store.items.peek()).toHaveLength(0);
        expect(tool.state.mode.peek()).toBe('draw'); // still armed
        expect(tool.history.canUndo.peek()).toBe(false);
    });

    test('commitTrace outside draw mode is a no-op', async () => {
        const { tool, features } = await loadedTool();
        const ok = tool.commitTrace(circleStroke(538_000, 6_398_000, 10, 120));
        expect(ok).toBe(false);
        await tick();
        expect(features.store.items.peek()).toHaveLength(0);
    });
});
