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
    // Style layer order, honoring beforeId like maplibre's addLayer/moveLayer.
    const insertLayer = (layer: any, beforeId?: string): void => {
        const i = beforeId === undefined ? -1 : layers.findIndex(l => l.id === beforeId);
        if (i >= 0) layers.splice(i, 0, layer);
        else layers.push(layer);
    };
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
                updateData: () => new Promise<void>(resolve => setDataCalls.push({ id, resolve })),
            };
        },
        getSource: (id: string) => sources[id],
        addLayer: insertLayer,
        getLayer: (id: string) => layers.find(l => l.id === id),
        getLayersOrder: () => layers.map(l => l.id),
        moveLayer: (id: string, beforeId?: string) => {
            insertLayer(layers.splice(layers.findIndex(l => l.id === id), 1)[0], beforeId);
        },
        removeLayer: (id: string) => { const i = layers.findIndex(l => l.id === id); if (i >= 0) layers.splice(i, 1); },
        removeSource: (id: string) => { delete sources[id]; },
        remove: () => {},
    };
    const emit = (type: string, e: any) => { for (const fn of [...(handlers.get(type) ?? [])]) fn(e); };
    return { map, emit, setDataCalls, terrain, rttTile, layers };
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

    test('an updateData diff during a pan counts as a change', async () => {
        const { svc, f, internals } = await setup();
        internals.onGestureStart();
        svc.updateOverlayDiff('shapes', { remove: ['f1'] }, EMPTY as never);
        expect(f.setDataCalls.map(c => c.id)).toEqual(['shapes']);
        await settle(f);
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

// Review item 13: circle/symbol layers between draped layers split the
// terrain render-to-texture stack, and with two or more stacks maplibre
// re-renders every draped tile every frame. addOverlayLayer keeps every
// draped layer below every non-draped one, keepOnTop holding within each
// group.
describe('overlay layer order keeps one draped run', () => {
    const DRAPED = new Set(['background', 'fill', 'line', 'raster', 'hillshade', 'color-relief']);

    /** Contiguous runs of draped layers, the way maplibre builds RTT stacks. */
    function stacks(layers: Array<{ id: string; type: string }>): string[][] {
        const out: string[][] = [];
        let prevDraped = false;
        for (const l of layers) {
            const draped = DRAPED.has(l.type);
            if (draped && !prevDraped) out.push([]);
            if (draped) out[out.length - 1].push(l.id);
            prevDraped = draped;
        }
        return out;
    }

    function service() {
        const svc = new MapService();
        services.push(svc);
        const f = fakeMap();
        // Base style: ortho raster + hillshade, both draped.
        f.map.addLayer({ id: 'ortho', type: 'raster' });
        f.map.addLayer({ id: 'hillshade', type: 'hillshade' });
        svc.map.set(f.map as never);
        svc.ready.set(true);
        return { svc, f };
    }

    test('fill+line, then circle, then a keepOnTop fill: draped run first, circles after', () => {
        const { svc, f } = service();
        svc.addOverlayLayer('features', EMPTY as never, [
            { id: 'features-fill', type: 'fill', paint: {} },
            { id: 'features-outline', type: 'line', paint: {} },
        ]);
        svc.addOverlayLayer('furniture', EMPTY as never, [{ id: 'furniture-points', type: 'circle', paint: {} }]);
        svc.addOverlayLayer('preview', EMPTY as never, [{ id: 'preview-fill', type: 'fill', paint: {} }], { keepOnTop: true });
        expect(f.layers.map(l => l.id)).toEqual([
            'ortho', 'hillshade', 'features-fill', 'features-outline', 'preview-fill', 'furniture-points',
        ]);
        expect(stacks(f.layers)).toHaveLength(1);
    });

    test('the draw preview (keepOnTop, lines + circles) added first stays on top of each group', () => {
        const { svc, f } = service();
        svc.addOverlayLayer('draw', EMPTY as never, [
            { id: 'draw-fill', type: 'fill', paint: {} },
            { id: 'draw-line', type: 'line', paint: {} },
            { id: 'draw-vertices', type: 'circle', paint: {} },
            { id: 'draw-handles', type: 'circle', paint: {} },
        ], { keepOnTop: true });
        svc.addOverlayLayer('features', EMPTY as never, [
            { id: 'features-fill', type: 'fill', paint: {} },
            { id: 'features-selected', type: 'line', paint: {} },
            { id: 'features-labels', type: 'symbol', layout: {} },
        ]);
        svc.addOverlayLayer('furniture', EMPTY as never, [
            { id: 'furniture-zones', type: 'line', paint: {} },
            { id: 'furniture-points', type: 'circle', paint: {} },
        ]);
        svc.addImageOverlay('clean', 'data:,', [[0, 1], [1, 1], [1, 0], [0, 0]]);
        expect(f.layers.map(l => l.id)).toEqual([
            'ortho', 'hillshade',
            'features-fill', 'features-selected', 'furniture-zones', 'clean',
            'draw-fill', 'draw-line',
            'features-labels', 'furniture-points',
            'draw-vertices', 'draw-handles',
        ]);
        expect(stacks(f.layers)).toHaveLength(1);
    });

    test('explicit beforeId: honored inside its group, clamped to the group edge across groups', () => {
        const { svc, f } = service();
        svc.addOverlayLayer('features', EMPTY as never, [
            { id: 'features-fill', type: 'fill', paint: {} },
            { id: 'features-selected', type: 'line', paint: {} },
        ]);
        svc.addOverlayLayer('marks', EMPTY as never, [{ id: 'marks-points', type: 'circle', paint: {} }]);
        // Same group: slots under the named layer.
        svc.addOverlayLayer('generated', EMPTY as never, [
            { id: 'generated-fill', type: 'fill', paint: {} },
        ], { beforeId: 'features-selected' });
        // A circle cloud asked to sit under the fills goes to the bottom of
        // the non-draped run instead of splitting the drape.
        svc.addOverlayLayer('scatter', EMPTY as never, [
            { id: 'scatter-points', type: 'circle', paint: {} },
        ], { beforeId: 'features-fill' });
        // A line asked to sit under a circle layer goes to the top of the drape.
        svc.addOverlayLayer('route', EMPTY as never, [
            { id: 'route-line', type: 'line', paint: {} },
        ], { beforeId: 'marks-points' });
        expect(f.layers.map(l => l.id)).toEqual([
            'ortho', 'hillshade', 'features-fill', 'generated-fill', 'features-selected', 'route-line',
            'scatter-points', 'marks-points',
        ]);
        expect(stacks(f.layers)).toHaveLength(1);
    });
});
