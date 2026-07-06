import { describe, expect, test } from 'bun:test';
import { hazardsAlongLine } from './carry';
import type { FlatRing } from './corridor';

// Hand-computed planar fixtures. Compass bearing 90° = east (+x).

const box = (minX: number, maxX: number, minY: number, maxY: number, kind = 'bunker'): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

describe('hazardsAlongLine', () => {
    test('ray through a box reports front and carry crossings', () => {
        const bunker = box(10, 20, -5, 5);
        const hazards = hazardsAlongLine({ x: 0, y: 0 }, 90, [bunker]);

        expect(hazards).toHaveLength(1);
        expect(hazards[0].ring).toBe(bunker);
        expect(hazards[0].frontM).toBeCloseTo(10, 9);
        expect(hazards[0].carryM).toBeCloseTo(20, 9);
    });

    test('tangent and miss are omitted', () => {
        const tangent = box(10, 20, -10, 0);
        const miss = box(10, 20, 10, 20, 'water');
        const hazards = hazardsAlongLine({ x: 0, y: 0 }, 90, [tangent, miss]);

        expect(hazards).toEqual([]);
    });

    test('origin inside a ring reports front as zero and carry as exit crossing', () => {
        const water = box(10, 20, -5, 5, 'water');
        const hazards = hazardsAlongLine({ x: 15, y: 0 }, 90, [water]);

        expect(hazards).toHaveLength(1);
        expect(hazards[0].ring).toBe(water);
        expect(hazards[0].frontM).toBe(0);
        expect(hazards[0].carryM).toBeCloseTo(5, 9);
    });
});
