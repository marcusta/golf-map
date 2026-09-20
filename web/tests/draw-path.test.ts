import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { flattenRing } from '../src/geo/bezier';
import type { Point } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Cart-path drawing: a centerline of clicks plus a width commits as one
// editable `path` spline (the corridor). As with the trace tests, the
// pointer wiring needs a live MaplibreMap, so these exercise the mode
// switches and the commit seam (`commitCenterline`) directly.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

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
const p = (x: number, y: number): Point => ({ x, y });

/** Distance from q to the closest segment of an open polyline. */
function distToPolyline(q: Point, line: Point[]): number {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)));
    }
    return best;
}

describe('path drawing (centerline + width)', () => {
    test('armPath arms drawing as a path; armDraw goes back to polygons', async () => {
        const { tool } = await loadedTool();
        tool.drawType.set('bunker');
        tool.armPath();
        expect(tool.state.mode.peek()).toBe('draw');
        expect(tool.pathMode.peek()).toBe(true);
        expect(tool.drawType.peek()).toBe('path');
        tool.armDraw();
        expect(tool.pathMode.peek()).toBe(false);
    });

    test('a right-angle centerline commits as an exact mitered corridor of corner controls', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        const line = [p(538_000, 6_398_000), p(538_060, 6_398_000), p(538_060, 6_398_040)];
        expect(tool.commitCenterline(line, 3)).toBe(true);
        await tick();

        const items = features.store.items.peek();
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('path');
        expect(items[0].geometry.curveType).toBe('bezier');
        const ring = items[0].geometry.rings[0];
        // One kerb anchor opposite every click on each side; the ends and
        // the 90° bend are corners, so every segment is straight and the
        // ring IS the buffered polygon: sides 1.5 m from the centerline,
        // miters 1.5·√2.
        expect(ring.points).toHaveLength(6);
        expect(ring.points.every(c => !c.corner && !c.hIn && !c.hOut)).toBe(true);
        const outline = flattenRing(ring, 0.05, 'bezier').map(([x, y]) => p(x, y));
        expect(outline.length).toBeGreaterThanOrEqual(6);
        const ends = [line[0], line[2]];
        for (const q of outline) {
            const d = distToPolyline(q, line);
            expect(d).toBeLessThan(1.5 * Math.SQRT2 + 0.1);
            // The butt caps cross the centerline's endpoints, so only the sides are bounded below.
            if (ends.some(e => Math.hypot(q.x - e.x, q.y - e.y) <= 1.6)) continue;
            expect(d).toBeGreaterThan(1.5 - 0.1); // the ring flattening's own tolerance
        }
        // Chain-draw: still armed, still a path, draft cleared.
        expect(tool.state.mode.peek()).toBe('draw');
        expect(tool.pathMode.peek()).toBe(true);
        expect(tool.drawType.peek()).toBe('path');
        expect(tool.state.draft.peek()).toHaveLength(0);
    });

    test('gentle bends stay smooth and the kerbs stay a half-width out', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        // A 20 m-radius-ish arc clicked every ~20°: seven points, each turn 20°.
        const line: Point[] = [];
        for (let i = 0; i < 7; i++) {
            const a = (i * 20 * Math.PI) / 180;
            line.push(p(538_000 + 40 * Math.cos(a), 6_398_000 + 40 * Math.sin(a)));
        }
        expect(tool.commitCenterline(line, 2.5)).toBe(true);
        await tick();
        const ring = features.store.items.peek()[0].geometry.rings[0];
        expect(ring.points).toHaveLength(14);
        // Anchors sit exactly on the kerbs (the mitered offsets of the clicks);
        // the segments between gentle bends carry Catmull-Rom handles, the
        // ones touching the cap corners none.
        for (const a of ring.points) expect(Math.abs(Math.abs(Math.hypot(a.x - 538_000, a.y - 6_398_000) - 40) - 1.25)).toBeLessThan(0.03);
        // Per side: 7 anchors, the two end ones corners, so segments 1-2 … 4-5
        // are curved: anchors 1-5 carry a handle, 2-4 carry both.
        expect(ring.points.filter(a => a.hIn || a.hOut).length).toBe(10);
        expect(ring.points.filter(a => a.hIn && a.hOut).length).toBe(6);
        // Measured against the true arc (radius 40 about the centre), not the
        // chord polyline the clicks make: a Catmull-Rom curve through points
        // on a circle hugs the circle to within centimetres.
        const outline = flattenRing(ring, 0.05, 'bezier').map(([x, y]) => p(x, y));
        const offsets: number[] = [];
        for (const q of outline) {
            if (Math.hypot(q.x - line[0].x, q.y - line[0].y) < 2 || Math.hypot(q.x - line[6].x, q.y - line[6].y) < 2) continue;
            offsets.push(Math.abs(Math.hypot(q.x - 538_000, q.y - 6_398_000) - 40));
        }
        expect(offsets.length).toBeGreaterThan(20);
        // The first/last side segments are straight chords (they touch a cap
        // corner): a 20° chord's sagitta is up to 0.6 m; the curved ones stay
        // within 0.1 m of the true offset.
        for (const offset of offsets) {
            expect(offset).toBeGreaterThan(1.25 - 0.65);
            expect(offset).toBeLessThan(1.25 + 0.65);
        }
        const median = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
        expect(Math.abs(median - 1.25)).toBeLessThan(0.1);
    });

    test('a two-click straight path is enough, and is one undoable entry', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        expect(tool.commitCenterline([p(538_000, 6_398_000), p(538_050, 6_398_010)], 2.5)).toBe(true);
        await tick();
        expect(features.store.items.peek()).toHaveLength(1);
        await tool.history.undo(features);
        expect(features.store.items.peek()).toHaveLength(0);
        expect(tool.history.canUndo.peek()).toBe(false);
    });

    test('degenerate input commits nothing and stays armed', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        expect(tool.commitCenterline([p(538_000, 6_398_000)], 2.5)).toBe(false);
        expect(tool.commitCenterline([p(538_000, 6_398_000), p(538_000, 6_398_000)], 2.5)).toBe(false);
        expect(tool.commitCenterline([p(538_000, 6_398_000), p(538_050, 6_398_000)], 0)).toBe(false);
        await tick();
        expect(features.store.items.peek()).toHaveLength(0);
        expect(tool.state.mode.peek()).toBe('draw');
    });

    test('commitCenterline outside draw mode is a no-op', async () => {
        const { tool, features } = await loadedTool();
        expect(tool.commitCenterline([p(538_000, 6_398_000), p(538_050, 6_398_000)], 2.5)).toBe(false);
        await tick();
        expect(features.store.items.peek()).toHaveLength(0);
    });

    test('the path width persists through setPathWidthM and rejects junk', async () => {
        const { tool } = await loadedTool();
        tool.setPathWidthM(3.5);
        expect(tool.pathWidthM.peek()).toBe(3.5);
        tool.setPathWidthM(-1);
        tool.setPathWidthM(Number.NaN);
        expect(tool.pathWidthM.peek()).toBe(3.5);
        expect(new DrawToolService().pathWidthM.peek()).toBe(3.5);
    });
});
