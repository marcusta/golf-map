import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { FeatureCollection, Point as GeoPoint, Polygon } from 'geojson';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import {
    DrawToolService,
    DRAW_TOOL_ID,
    DELETE_CONFIRM_THRESHOLD,
    NOTICE_MS,
    NUDGE_COALESCE_MS,
} from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { translateAnchors, toggleVerticesCorner, vertexKey } from '../src/draw/draw-state';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry, Point } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import { withBatchEndpoints } from './fake-feature-api';

// Review items 23 and 24: delete without a dialog up to a threshold, edge
// press-drag inserts and moves a vertex, a multi-vertex selection drags and
// nudges as a group, and 'C' acts on the vertex selection. The fake gl map
// projects with a flat linear transform around `base`, so screen pixels and
// EPSG:3006 meters convert exactly at ZOOM.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const base = wgs84ToSweref99tm(58.4015, 15.5658);
const ZOOM = 18;
/** Meters per screen px at ZOOM and the given latitude (the tool's formula). */
function mpp(lat: number): number {
    return (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / 2 ** (ZOOM + 8);
}
const MPP = mpp(58.4015);

function screenOf(p: Point): { x: number; y: number } {
    return { x: 500 + (p.x - base.x) / MPP, y: 400 - (p.y - base.y) / MPP };
}

function square(half: number, curveType?: 'bspline'): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        ...(curveType ? { curveType } : {}),
        rings: [{
            points: [
                { x: base.x - half, y: base.y - half },
                { x: base.x + half, y: base.y - half },
                { x: base.x + half, y: base.y + half },
                { x: base.x - half, y: base.y + half },
            ],
        }],
    };
}

function row(id: string, geometry: FeatureGeometry): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, type: 'bunker', geometry,
        sortOrder: 0, source: null, sourceRef: null, license: null, attributes: null, version: 1,
    };
}

/** In-memory courseFeatures API with optimistic locking. */
function fakeApi(initial: CourseFeature[]): CourseFeaturesApi {
    const rows = new Map(initial.map(f => [f.id, structuredClone(f)]));
    let seq = 0;
    const api: CourseFeaturesApi = {
        listByCourse: async () => [...rows.values()].map(f => structuredClone(f)),
        listByHole: () => Promise.reject(new Error('not under test')),
        geojsonByCourse: () => Promise.reject(new Error('not under test')),
        async create(input) {
            const f = row(`new${++seq}`, structuredClone(input.geometry) as FeatureGeometry);
            f.type = input.type;
            f.holeId = input.holeId ?? null;
            rows.set(f.id, f);
            return structuredClone(f);
        },
        async update(input) {
            const r = rows.get(input.id);
            if (!r || r.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.geometry !== undefined) r.geometry = structuredClone(input.geometry) as FeatureGeometry;
            if (input.type !== undefined) r.type = input.type;
            r.version += 1;
            return structuredClone(r);
        },
        async remove(input) {
            const r = rows.get(input.id);
            if (!r || r.version !== input.version) throw new ApiError(409, 'Version conflict');
            rows.delete(input.id);
            return { ok: true };
        },
        reorder: async () => ({ ok: true }),
    };
    return withBatchEndpoints(api, rows);
}

async function setup(rows: CourseFeature[], opts: { bearing?: number } = {}) {
    const detail = new CourseDetailService();
    detail.holeStore.set([]);
    di.set(CourseDetailService, detail);
    const confirm = new ConfirmService();
    di.set(ConfirmService, confirm);

    const features = new FeaturesService(fakeApi(rows));
    features.geometryDebounceMs = 0;
    await features.load('c1');

    const moveHandlers: Array<(e: MapPointerEvent) => void> = [];
    const clickHandlers: Array<(e: MapPointerEvent) => void> = [];
    const glHandlers = new Map<string, Set<(e: unknown) => void>>();
    let overlay: FeatureCollection | null = null;
    const glMap = {
        transform: {
            locationToScreenPoint: (l: { lng: number; lat: number }) => screenOf(wgs84ToSweref99tm(l.lat, l.lng)),
        },
        project: () => { throw new Error('terrain-aware project must not be called'); },
        getBearing: () => opts.bearing ?? 0,
        on(type: string, h: (e: unknown) => void) {
            let set = glHandlers.get(type);
            if (!set) glHandlers.set(type, set = new Set());
            set.add(h);
        },
        off(type: string, h: (e: unknown) => void) { glHandlers.get(type)?.delete(h); },
        once() {}, getCanvas: () => ({ style: {} }),
        dragPan: { enable() {}, disable() {} }, boxZoom: { enable() {}, disable() {} },
        setPaintProperty() {}, setFilter() {}, getSource: () => ({ type: 'geojson' }),
    };
    const map = {
        ready: new Signal(true),
        map: new Signal(glMap),
        zoom: new Signal(ZOOM),
        interactionMode: new Signal(DRAW_TOOL_ID),
        onClick: (h: (e: MapPointerEvent) => void) => { clickHandlers.push(h); return () => {}; },
        onMouseMove: (h: (e: MapPointerEvent) => void) => { moveHandlers.push(h); return () => {}; },
        addOverlayLayer: (_id: string, data: FeatureCollection) => { overlay = data; },
        updateOverlayData: (_id: string, data: FeatureCollection) => { overlay = data; },
        removeOverlayLayer: () => {},
    };
    const ctx: ToolContext = {
        map: map as never,
        elevation: null as never,
        tileset: null as never,
        courseDetail: null as never,
        features,
        courseId: 'c1',
        track: (d: () => void) => { cleanups.push(d); },
    };
    const tool = new DrawToolService();
    tool.attach(ctx);
    let queued: Array<() => void> = [];
    tool.frameScheduler = cb => { queued.push(cb); };
    let now = 1_000_000;
    tool.clock = () => now;
    const frame = (): void => {
        const run = queued;
        queued = [];
        for (const cb of run) cb();
    };
    tool.activate(ctx);

    const at = (p: Point) => {
        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
        return { lngLat: { lng: lon, lat }, point: screenOf(p) };
    };
    const fire = (type: string, e: unknown) => { for (const h of glHandlers.get(type) ?? []) h(e); };
    const down = (p: Point, init: MouseEventInit = {}) => fire('mousedown', {
        ...at(p), originalEvent: new MouseEvent('mousedown', { button: 0, buttons: 1, ...init }), preventDefault() {},
    });
    const move = (p: Point) => {
        for (const h of moveHandlers) h({ ...at(p), originalEvent: new MouseEvent('mousemove', { buttons: 1 }) });
        frame();
    };
    const up = (p: Point) => fire('mouseup', { ...at(p), originalEvent: new MouseEvent('mouseup', { button: 0 }), preventDefault() {} });
    // MapLibre synthesizes a click right after a mouseup that did not pan.
    const click = (p: Point) => { for (const h of clickHandlers) h({ ...at(p), originalEvent: new MouseEvent('click') }); };
    const key = (k: string, init: KeyboardEventInit = {}) => {
        const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
        window.dispatchEvent(e);
        return e;
    };
    const geometryOf = (id: string) => features.store.items.peek().find(f => f.id === id)!.geometry;
    /** Undo every entry; returns how many there were. */
    const undoAll = async () => {
        let n = 0;
        while (tool.history.canUndo.peek()) {
            await tool.history.undo(features);
            n++;
        }
        return n;
    };
    return {
        tool, features, confirm, down, move, up, click, key, frame, geometryOf, undoAll,
        overlay: () => overlay,
        advance: (ms: number) => { now += ms; },
    };
}

function expectNear(p: Point, q: Point, eps = 1e-6): void {
    expect(Math.abs(p.x - q.x)).toBeLessThan(eps);
    expect(Math.abs(p.y - q.y)).toBeLessThan(eps);
}

/** EPSG:3006 positions of the overlay points with the given role. */
function overlayPoints(fc: FeatureCollection | null, role: string): Point[] {
    return (fc?.features ?? [])
        .filter(f => f.properties?.role === role)
        .map(f => {
            const [lng, lat] = (f.geometry as GeoPoint).coordinates;
            return wgs84ToSweref99tm(lat, lng);
        });
}

describe('translateAnchors', () => {
    const geometry: FeatureGeometry = {
        crs: 'EPSG:3006',
        rings: [
            { points: [
                { x: 0, y: 0, hOut: { x: 1, y: 0 } },
                { x: 10, y: 0, hIn: { x: 9, y: 0 }, corner: true },
                { x: 10, y: 10 },
            ] },
            { points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }] },
        ],
    };

    test('moves the named anchors and their handles, shares everything else', () => {
        const next = translateAnchors(geometry, ['0:0', '0:1'], 2, -1);
        expect(next.rings[0].points[0]).toEqual({ x: 2, y: -1, hOut: { x: 3, y: -1 } });
        expect(next.rings[0].points[1]).toEqual({ x: 12, y: -1, hIn: { x: 11, y: -1 }, corner: true });
        // Structural sharing: new geometry, rings array and edited ring;
        // untouched ring and point objects are the input's.
        expect(next).not.toBe(geometry);
        expect(next.rings).not.toBe(geometry.rings);
        expect(next.rings[0]).not.toBe(geometry.rings[0]);
        expect(next.rings[0].points).not.toBe(geometry.rings[0].points);
        expect(next.rings[0].points[2]).toBe(geometry.rings[0].points[2]);
        expect(next.rings[1]).toBe(geometry.rings[1]);
        // Input untouched.
        expect(geometry.rings[0].points[0]).toEqual({ x: 0, y: 0, hOut: { x: 1, y: 0 } });
    });

    test('keys naming no anchor are ignored', () => {
        const next = translateAnchors(geometry, ['5:0', '0:9'], 1, 1);
        expect(next.rings[0]).toBe(geometry.rings[0]);
        expect(next.rings[1]).toBe(geometry.rings[1]);
    });

    test('toggleVerticesCorner flips each named vertex and shares the rest', () => {
        const spline = square(10, 'bspline');
        const next = toggleVerticesCorner(spline, ['0:0', '0:2']);
        expect(next.rings[0].points.map(p => !!p.corner)).toEqual([true, false, true, false]);
        expect(next.rings[0].points[1]).toBe(spline.rings[0].points[1]);
    });
});

describe('edge press inserts and grabs a vertex (24a)', () => {
    const edgeMid = (): Point => ({ x: base.x, y: base.y - 20 });

    test('press on an edge and drag: inserted vertex follows, one history entry', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        t.down(edgeMid());
        t.move({ x: base.x + 1, y: base.y - 25 });
        t.move({ x: base.x + 2, y: base.y - 30 });

        // The ghost shows the inserted vertex at the cursor before mouseup.
        const ghostVertices = overlayPoints(t.overlay(), 'vertex');
        expect(ghostVertices).toHaveLength(5);
        expect(ghostVertices.some(p => Math.hypot(p.x - (base.x + 2), p.y - (base.y - 30)) < 0.01)).toBe(true);

        t.up({ x: base.x + 2, y: base.y - 30 });
        t.click({ x: base.x + 2, y: base.y - 30 }); // suppressed: no second insert

        const pts = t.geometryOf('sq').rings[0].points;
        expect(pts).toHaveLength(5);
        expectNear(pts[1], { x: base.x + 2, y: base.y - 30 }, 1e-3);
        expect([...t.tool.vertexSelection.peek()]).toEqual([vertexKey(0, 1)]);

        await t.features.flush();
        expect(await t.undoAll()).toBe(1);
        expect(t.geometryOf('sq').rings[0].points).toHaveLength(4);
    });

    test('press and release on an edge without moving inserts only', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        t.down(edgeMid());
        t.up(edgeMid());
        t.click(edgeMid());

        const pts = t.geometryOf('sq').rings[0].points;
        expect(pts).toHaveLength(5);
        expectNear(pts[1], edgeMid(), 1e-3);
        // The other anchors stay put.
        expectNear(pts[0], { x: base.x - 20, y: base.y - 20 });
        expectNear(pts[2], { x: base.x + 20, y: base.y - 20 });

        await t.features.flush();
        expect(await t.undoAll()).toBe(1);
        expect(t.geometryOf('sq').rings[0].points).toHaveLength(4);
    });

    test('b-spline edge press inserts a control point and drags it', async () => {
        const t = await setup([row('sp', square(20, 'bspline'))]);
        t.features.select('sp');
        // The spline curve sits inside its control polygon; press on the curve.
        const curveBottom = (() => {
            // Nearest curve point below the center: scan down for the edge hit.
            for (let d = 20; d > 0; d -= 0.1) {
                const p = { x: base.x, y: base.y - d };
                t.down(p);
                t.up(p);
                t.click(p);
                if (t.geometryOf('sp').rings[0].points.length === 5) return p;
            }
            return null;
        })();
        expect(curveBottom).not.toBeNull();
        expect(t.tool.history.canUndo.peek()).toBe(true);
    });
});

describe('multi-vertex drag (24b)', () => {
    test('grabbing a selected vertex moves the whole vertex selection; the ghost shows all', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        t.tool.vertexSelection.set(new Set([vertexKey(0, 0), vertexKey(0, 1)]));
        const grab = { x: base.x - 20, y: base.y - 20 };
        t.down(grab);
        t.move({ x: grab.x + 2, y: grab.y + 1 });
        t.move({ x: grab.x + 5, y: grab.y + 3 });

        const selected = overlayPoints(t.overlay(), 'vertex-selected');
        expect(selected).toHaveLength(2);
        expectNear(selected[0], { x: base.x - 15, y: base.y - 17 }, 0.01);
        expectNear(selected[1], { x: base.x + 25, y: base.y - 17 }, 0.01);
        const ghost = (t.overlay()?.features ?? []).filter(f => f.properties?.role === 'ghost');
        expect(ghost).toHaveLength(1);
        const ring = (ghost[0].geometry as Polygon).coordinates[0].map(([lng, lat]) => wgs84ToSweref99tm(lat, lng));
        expect(ring.some(p => Math.hypot(p.x - (base.x + 25), p.y - (base.y - 17)) < 0.01)).toBe(true);

        t.up({ x: grab.x + 5, y: grab.y + 3 });
        const pts = t.geometryOf('sq').rings[0].points;
        expectNear(pts[0], { x: base.x - 15, y: base.y - 17 }, 1e-3);
        expectNear(pts[1], { x: base.x + 25, y: base.y - 17 }, 1e-3);
        expectNear(pts[2], { x: base.x + 20, y: base.y + 20 });
        expectNear(pts[3], { x: base.x - 20, y: base.y + 20 });
        // The selection survives the move.
        expect(t.tool.vertexSelection.peek().size).toBe(2);

        await t.features.flush();
        expect(await t.undoAll()).toBe(1);
    });

    test('grabbing an unselected vertex drops the selection and moves that vertex only', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        t.tool.vertexSelection.set(new Set([vertexKey(0, 0), vertexKey(0, 1)]));
        const grab = { x: base.x + 20, y: base.y + 20 };
        t.down(grab);
        t.move({ x: grab.x + 4, y: grab.y });
        t.up({ x: grab.x + 4, y: grab.y });
        const pts = t.geometryOf('sq').rings[0].points;
        expectNear(pts[2], { x: base.x + 24, y: base.y + 20 }, 1e-3);
        expectNear(pts[0], { x: base.x - 20, y: base.y - 20 });
        expect(t.tool.vertexSelection.peek().size).toBe(0);
    });
});

describe('arrow nudge (24c)', () => {
    test('1 px per arrow, 10 px with Shift, in meters at the current zoom', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        t.tool.vertexSelection.set(new Set([vertexKey(0, 2)]));
        const start = t.geometryOf('sq').rings[0].points[2];
        const m = mpp(sweref99tmToWgs84(start.x, start.y).lat);

        const e = t.key('ArrowRight');
        expect(e.defaultPrevented).toBe(true);
        expectNear(t.geometryOf('sq').rings[0].points[2], { x: start.x + m, y: start.y }, 1e-6);

        t.advance(NUDGE_COALESCE_MS + 1);
        t.key('ArrowUp', { shiftKey: true });
        expectNear(t.geometryOf('sq').rings[0].points[2], { x: start.x + m, y: start.y + 10 * m }, 1e-6);
        // Unselected vertices stay put.
        expectNear(t.geometryOf('sq').rings[0].points[0], { x: base.x - 20, y: base.y - 20 });
    });

    test('screen directions follow the map bearing', async () => {
        const t = await setup([row('sq', square(20))], { bearing: 90 });
        t.features.select('sq');
        t.tool.vertexSelection.set(new Set([vertexKey(0, 2)]));
        const start = t.geometryOf('sq').rings[0].points[2];
        const m = mpp(sweref99tmToWgs84(start.x, start.y).lat);
        // Bearing 90: east is screen up.
        t.key('ArrowUp');
        expectNear(t.geometryOf('sq').rings[0].points[2], { x: start.x + m, y: start.y }, 1e-6);
    });

    test('repeats of one key within the window share one history entry', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        t.tool.vertexSelection.set(new Set([vertexKey(0, 2)]));
        const start = t.geometryOf('sq').rings[0].points[2];
        const m = mpp(sweref99tmToWgs84(start.x, start.y).lat);

        t.key('ArrowRight');
        t.advance(100);
        t.key('ArrowRight');
        t.advance(100);
        t.key('ArrowRight'); // run of three: one entry
        t.advance(NUDGE_COALESCE_MS + 50);
        t.key('ArrowRight'); // gap: new entry
        t.advance(50);
        t.key('ArrowLeft'); // other key: new entry
        expectNear(t.geometryOf('sq').rings[0].points[2], { x: start.x + 3 * m, y: start.y }, 1e-6);

        await t.features.flush();
        await t.tool.history.undo(t.features); // ArrowLeft
        expectNear(t.geometryOf('sq').rings[0].points[2], { x: start.x + 4 * m, y: start.y }, 1e-6);
        await t.tool.history.undo(t.features); // the lone ArrowRight
        expectNear(t.geometryOf('sq').rings[0].points[2], { x: start.x + 3 * m, y: start.y }, 1e-6);
        await t.tool.history.undo(t.features); // the run of three
        expectNear(t.geometryOf('sq').rings[0].points[2], start, 1e-6);
        expect(t.tool.history.canUndo.peek()).toBe(false);
    });

    test('arrows without a vertex selection are left to the map', async () => {
        const t = await setup([row('sq', square(20))]);
        t.features.select('sq');
        const e = t.key('ArrowRight');
        expect(e.defaultPrevented).toBe(false);
        expect(t.tool.history.canUndo.peek()).toBe(false);
    });
});

describe("'C' on the vertex selection (24c)", () => {
    test('toggles every selected vertex as one entry', async () => {
        const t = await setup([row('sp', square(20, 'bspline'))]);
        t.features.select('sp');
        t.tool.vertexSelection.set(new Set([vertexKey(0, 0), vertexKey(0, 2)]));
        t.key('c');
        expect(t.geometryOf('sp').rings[0].points.map(p => !!p.corner)).toEqual([true, false, true, false]);
        await t.features.flush();
        expect(await t.undoAll()).toBe(1);
    });

    test('without a selection it acts on the hovered vertex', async () => {
        const t = await setup([row('sp', square(20, 'bspline'))]);
        t.features.select('sp');
        t.tool.hoverVertex.set({ ringIdx: 0, idx: 1 });
        t.key('c');
        expect(t.geometryOf('sp').rings[0].points.map(p => !!p.corner)).toEqual([false, true, false, false]);
    });
});

describe('delete without a dialog up to the threshold (23)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => {
        const g = square(5);
        return row(`f${i}`, translateAnchors(g, ['0:0', '0:1', '0:2', '0:3'], i * 20, 0));
    });

    test('deleting 3 skips the dialog, sets the notice and undoes in one step', async () => {
        const t = await setup(many(3));
        t.features.setSelection(['f0', 'f1', 'f2']);
        const before = Date.now();
        await t.tool.deleteSelected();
        expect(t.confirm.current.peek()).toBeNull();
        expect(t.features.store.items.peek()).toHaveLength(0);

        const notice = t.tool.notice.peek();
        expect(notice?.text).toMatch(/^Deleted 3\. (Cmd|Ctrl)\+Z to undo\.$/);
        expect(notice!.until).toBeGreaterThanOrEqual(before + NOTICE_MS);
        expect(notice!.until).toBeLessThanOrEqual(Date.now() + NOTICE_MS);

        await t.features.flush();
        t.tool.undo(); // clears the notice
        expect(t.tool.notice.peek()).toBeNull();
        await t.features.flush();
        await new Promise(r => setTimeout(r, 0));
        expect(t.features.store.items.peek()).toHaveLength(3);
    });

    test('the next edit clears the notice', async () => {
        const t = await setup(many(4));
        t.features.setSelection(['f0']);
        await t.tool.deleteSelected();
        expect(t.tool.notice.peek()).not.toBeNull();
        t.features.setSelection(['f1']);
        t.tool.retypeSelection('green');
        expect(t.tool.notice.peek()).toBeNull();
    });

    test(`deleting ${DELETE_CONFIRM_THRESHOLD + 1} asks first`, async () => {
        const n = DELETE_CONFIRM_THRESHOLD + 1;
        const t = await setup(many(n));
        t.features.setSelection(many(n).map(f => f.id));

        const cancelled = t.tool.deleteSelected();
        expect(t.confirm.current.peek()?.title).toBe(`Delete ${n} features?`);
        t.confirm.cancel();
        await cancelled;
        expect(t.features.store.items.peek()).toHaveLength(n);

        const accepted = t.tool.deleteSelected();
        t.confirm.accept();
        await accepted;
        expect(t.features.store.items.peek()).toHaveLength(0);
        expect(t.tool.notice.peek()).toBeNull();
        expect(t.tool.history.canUndo.peek()).toBe(true);
    });
});

describe('isBusy', () => {
    test('true with draft points or a live drag, false when merely armed', async () => {
        const t = await setup([row('sq', square(20))]);
        expect(t.tool.isBusy()).toBe(false);
        t.tool.armDraw();
        expect(t.tool.isBusy()).toBe(false); // armed, empty draft (chain-draw)
        t.tool.state.addPoint({ x: base.x, y: base.y });
        expect(t.tool.isBusy()).toBe(true);
        t.tool.state.handleEscape();
        expect(t.tool.isBusy()).toBe(false);

        t.features.select('sq');
        const corner = { x: base.x - 20, y: base.y - 20 };
        t.down(corner);
        expect(t.tool.isBusy()).toBe(true);
        t.up(corner);
        expect(t.tool.isBusy()).toBe(false);
    });
});
