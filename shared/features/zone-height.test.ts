import { describe, expect, test } from 'bun:test';
import { editZoneHeight, parseZoneHeight, zoneHeightOf, zoneHeightProblem } from './zone-height';

describe('zone height', () => {
    test('a height is both ends, in range, or absent', () => {
        expect(zoneHeightProblem({ zoneType: 'shrub' })).toBeNull();
        expect(zoneHeightProblem({ heightMin: 2, heightMax: 3 })).toBeNull();
        expect(zoneHeightProblem({ heightMin: 2.5, heightMax: 2.5 })).toBeNull();
        for (const bad of [{ heightMin: 2 }, { heightMax: 2 }, { heightMin: 3, heightMax: 2 },
            { heightMin: 0, heightMax: 2 }, { heightMin: 1, heightMax: 13 }, { heightMin: '1', heightMax: 2 }]) {
            expect(zoneHeightProblem(bad)).toContain('heightMin');
            expect(zoneHeightOf(bad)).toBeNull();
        }
        expect(zoneHeightOf({ heightMin: 2, heightMax: 3 })).toEqual({ min: 2, max: 3 });
    });

    test('the first end typed sets both, and an end moved past the other takes it along', () => {
        expect(editZoneHeight(null, 'min', '2')).toEqual({ min: 2, max: 2 });
        expect(editZoneHeight({ min: 2, max: 2 }, 'max', '3')).toEqual({ min: 2, max: 3 });
        expect(editZoneHeight({ min: 2, max: 3 }, 'min', '4')).toEqual({ min: 4, max: 4 });
        expect(editZoneHeight({ min: 2, max: 3 }, 'max', '1,5')).toEqual({ min: 1.5, max: 1.5 });
        expect(editZoneHeight({ min: 2, max: 3 }, 'max', '40')).toEqual({ min: 2, max: 12 });
    });

    test('an emptied or unusable end clears the height', () => {
        for (const raw of ['', '  ', '0', '-1', 'tall']) expect(editZoneHeight({ min: 2, max: 3 }, 'min', raw)).toBeNull();
    });

    test('the CLI takes a range, one height or none', () => {
        expect(parseZoneHeight('2-3')).toEqual({ height: { min: 2, max: 3 } });
        expect(parseZoneHeight('2.5')).toEqual({ height: { min: 2.5, max: 2.5 } });
        expect(parseZoneHeight('none')).toEqual({ height: null });
        for (const bad of ['3-2', '0-2', '2-20', 'tall', '2-']) expect('error' in parseZoneHeight(bad)).toBe(true);
    });
});
