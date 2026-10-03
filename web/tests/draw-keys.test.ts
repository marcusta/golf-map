import { describe, test, expect } from 'bun:test';
import { nudgeDirection } from '../src/draw/draw-keys';

// nudgeDirection maps an arrow key to a unit EPSG:3006 vector at the map
// bearing. Screen up points along the bearing; screen right is 90° clockwise.

function close(v: { east: number; north: number } | null, east: number, north: number): void {
    expect(v).not.toBeNull();
    expect(v!.east).toBeCloseTo(east, 9);
    expect(v!.north).toBeCloseTo(north, 9);
}

describe('nudgeDirection', () => {
    test('north-up map: arrows map to the compass axes', () => {
        close(nudgeDirection('ArrowUp', 0), 0, 1);
        close(nudgeDirection('ArrowDown', 0), 0, -1);
        close(nudgeDirection('ArrowRight', 0), 1, 0);
        close(nudgeDirection('ArrowLeft', 0), -1, 0);
    });

    test('bearing 90 (east up): up is east, right is south', () => {
        close(nudgeDirection('ArrowUp', 90), 1, 0);
        close(nudgeDirection('ArrowRight', 90), 0, -1);
    });

    test('bearing -45: up points north-west', () => {
        close(nudgeDirection('ArrowUp', -45), -Math.SQRT1_2, Math.SQRT1_2);
    });

    test('any other key has no direction', () => {
        expect(nudgeDirection('a', 0)).toBeNull();
        expect(nudgeDirection('Enter', 30)).toBeNull();
    });
});
