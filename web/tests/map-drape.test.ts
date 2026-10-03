import { afterEach, describe, expect, test } from 'bun:test';
import { MapService, type OverlayLayerSpec } from '../src/map/map.service';

// Drape repair bookkeeping (review item 12), driven through a fake maplibre
// map: the gesture-end full freeRtt runs only when a draped overlay changed
// during the gesture, and the per-tile free skips circle/symbol-only overlays.

const EMPTY = { type: 'FeatureCollection', features: [] } as const;

function fakeMap() {
    const handlers = new Map<string, Set<(e: any) => void>>();
    const sources: Record<string, any> = {};
    const layers: any[] = [];
    const setDataCalls: Array<{ id: string; resolve: () => void }> = [];
    const rttTile = { tileID: { canonical: { z: 18, x: 100, y: 200 } }, rtt: ['texture'] as unknown[] };
    const terrain = { tileManager: { _tiles: { a: rttTile } as Record<string, typeof rttTile>, freeRttCalls: 0, freeRtt() { this.freeRttCalls++; } } };
    const map = {
        terrain,
        repaints: 0,
        triggerRepaint() { this.repaints++; },
        on(type: string, fn: (e: any) => void) { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn); },
        off(type: string, fn: (e: any) => void) { handlers.get(type)?.delete(fn); },
        addSource(id: string) {
            sources[id] = {
                type: 'geojson',
                setData: () => new Promise<void>(resolve => setDataCalls.push({ id, resolve })),
            };
        },
        getSource: (id: string) => sources[id],
        addLayer: (layer: any) => { layers.push(layer); },
        getLayer: (id: string) => layers.find(l => l.id === id),
        moveLayer: () => {},
        removeLayer: (id: string) => { const i = layers.findIndex(l => l.id === id); if (i >= 0) layers.splice(i, 1); },
        removeSource: (id: string) => { delete sources[id]; },
        remove: () => {},
    };
    const emit = (type: string, e: any) => { for (const fn of [...(handlers.get(type) ?? [])]) fn(e); };
    return { map, emit, setDataCalls, terrain, rttTile };
}

interface Internals {
    onGestureStart(): void;
    onGestureEnd(): void;
    onOverlaySourceData(e: unknown): void;
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const REPAIR_WAIT = 200;

const FILL: OverlayLayerSpec[] = [{ id: 'shapes-fill', type: 'fill', paint: {} }];
const MARKERS: OverlayLayerSpec[] = [{ id: 'markers-points', type: 'circle', paint: {} }];
const MIXED: OverlayLayerSpec[] = [
    { id: 'draft-line', type: 'line', paint: {} },
    { id: 'draft-points', type: 'circle', paint: {} },
];

let services: MapService[] = [];
afterEach(() => { for (const svc of services) svc.destroy(); services = []; });

async function setup() {
    const svc = new MapService();
    services.push(svc);
    const f = fakeMap();
    svc.map.set(f.map as never);
    svc.ready.set(true);
    svc.addOverlayLayer('shapes', EMPTY as never, FILL);
    svc.addOverlayLayer('markers', EMPTY as never, MARKERS);
    svc.addOverlayLayer('draft', EMPTY as never, MIXED);
    // Let every source's initial load settle so updates pump straight away.
    for (const id of ['shapes', 'markers', 'draft']) f.emit('sourcedata', { sourceId: id, isSourceLoaded: true });
    await tick();
    return { svc, f, internals: svc as unknown as Internals };
}

async function settle(f: ReturnType<typeof fakeMap>): Promise<void> {
    for (const call of f.setDataCalls.splice(0)) call.resolve();
    await tick();
}

describe('gesture-end drape repair', () => {
    test('no repair after a pan with no overlay change', async () => {
        const { f, internals } = await setup();
        internals.onGestureStart();
        internals.onGestureEnd();
        internals.onGestureEnd(); // zoomend + moveend
        await tick(REPAIR_WAIT);
        expect(f.terrain.tileManager.freeRttCalls).toBe(0);
    });

    test('one repair after a pan during which a draped overlay updated', async () => {
        const { svc, f, internals } = await setup();
        internals.onGestureStart();
        svc.updateOverlayData('shapes', EMPTY as never);
        expect(f.setDataCalls.map(c => c.id)).toEqual(['shapes']);
        await settle(f);
        internals.onGestureEnd();
        internals.onGestureEnd();
        await tick(REPAIR_WAIT);
        expect(f.terrain.tileManager.freeRttCalls).toBe(1);

        // The flag cleared: the next quiet pan repairs nothing.
        internals.onGestureStart();
        internals.onGestureEnd();
        await tick(REPAIR_WAIT);
        expect(f.terrain.tileManager.freeRttCalls).toBe(1);
    });

    test('a setData still in flight at movestart counts as a change', async () => {
        const { svc, f, internals } = await setup();
        svc.updateOverlayData('draft', EMPTY as never);
        internals.onGestureStart();
        await settle(f);
        internals.onGestureEnd();
        await tick(REPAIR_WAIT);
        expect(f.terrain.tileManager.freeRttCalls).toBe(1);
    });

    test('an update outside any gesture schedules no full repair', async () => {
        const { svc, f, internals } = await setup();
        svc.updateOverlayData('shapes', EMPTY as never);
        await settle(f);
        internals.onGestureStart();
        internals.onGestureEnd();
        await tick(REPAIR_WAIT);
        expect(f.terrain.tileManager.freeRttCalls).toBe(0);
    });

    test('a circle-only overlay update during a pan schedules no repair', async () => {
        const { svc, f, internals } = await setup();
        internals.onGestureStart();
        svc.updateOverlayData('markers', EMPTY as never);
        await settle(f);
        internals.onGestureEnd();
        await tick(REPAIR_WAIT);
        expect(f.terrain.tileManager.freeRttCalls).toBe(0);
    });
});

describe('per-tile drape free on overlay sourcedata', () => {
    const tileEvent = (sourceId: string) => ({
        dataType: 'source',
        sourceId,
        tile: { tileID: { canonical: { z: 18, x: 100, y: 200 } } },
    });

    test('skipped for a circle-only overlay', async () => {
        const { f, internals } = await setup();
        internals.onOverlaySourceData(tileEvent('markers'));
        expect(f.rttTile.rtt).toEqual(['texture']);
        expect(f.map.repaints).toBe(0);
    });

    test('kept for a mixed line + circle overlay (the draw preview)', async () => {
        const { f, internals } = await setup();
        internals.onOverlaySourceData(tileEvent('draft'));
        expect(f.rttTile.rtt).toEqual([]);
        expect(f.map.repaints).toBe(1);
    });

    test('kept for a fill overlay; skipped after it is removed', async () => {
        const { svc, f, internals } = await setup();
        internals.onOverlaySourceData(tileEvent('shapes'));
        expect(f.rttTile.rtt).toEqual([]);
        f.rttTile.rtt = ['texture'];
        svc.removeOverlayLayer('shapes');
        internals.onOverlaySourceData(tileEvent('shapes'));
        expect(f.rttTile.rtt).toEqual(['texture']);
    });
});
