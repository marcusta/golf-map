import { describe, expect, test } from 'bun:test';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { resolveSurfaceStack } from '../../shared/render/resolved-surface-stack';

function square(id: string, type: string, stackKey: number, west: number, south: number, east: number, north: number): Feature<Polygon> {
    return {
        type: 'Feature',
        id,
        properties: { id, type, stackKey },
        geometry: {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
    };
}

describe('resolveSurfaceStack', () => {
    test('subtracts a higher surface from every lower surface before blending', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
                square('green', 'green', 20, 4, 4, 8, 8),
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const fairway = resolved.features.find(feature => feature.id === 'fairway')!;
        const green = resolved.features.find(feature => feature.id === 'green')!;

        expect(fairway.geometry.type).toBe('MultiPolygon');
        if (fairway.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved fairway MultiPolygon');
        expect(fairway.geometry.coordinates[0]![1]).toEqual([[4, 4], [4, 8], [8, 8], [8, 4], [4, 4]]);
        expect(green.geometry.type).toBe('MultiPolygon');
        if (green.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved green MultiPolygon');
        expect(green.geometry.coordinates[0]![0]).toEqual([[4, 4], [8, 4], [8, 8], [4, 8], [4, 4]]);
    });

    test('uses stack key rather than source order to choose the visible surface', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('green', 'green', 20, 4, 4, 8, 8),
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const fairway = resolved.features.find(feature => feature.id === 'fairway')!;
        expect(fairway.geometry.type).toBe('MultiPolygon');
        if (fairway.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved fairway MultiPolygon');
        expect(fairway.geometry.coordinates[0]![1]).toHaveLength(5);
    });

    test('leaves spatially disjoint surfaces intact (bbox prefilter is a pure optimization)', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('far-bunker', 'bunker', 30, 100, 100, 110, 110),
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const fairway = resolved.features.find(feature => feature.id === 'fairway')!;
        const bunker = resolved.features.find(feature => feature.id === 'far-bunker')!;

        if (fairway.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved fairway MultiPolygon');
        // No hole punched — the higher bunker never overlapped it.
        expect(fairway.geometry.coordinates).toHaveLength(1);
        expect(fairway.geometry.coordinates[0]).toHaveLength(1);
        if (bunker.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved bunker MultiPolygon');
        expect(bunker.geometry.coordinates[0]![0]).toHaveLength(5);
    });

    test('memoizes per source collection identity', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
                square('green', 'green', 20, 4, 4, 8, 8),
            ],
        };

        const first = resolveSurfaceStack(source);
        expect(resolveSurfaceStack(source)).toBe(first);
        // A replaced collection (how the geojson Computed publishes changes)
        // is resolved fresh.
        const replaced: FeatureCollection = { ...source, features: [...source.features] };
        expect(resolveSurfaceStack(replaced)).not.toBe(first);
    });

    test('a degenerate ring skips only its own clip, not the whole render', () => {
        // Finite bbox (so the prefilter keeps it) but a NaN vertex that makes
        // polygon-clipping throw mid-sweep.
        const degenerate: Feature<Polygon> = {
            type: 'Feature',
            id: 'broken',
            properties: { id: 'broken', type: 'water', stackKey: 30 },
            geometry: {
                type: 'Polygon',
                coordinates: [[[4, 4], [8, 4], [NaN, 5], [8, 8], [4, 8], [4, 4]]],
            },
        };
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
                square('green', 'green', 20, 4, 4, 8, 8),
                degenerate,
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const fairway = resolved.features.find(feature => feature.id === 'fairway')!;
        // The green still punches its hole in the fairway even though the
        // degenerate water ring (stacked above both) throws in the clipper.
        if (fairway.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved fairway MultiPolygon');
        expect(fairway.geometry.coordinates[0]![1]).toEqual([[4, 4], [4, 8], [8, 8], [8, 4], [4, 4]]);
    });
});
