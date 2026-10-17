import { describe, expect, test } from 'bun:test';
import {
    autoCorners,
    bufferCenterlinePolyline,
    capPresetOf,
    centerlineError,
    centerlineGeometry,
    corridorRings,
    flattenCenterline,
    nearestOnCenterline,
    type CenterlinePoint,
} from './centerline';

const X = 538_000, Y = 6_398_000;
const p = (x: number, y: number, corner?: boolean): CenterlinePoint => (corner ? { x: X + x, y: Y + y, corner } : { x: X + x, y: Y + y });

function area(points: Array<{ x: number; y: number }>): number {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const q = points[i], r = points[(i + 1) % points.length];
        a += q.x * r.y - r.x * q.y;
    }
    return Math.abs(a / 2);
}

/** Distance from q to the nearest segment of an open polyline. */
function distToPolyline(q: { x: number; y: number }, line: Array<{ x: number; y: number }>): number {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)));
    }
    return best;
}

describe('centerline corridor', () => {
    test('a straight line buffers to a rectangle with round caps', () => {
        const rings = corridorRings({ points: [p(0, 0), p(100, 0)], widthM: 4 })!;
        expect(rings).toHaveLength(1);
        // 100 × 4 plus a full disc of radius 2 (as a 32-gon).
        const disc = 16 * 4 * Math.sin((2 * Math.PI) / 32);
        expect(area(rings[0].points)).toBeCloseTo(400 + disc, 2);
        for (const q of rings[0].points) expect(distToPolyline(q, [p(0, 0), p(100, 0)])).toBeCloseTo(2, 3);
    });

    test('every kerb point is a half-width from the curve, however it bends', () => {
        const points = [p(0, 0), p(40, 5), p(60, 30), p(55, 60, true), p(90, 70), p(95, 72)];
        const rings = corridorRings({ points, widthM: 5 })!;
        const curve = flattenCenterline(points);
        for (const q of rings[0].points) expect(Math.abs(distToPolyline(q, curve) - 2.5)).toBeLessThan(0.01);
    });

    test('a hairpin tighter than the road stays one solid surface', () => {
        const rings = corridorRings({ points: [p(0, 0), p(30, 0), p(31, 1.5), p(0, 3)], widthM: 6 })!;
        expect(rings).toHaveLength(1);
    });

    test('a closed loop leaves its inside as a hole', () => {
        const points = [p(0, 0), p(50, 0, true), p(50, 50, true), p(0, 50, true), p(0, -10)];
        const rings = corridorRings({ points, widthM: 4 })!;
        expect(rings).toHaveLength(2);
        expect(area(rings[1].points)).toBeCloseTo(46 * 46, 0);
    });

    test('bufferCenterlinePolyline rejects a line with no length', () => {
        expect(bufferCenterlinePolyline([{ x: X, y: Y }, { x: X, y: Y }], 2)).toBeNull();
        expect(bufferCenterlinePolyline([{ x: X, y: Y }, { x: X + 1, y: Y }], 0)).toBeNull();
    });
});

describe('centerline end shapes', () => {
    const line = [p(0, 0), p(100, 0)];
    const ring = (startCap?: object, endCap?: object) => corridorRings({ points: line, widthM: 4, ...(startCap ? { startCap } : {}), ...(endCap ? { endCap } : {}) } as never)!;
    const xs = (r: ReturnType<typeof ring>) => r[0].points.map(q => q.x - X);
    const halfWidthNear = (r: ReturnType<typeof ring>, x0: number, x1: number) =>
        Math.max(...r[0].points.filter(q => q.x - X >= x0 && q.x - X <= x1).map(q => Math.abs(q.y - Y)));

    test('a road without caps and one with rounding 1 are the same half circles', () => {
        expect(JSON.stringify(ring({ shape: 'rounded', rounding: 1 }, { shape: 'rounded', rounding: 1 }))).toBe(JSON.stringify(ring()));
    });

    test('rounding 0 cuts the road straight at its end points', () => {
        const r = ring({ shape: 'rounded', rounding: 0 }, { shape: 'rounded', rounding: 0 });
        expect(area(r[0].points)).toBeCloseTo(400, 6);
        expect(Math.min(...xs(r))).toBeCloseTo(0, 6);
        expect(Math.max(...xs(r))).toBeCloseTo(100, 6);
    });

    test('soft corners reach rounding × half width beyond the end, full width at the end point', () => {
        const r = ring({ shape: 'rounded', rounding: 0.4 }, { shape: 'rounded', rounding: 0.4 });
        expect(Math.min(...xs(r))).toBeCloseTo(-0.8, 6);
        expect(Math.max(...xs(r))).toBeCloseTo(100.8, 6);
        expect(halfWidthNear(r, 99.999, 100.001)).toBeCloseTo(2, 6);
        expect(area(r[0].points)).toBeGreaterThan(400 + 2 * 4 * 0.8 - 2 * 0.8 * 0.8);
        expect(area(r[0].points)).toBeLessThan(400 + 2 * 4 * 0.8);
    });

    test('a turning circle is a disc of the diameter about the end point, 2.5 × width by default', () => {
        const r = ring(undefined, { shape: 'turning' });
        expect(r).toHaveLength(1);
        expect(Math.max(...xs(r))).toBeCloseTo(105, 3);
        expect(halfWidthNear(r, 95, 105)).toBeCloseTo(5, 3);
        expect(Math.max(...xs(ring(undefined, { shape: 'turning', diameterM: 16 })))).toBeCloseTo(108, 3);
    });

    test('a turning circle meets the road with fillets: no sharp inside corner where it leaves the kerb', () => {
        const r = ring(undefined, { shape: 'turning' });
        // Without fillets the kerb (y = ±2) would run straight into the circle at x = 100 - √21 ≈ 95.42;
        // a fillet of radius 2 leaves it at 100 - √((5+2)² - (2+2)²) = 100 - √33.
        const kerbEnd = Math.max(...r[0].points.filter(q => Math.abs(Math.abs(q.y - Y) - 2) < 1e-6).map(q => q.x - X));
        expect(kerbEnd).toBeCloseTo(100 - Math.sqrt(33), 3);
    });

    test('a taper narrows the last 2 × width to 40 % and ends in a round tip', () => {
        const r = ring(undefined, { shape: 'taper' });
        expect(halfWidthNear(r, 80, 92)).toBeCloseTo(2, 6);
        expect(halfWidthNear(r, 99.9, 101)).toBeCloseTo(0.8, 3);
        expect(Math.max(...xs(r))).toBeCloseTo(100.8, 3);
        expect(halfWidthNear(r, 91.999, 92.001)).toBeCloseTo(2, 6); // the narrowing starts 8 m from the end
    });

    test('tapers on both ends of a short road share its length', () => {
        const r = corridorRings({ points: [p(0, 0), p(6, 0)], widthM: 4, startCap: { shape: 'taper' }, endCap: { shape: 'taper' } })!;
        expect(r).toHaveLength(1);
        expect(halfWidthNear(r, 2.999, 3.001)).toBeCloseTo(2, 6);
    });

    test('caps are validated', () => {
        const c = (cap: object) => centerlineError({ points: line, widthM: 4, endCap: cap });
        expect(c({ shape: 'rounded', rounding: 0.4 })).toBeNull();
        expect(c({ shape: 'turning' })).toBeNull();
        expect(c({ shape: 'taper', lengthM: 10, endWidthM: 0 })).toBeNull();
        expect(c({ shape: 'rounded' })).toContain('rounding');
        expect(c({ shape: 'rounded', rounding: 1.5 })).toContain('rounding');
        expect(c({ shape: 'turning', diameterM: 3 })).toContain('diameter');
        expect(c({ shape: 'taper', endWidthM: 4 })).toContain('end width');
        expect(c({ shape: 'square' })).toContain('shape');
        expect(c({ shape: 'taper', lengthM: 'long' })).toContain('numbers');
    });

    test('centerlineGeometry keeps the caps, without unknown fields', () => {
        const g = centerlineGeometry('EPSG:3006', { points: line, widthM: 4, startCap: { shape: 'rounded', rounding: 0, diameterM: 9 } as never, endCap: { shape: 'turning', diameterM: 12 } })!;
        expect(g.centerline.startCap).toEqual({ shape: 'rounded', rounding: 0 });
        expect(g.centerline.endCap).toEqual({ shape: 'turning', diameterM: 12 });
        expect(centerlineGeometry('EPSG:3006', { points: line, widthM: 4 })!.centerline).toEqual({ points: line, widthM: 4 });
    });

    test('capPresetOf names the preset a cap is', () => {
        expect(capPresetOf(undefined)).toBe('round');
        expect(capPresetOf({ shape: 'rounded', rounding: 0.4 })).toBe('soft');
        expect(capPresetOf({ shape: 'rounded', rounding: 0 })).toBe('straight');
        expect(capPresetOf({ shape: 'turning' })).toBe('turning');
        expect(capPresetOf({ shape: 'turning', diameterM: 14 })).toBeNull();
        expect(capPresetOf({ shape: 'rounded', rounding: 0.55 })).toBeNull();
    });
});

describe('centerline curve', () => {
    test('passes through every control point, straight into and out of a corner', () => {
        const points = [p(0, 0), p(40, 0), p(40, 40, true), p(80, 60)];
        const curve = flattenCenterline(points);
        for (const c of points) expect(Math.min(...curve.map(q => Math.hypot(q.x - c.x, q.y - c.y)))).toBeLessThan(1e-9);
    });

    test('evenly spaced points on an arc follow the arc', () => {
        const points: CenterlinePoint[] = [];
        for (let i = 0; i <= 6; i++) {
            const a = (i * 20 * Math.PI) / 180;
            points.push(p(40 * Math.cos(a), 40 * Math.sin(a)));
        }
        // Interior spans (the end spans leave along their chord).
        const curve = flattenCenterline(points.slice(0, 7)).filter(q =>
            Math.hypot(q.x - points[0].x, q.y - points[0].y) > 14 && Math.hypot(q.x - points[6].x, q.y - points[6].y) > 14);
        for (const q of curve) expect(Math.abs(Math.hypot(q.x - X, q.y - Y) - 40)).toBeLessThan(0.1);
    });

    test('a long straight into a tight bend does not overshoot', () => {
        const curve = flattenCenterline([p(0, 0), p(200, 0), p(205, 5), p(205, 10)]);
        for (const q of curve) expect(q.y - Y).toBeGreaterThan(-0.5);
    });

    test('nearestOnCenterline names the span a point lies along', () => {
        const points = [p(0, 0), p(50, 0), p(100, 0)];
        const hit = nearestOnCenterline(points, { x: X + 70, y: Y + 1 })!;
        expect(hit.span).toBe(1);
        expect(hit.dist).toBeCloseTo(1, 3);
    });

    test('autoCorners flags sharp turns only', () => {
        const pts = autoCorners([p(0, 0), p(50, 0), p(50, 50), p(55, 90)], 45);
        expect(pts.map(q => q.corner === true)).toEqual([false, true, false, false]);
    });
});

describe('centerline geometry', () => {
    test('derives the rings and cleans the centerline', () => {
        const geometry = centerlineGeometry('EPSG:3006', { points: [p(0, 0), p(0, 0), p(30, 0, false), p(30, 20, true)], widthM: 3 })!;
        expect(geometry.curveType).toBe('bezier');
        expect(geometry.centerline.points).toEqual([p(0, 0), p(30, 0), p(30, 20, true)]);
        expect(geometry.rings[0].points.length).toBeGreaterThan(10);
    });

    test('validation', () => {
        expect(centerlineError({ points: [p(0, 0), p(10, 0)], widthM: 3 })).toBeNull();
        expect(centerlineError({ points: [p(0, 0)], widthM: 3 })).toMatch(/2 distinct/);
        expect(centerlineError({ points: [p(0, 0), p(10, 0)], widthM: 0 })).toMatch(/widthM/);
        expect(centerlineError({ points: [{ x: Number.NaN, y: 0 }, p(10, 0)], widthM: 3 })).toMatch(/finite/);
        expect(centerlineError(null)).toMatch(/object/);
        expect(centerlineGeometry('EPSG:3006', { points: [p(0, 0)], widthM: 3 })).toBeNull();
    });
});
