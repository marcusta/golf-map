import { test, expect, describe } from 'bun:test';
import {
    flattenRing,
    flattenOpenPath,
    pointInRing,
    pointInGeometry,
    ringBbox,
    signedArea,
    nearestOnRing,
    splitSegment,
    outerRingArea,
    cubicBezierPoint,
    segmentControls,
    type PathRing,
    type FeatureGeometry,
} from '../src/geo/bezier';

// ── flattenRing — must match the server's flattening behavior ────────────

describe('flattenRing (server parity)', () => {
    test('straight-edged ring (no handles) returns just the anchor points', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        expect(flattenRing(ring, 0.25)).toEqual([
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]);
    });

    test('bezier segment is subdivided into multiple points', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        expect(flattenRing(ring, 0.25).length).toBeGreaterThan(4);
    });

    test('finer tolerance produces more subdivision points', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        expect(flattenRing(ring, 0.1).length).toBeGreaterThan(flattenRing(ring, 2.0).length);
    });

    test('single-point ring returns that point; empty ring returns []', () => {
        expect(flattenRing({ points: [{ x: 5, y: 5 }] }, 0.25)).toEqual([[5, 5]]);
        expect(flattenRing({ points: [] }, 0.25)).toEqual([]);
    });

    test('subdivision count matches the server heuristic: ceil(controlLength / tol), capped 256', () => {
        // One curved segment with a known control polygon length.
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 10, y: 0 } },
                { x: 30, y: 0, hIn: { x: 20, y: 0 } },
                { x: 30, y: 30 },
            ],
        };
        // Control length of segment 0 = 10 + 10 + 10 = 30; tol 1 → 30 pieces
        // → 29 interior points + anchor. Other two segments are straight.
        const flat = flattenRing(ring, 1.0);
        expect(flat.length).toBe(3 + 29);

        // Cap at 256 pieces even for absurdly fine tolerance.
        const fine = flattenRing(ring, 1e-9);
        expect(fine.length).toBe(3 + 255);
    });
});

describe('flattenOpenPath', () => {
    test('open path includes both endpoints and no closing segment', () => {
        const flat = flattenOpenPath(
            [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
            ],
            0.25,
        );
        expect(flat).toEqual([
            [0, 0],
            [10, 0],
            [10, 10],
        ]);
    });

    test('curved middle segment subdivides; endpoints exact', () => {
        const flat = flattenOpenPath(
            [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
            ],
            0.25,
        );
        expect(flat[0]).toEqual([0, 0]);
        expect(flat[flat.length - 1]).toEqual([10, 0]);
        expect(flat.length).toBeGreaterThan(2);
    });

    test('empty and single-point inputs', () => {
        expect(flattenOpenPath([], 0.25)).toEqual([]);
        expect(flattenOpenPath([{ x: 1, y: 2 }], 0.25)).toEqual([[1, 2]]);
    });
});

// ── hit testing ───────────────────────────────────────────────────────────

describe('pointInRing / pointInGeometry', () => {
    const square: Array<[number, number]> = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
    ];

    test('inside / outside / far away', () => {
        expect(pointInRing({ x: 5, y: 5 }, square)).toBe(true);
        expect(pointInRing({ x: 11, y: 5 }, square)).toBe(false);
        expect(pointInRing({ x: -3, y: -3 }, square)).toBe(false);
    });

    test('geometry with a hole: inside outer but inside hole = miss', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [
                { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] },
                { points: [{ x: 8, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 12 }, { x: 8, y: 12 }] },
            ],
        };
        expect(pointInGeometry({ x: 2, y: 2 }, geometry)).toBe(true);
        expect(pointInGeometry({ x: 10, y: 10 }, geometry)).toBe(false); // in the hole
        expect(pointInGeometry({ x: 30, y: 30 }, geometry)).toBe(false);
    });

    test('curved boundary is respected (bulge included in hit area)', () => {
        // Square with the right edge bulging out to x≈14 via handles.
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [
                {
                    points: [
                        { x: 0, y: 0 },
                        { x: 10, y: 0, hOut: { x: 15, y: 3 } },
                        { x: 10, y: 10, hIn: { x: 15, y: 7 } },
                        { x: 0, y: 10 },
                    ],
                },
            ],
        };
        expect(pointInGeometry({ x: 12, y: 5 }, geometry)).toBe(true); // inside bulge
        expect(pointInGeometry({ x: 12, y: 0.5 }, geometry)).toBe(false); // outside, near corner
    });
});

// ── bbox and area ─────────────────────────────────────────────────────────

describe('ringBbox / signedArea / outerRingArea', () => {
    test('bbox of a straight square', () => {
        const ring: PathRing = {
            points: [{ x: 1, y: 2 }, { x: 11, y: 2 }, { x: 11, y: 12 }, { x: 1, y: 12 }],
        };
        expect(ringBbox(ring)).toEqual({ minX: 1, minY: 2, maxX: 11, maxY: 12 });
    });

    test('bbox includes curved bulges beyond the anchors', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0, hOut: { x: 15, y: 3 } },
                { x: 10, y: 10, hIn: { x: 15, y: 7 } },
                { x: 0, y: 10 },
            ],
        };
        const bbox = ringBbox(ring)!;
        expect(bbox.maxX).toBeGreaterThan(10.5); // bulge extends right of the anchors
        expect(bbox.minX).toBe(0);
    });

    test('empty ring has no bbox', () => {
        expect(ringBbox({ points: [] })).toBeNull();
    });

    test('signedArea sign follows winding; outerRingArea is |area| of ring 0', () => {
        const ccw: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const cw = [...ccw].reverse() as Array<[number, number]>;
        expect(signedArea(ccw)).toBe(100);
        expect(signedArea(cw)).toBe(-100);

        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{ points: cw.map(([x, y]) => ({ x, y })) }],
        };
        expect(outerRingArea(geometry)).toBe(100);
    });
});

// ── nearest point on ring ─────────────────────────────────────────────────

describe('nearestOnRing', () => {
    const square: PathRing = {
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    };

    test('projects onto the closest straight edge', () => {
        const hit = nearestOnRing(square, { x: 5, y: -2 })!;
        expect(hit.segIdx).toBe(0); // bottom edge (0,0)→(10,0)
        expect(hit.point.x).toBeCloseTo(5, 3);
        expect(hit.point.y).toBeCloseTo(0, 3);
        expect(hit.dist).toBeCloseTo(2, 3);
        expect(hit.t).toBeCloseTo(0.5, 3);
    });

    test('closing segment (last anchor → first) is included', () => {
        const hit = nearestOnRing(square, { x: -2, y: 5 })!;
        expect(hit.segIdx).toBe(3); // left edge (0,10)→(0,0)
        expect(hit.point.x).toBeCloseTo(0, 3);
        expect(hit.point.y).toBeCloseTo(5, 3);
    });

    test('finds the nearest point on a curved segment', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 0, y: 10 } },
                { x: 20, y: 0, hIn: { x: 20, y: 10 } },
                { x: 10, y: -10 },
            ],
        };
        // Query above the arc's apex (apex ≈ (10, 7.5) for this cubic).
        const hit = nearestOnRing(ring, { x: 10, y: 12 })!;
        expect(hit.segIdx).toBe(0);
        expect(hit.point.x).toBeCloseTo(10, 1);
        expect(hit.point.y).toBeCloseTo(7.5, 1);
        expect(hit.t).toBeCloseTo(0.5, 2);
    });

    test('degenerate rings return null', () => {
        expect(nearestOnRing({ points: [] }, { x: 0, y: 0 })).toBeNull();
        expect(nearestOnRing({ points: [{ x: 1, y: 1 }] }, { x: 0, y: 0 })).toBeNull();
    });
});

// ── splitSegment ──────────────────────────────────────────────────────────

describe('splitSegment', () => {
    test('splitting a straight segment inserts a plain on-line anchor', () => {
        const square: PathRing = {
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        };
        const out = splitSegment(square, 0, 0.25);
        expect(out.points.length).toBe(5);
        expect(out.points[1]).toEqual({ x: 2.5, y: 0 });
        expect(out.points[1].hIn).toBeUndefined();
        expect(out.points[1].hOut).toBeUndefined();
        // Original untouched
        expect(square.points.length).toBe(4);
    });

    test('splitting a curved segment preserves the curve shape', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 5, y: 10 } },
                { x: 20, y: 0, hIn: { x: 15, y: 10 } },
                { x: 10, y: -10 },
            ],
        };
        const split = splitSegment(ring, 0, 0.37);

        expect(split.points.length).toBe(4);
        const mid = split.points[1];
        expect(mid.hIn).toBeDefined();
        expect(mid.hOut).toBeDefined();

        // The new anchor lies exactly on the original curve at t=0.37.
        const [p0, p1, p2, p3] = segmentControls(ring, 0);
        const [ex, ey] = cubicBezierPoint(p0, p1, p2, p3, 0.37);
        expect(mid.x).toBeCloseTo(ex, 9);
        expect(mid.y).toBeCloseTo(ey, 9);

        // Sample the original cubic at many t values; each sample must lie
        // (near-)exactly on the flattened split ring's first two segments.
        const flatSplit = flattenOpenPath(split.points.slice(0, 3), 0.01);
        for (let i = 1; i < 10; i++) {
            const t = i / 10;
            const [x, y] = cubicBezierPoint(p0, p1, p2, p3, t);
            const minDist = Math.min(...flatSplit.map(([fx, fy]) => Math.hypot(fx - x, fy - y)));
            // Distance to the nearest polyline VERTEX (not segment) — bounded
            // by the flattening chord spacing, so allow a few centimeters on
            // a ~25 m segment.
            expect(minDist).toBeLessThan(0.06);
        }
    });

    test('splitting the closing segment (last → first) works', () => {
        const square: PathRing = {
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        };
        const out = splitSegment(square, 3, 0.5);
        expect(out.points.length).toBe(5);
        expect(out.points[4]).toEqual({ x: 0, y: 5 });
    });
});
