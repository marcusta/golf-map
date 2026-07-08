import { describe, expect, test } from 'bun:test';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import { buildLieMap } from '../src/planner/lie-map';

/**
 * A square feature (EPSG:3006 meters), straight edges (no bezier handles).
 * `sortOrder`/`holeId` drive the D23/D24 stack — higher `sortOrder` is on top
 * within a group; a non-null `holeId` outranks course-level via the group key.
 */
function squareFeature(
    id: string,
    type: string,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    opts: { sortOrder?: number; holeId?: string | null } = {},
): CourseFeature {
    return {
        id,
        courseId: 'course-1',
        holeId: opts.holeId ?? null,
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
        sortOrder: opts.sortOrder ?? 0,
        version: 1,
    };
}

describe('buildLieMap', () => {
    test('point inside a fairway feature classifies as fairway', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const map = buildLieMap([fairway]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('fairway');
    });

    test('point in no feature falls back to rough (D23)', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200);
        const map = buildLieMap([fairway]);
        expect(map.classifyLie({ x: 500, y: 500 })).toBe('rough');
    });

    test('nesting: topmost-in-stack containing feature wins (bunker above fairway)', () => {
        // Bunker sits ABOVE the fairway in the stack (higher sortOrder) — the
        // D25 backfill puts a smaller nested feature on top, so this preserves
        // the old smallest-area lie semantics via explicit order (D23).
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200, { sortOrder: 0 });
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110, { sortOrder: 1 });
        const map = buildLieMap([fairway, bunker]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('sand');
        // Outside the bunker but still inside the fairway.
        expect(map.classifyLie({ x: 10, y: 10 })).toBe('fairway');
    });

    test('nesting follows the stack, not array order (bunker listed first still wins from on top)', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200, { sortOrder: 0 });
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110, { sortOrder: 1 });
        const map = buildLieMap([bunker, fairway]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('sand');
    });

    test('lowering the bunker below the fairway flips the lie to fairway (D23)', () => {
        // The inverse of the nesting case: same geometry, bunker now UNDER the
        // fairway (lower sortOrder) — the fairway paints over it and owns the lie.
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200, { sortOrder: 1 });
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110, { sortOrder: 0 });
        const map = buildLieMap([fairway, bunker]);
        expect(map.classifyLie({ x: 50, y: 100 })).toBe('fairway');
    });

    test('cross-group: a hole feature outranks an overlapping course-level one regardless of area (scenario 3)', () => {
        // Course-level fairway (rank 0) vs. a LARGER hole-1 water (rank 1):
        // the hole feature wins by the D24 group key even though it is bigger
        // and would have lost under smallest-area.
        const courseFairway = squareFeature('f1', 'fairway', 0, 100, 0, 100, { holeId: null, sortOrder: 5 });
        const holeWater = squareFeature('w1', 'water', 0, 200, 0, 200, { holeId: 'h1', sortOrder: 0 });
        const map = buildLieMap([courseFairway, holeWater], new Map([['h1', 1]]));
        expect(map.classifyLie({ x: 50, y: 50 })).toBe('penalty');
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
            sortOrder: 0,
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

    test('surfaces() includes every classifiable feature, topmost-first (D23)', () => {
        const fairway = squareFeature('f1', 'fairway', 0, 100, 0, 200, { sortOrder: 0 });
        const bunker = squareFeature('b1', 'bunker', 40, 60, 90, 110, { sortOrder: 1 });
        const map = buildLieMap([fairway, bunker]);
        const surfaces = map.surfaces();
        expect(surfaces).toHaveLength(2);
        expect(surfaces[0].kind).toBe('bunker'); // topmost (higher sortOrder) first
        expect(surfaces[1].kind).toBe('fairway');
    });
});
