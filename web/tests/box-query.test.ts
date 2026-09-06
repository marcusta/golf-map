import { test, expect } from 'bun:test';
import { describeBoxQuery } from '../src/planner/box-query';

test('a dragged box copies whole-metre EPSG:3006 bounds with its size', () => {
    // A pitched view hands over a trapezoid; the bounds cover all four corners.
    const q = describeBoxQuery([
        { x: 532810.4, y: 6473341.2 }, { x: 532839.6, y: 6473340.7 },
        { x: 532806.1, y: 6473369.9 }, { x: 532843.8, y: 6473368.3 },
    ]);
    expect(q.bbox).toEqual([532806, 6473341, 532844, 6473370]);
    expect(q.point).toBeNull();
    expect(q.text).toBe('EPSG:3006 bbox 532806,6473341,532844,6473370 (38 x 29 m)');
});

test('a click without a drag copies the point', () => {
    const q = describeBoxQuery([{ x: 532820.2, y: 6473355.6 }, { x: 532821.1, y: 6473356.1 }]);
    expect(q.bbox).toBeNull();
    expect(q.point).toEqual({ x: 532821, y: 6473356 });
    expect(q.text).toBe('EPSG:3006 point 532821,6473356');
});
