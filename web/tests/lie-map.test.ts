import { describe, expect, test } from 'bun:test';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import { buildLieMap } from '../src/planner/lie-map';

/** A square feature (EPSG:3006 meters), straight edges (no bezier handles). */
function squareFeature(
    id: string,
    type: string,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
): CourseFeature {
    return {
        id,
        courseId: 'course-1',
        holeId: null,
        type,
        geometry: {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: minX, y: minY },
                    { x: maxX, y: minY },
                    { x: maxX, y: maxY },
                    { x: minX, y: maxY },
                ],
            }],
        },
        geojson: null,
        version: 1,
    };
}

describe('buildLieMap', () => {
    test('point inside a fairway feature classifies as fairway', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const map = buildLieMap([fairway]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('fairway');
    });

    test('point in no feature falls back to rough (D17)', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const map = buildLieMap([fairway]);
        expect(map.classifyLie({ x: 500, y: 500 })).toBe('rough');
    });

    test('nesting: smallest-area containing feature wins (bunker inside fairway)', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110);
        const map = buildLieMap([fairway, bunker]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('sand');
        // Outside the bunker but still inside the fairway.
        expect(map.classifyLie({ x: 10, y: 10 })).toBe('fairway');
    });

    test('nesting is order-independent (bunker listed first still wins)', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110);
        const map = buildLieMap([bunker, fairway]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('sand');
    });

    test('water/outside map to penalty via lieFromFeatureType', () => {
        const water = squareFeature('w1', 'water', 0, 50, 0, 50);
        const map = buildLieMap([water]);
        expect(map.classifyLie({ x: 25, y: 25 })).toBe('penalty');
    });

    test('degenerate (< 3 point) rings are skipped, not thrown', () => {
        const degenerate: CourseFeature = {
            id: 'd1',
            courseId: 'course-1',
            holeId: null,
            type: 'bunker',
            geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] },
            geojson: null,
            version: 1,
        };
        const map = buildLieMap([degenerate]);
        expect(map.classifyLie({ x: 0.5, y: 0.5 })).toBe('rough');
        expect(map.surfaces()).toHaveLength(0);
    });

    test('hazardRings() returns only DEFAULT_HAZARD_TYPES features', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110);
        const water = squareFeature('w1', 'water', 200, 250, 200, 250);
        const map = buildLieMap([fairway, bunker, water]);
        const hazardKinds = map.hazardRings().map(r => r.kind).sort();
        expect(hazardKinds).toEqual(['bunker', 'water']);
    });

    test('surfaces() includes every classifiable feature, smallest-area-first', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110);
        const map = buildLieMap([fairway, bunker]);
        const surfaces = map.surfaces();
        expect(surfaces).toHaveLength(2);
        expect(surfaces[0].kind).toBe('bunker'); // smaller area first
        expect(surfaces[1].kind).toBe('fairway');
    });
});
