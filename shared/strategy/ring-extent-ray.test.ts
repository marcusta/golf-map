import { describe, expect, test } from 'bun:test';
import { ringExtentAlongRay } from './ring-extent';
import type { FlatRing } from './corridor';

const square = (minX: number, maxX: number, minY: number, maxY: number, kind = 'bunker'): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

describe('ringExtentAlongRay', () => {
    test('ray through the tapped point reports the ring entry/exit window', () => {
        // Origin south, bunker due north 120..150 — tap its middle.
        const extent = ringExtentAlongRay({ x: 0, y: 0 }, { x: 0, y: 135 }, square(-10, 10, 120, 150));
        expect(extent).not.toBeNull();
        expect(extent!.frontM).toBeCloseTo(120);
        expect(extent!.carryM).toBeCloseTo(150);
        expect(extent!.side).toBe('on-line');
        // Edge points sit ON the ring boundary, along the ray.
        expect(extent!.frontPoint).toEqual({ x: 0, y: 120 });
        expect(extent!.carryPoint).toEqual({ x: 0, y: 150 });
    });

    test('an off-axis shape measures along the ray at it, not any hole line', () => {
        // Bunker to the north-east; ray goes diagonally through the tap.
        const extent = ringExtentAlongRay({ x: 0, y: 0 }, { x: 100, y: 100 }, square(90, 110, 90, 110));
        expect(extent).not.toBeNull();
        // Entry at (90,90) → √(2·90²) ≈ 127.3; exit at (110,110) ≈ 155.6.
        expect(extent!.frontM).toBeCloseTo(Math.hypot(90, 90));
        expect(extent!.carryM).toBeCloseTo(Math.hypot(110, 110));
        expect(extent!.frontPoint.x).toBeCloseTo(90);
        expect(extent!.carryPoint.y).toBeCloseTo(110);
    });

    test('origin inside the ring reads front 0 at the origin, carry = exit', () => {
        const extent = ringExtentAlongRay({ x: 0, y: 5 }, { x: 0, y: 20 }, square(-10, 10, -10, 30));
        expect(extent!.frontM).toBe(0);
        expect(extent!.carryM).toBeCloseTo(25); // exit at y=30, 25 m ahead
        expect(extent!.frontPoint).toEqual({ x: 0, y: 5 });
    });

    test('degenerate inputs return null', () => {
        expect(ringExtentAlongRay({ x: 0, y: 0 }, { x: 0, y: 0 }, square(-5, 5, 10, 20))).toBeNull();
        expect(ringExtentAlongRay(
            { x: 0, y: 0 }, { x: 0, y: 10 },
            { kind: 'bunker', points: [{ x: 0, y: 1 }, { x: 1, y: 1 }] },
        )).toBeNull();
    });
});
