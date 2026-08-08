import { describe, expect, test } from 'bun:test';
import { ringExtentAlongLines } from './ring-extent';
import type { FlatRing } from './corridor';

// Hand-computed planar fixtures, +x east, +y north. Lines run south → north
// (+y) so along-line chainage is simply the y offset from the line start.

const square = (minX: number, maxX: number, minY: number, maxY: number, kind = 'bunker'): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

describe('ringExtentAlongLines', () => {
    test('on-line ring reports its near/far chainage window', () => {
        const line = [{ x: 0, y: 0 }, { x: 0, y: 300 }];
        const extent = ringExtentAlongLines([line], square(-10, 10, 120, 150));
        expect(extent).not.toBeNull();
        expect(extent!.frontM).toBeCloseTo(120);
        expect(extent!.carryM).toBeCloseTo(150);
        expect(extent!.side).toBe('on-line');
        expect(extent!.centroid).toEqual({ x: 0, y: 135 });
        expect(extent!.frontPoint.y).toBeCloseTo(120);
        expect(extent!.carryPoint.y).toBeCloseTo(150);
        expect(extent!.frontPoint.x).toBeCloseTo(0);
    });

    test('side ring still measures along the line and reports its side', () => {
        const line = [{ x: 0, y: 0 }, { x: 0, y: 300 }];
        const right = ringExtentAlongLines([line], square(30, 50, 80, 110));
        expect(right).not.toBeNull();
        expect(right!.frontM).toBeCloseTo(80);
        expect(right!.carryM).toBeCloseTo(110);
        expect(right!.side).toBe('right');

        const left = ringExtentAlongLines([line], square(-50, -30, 80, 110));
        expect(left!.side).toBe('left');
    });

    test('ring past the line end is unclamped (reads beyond the line)', () => {
        const line = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
        const extent = ringExtentAlongLines([line], square(-5, 5, 130, 160));
        expect(extent!.frontM).toBeCloseTo(130);
        expect(extent!.carryM).toBeCloseTo(160);
        // Edge points extrapolate along the last segment past the line end.
        expect(extent!.frontPoint.y).toBeCloseTo(130);
        expect(extent!.carryPoint.y).toBeCloseTo(160);
    });

    test('ring straddling the origin clamps front to zero', () => {
        const line = [{ x: 0, y: 0 }, { x: 0, y: 300 }];
        const extent = ringExtentAlongLines([line], square(-5, 5, -20, 30));
        expect(extent!.frontM).toBe(0);
        expect(extent!.carryM).toBeCloseTo(30);
    });

    test('ring entirely behind the origin returns null', () => {
        const line = [{ x: 0, y: 0 }, { x: 0, y: 300 }];
        expect(ringExtentAlongLines([line], square(-5, 5, -80, -40))).toBeNull();
    });

    test('measures along the nearest of several lines (dogleg routed line)', () => {
        // Routed line turns east at (0, 100); direct line cuts the corner.
        const routed = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 200, y: 100 }];
        const direct = [{ x: 0, y: 0 }, { x: 200, y: 100 }];
        // A bunker on the second routed leg, well right of the direct line:
        // chainage = 100 (first leg) + 50..70 along the second.
        const extent = ringExtentAlongLines([routed, direct], square(50, 70, 95, 105));
        expect(extent).not.toBeNull();
        expect(extent!.frontM).toBeCloseTo(150);
        expect(extent!.carryM).toBeCloseTo(170);
        expect(extent!.side).toBe('on-line');
        // Edge points sit on the routed second leg, past the corner.
        expect(extent!.frontPoint).toEqual({ x: 50, y: 100 });
        expect(extent!.carryPoint).toEqual({ x: 70, y: 100 });
    });

    test('degenerate inputs return null', () => {
        const line = [{ x: 0, y: 0 }, { x: 0, y: 300 }];
        expect(ringExtentAlongLines([], square(0, 10, 0, 10))).toBeNull();
        expect(ringExtentAlongLines([[{ x: 0, y: 0 }]], square(0, 10, 0, 10))).toBeNull();
        expect(ringExtentAlongLines([line], { kind: 'bunker', points: [{ x: 0, y: 1 }, { x: 1, y: 1 }] })).toBeNull();
    });
});
