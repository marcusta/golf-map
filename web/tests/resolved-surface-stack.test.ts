import { describe, expect, test } from 'bun:test';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { createSurfaceStackResolver, resolveSurfaceStack } from '../../shared/render/resolved-surface-stack';

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

    test('the memoized resolver re-clips only features whose own or occluders\' geometry changed', () => {
        const resolve = createSurfaceStackResolver();
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
                square('green', 'green', 20, 4, 4, 8, 8),
                square('far-fairway', 'fairway', 11, 100, 100, 110, 110),
                square('far-bunker', 'bunker', 30, 104, 104, 106, 106),
            ],
        };
        const geometryOf = (fc: FeatureCollection, id: string) => fc.features.find(f => f.id === id)!.geometry;

        const first = resolve(source);
        // A structured clone (how the worker receives it) and one moved bunker.
        const moved = structuredClone(source);
        moved.features[3] = square('far-bunker', 'bunker', 30, 103, 104, 105, 106);
        const second = resolve(moved);

        expect(geometryOf(second, 'fairway')).toEqual(geometryOf(first, 'fairway'));
        expect((geometryOf(second, 'fairway') as MultiPolygon).coordinates)
            .toBe((geometryOf(first, 'fairway') as MultiPolygon).coordinates); // reused, not re-clipped
        expect((geometryOf(second, 'far-fairway') as MultiPolygon).coordinates)
            .not.toBe((geometryOf(first, 'far-fairway') as MultiPolygon).coordinates);
        expect(second).toEqual(resolveSurfaceStack(moved));
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

    // OOB is painted as a white boundary LINE, not a fill, and its ring is
    // drawn around the whole property — so it must never clip the course out
    // from under itself.
    test('an OOB ring enclosing the course clips nothing', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('fairway', 'fairway', 10, 2, 2, 8, 8),
                square('oob', 'oob', 90, 0, 0, 10, 10),
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const fairway = resolved.features.find(feature => feature.id === 'fairway')!;
        const oob = resolved.features.find(feature => feature.id === 'oob')!;

        // The fairway survives whole, despite sitting entirely inside the
        // higher-stacked OOB ring.
        if (fairway.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved fairway MultiPolygon');
        expect(fairway.geometry.coordinates[0]).toHaveLength(1);
        expect(fairway.geometry.coordinates[0]![0]).toHaveLength(5);
        // … and the OOB ring passes through untouched, still a Polygon.
        expect(oob.geometry.type).toBe('Polygon');
    });

    // Penalty areas are rules lines round other surfaces: a higher shape must
    // not trim them away, and they must not cut the water they mark.
    test('penalty areas pass through: never trimmed, never occluding', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('water', 'water', 10, 2, 2, 8, 8),
                square('red', 'penalty_red', 20, 0, 0, 10, 10),
                square('rough-over-all', 'rough', 30, -5, -5, 15, 15),
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const red = resolved.features.find(feature => feature.id === 'red')!;
        expect(red.geometry.type).toBe('Polygon'); // untouched, though the rough covers it
        // The water is trimmed by the rough above it, not by the penalty area.
        expect(resolved.features.some(feature => feature.id === 'water')).toBe(false);
        const withoutRough = resolveSurfaceStack({ type: 'FeatureCollection', features: source.features.slice(0, 2) });
        const water = withoutRough.features.find(feature => feature.id === 'water')!;
        if (water.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved water MultiPolygon');
        expect(water.geometry.coordinates[0]).toHaveLength(1);
    });

    // A vegetation zone is an authoring overlay (docs/feature-vegetation-zones.md
    // §5), so it neither gets clipped by the surfaces nor clips them.
    test('vegetation zones pass through and never occlude the surfaces below', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                square('fairway', 'fairway', 10, 0, 0, 10, 10),
                square('zone', 'vegetation_zone', 30, 4, 4, 8, 8),
            ],
        };

        const resolved = resolveSurfaceStack(source);
        const fairway = resolved.features.find(feature => feature.id === 'fairway')!;
        const zone = resolved.features.find(feature => feature.id === 'zone')!;

        // The fairway keeps its single unclipped ring …
        expect(fairway.geometry.type).toBe('MultiPolygon');
        if (fairway.geometry.type !== 'MultiPolygon') throw new Error('Expected resolved fairway MultiPolygon');
        expect(fairway.geometry.coordinates[0]).toHaveLength(1);
        // … and the zone comes back exactly as it went in.
        expect(zone.geometry).toEqual(source.features[1]!.geometry);
    });
});
