import { describe, expect, test } from 'bun:test';
import { corridorWidth, DEFAULT_HAZARD_TYPES, type FlatRing } from './corridor';

// Hand-computed planar fixtures. Compass bearings: axis 0° = north (+y),
// so "right" = +x (east) and "left" = −x (west).

const square = (minX: number, maxX: number, minY: number, maxY: number, kind = 'bunker'): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

describe('corridorWidth', () => {
    test('square hazard right of a north axis: right 10, left capped', () => {
        const bunker = square(10, 20, -5, 5);
        const w = corridorWidth({ station: { x: 0, y: 0 }, axisBearingDeg: 0, obstacles: [bunker] });
        expect(w.rightM).toBeCloseTo(10, 9);
        expect(w.rightHit).toBe(bunker);
        expect(w.leftM).toBe(100); // default cap
        expect(w.leftHit).toBeUndefined();
    });

    test('no obstacles → both sides at the cap', () => {
        const w = corridorWidth({ station: { x: 0, y: 0 }, axisBearingDeg: 0, obstacles: [] });
        expect(w.leftM).toBe(100);
        expect(w.rightM).toBe(100);
        expect(w.leftHit).toBeUndefined();
        expect(w.rightHit).toBeUndefined();
    });

    test('custom cap: hazard beyond the cap is ignored', () => {
        const far = square(60, 70, -5, 5);
        const w = corridorWidth({
            station: { x: 0, y: 0 },
            axisBearingDeg: 0,
            obstacles: [far],
            maxHalfWidthM: 50,
        });
        expect(w.rightM).toBe(50);
        expect(w.rightHit).toBeUndefined();
    });

    test('station inside a hazard → 0/0 with the ring as both hits', () => {
        const water = square(10, 20, -5, 5, 'water');
        const w = corridorWidth({ station: { x: 15, y: 0 }, axisBearingDeg: 0, obstacles: [water] });
        expect(w.leftM).toBe(0);
        expect(w.rightM).toBe(0);
        expect(w.leftHit).toBe(water);
        expect(w.rightHit).toBe(water);
    });

    test('asymmetric corridor: different hazards at different distances', () => {
        const leftTrees = square(-30, -25, -10, 10, 'deep_rough');
        const rightWater = square(10, 20, -10, 10, 'water');
        const w = corridorWidth({
            station: { x: 0, y: 0 },
            axisBearingDeg: 0,
            obstacles: [leftTrees, rightWater],
        });
        expect(w.leftM).toBeCloseTo(25, 9);
        expect(w.leftHit).toBe(leftTrees);
        expect(w.rightM).toBeCloseTo(10, 9);
        expect(w.rightHit).toBe(rightWater);
    });

    test('nearest ring wins when several overlap one side', () => {
        const near = square(8, 12, -5, 5);
        const far = square(15, 30, -5, 5, 'outside');
        const w = corridorWidth({
            station: { x: 0, y: 0 },
            axisBearingDeg: 0,
            obstacles: [far, near],
        });
        expect(w.rightM).toBeCloseTo(8, 9);
        expect(w.rightHit).toBe(near);
    });

    test('axis bearing 90 (east): left = north, right = south', () => {
        const north = square(-5, 5, 30, 40); // 30 m above the station
        const south = square(-5, 5, -22, -15); // 15 m below
        const w = corridorWidth({
            station: { x: 0, y: 0 },
            axisBearingDeg: 90,
            obstacles: [north, south],
        });
        expect(w.leftM).toBeCloseTo(30, 9); // facing east, left = +y
        expect(w.leftHit).toBe(north);
        expect(w.rightM).toBeCloseTo(15, 9);
        expect(w.rightHit).toBe(south);
    });

    test('diagonal edge: ray hits a slanted segment at the interpolated point', () => {
        // Diamond with vertices (10,0), (15,5), (20,0), (15,−5); ray east from
        // (0,1) crosses edge (10,0)→(15,5) where y = 1 → x = 11.
        const diamond: FlatRing = {
            kind: 'bunker',
            points: [
                { x: 10, y: 0 },
                { x: 15, y: 5 },
                { x: 20, y: 0 },
                { x: 15, y: -5 },
            ],
        };
        const w = corridorWidth({ station: { x: 0, y: 1 }, axisBearingDeg: 0, obstacles: [diamond] });
        expect(w.rightM).toBeCloseTo(11, 9);
        expect(w.rightHit).toBe(diamond);
    });

    test('ray direction matters: hazard behind the left ray never hits the right side', () => {
        const west = square(-20, -10, -5, 5);
        const w = corridorWidth({ station: { x: 0, y: 0 }, axisBearingDeg: 0, obstacles: [west] });
        expect(w.leftM).toBeCloseTo(10, 9);
        expect(w.rightM).toBe(100);
    });

    test('degenerate rings (< 3 points) never classify the station as inside', () => {
        const sliver: FlatRing = { kind: 'water', points: [{ x: 5, y: -1 }, { x: 5, y: 1 }] };
        const w = corridorWidth({ station: { x: 0, y: 0 }, axisBearingDeg: 0, obstacles: [sliver] });
        // The two-point "ring" is never an "inside" hit (no area), but its
        // segment still blocks the ray like any boundary.
        expect(w.rightM).toBeCloseTo(5, 9);
        expect(w.rightHit).toBe(sliver);
        expect(w.leftM).toBe(100);
    });
});

describe('DEFAULT_HAZARD_TYPES', () => {
    test('matches the ROADMAP Phase-5 decision set', () => {
        expect([...DEFAULT_HAZARD_TYPES]).toEqual(['bunker', 'water', 'water_creek', 'outside', 'deep_rough']);
    });
});
