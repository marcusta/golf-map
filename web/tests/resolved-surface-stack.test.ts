import { describe, expect, test } from 'bun:test';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { resolveSurfaceStack } from '../src/draw/resolved-surface-stack';

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
});
