import { describe, expect, test } from 'bun:test';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { resolveSurfaceStack } from './resolved-surface-stack';
import { COURSE_GROUP_RANK, ROADS_GROUP_RANK, ROAD_SURFACE_RANK, STACK_GROUP_SPAN, stackKey } from './stack-key';

const road = (surface: string | null, sortOrder: number) =>
    stackKey(null, null, sortOrder, 'path', surface ? { surface } : null);

function rect(id: string, key: number, west: number, south: number, east: number, north: number): Feature<Polygon> {
    return {
        type: 'Feature',
        id,
        properties: { id, type: 'path', stackKey: key },
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    };
}

describe('D33 roads ranked by surface', () => {
    test('a gravel road drawn after an asphalt road still goes under it', () => {
        expect(road('asphalt', 0)).toBeGreaterThan(road('gravel', 4000));
    });

    test('the rank follows the export (asphalt > concrete > paving > wood > gravel > dirt > grass > unknown)', () => {
        const keys = [...ROAD_SURFACE_RANK, null].map(surface => road(surface, 0));
        expect(keys).toEqual([...keys].sort((a, b) => b - a));
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('a gravel track is gravel; sort order still orders roads of one surface', () => {
        expect(road('gravel-track', 3)).toBe(road('gravel', 3));
        expect(road('gravel', 2)).toBeGreaterThan(road('gravel', 1));
    });

    test('every road stays above the course-level group, and the largest key is an exact float32', () => {
        expect(road(null, 0)).toBe(ROADS_GROUP_RANK * STACK_GROUP_SPAN);
        expect(road('grass', 0)).toBeGreaterThan(stackKey(null, COURSE_GROUP_RANK, STACK_GROUP_SPAN - 1, 'water'));
        const top = road('asphalt', STACK_GROUP_SPAN - 1);
        expect(Math.fround(top)).toBe(top);
    });

    test('the map clips the gravel at the asphalt edge, whichever was drawn last', () => {
        const source: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                rect('asphalt', road('asphalt', 0), 0, 0, 10, 2),
                rect('gravel', road('gravel', 9), 4, 1, 6, 8), // drawn later, overshoots into the asphalt
            ],
        };
        const resolved = resolveSurfaceStack(source);
        const gravel = resolved.features.find(f => f.id === 'gravel')!;
        const asphalt = resolved.features.find(f => f.id === 'asphalt')!;
        if (gravel.geometry.type !== 'MultiPolygon' || asphalt.geometry.type !== 'MultiPolygon') throw new Error('expected MultiPolygons');
        const gravelYs = gravel.geometry.coordinates.flat(2).map(([, y]) => y);
        expect(Math.min(...gravelYs)).toBe(2); // stops at the asphalt kerb
        expect(asphalt.geometry.coordinates[0]!.length).toBe(1); // asphalt keeps its whole outline, no hole
    });
});
