import { afterEach, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { FeatureCollection } from 'geojson';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FurnitureService, FURNITURE_TOOL_ID } from '../src/furniture/furniture.service';
import { FurnitureToolService } from '../src/furniture/furniture-tool.service';
import { FURNITURE_DRAG_OVERLAY_ID, FURNITURE_OVERLAY_ID } from '../src/furniture/furniture-overlay';
import type { Tee, TeesApi } from '../../shared/api/tees.gen';
import type { Green, GreensApi } from '../../shared/api/greens.gen';
import type { PinsApi } from '../../shared/api/pins.gen';
import type { AimPointsApi } from '../../shared/api/aim-points.gen';

// Marker drag on the furniture tool. The moving marker renders through a
// one-feature drag overlay; the main overlay keeps its pre-drag data until
// mouseup and rebuilds once there. Hit tests use the flat transform and
// never call terrain-aware `map.project`.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups.reverse()) c();
    cleanups = [];
    _reset();
    di.reset();
});

const LAT0 = 58.4;
const LON0 = 15.5;
/** Screen px per degree in the fake flat transform. */
const PX = 1e5;

const toScreen = (lng: number, lat: number) => ({ x: (lng - LON0) * PX, y: (LAT0 - lat) * PX });
const toLngLat = (x: number, y: number) => ({ lng: LON0 + x / PX, lat: LAT0 - y / PX });

function tee(i: number): Tee {
    // 20 per row, 40 px apart: far outside each other's 14 px hit radius.
    const { lng, lat } = toLngLat(100 + (i % 20) * 40, 100 + Math.floor(i / 20) * 40);
    return { id: `t${i}`, holeId: 'h1', name: `T${i}`, color: 'white', lat, lon: lng, elevation: null, sortOrder: i, version: 1 };
}

function teesApi(updates: Array<{ id: string; lat?: number; lon?: number }>): TeesApi {
    return {
        listByHole: async () => [],
        listByCourse: async () => [],
        create: () => Promise.reject(new Error('not under test')),
        update: async input => {
            updates.push({ id: input.id, lat: input.lat, lon: input.lon });
            return { ...tee(Number(input.id.slice(1))), lat: input.lat!, lon: input.lon!, version: input.version + 1 };
        },
        remove: () => Promise.reject(new Error('not under test')),
        reorder: () => Promise.reject(new Error('not under test')),
    } as TeesApi;
}

const GREEN_CENTER = toLngLat(1000, 1000);
const green: Green = {
    id: 'g1', holeId: 'h1', boundaryJson: null,
    centerLat: GREEN_CENTER.lat, centerLon: GREEN_CENTER.lng,
    frontLat: null, frontLon: null, backLat: null, backLon: null, elevation: null, version: 1,
};

function greensApi(updates: Array<Parameters<GreensApi['update']>[0]>): GreensApi {
    return {
        getByHole: async () => null,
        create: () => Promise.reject(new Error('not under test')),
        update: async input => {
            updates.push(input);
            return { ...green, ...input, version: input.version + 1 } as Green;
        },
    };
}

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error('not under test')) });

function setup(markers: number) {
    const detail = new CourseDetailService();
    detail.holeStore.set([]);
    di.set(CourseDetailService, detail);
    di.set(ConfirmService, new ConfirmService());
    const saves: Array<{ id: string; lat?: number; lon?: number }> = [];
    const greenSaves: Array<Parameters<GreensApi['update']>[0]> = [];
    const svc = new FurnitureService(teesApi(saves), greensApi(greenSaves), unused as PinsApi, unused as AimPointsApi);
    di.set(FurnitureService, svc);
    svc.tees.set(Array.from({ length: markers }, (_, i) => tee(i)));
    svc.greens.set([green]);

    const updates = new Map<string, FeatureCollection[]>();
    const record = (id: string, data: unknown): void => {
        let list = updates.get(id);
        if (!list) updates.set(id, list = []);
        list.push(data as FeatureCollection);
    };
    const gl = new Map<string, Set<(e: unknown) => void>>();
    let dragPanEnabled = true;
    const glMap = {
        transform: { locationToScreenPoint: (l: { lng: number; lat: number }) => toScreen(l.lng, l.lat) },
        project: () => { throw new Error('terrain-aware map.project called'); },
        on(type: string, h: (e: unknown) => void) {
            let set = gl.get(type);
            if (!set) gl.set(type, set = new Set());
            set.add(h);
        },
        off(type: string, h: (e: unknown) => void) { gl.get(type)?.delete(h); },
        dragPan: { enable() { dragPanEnabled = true; }, disable() { dragPanEnabled = false; } },
    };
    const moveHandlers: Array<(e: MapPointerEvent) => void> = [];
    const clickHandlers: Array<(e: MapPointerEvent) => void> = [];
    const map = {
        ready: new Signal(true),
        map: new Signal(glMap),
        interactionMode: new Signal<string | null>(FURNITURE_TOOL_ID),
        onClick: (h: (e: MapPointerEvent) => void) => { clickHandlers.push(h); return () => {}; },
        onMouseMove: (h: (e: MapPointerEvent) => void) => { moveHandlers.push(h); return () => {}; },
        addOverlayLayer: (id: string, data: unknown) => record(`add:${id}`, data),
        updateOverlayData: (id: string, data: unknown) => record(id, data),
        removeOverlayLayer: () => {},
    };
    const ctx: ToolContext = {
        map: map as never,
        elevation: { elevationAt: async () => null } as never,
        tileset: null as never,
        courseDetail: detail,
        features: null as never,
        courseId: 'c1',
        track: (d: () => void) => { cleanups.push(d); },
    };
    const tool = new FurnitureToolService();
    tool.attach(ctx);
    tool.activate(ctx);
    cleanups.push(() => tool.deactivate());

    const raw = (type: string, x: number, y: number): void => {
        const e = {
            point: { x, y },
            lngLat: toLngLat(x, y),
            originalEvent: new MouseEvent(type, { button: 0 }),
            preventDefault() {},
        };
        for (const h of gl.get(type) ?? []) h(e);
    };
    const pointer = (handlers: Array<(e: MapPointerEvent) => void>, type: string, x: number, y: number): void => {
        const e: MapPointerEvent = { point: { x, y }, lngLat: toLngLat(x, y), originalEvent: new MouseEvent(type, { buttons: type === 'mousemove' ? 1 : 0 }) };
        for (const h of handlers) h(e);
    };
    const count = (id: string): number => updates.get(id)?.length ?? 0;
    return {
        svc, saves, greenSaves, updates, count,
        down: (x: number, y: number) => raw('mousedown', x, y),
        up: (x: number, y: number) => raw('mouseup', x, y),
        move: (x: number, y: number) => pointer(moveHandlers, 'mousemove', x, y),
        click: (x: number, y: number) => pointer(clickHandlers, 'click', x, y),
        dragPanEnabled: () => dragPanEnabled,
        deactivate: () => tool.deactivate(),
    };
}

const last = (list: FeatureCollection[] | undefined): FeatureCollection => list![list!.length - 1];

test('marker drag: main overlay updates once on mouseup, drag overlay carries the moves', async () => {
    const N = 30;
    const t = setup(200);
    const target = tee(25);
    const start = toScreen(target.lon, target.lat);

    t.down(start.x + 3, start.y - 2);
    expect(t.svc.selection.peek()).toEqual({ kind: 'tee', id: 't25' });
    expect(t.dragPanEnabled()).toBe(false);
    // Counting starts after mousedown: its selection change is a regular
    // main-overlay update (the selection ring), not part of the drag.
    const mainBefore = t.count(FURNITURE_OVERLAY_ID);
    const dragBefore = t.count(FURNITURE_DRAG_OVERLAY_ID);

    const t0 = performance.now();
    for (let i = 1; i <= N; i++) t.move(start.x + i * 5, start.y + i * 2);
    const msPerMove = (performance.now() - t0) / N;

    const mainDuringDrag = t.count(FURNITURE_OVERLAY_ID) - mainBefore;
    const dragDuringDrag = t.count(FURNITURE_DRAG_OVERLAY_ID) - dragBefore;
    expect(mainDuringDrag).toBe(0);
    expect(dragDuringDrag).toBeLessThanOrEqual(N);

    // The drag overlay holds exactly the moving marker at the pointer.
    const dragData = last(t.updates.get(FURNITURE_DRAG_OVERLAY_ID));
    expect(dragData.features).toHaveLength(1);
    const end = toLngLat(start.x + N * 5, start.y + N * 2);
    expect(dragData.features[0].properties).toMatchObject({ role: 'tee', id: 't25', selected: true });
    expect(dragData.features[0].geometry).toEqual({ type: 'Point', coordinates: [end.lng, end.lat] });
    // The store is untouched until the drop.
    expect(t.svc.tees.items.peek().find(x => x.id === 't25')!.lat).toBe(target.lat);

    t.up(start.x + N * 5, start.y + N * 2);
    const mainOnUp = t.count(FURNITURE_OVERLAY_ID) - mainBefore;
    const dragOnUp = t.count(FURNITURE_DRAG_OVERLAY_ID) - dragBefore - dragDuringDrag;
    expect(mainOnUp).toBe(1);
    expect(dragOnUp).toBe(1);
    expect(last(t.updates.get(FURNITURE_DRAG_OVERLAY_ID)).features).toHaveLength(0);
    const moved = last(t.updates.get(FURNITURE_OVERLAY_ID)).features.find(f => f.properties?.id === 't25')!;
    expect(moved.geometry).toEqual({ type: 'Point', coordinates: [end.lng, end.lat] });
    expect(t.dragPanEnabled()).toBe(true);
    // The click MapLibre synthesizes after the mouseup does not reselect.
    t.click(start.x, start.y);
    expect(t.svc.selection.peek()).toEqual({ kind: 'tee', id: 't25' });

    // Save path unchanged: one update with the dropped position, selection kept.
    await Bun.sleep(0);
    expect(t.saves).toEqual([{ id: 't25', lat: end.lat, lon: end.lng }]);
    expect(t.svc.selection.peek()).toEqual({ kind: 'tee', id: 't25' });
    const row = t.svc.tees.items.peek().find(x => x.id === 't25')!;
    expect([row.lat, row.lon]).toEqual([end.lat, end.lng]);

    console.log(`furniture drag, 200 markers, ${N} moves: main overlay ${mainDuringDrag} updates during drag + ${mainOnUp} on mouseup; drag overlay ${dragDuringDrag} + ${dragOnUp}; ${msPerMove.toFixed(3)} ms per move`);
});

test('a press without movement saves nothing and leaves both overlays alone', async () => {
    const t = setup(10);
    const p = toScreen(tee(3).lon, tee(3).lat);
    t.down(p.x, p.y);
    const main = t.count(FURNITURE_OVERLAY_ID);
    const drag = t.count(FURNITURE_DRAG_OVERLAY_ID);
    t.move(p.x + 1, p.y); // under the 2 px threshold
    t.up(p.x + 1, p.y);
    await Bun.sleep(0);
    expect(t.count(FURNITURE_OVERLAY_ID)).toBe(main);
    expect(t.count(FURNITURE_DRAG_OVERLAY_ID)).toBe(drag);
    expect(t.saves).toEqual([]);
    expect(t.svc.selection.peek()).toEqual({ kind: 'tee', id: 't3' });
});

test('hit tests on click and mousedown use the flat transform, never map.project', () => {
    // The fake map.project throws: any call fails the test.
    const t = setup(200);
    const p = toScreen(tee(150).lon, tee(150).lat);
    t.click(p.x + 4, p.y + 4);
    expect(t.svc.selection.peek()).toEqual({ kind: 'tee', id: 't150' });
    t.click(5, 5); // empty ground
    expect(t.svc.selection.peek()).toBeNull();
    t.down(p.x - 3, p.y);
    expect(t.svc.selection.peek()).toEqual({ kind: 'tee', id: 't150' });
    t.up(p.x - 3, p.y);
});

test('green point drag: main overlay updates once on mouseup, setGreenPoint saves the drop', async () => {
    const t = setup(20);
    t.down(1000, 1000);
    expect(t.svc.selection.peek()).toEqual({ kind: 'green', holeId: 'h1', point: 'center' });
    const main = t.count(FURNITURE_OVERLAY_ID);
    for (let i = 1; i <= 10; i++) t.move(1000 + i * 4, 1000);
    expect(t.count(FURNITURE_OVERLAY_ID)).toBe(main);
    expect(last(t.updates.get(FURNITURE_DRAG_OVERLAY_ID)).features[0].properties).toMatchObject({ role: 'green-center', holeId: 'h1' });
    t.up(1040, 1000);
    expect(t.count(FURNITURE_OVERLAY_ID)).toBe(main + 1);
    const end = toLngLat(1040, 1000);
    expect(t.svc.greens.peek()[0]).toMatchObject({ centerLat: end.lat, centerLon: end.lng });
    await Bun.sleep(0);
    expect(t.greenSaves).toEqual([{ id: 'g1', version: 1, centerLat: end.lat, centerLon: end.lng }]);
});

test('a drag cut short by deactivate drops the unsaved position', () => {
    const t = setup(10);
    const p = toScreen(tee(4).lon, tee(4).lat);
    t.down(p.x, p.y);
    t.move(p.x + 30, p.y);
    t.deactivate();
    expect(last(t.updates.get(FURNITURE_DRAG_OVERLAY_ID)).features).toHaveLength(0);
    expect(t.svc.tees.items.peek().find(x => x.id === 't4')).toMatchObject({ lat: tee(4).lat, lon: tee(4).lon });
    expect(t.saves).toEqual([]);
    expect(t.dragPanEnabled()).toBe(true);
});
