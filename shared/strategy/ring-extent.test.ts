import { describe, expect, test } from 'bun:test';
import { hazardsNearLines, ringExtentAlongLines } from './ring-extent';
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

describe('hazardsNearLines', () => {
    const line = [{ x: 0, y: 0 }, { x: 0, y: 300 }];

    test('includes rings beside the line within the corridor, side-tagged', () => {
        const hits = hazardsNearLines([line], [
            square(20, 40, 100, 130),   // right of the line, 20 m lateral gap
            square(-45, -25, 150, 180), // left of the line
        ], { corridorHalfWidthM: 60 });
        expect(hits).toHaveLength(2);
        expect(hits[0].side).toBe('right');
        expect(hits[0].frontM).toBeCloseTo(100);
        expect(hits[0].carryM).toBeCloseTo(130);
        expect(hits[0].frontPoint).toEqual({ x: 0, y: 100 });
        expect(hits[1].side).toBe('left');
        expect(hits[1].frontM).toBeCloseTo(150);
    });

    test('excludes rings outside the corridor', () => {
        const hits = hazardsNearLines([line], [square(80, 100, 100, 130)], { corridorHalfWidthM: 35 });
        expect(hits).toHaveLength(0);
    });

    test('a crossed ring reads on-line', () => {
        const hits = hazardsNearLines([line], [square(-10, 10, 60, 80)], { corridorHalfWidthM: 35 });
        expect(hits).toHaveLength(1);
        expect(hits[0].side).toBe('on-line');
        expect(hits[0].frontM).toBeCloseTo(60);
        expect(hits[0].carryM).toBeCloseTo(80);
    });

    test('excludes rings beyond the line end + extraAheadM and behind the start', () => {
        const behind = square(-5, 5, -60, -30);
        const justPast = square(-5, 5, 320, 335);  // front 320 ≤ 300 + 40
        const farPast = square(-5, 5, 360, 380);   // front 360 > 300 + 40
        const hits = hazardsNearLines([line], [behind, justPast, farPast], {
            corridorHalfWidthM: 35, extraAheadM: 40,
        });
        expect(hits).toHaveLength(1);
        expect(hits[0].frontM).toBeCloseTo(320);
    });

    test('measures along the nearest of several lines and sorts nearest-first', () => {
        const routed = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 200, y: 100 }];
        const direct = [{ x: 0, y: 0 }, { x: 200, y: 100 }];
        const secondLeg = square(50, 70, 110, 130); // above the second routed leg
        const firstLeg = square(15, 30, 40, 60);    // right of the first leg
        const hits = hazardsNearLines([routed, direct], [secondLeg, firstLeg], { corridorHalfWidthM: 60 });
        expect(hits).toHaveLength(2);
        expect(hits[0].frontM).toBeCloseTo(40);      // first-leg bunker nearest
        expect(hits[1].frontM).toBeCloseTo(150);     // 100 + 50 along the second leg
        expect(hits[1].side).toBe('left');           // above the eastward leg = left of travel
    });

    test('cap keeps the nearest rings', () => {
        const rings = [0, 1, 2].map(i => square(20, 30, 50 + i * 60, 70 + i * 60));
        const hits = hazardsNearLines([line], rings, { corridorHalfWidthM: 60, cap: 2 });
        expect(hits.map(h => Math.round(h.frontM))).toEqual([50, 110]);
    });
});
