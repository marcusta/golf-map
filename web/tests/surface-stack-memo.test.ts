import { describe, expect, test } from 'bun:test';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { resolveSurfaceStack, surfaceStackStats } from '../../shared/render/resolved-surface-stack';

function square(id: string, stackKey: number, west: number, south: number, size: number): Feature<Polygon> {
    const east = west + size, north = south + size;
    return {
        type: 'Feature',
        id,
        properties: { id, type: 'fairway', stackKey },
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    };
}

const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

/** Two disjoint clusters: a base with a cover on top, at x=0 and x=100. */
function clusters(): Feature<Polygon>[] {
    return [
        square('a-base', 1, 0, 0, 10), square('a-top', 2, 4, 4, 2),
        square('b-base', 3, 100, 0, 10), square('b-top', 4, 104, 4, 2),
    ];
}

function clipsDuring(run: () => void): number {
    const before = surfaceStackStats.clips;
    run();
    return surfaceStackStats.clips - before;
}

describe('resolveSurfaceStack per-surface memo', () => {
    test('a rebuilt collection with the same coordinates clips nothing', () => {
        const features = clusters();
        resolveSurfaceStack(collection(features));
        // Visibility toggles and reorders rebuild every Feature object.
        const rebuilt = features.map(f => ({ ...f, properties: { ...f.properties } }));
        expect(clipsDuring(() => resolveSurfaceStack(collection(rebuilt)))).toBe(0);
    });

    test('an edit re-clips only the edited surface and the surfaces it overlaps', () => {
        const features = clusters();
        const first = resolveSurfaceStack(collection(features));
        const moved = square('a-top', 2, 5, 5, 2);
        const next = features.map(f => (f.id === 'a-top' ? moved : f));
        let result!: FeatureCollection;
        // a-top (new coordinates) and a-base (occluder changed); b-* reused.
        expect(clipsDuring(() => { result = resolveSurfaceStack(collection(next)); })).toBe(2);
        expect(result.features.find(f => f.id === 'b-base')).toBe(first.features.find(f => f.id === 'b-base'));

        // Same answer as a resolve from scratch.
        const scratch = resolveSurfaceStack(collection(next.map(f => ({ ...f, geometry: structuredClone(f.geometry) }))));
        const byId = (c: FeatureCollection) => Object.fromEntries(c.features.map(f => [f.id, f.geometry]));
        expect(byId(result)).toEqual(byId(scratch));
    });

    test('a stack reorder that changes who occludes whom re-clips the swapped pair', () => {
        const features = clusters();
        resolveSurfaceStack(collection(features));
        const swapped = features.map(f => {
            if (f.id === 'a-base') return { ...f, properties: { ...f.properties, stackKey: 2 } };
            if (f.id === 'a-top') return { ...f, properties: { ...f.properties, stackKey: 1 } };
            return f;
        });
        let result!: FeatureCollection;
        expect(clipsDuring(() => { result = resolveSurfaceStack(collection(swapped)); })).toBe(2);
        // a-base now covers a-top completely, so a-top drops out.
        expect(result.features.map(f => f.id)).not.toContain('a-top');
    });
});
