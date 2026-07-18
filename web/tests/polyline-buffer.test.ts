import { test, expect, describe } from 'bun:test';
import { bufferPolyline } from '../src/geo/polyline-buffer';

/** Shoelace area of an explicitly-closed ring. */
function ringArea(ring: number[][]): number {
    let sum = 0;
    for (let i = 0; i + 1 < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum / 2);
}

describe('bufferPolyline', () => {
    test('straight line becomes a rectangle of the requested width', () => {
        const ring = bufferPolyline([[0, 0], [10, 0]], 2)!;
        expect(ring).not.toBeNull();
        expect(ring[0]).toEqual(ring[ring.length - 1]); // explicitly closed
        expect(ring.length).toBe(5); // 4 corners + closure
        expect(ringArea(ring)).toBeCloseTo(20, 6); // 10 m × 2 m, butt caps
        // Symmetric about the centerline (y = 0).
        for (const [, y] of ring) expect(Math.abs(y)).toBeCloseTo(1, 6);
        // Butt caps: no extension past the endpoints.
        for (const [x] of ring) {
            expect(x).toBeGreaterThanOrEqual(-1e-9);
            expect(x).toBeLessThanOrEqual(10 + 1e-9);
        }
    });

    test('multi-vertex line keeps its width through a right-angle bend', () => {
        const ring = bufferPolyline([[0, 0], [10, 0], [10, 10]], 2)!;
        // 20 m of centerline × 2 m; the mitered outer corner adds ~1 m²,
        // the inner corner overlaps ~1 m² — area stays close to 40.
        expect(ringArea(ring)).toBeGreaterThan(38);
        expect(ringArea(ring)).toBeLessThan(44);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
    });

    test('creek-scale ribbon: EPSG:3006 coordinates round-trip sanely', () => {
        const line = [[531200, 6473200], [531200, 6474200]]; // 1 km due north
        const ring = bufferPolyline(line, 2)!;
        expect(ringArea(ring)).toBeCloseTo(2000, 3); // 1000 m × 2 m
        for (const [x] of ring) expect(Math.abs(x - 531200)).toBeCloseTo(1, 6);
    });

    test('consecutive duplicate positions are merged before buffering', () => {
        const ring = bufferPolyline([[0, 0], [0, 0], [10, 0], [10, 0]], 2)!;
        expect(ring.length).toBe(5);
        expect(ringArea(ring)).toBeCloseTo(20, 6);
    });

    test('degenerate input yields null', () => {
        expect(bufferPolyline([], 2)).toBeNull();
        expect(bufferPolyline([[5, 5]], 2)).toBeNull();
        expect(bufferPolyline([[5, 5], [5, 5]], 2)).toBeNull(); // zero length
        expect(bufferPolyline([[0, 0], [10, 0]], 0)).toBeNull();
        expect(bufferPolyline([[0, 0], [10, 0]], -1)).toBeNull();
    });
});
