import { afterEach, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// House rule: hover hit-testing is off while a mouse button is held (pan or
// drag). The hover scan projects the selected shape's vertices through the
// map's flat transform, once per camera state (screen-cache.ts), so counting
// calls to that transform counts cache builds.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const base = wgs84ToSweref99tm(58.4015, 15.5658);

function polygon(n: number, r: number, cx: number, cy: number): FeatureGeometry {
    const points = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return { crs: 'EPSG:3006', rings: [{ points }] };
}

function feature(id: string, i: number, verts: number): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, type: 'bunker',
        geometry: polygon(verts, 5, base.x + (i % 20) * 30, base.y + Math.floor(i / 20) * 30),
        sortOrder: i, source: null, sourceRef: null, license: null, attributes: null, version: 1,
    };
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

async function setup() {
    const detail = new CourseDetailService();
    detail.holeStore.set([]);
    di.set(CourseDetailService, detail);
    di.set(ConfirmService, new ConfirmService());

    const rows = Array.from({ length: 300 }, (_, i) => feature(`f${i}`, i, 12));
    const features = new FeaturesService(listOnlyApi(rows));
    await features.load('c1');

    const moveHandlers: Array<(e: MapPointerEvent) => void> = [];
    const glHandlers = new Map<string, Set<() => void>>();
    let projections = 0;
    const glMap = {
        // Counts one vertex or handle projection of the hover scan.
        transform: { locationToScreenPoint: () => { projections++; return { x: -1e6, y: -1e6 }; } },
        project: () => { projections++; return { x: -1e6, y: -1e6 }; },
        on(type: string, h: () => void) {
            let set = glHandlers.get(type);
            if (!set) glHandlers.set(type, set = new Set());
            set.add(h);
        },
        off(type: string, h: () => void) { glHandlers.get(type)?.delete(h); },
        once() {}, getCanvas: () => ({ style: {} }),
        dragPan: { enable() {}, disable() {} }, boxZoom: { enable() {}, disable() {} }, doubleClickZoom: { enable() {}, disable() {} },
        setPaintProperty() {}, setFilter() {}, getSource: () => ({ type: 'geojson' }),
    };
    const map = {
        ready: new Signal(true),
        map: new Signal(glMap),
        zoom: new Signal(18),
        interactionMode: new Signal(DRAW_TOOL_ID),
        onClick: () => () => {},
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
    features.select('f7');
    expect(features.editableSelected.peek()?.id).toBe('f7');

    const move = (i: number, buttons: number): void => {
        const e: MapPointerEvent = {
            lngLat: { lng: 15.5 + i * 1e-5, lat: 58.4 + i * 1e-5 },
            point: { x: 100 + i, y: 100 + i },
            originalEvent: new MouseEvent('mousemove', { buttons }),
        };
        for (const h of moveHandlers) h(e);
        frame();
    };
    // A camera change: MapLibre fires `move` on the gl map.
    const cameraMove = (): void => {
        for (const h of glHandlers.get('move') ?? []) h();
    };
    return {
        move, cameraMove, features,
        projections: () => projections, handlerCount: () => moveHandlers.length,
    };
}

test('hover scan: zero hit-tests per move while a button is held, cached between camera moves when not', async () => {
    const t = await setup();
    expect(t.handlerCount()).toBeGreaterThan(0);
    const verts = 12;

    // Button up, camera still: the first move projects every vertex once,
    // later moves hit the cache and project nothing.
    let before = t.projections();
    t.move(0, 0);
    expect(t.projections() - before).toBe(verts);
    for (let i = 1; i < 10; i++) {
        before = t.projections();
        t.move(i, 0);
        expect(t.projections() - before).toBe(0);
    }

    // Button down (pan): no projections at all, even across camera moves.
    const heldBefore = t.projections();
    for (let i = 10; i < 60; i++) {
        t.cameraMove();
        t.move(i, 1);
    }
    expect(t.projections() - heldBefore).toBe(0);

    // Release after the pan moved the camera: the scan projects again once.
    before = t.projections();
    t.move(60, 0);
    expect(t.projections() - before).toBe(verts);
    before = t.projections();
    t.move(61, 0);
    expect(t.projections() - before).toBe(0);

    // A `move` event alone invalidates: the next buttonless move projects.
    t.cameraMove();
    before = t.projections();
    t.move(62, 0);
    expect(t.projections() - before).toBe(verts);

    // A new geometry identity (another feature selected) projects too.
    t.features.select('f8');
    before = t.projections();
    t.move(63, 0);
    expect(t.projections() - before).toBe(verts);
});
