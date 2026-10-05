import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import type { FeatureGeometry, Point } from '../src/geo/bezier';
import {
    applyVertexEdit,
    deleteAnchor,
    editViewOf,
    fromEditView,
    insertBetweenVertices,
    minVertexCount,
    moveAnchor,
    offsetGeometry,
    simplifyGeometry,
    toggleVertexCorner,
    translateGeometry,
} from '../src/draw/draw-state';
import { centerlineGeometry, flattenCenterline } from '../../shared/features/centerline';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Cart paths and roads: a centerline of clicks plus a width commits as one
// CENTERLINE `path` — the line is the shape, the corridor is derived from it
// (shared/features/centerline.ts), and the vertex tools edit the line. As
// with the trace tests, the pointer wiring needs a live MaplibreMap, so these
// exercise the mode switches, the commit seam (`commitCenterline`) and the
// edit-view ops the pointer handlers run.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

function fakeApi() {
    let n = 0;
    const stored = new Map<string, CourseFeature>();
    const reject = () => Promise.reject(new Error('not under test'));
    const api: CourseFeaturesApi = {
        listByCourse: async () => [],
        listByHole: reject,
        geojsonByCourse: reject,
        create: async input => {
            n += 1;
            const f = { id: `f${n}`, version: 1, ...input } as CourseFeature;
            stored.set(f.id, f);
            return f;
        },
        update: async ({ id, version, ...patch }) => {
            const f = { ...stored.get(id)!, ...patch, version: version + 1 } as CourseFeature;
            stored.set(id, f);
            return f;
        },
        remove: async () => ({}) as never,
        reorder: reject,
        imported: async () => [],
        removeImported: async () => ({ removed: 0 }),
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

    test('with Creek as the draw type, P draws a creek centerline (no road surface)', async () => {
        const { tool, features } = await loadedTool();
        tool.setPathSurface('asphalt');
        tool.drawType.set('water_creek');
        tool.armPath();
        expect(tool.drawType.peek()).toBe('water_creek');
        const line = [p(538_000, 6_398_000), p(538_050, 6_398_010)];
        expect(tool.commitCenterline(line, 2)).toBe(true);
        await tick();
        const [creek] = features.store.items.peek();
        expect(creek.type).toBe('water_creek');
        expect(creek.geometry.centerline?.widthM).toBe(2);
        expect((creek.attributes as Record<string, unknown> | undefined)?.surface).toBeUndefined();
    });

    test('a right-angle centerline commits as a centerline path: the line is the shape, the corridor derived', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        const line = [p(538_000, 6_398_000), p(538_060, 6_398_000), p(538_060, 6_398_040)];
        expect(tool.commitCenterline(line, 3)).toBe(true);
        await tick();

        const items = features.store.items.peek();
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('path');
        const geometry = items[0].geometry;
        // The clicks ARE the stored line; the 90° bend is a corner.
        expect(geometry.centerline).toEqual({ points: [line[0], { ...line[1], corner: true }, line[2]], widthM: 3 });
        // A corner means straight legs, so the curve is the clicks themselves.
        const curve = flattenCenterline(geometry.centerline!.points);
        expect(curve).toEqual(line);
        // The rings are its corridor: every kerb point 1.5 m from the line
        // (round joins and caps, within the arcs' polygon sagitta).
        expect(geometry.rings).toHaveLength(1);
        for (const q of geometry.rings[0].points) expect(Math.abs(distToPolyline(q, curve) - 1.5)).toBeLessThan(0.01);
        // Committing leaves drawing mode, draft cleared.
        expect(tool.state.mode.peek()).toBe('select');
        expect(tool.state.draft.peek()).toHaveLength(0);
    });

    test('gentle bends stay smooth and the kerbs stay a half-width out', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        // A 40 m-radius arc clicked every 20°: seven points, each turn 20°.
        const line: Point[] = [];
        for (let i = 0; i < 7; i++) {
            const a = (i * 20 * Math.PI) / 180;
            line.push(p(538_000 + 40 * Math.cos(a), 6_398_000 + 40 * Math.sin(a)));
        }
        expect(tool.commitCenterline(line, 2.5)).toBe(true);
        await tick();
        const geometry = features.store.items.peek()[0].geometry;
        expect(geometry.centerline!.points.some(q => q.corner)).toBe(false);
        // Away from the ends (whose spans leave along their chords) the
        // kerbs follow the true arc a half-width either side.
        const offsets = geometry.rings[0].points
            .filter(q => Math.hypot(q.x - line[0].x, q.y - line[0].y) > 16 && Math.hypot(q.x - line[6].x, q.y - line[6].y) > 16)
            .map(q => Math.abs(Math.hypot(q.x - 538_000, q.y - 6_398_000) - 40));
        expect(offsets.length).toBeGreaterThan(10);
        for (const offset of offsets) expect(Math.abs(offset - 1.25)).toBeLessThan(0.1);
    });

    test('a Shift-clicked point stays a corner even on a gentle bend', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        const line = [p(538_000, 6_398_000), { x: 538_050, y: 6_398_005, corner: true }, p(538_100, 6_398_000)];
        expect(tool.commitCenterline(line, 2.5)).toBe(true);
        await tick();
        expect(features.store.items.peek()[0].geometry.centerline!.points[1].corner).toBe(true);
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
        expect(tool.commitCenterline([p(538_000, 6_398_000), p(538_050, 6_398_000)], 500)).toBe(false);
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

describe('editing a centerline path', () => {
    /** A road with a corner, its corridor derived. */
    const road = (): FeatureGeometry => centerlineGeometry('EPSG:3006', {
        points: [p(538_000, 6_398_000), p(538_050, 6_398_000), { x: 538_100, y: 6_398_030, corner: true }, p(538_150, 6_398_030)],
        widthM: 4,
    })!;
    const minX = (g: FeatureGeometry) => Math.min(...g.rings[0].points.map(q => q.x));
    const maxY = (g: FeatureGeometry) => Math.max(...g.rings[0].points.map(q => q.y));

    test('the vertex tools see the control points as one open ring', () => {
        const view = editViewOf(road());
        expect(view.rings).toHaveLength(1);
        expect(view.rings[0].points).toHaveLength(4);
        expect(view.curveType).toBe('bspline'); // no bezier handles, corner flags
        expect(minVertexCount(road())).toBe(2);
    });

    test('dragging a control point moves the line and re-derives the corridor round it', () => {
        const moved = applyVertexEdit(road(), view => moveAnchor(view, 0, 1, p(538_050, 6_398_020)))!;
        expect(moved.centerline!.points[1]).toEqual(p(538_050, 6_398_020));
        expect(moved.centerline!.widthM).toBe(4);
        const curve = flattenCenterline(moved.centerline!.points);
        for (const q of moved.rings[0].points) expect(Math.abs(distToPolyline(q, curve) - 2)).toBeLessThan(0.02);
    });

    test('corner toggle, delete down to two points, insert between on an open line', () => {
        const smooth = applyVertexEdit(road(), view => toggleVertexCorner(view, 0, 2))!;
        expect(smooth.centerline!.points[2].corner).toBeUndefined();
        let g = road();
        g = applyVertexEdit(g, view => deleteAnchor(view, 0, 1, minVertexCount(g)))!;
        g = applyVertexEdit(g, view => deleteAnchor(view, 0, 1, minVertexCount(g)))!;
        expect(g.centerline!.points).toHaveLength(2);
        expect(applyVertexEdit(g, view => deleteAnchor(view, 0, 0, minVertexCount(g)))).toBeNull();
        // First and last of a two-point line are neighbours, not a wrap-around.
        const result = insertBetweenVertices(editViewOf(g), 0, 0, 1, true)!;
        const inserted = fromEditView(g, result.geometry)!;
        expect(inserted.centerline!.points).toHaveLength(3);
        expect(inserted.centerline!.points[1].x).toBeCloseTo(538_075, 6);
    });

    test('move, expand/contract and simplify act on the line', () => {
        const moved = translateGeometry(road(), 10, -5);
        expect(moved.centerline!.points[0]).toEqual(p(538_010, 6_397_995));
        expect(minX(moved)).toBeCloseTo(minX(road()) + 10, 6);
        const wider = offsetGeometry(road(), 1)!;
        expect(wider.centerline!.widthM).toBe(6);
        expect(maxY(wider)).toBeCloseTo(6_398_033, 1);
        expect(offsetGeometry(road(), -2)).toBeNull(); // would leave no road
        const straightened = simplifyGeometry(road(), 50);
        expect(straightened.centerline!.points).toHaveLength(2);
    });

    test('the selection panel width is one undoable edit', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        tool.commitCenterline([p(538_000, 6_398_000), p(538_050, 6_398_000)], 2.5);
        await tick();
        const id = features.store.items.peek()[0].id;
        features.select(id);
        tool.setSelectedCenterlineWidth(6);
        await tick();
        const widened = features.store.items.peek()[0].geometry;
        expect(widened.centerline!.widthM).toBe(6);
        expect(maxY(widened)).toBeCloseTo(6_398_003, 2);
        await tool.history.undo(features);
        await tick();
        expect(features.store.items.peek()[0].geometry.centerline!.widthM).toBe(2.5);
    });
});

describe('kerb fillets on the map', () => {
    test('roads that meet get live fillets in the map collection; the stored copies stay out of the store', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        tool.commitCenterline([p(538_000, 6_398_000), p(538_100, 6_398_000)], 4);
        await tick();
        const junctions = () => features.geojson.peek().features.filter(f => f.properties?.source === 'road-junctions');
        expect(junctions()).toHaveLength(0);
        tool.armPath();
        tool.commitCenterline([p(538_050, 6_398_000), p(538_050, 6_398_040)], 4);
        await tick();
        expect(junctions()).toHaveLength(2);
        expect(junctions().every(f => f.properties?.type === 'path')).toBe(true);

        // Rounding off on the branch (the selection panel's checkbox) drops them.
        const branch = features.store.items.peek()[1];
        await features.update(branch.id, { attributes: { kerbFillets: false } });
        expect(junctions()).toHaveLength(0);

        const stored = new FeaturesService({
            ...fakeApi(),
            listByCourse: async () => [{ id: 'j1', type: 'path', source: 'road-junctions', generated: true } as unknown as CourseFeature],
        });
        await stored.load('course-2');
        expect(stored.store.items.peek()).toHaveLength(0);
    });
});

describe('freehand path trace', () => {
    test('a press-drag stroke in path mode commits as a centerline, thinned to a few points', async () => {
        const { tool, features } = await loadedTool();
        tool.armPath();
        // A wobbly hand-drawn gentle S, sampled every metre.
        const stroke: Point[] = [];
        for (let i = 0; i <= 120; i++) stroke.push(p(538_000 + i, 6_398_000 + 10 * Math.sin(i / 25) + 0.1 * Math.sin(i * 1.7)));
        expect(tool.commitTrace(stroke)).toBe(true);
        await tick();
        const [f] = features.store.items.peek();
        expect(f.type).toBe('path');
        const points = f.geometry.centerline!.points;
        expect(points.length).toBeGreaterThanOrEqual(3);
        expect(points.length).toBeLessThan(20);
        expect(points[0]).toEqual(stroke[0]);
        expect(points.at(-1)).toEqual(stroke.at(-1)!);
        // The curve stays on the stroke.
        const curve = flattenCenterline(points);
        for (const q of stroke) expect(distToPolyline(q, curve)).toBeLessThan(0.7);
    });
});
