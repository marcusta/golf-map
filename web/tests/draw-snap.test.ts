import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { ScreenPointCache } from '../src/draw/screen-cache';
import { flatGeometry } from '../src/geo/flat-cache';
import { HIT_FLATTEN_TOL_M, SNAP_PX, resolveSnap, snapBypassed, type SnapFeature } from '../src/draw/draw-snap';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry, Point } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Draw snapping (review item 25). The fake map projects EPSG:3006 to screen
// linearly at K px per meter around `base` (y down), through the same
// lng/lat round trip the real flat transform sees.

const base = wgs84ToSweref99tm(58.4015, 15.5658);
const K = 4;

function fakeTransform() {
    return {
        locationToScreenPoint: ({ lng, lat }: { lng: number; lat: number }) => {
            const s = wgs84ToSweref99tm(lat, lng);
            return { x: (s.x - base.x) * K, y: (base.y - s.y) * K };
        },
    };
}

function fakeMap(): MaplibreMap {
    return { transform: fakeTransform(), project: () => { throw new Error('map.project must not be called'); } } as unknown as MaplibreMap;
}

/** EPSG:3006 point at screen (sx, sy). */
function world(sx: number, sy: number): Point {
    return { x: base.x + sx / K, y: base.y - sy / K };
}

function square(id: string, sx: number, sy: number, sizePx: number, curveType?: 'bspline', corner = false): SnapFeature {
    const pts = [[0, 0], [sizePx, 0], [sizePx, sizePx], [0, sizePx]].map(([dx, dy]) => ({
        ...world(sx + dx, sy + dy), ...(corner ? { corner: true } : {}),
    }));
    const geometry: FeatureGeometry = { crs: 'EPSG:3006', ...(curveType ? { curveType } : {}), rings: [{ points: pts }] };
    return { id, geometry };
}

function snapAt(features: SnapFeature[], sx: number, sy: number, opts: { bypass?: boolean; excludeId?: string | null; skip?: (f: SnapFeature) => boolean } = {}) {
    return resolveSnap(
        features,
        { screen: { x: sx, y: sy }, world: world(sx, sy), bypass: opts.bypass ?? false, excludeId: opts.excludeId ?? null },
        fakeMap(),
        new ScreenPointCache(),
        opts.skip,
    );
}

describe('resolveSnap', () => {
    test('an anchor in range beats a nearer edge', () => {
        // A's corner (100, 100) is 6 px from the pointer; B's left edge
        // (x = 108) is 2 px from it.
        const a = square('A', 40, 40, 60);
        const b = square('B', 108, 60, 80);
        const hit = snapAt([b, a], 106, 100);
        expect(hit?.kind).toBe('anchor');
        expect(hit?.featureId).toBe('A');
        // The snapped point is the anchor's own coordinates, not a re-projection.
        expect(hit?.point).toEqual({ x: a.geometry.rings[0].points[2].x, y: a.geometry.rings[0].points[2].y });
    });

    test('nearest anchor wins across features', () => {
        const a = square('A', 0, 0, 100); // corner at (100, 100)
        const b = square('B', 105, 105, 50); // corner at (105, 105)
        const hit = snapAt([a, b], 104, 104);
        expect(hit?.featureId).toBe('B');
        expect(hit?.point).toEqual({ x: b.geometry.rings[0].points[0].x, y: b.geometry.rings[0].points[0].y });
        expect(hit?.dist).toBeCloseTo(Math.SQRT2, 1);
    });

    test('edge snap lands on the outline when no anchor is in range', () => {
        const a = square('A', 0, 0, 200);
        const hit = snapAt([a], 100, 205);
        expect(hit?.kind).toBe('edge');
        // The lng/lat round trip costs a few thousandths of a pixel.
        expect(hit?.screen.x).toBeCloseTo(100, 1);
        expect(hit?.screen.y).toBeCloseTo(200, 1);
        expect(hit?.point.y).toBeCloseTo(world(0, 200).y, 3);
    });

    test('radius boundary: in at SNAP_PX - 0.1, out at SNAP_PX + 0.1', () => {
        const a = square('A', 0, 0, 200);
        expect(snapAt([a], 200 + SNAP_PX - 0.1, 200)?.kind).toBe('anchor');
        expect(snapAt([a], 200 + SNAP_PX + 0.1, 200)).toBeNull();
        // Edge: 100 px from both corners, so only the edge can match.
        expect(snapAt([a], 100, 200 + SNAP_PX - 0.1)?.kind).toBe('edge');
        expect(snapAt([a], 100, 200 + SNAP_PX + 0.1)).toBeNull();
    });

    test('the excluded feature is never a target', () => {
        const self = square('self', 0, 0, 100);
        const other = square('other', 0, 0, 300);
        expect(snapAt([self, other], 101, 101, { excludeId: 'self' })).toBeNull();
        expect(snapAt([self, other], 101, 299, { excludeId: 'self' })?.featureId).toBe('other');
    });

    test('skip drops hidden features', () => {
        const a = square('A', 0, 0, 100);
        expect(snapAt([a], 101, 101, { skip: f => f.id === 'A' })).toBeNull();
    });

    test('bypass turns snapping off; Cmd and Ctrl both bypass', () => {
        const a = square('A', 0, 0, 100);
        expect(snapAt([a], 101, 101, { bypass: true })).toBeNull();
        const ev = (metaKey: boolean, ctrlKey: boolean) => ({ point: { x: 0, y: 0 }, originalEvent: { metaKey, ctrlKey } });
        expect(snapBypassed(ev(true, false))).toBe(true);
        expect(snapBypassed(ev(false, true))).toBe(true);
        expect(snapBypassed(ev(false, false))).toBe(false);
    });

    test('b-spline: smooth controls are not anchors, the flattened curve is the edge, corners are anchors', () => {
        const smooth = square('S', 0, 0, 200, 'bspline');
        // A smooth control lies off the curve: no anchor snap at it.
        expect(snapAt([smooth], 201, 201)).toBeNull();
        // The edge snap lands on the flattened curve: aim 5 px outside a
        // point of it, along +y (the bottom of the rounded shape).
        const flat = flatGeometry(smooth.geometry, HIT_FLATTEN_TOL_M).rings[0].pts;
        const bottom = flat.reduce((a, b) => (b[1] < a[1] ? b : a));
        const sx = (bottom[0] - base.x) * K, sy = (base.y - bottom[1]) * K;
        const onCurve = snapAt([smooth], sx, sy + 5);
        expect(onCurve?.kind).toBe('edge');
        expect(onCurve?.screen.y).toBeCloseTo(sy, 0);
        const corner = square('C', 0, 0, 200, 'bspline', true);
        const hit = snapAt([corner], 203, 203);
        expect(hit?.kind).toBe('anchor');
        expect(hit?.point.x).toBe(corner.geometry.rings[0].points[2].x);
    });
});

// ─── Through the pointer binding ──────────────────────────────────────────

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

function row(id: string, geometry: FeatureGeometry, i: number): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, type: 'bunker', geometry,
        sortOrder: i, source: null, sourceRef: null, license: null, attributes: null, version: 1,
    };
}

function api(rows: CourseFeature[]): CourseFeaturesApi {
    return {
        listByCourse: async () => rows.map(r => structuredClone(r)),
        listByHole: () => Promise.reject(new Error('not under test')),
        geojsonByCourse: () => Promise.reject(new Error('not under test')),
        create: () => Promise.reject(new Error('not under test')),
        update: async input => ({ ...rows.find(r => r.id === input.id)!, ...input, version: input.version + 1 }) as CourseFeature,
        remove: async () => ({ ok: true }),
        reorder: () => Promise.reject(new Error('not under test')),
    } as CourseFeaturesApi;
}

async function setup(rows: CourseFeature[]) {
    const detail = new CourseDetailService();
    detail.holeStore.set([]);
    di.set(CourseDetailService, detail);
    di.set(ConfirmService, new ConfirmService());
    const features = new FeaturesService(api(rows));
    await features.load('c1');

    const clickHandlers: Array<(e: MapPointerEvent) => void> = [];
    const moveHandlers: Array<(e: MapPointerEvent) => void> = [];
    const glHandlers = new Map<string, Set<(e: unknown) => void>>();
    const glMap = {
        transform: fakeTransform(),
        project: () => { throw new Error('map.project must not be called'); },
        on(type: string, h: (e: unknown) => void) {
            let set = glHandlers.get(type);
            if (!set) glHandlers.set(type, set = new Set());
            set.add(h);
        },
        off(type: string, h: (e: unknown) => void) { glHandlers.get(type)?.delete(h); },
        once() {}, getCanvas: () => ({ style: {} }),
        dragPan: { enable() {}, disable() {} }, boxZoom: { enable() {}, disable() {} }, doubleClickZoom: { enable() {}, disable() {} },
        setPaintProperty() {}, setFilter() {}, getSource: () => ({ type: 'geojson' }),
    };
    const map = {
        ready: new Signal(true),
        map: new Signal(glMap),
        zoom: new Signal(20),
        interactionMode: new Signal(DRAW_TOOL_ID),
        onClick: (h: (e: MapPointerEvent) => void) => { clickHandlers.push(h); return () => {}; },
        onMouseMove: (h: (e: MapPointerEvent) => void) => { moveHandlers.push(h); return () => {}; },
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
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
    let queued: Array<() => void> = [];
    tool.frameScheduler = cb => { queued.push(cb); };
    const frame = (): void => {
        const run = queued;
        queued = [];
        for (const cb of run) cb();
    };
    tool.activate(ctx);

    const pointer = (type: string, sx: number, sy: number, init: MouseEventInit = {}): MapPointerEvent => {
        const w = world(sx, sy);
        const { lat, lon } = sweref99tmToWgs84(w.x, w.y);
        return { lngLat: { lng: lon, lat }, point: { x: sx, y: sy }, originalEvent: new MouseEvent(type, init) };
    };
    const click = (sx: number, sy: number, init: MouseEventInit = {}): void => {
        for (const h of clickHandlers) h(pointer('click', sx, sy, init));
    };
    const move = (sx: number, sy: number, init: MouseEventInit = {}): void => {
        for (const h of moveHandlers) h(pointer('mousemove', sx, sy, init));
        frame();
    };
    const gl = (type: 'mousedown' | 'mouseup', sx: number, sy: number, init: MouseEventInit = {}): void => {
        const e = { ...pointer(type, sx, sy, { button: 0, ...init }), preventDefault() {} } as unknown as MapMouseEvent;
        for (const h of glHandlers.get(type) ?? []) h(e);
    };
    const preview = () => (tool as unknown as { previewGeojson(): { features: Array<{ properties: { role: string } }> } }).previewGeojson();
    return { tool, features, click, move, gl, frame, preview };
}

describe('draw tool snapping', () => {
    const neighbour = square('N', 0, 0, 100).geometry;
    const corner = neighbour.rings[0].points[2]; // screen (100, 100)

    test('a draft click 5 px from a neighbour anchor lands exactly on it; Cmd-click does not snap', async () => {
        const t = await setup([row('N', neighbour, 0)]);
        t.tool.armDraw();
        t.move(104, 103);
        expect(t.preview().features.some(f => f.properties.role === 'snap-anchor')).toBe(true);
        t.click(104, 103);
        expect(t.tool.state.draft.peek()[0]).toMatchObject({ x: corner.x, y: corner.y });

        t.click(104, 103, { metaKey: true });
        const raw = t.tool.state.draft.peek()[1];
        expect(raw.x).not.toBe(corner.x);
        expect(raw.x).toBeCloseTo(world(104, 103).x, 6);
    });

    test('a vertex drag snaps to a neighbour anchor and excludes its own feature', async () => {
        const mine = square('M', 150, 150, 100).geometry; // corner 0 at (150, 150)
        const t = await setup([row('N', neighbour, 0), row('M', mine, 1)]);
        t.features.select('M');
        t.gl('mousedown', 150, 150);
        t.move(130, 130, { buttons: 1 });
        t.move(105, 104, { buttons: 1 });
        expect(t.preview().features.some(f => f.properties.role === 'snap-anchor')).toBe(true);
        t.gl('mouseup', 105, 104);
        const moved = t.features.store.items.peek().find(f => f.id === 'M')!.geometry.rings[0].points[0];
        expect(moved).toMatchObject({ x: corner.x, y: corner.y });
        expect(t.preview().features.some(f => f.properties.role.startsWith('snap-'))).toBe(false);
    });
});
