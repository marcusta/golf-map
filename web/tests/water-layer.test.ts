import { describe, expect, test } from 'bun:test';
import type { BufferGeometry, Mesh } from 'three';
import type { Feature, FeatureCollection } from 'geojson';
import { WaterLayer } from '../src/map/water-layer';
import type { WaterElevationQueue } from '../src/map/water-elevation-queue';

// The features service builds a fresh Feature + geometry wrapper on every
// push but reuses each feature's cached WGS84 ring array while its geometry is
// unchanged. These pushes mimic that: new wrappers, shared `coordinates`.
function square(lng: number, lat: number, size = 0.0005): number[][][] {
    return [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]];
}
function push(waters: Array<{ type: string; coordinates: number[][][] }>): FeatureCollection {
    const features: Feature[] = waters.map((w, i) => ({
        type: 'Feature',
        properties: { id: `w${i}`, type: w.type },
        geometry: { type: 'Polygon', coordinates: w.coordinates },
    }));
    features.push({ type: 'Feature', properties: { type: 'green' }, geometry: { type: 'Polygon', coordinates: square(15.71, 58.35) } });
    return { type: 'FeatureCollection', features };
}

interface LayerInternals {
    meshes: Mesh<BufferGeometry>[];
    elevationQueue: WaterElevationQueue;
    sampler: ((x: number, y: number) => number) | null;
    sampledTerrain: unknown;
}
const internals = (layer: WaterLayer) => layer as unknown as LayerInternals;

describe('WaterLayer.setData change detection', () => {
    test('pushing the same water geometries twice does not rebuild', () => {
        const layer = new WaterLayer();
        const pond = square(15.70, 58.34), creek = square(15.701, 58.341);
        layer.setData(push([{ type: 'water', coordinates: pond }, { type: 'water_creek', coordinates: creek }]));
        expect(layer.builds).toEqual({ sets: 1, meshes: 2 });
        const meshes = [...internals(layer).meshes];

        layer.setData(push([{ type: 'water', coordinates: pond }, { type: 'water_creek', coordinates: creek }]));

        expect(layer.builds).toEqual({ sets: 1, meshes: 2 });
        expect(internals(layer).meshes).toEqual(meshes);
    });

    test('replacing one geometry object rebuilds only that mesh', () => {
        const layer = new WaterLayer();
        const pond = square(15.70, 58.34), creek = square(15.701, 58.341);
        layer.setData(push([{ type: 'water', coordinates: pond }, { type: 'water_creek', coordinates: creek }]));
        const [pondMesh, creekMesh] = internals(layer).meshes;

        // Same values, new array: an edit that produced identical coordinates still counts.
        layer.setData(push([{ type: 'water', coordinates: pond }, { type: 'water_creek', coordinates: square(15.701, 58.341) }]));

        expect(layer.builds).toEqual({ sets: 2, meshes: 3 });
        const [nextPond, nextCreek] = internals(layer).meshes;
        expect(nextPond).toBe(pondMesh);
        expect(nextCreek).not.toBe(creekMesh);
    });

    test('a type change on the same geometry rebuilds it', () => {
        const layer = new WaterLayer();
        const pond = square(15.70, 58.34);
        layer.setData(push([{ type: 'water', coordinates: pond }]));
        layer.setData(push([{ type: 'water_creek', coordinates: pond }]));
        expect(layer.builds).toEqual({ sets: 2, meshes: 2 });
    });

    test('after a completed elevation pass, only new water is re-sampled', () => {
        const layer = new WaterLayer();
        const pond = square(15.70, 58.34);
        layer.setData(push([{ type: 'water', coordinates: pond }]));
        const sampled: number[] = [];
        // Stand in for render(): a finished pass at the current terrain state.
        const sampler = (x: number, y: number) => { sampled.push(x + y); return 7; };
        internals(layer).sampler = sampler;
        internals(layer).sampledTerrain = {};
        const first = internals(layer).elevationQueue;
        first.start(sampler);
        while (first.pending) first.step();
        const pondGeometry = internals(layer).meshes[0].geometry;

        layer.setData(push([{ type: 'water', coordinates: pond }, { type: 'water', coordinates: square(15.702, 58.342) }]));

        const queue = internals(layer).elevationQueue;
        expect(queue.pending).toBe(true);
        const completed: BufferGeometry[] = [];
        while (queue.pending) completed.push(...queue.step().completed);
        expect(completed).toEqual([internals(layer).meshes[1].geometry]);
        expect(completed).not.toContain(pondGeometry);
        // The kept pond still has the sampled heights.
        expect(pondGeometry.getAttribute('position').getZ(0)).toBe(7);
    });

    test('a change while a pass is still running restarts the full pass', () => {
        const layer = new WaterLayer();
        const pond = square(15.70, 58.34);
        layer.setData(push([{ type: 'water', coordinates: pond }]));
        internals(layer).sampler = () => 1;
        internals(layer).sampledTerrain = {};
        internals(layer).elevationQueue.start(() => 1);

        layer.setData(push([{ type: 'water', coordinates: pond }, { type: 'water', coordinates: square(15.702, 58.342) }]));

        // render() starts the next pass over every surface.
        expect(internals(layer).sampledTerrain).toBeNull();
        expect(internals(layer).elevationQueue.pending).toBe(false);
    });
});
