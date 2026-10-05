import { afterEach, describe, expect, test } from 'bun:test';
import type { FeatureCollection } from 'geojson';
import { MapService, type OverlayLayerSpec } from '../src/map/map.service';
import { WATER_LAYER_ID } from '../src/map/custom-layer-ids';
import { LazyCustomLayer } from '../src/map/lazy-custom-layer';
import type { WaterLayer } from '../src/map/water-layer';

// The three.js water and tree layers load through import() (review item 33).
// A late chunk must land in the slot the layer had when it was reserved, and
// the toggles must tolerate a load in flight. Driven through a fake maplibre
// map that keeps style layer order like addLayer/removeLayer do.

function fakeMap() {
    const layers: any[] = [];
    const map = {
        on() {},
        off() {},
        triggerRepaint() {},
        addSource() {},
        getSource: () => undefined,
        addLayer(layer: any, beforeId?: string) {
            const i = beforeId === undefined ? -1 : layers.findIndex(l => l.id === beforeId);
            if (i >= 0) layers.splice(i, 0, layer);
            else layers.push(layer);
        },
        getLayer: (id: string) => layers.find(l => l.id === id),
        getLayersOrder: () => layers.map(l => l.id),
        removeLayer(id: string) {
            const i = layers.findIndex(l => l.id === id);
            if (i >= 0) layers.splice(i, 1);
        },
        removeSource() {},
        remove() {},
    };
    return { map, layers };
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

/** Stands in for WaterLayer: the slot logic needs only the id and the data/enabled surface. */
function waterStandIn() {
    return {
        id: WATER_LAYER_ID,
        type: 'custom' as const,
        renderingMode: '3d' as const,
        enabled: true,
        data: null as FeatureCollection | null,
        render() {},
        setData(data: FeatureCollection) { this.data = data; },
    };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function water(id: string): FeatureCollection {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id, type: 'water' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] };
}

const SHAPES: OverlayLayerSpec[] = [{ id: 'shapes-fill', type: 'fill', paint: {} }];
const MARKERS: OverlayLayerSpec[] = [{ id: 'markers-points', type: 'circle', paint: {} }];
const DRAFT: OverlayLayerSpec[] = [
    { id: 'draft-line', type: 'line', paint: {} },
    { id: 'draft-points', type: 'circle', paint: {} },
];
const HOLES: OverlayLayerSpec[] = [{ id: 'holes-fill', type: 'fill', paint: {} }];
const LABELS: OverlayLayerSpec[] = [{ id: 'labels-points', type: 'circle', paint: {} }];

let services: MapService[] = [];
afterEach(() => { for (const svc of services) svc.destroy(); services = []; });

function setup() {
    const svc = new MapService();
    services.push(svc);
    const f = fakeMap();
    svc.map.set(f.map as never);
    svc.ready.set(true);
    const loads: Deferred<WaterLayer>[] = [];
    svc.loadWaterLayer = () => {
        const d = deferred<WaterLayer>();
        loads.push(d);
        return d.promise;
    };
    const toggleWater = (on: boolean) => (svc as unknown as { setWaterEnabled(on: boolean): void }).setWaterEnabled(on);
    return { svc, f, loads, toggleWater };
}

describe('lazy water layer', () => {
    test('a late chunk lands in the slot reserved when the water arrived', async () => {
        const { svc, f, loads } = setup();
        svc.addOverlayLayer('shapes', water('w1'), SHAPES, { waterSurface: true });
        // Overlays added while the chunk is in flight: a circle overlay, a
        // keepOnTop tool preview, a later fill, and a circle anchored to a
        // draped layer (which the slot logic sends to the bottom of the
        // non-draped run, directly under the water).
        svc.addOverlayLayer('markers', { type: 'FeatureCollection', features: [] }, MARKERS);
        svc.addOverlayLayer('draft', { type: 'FeatureCollection', features: [] }, DRAFT, { keepOnTop: true });
        svc.addOverlayLayer('holes', { type: 'FeatureCollection', features: [] }, HOLES);
        svc.addOverlayLayer('labels', { type: 'FeatureCollection', features: [] }, LABELS, { beforeId: 'shapes-fill' });
        // The order an eagerly added water layer produces.
        const expected = ['shapes-fill', 'holes-fill', 'draft-line', 'labels-points', WATER_LAYER_ID, 'markers-points', 'draft-points'];
        expect(f.map.getLayersOrder()).toEqual(expected);
        expect(loads).toHaveLength(1);

        const layer = waterStandIn();
        loads[0].resolve(layer as unknown as WaterLayer);
        await tick();
        expect(f.map.getLayersOrder()).toEqual(expected);
        expect(f.map.getLayer(WATER_LAYER_ID)).toBe(layer);
        expect(layer.data).toEqual(water('w1'));
    });

    test('the latest water data reaches the layer when the chunk lands', async () => {
        const { svc, loads } = setup();
        svc.addOverlayLayer('shapes', water('w1'), SHAPES, { waterSurface: true });
        svc.updateOverlayData('shapes', water('w2'));
        expect(loads).toHaveLength(1);
        const layer = waterStandIn();
        loads[0].resolve(layer as unknown as WaterLayer);
        await tick();
        expect(layer.data).toEqual(water('w2'));
        svc.updateOverlayData('shapes', water('w3'));
        expect(layer.data).toEqual(water('w3'));
    });

    test('no chunk load for a course without water', () => {
        const { svc, f, loads } = setup();
        svc.addOverlayLayer('shapes', { type: 'FeatureCollection', features: [] }, SHAPES, { waterSurface: true });
        expect(loads).toHaveLength(0);
        expect(f.map.getLayer(WATER_LAYER_ID)).toBeUndefined();
    });

    test('toggling off and on again before the chunk lands adds the layer once', async () => {
        const { svc, f, loads, toggleWater } = setup();
        svc.addOverlayLayer('shapes', water('w1'), SHAPES, { waterSurface: true });
        toggleWater(false);
        toggleWater(true);
        expect(loads).toHaveLength(1);
        const layer = waterStandIn();
        loads[0].resolve(layer as unknown as WaterLayer);
        await tick();
        expect(f.map.getLayersOrder().filter(id => id === WATER_LAYER_ID)).toHaveLength(1);
        expect(f.map.getLayer(WATER_LAYER_ID)).toBe(layer);
        expect(layer.enabled).toBe(true);
    });

    test('toggling off before the chunk lands cancels the add; on again loads into the same slot', async () => {
        const { svc, f, loads, toggleWater } = setup();
        svc.addOverlayLayer('shapes', water('w1'), SHAPES, { waterSurface: true });
        svc.addOverlayLayer('markers', { type: 'FeatureCollection', features: [] }, MARKERS);
        toggleWater(false);
        const first = waterStandIn();
        loads[0].resolve(first as unknown as WaterLayer);
        await tick();
        expect(f.map.getLayer(WATER_LAYER_ID)).not.toBe(first);
        expect(f.map.getLayersOrder()).toEqual(['shapes-fill', WATER_LAYER_ID, 'markers-points']);

        toggleWater(true);
        expect(loads).toHaveLength(2);
        const second = waterStandIn();
        loads[1].resolve(second as unknown as WaterLayer);
        await tick();
        expect(f.map.getLayer(WATER_LAYER_ID)).toBe(second);
        expect(f.map.getLayersOrder()).toEqual(['shapes-fill', WATER_LAYER_ID, 'markers-points']);
    });

    test('removing the water overlay before the chunk lands drops the result', async () => {
        const { svc, f, loads } = setup();
        svc.addOverlayLayer('shapes', water('w1'), SHAPES, { waterSurface: true });
        svc.removeOverlayLayer('shapes');
        expect(f.map.getLayer(WATER_LAYER_ID)).toBeUndefined();
        loads[0].resolve(waterStandIn() as unknown as WaterLayer);
        await tick();
        expect(f.map.getLayersOrder()).toEqual([]);
    });
});

describe('LazyCustomLayer', () => {
    const standIn = (id: string) => ({ id, type: 'custom' as const, render() {} });

    test('a request while a load is in flight starts no second load', async () => {
        const { map, layers } = fakeMap();
        const loads: Deferred<ReturnType<typeof standIn>>[] = [];
        const slot = new LazyCustomLayer(map as never, 'trees', () => {
            const d = deferred<ReturnType<typeof standIn>>();
            loads.push(d);
            return d.promise;
        });
        slot.reserve();
        void slot.request();
        void slot.request();
        expect(loads).toHaveLength(1);
        const layer = standIn('trees');
        loads[0].resolve(layer);
        await tick();
        expect(layers).toEqual([layer]);
        void slot.request();
        expect(loads).toHaveLength(1);
    });

    test('release while loading drops the result even after a new reserve', async () => {
        const { map, layers } = fakeMap();
        const loads: Deferred<ReturnType<typeof standIn>>[] = [];
        const slot = new LazyCustomLayer(map as never, 'trees', () => {
            const d = deferred<ReturnType<typeof standIn>>();
            loads.push(d);
            return d.promise;
        });
        slot.reserve();
        void slot.request();
        slot.release();
        slot.reserve();
        void slot.request();
        expect(loads).toHaveLength(2);
        const stale = standIn('trees');
        loads[0].resolve(stale);
        await tick();
        expect(slot.layer).toBeNull();
        const fresh = standIn('trees');
        loads[1].resolve(fresh);
        await tick();
        expect(layers).toEqual([fresh]);
    });
});
