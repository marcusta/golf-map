import { describe, expect, test } from 'bun:test';
import { Vector2 } from 'three';
import { waterGeometry } from '../src/map/water-geometry';

const ring = (points: number[][]) => points.map(([x, y]) => new Vector2(x, y));
function area(positions: ReturnType<typeof waterGeometry>['attributes']['position']): number {
    let sum = 0;
    for (let i = 0; i < positions.count; i += 3) {
        const ax = positions.getX(i), ay = positions.getY(i);
        sum += Math.abs((positions.getX(i + 1) - ax) * (positions.getY(i + 2) - ay)
            - (positions.getY(i + 1) - ay) * (positions.getX(i + 2) - ax)) / 2;
    }
    return sum;
}
describe('water triangulation', () => {
    test('preserves an island and surface area through subdivision', () => {
        const geometry = waterGeometry([
            ring([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]),
            ring([[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]]),
        ]);
        const positions = geometry.getAttribute('position');
        expect(area(positions)).toBeCloseTo(9600, 3);
        for (let i = 0; i < positions.count; i += 3) {
            const x = (positions.getX(i) + positions.getX(i + 1) + positions.getX(i + 2)) / 3;
            const y = (positions.getY(i) + positions.getY(i + 1) + positions.getY(i + 2)) / 3;
            expect(x > 40 && x < 60 && y > 40 && y < 60).toBe(false);
        }
        expect(Math.max(...Array.from(geometry.getAttribute('shore').array))).toBeGreaterThan(10);
        geometry.dispose();
    });
    test('keeps a concave creek bend without filling its notch', () => {
        const geometry = waterGeometry([ring([[0, 0], [30, 0], [30, 3], [3, 3], [3, 30], [0, 30]])]);
        expect(area(geometry.getAttribute('position'))).toBeCloseTo(171, 4);
        geometry.dispose();
    });
    test('terminates for equal longest edges', () => {
        const geometry = waterGeometry([ring([[0, 0], [100, 0], [50, 100]])]);
        expect(area(geometry.getAttribute('position'))).toBeCloseTo(5000, 4);
        expect(geometry.getAttribute('position').count).toBeLessThanOrEqual(3 * 256);
        geometry.dispose();
    });
});
