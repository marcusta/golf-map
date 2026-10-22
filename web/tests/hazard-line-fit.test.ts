import { describe, expect, test } from 'bun:test';
import { fitHazardLine, hazardLineGeometry, HAZARD_LINE_FIT_TOLERANCE_M } from '../src/geo/hazard-line-fit';
import { flattenRing } from '../src/geo/bezier';

// A GKD water line (gspro.py gkd-lines: a closed ring, nodes every 3 m at most, staked 1-3 m outside the water)
// fitted as the smooth closed B-spline a drawn penalty line is. Checked against an independently flattened curve:
// every point along the staked line lies within the tolerance of it.

const E0 = 529_400;
const N0 = 6_487_400;

/** A staked line round a pond of radius `r`: out 1 m, and up to 3 m where a bank lifts it, nodes every `step` m. */
function pondLine(r: number, step = 3): [number, number][] {
    const n = Math.ceil((2 * Math.PI * (r + 2)) / step);
    return Array.from({ length: n }, (_, i) => {
        const a = (i / n) * 2 * Math.PI;
        const out = 1 + Math.max(0, Math.sin(3 * a)) * 2;  // three banks where the line goes out to 3 m
        const rr = r * (1 + 0.15 * Math.cos(2 * a)) + out;
        return [E0 + rr * Math.cos(a), N0 + rr * Math.sin(a)];
    });
}

/** A staked line round a meandering creek `length` m long, 4 m wide: both banks and the ends, nodes every 3 m. */
function creekLine(length: number): [number, number][] {
    const centre = (s: number) => ({ x: E0 + s, y: N0 + 25 * Math.sin(s / 40) });
    const side = (s: number, off: number): [number, number] => {
        const a = centre(s), b = centre(s + 0.01);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        return [a.x - ((b.y - a.y) / len) * off, a.y + ((b.x - a.x) / len) * off];
    };
    const pts: [number, number][] = [];
    for (let s = 0; s <= length; s += 3) pts.push(side(s, 3 + Math.sin(s / 17)));
    for (let s = length; s >= 0; s -= 3) pts.push(side(s, -3 - Math.cos(s / 13)));
    return pts;
}

/** Points every 0.1 m along the closed ring. */
function along(points: [number, number][]): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!;
        const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
        for (let s = 0; s < pieces; s++) out.push([a[0] + ((b[0] - a[0]) * s) / pieces, a[1] + ((b[1] - a[1]) * s) / pieces]);
    }
    return out;
}

function distToClosed(p: [number, number], poly: Array<[number, number]>): number {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i]!, [bx, by] = poly[(i + 1) % poly.length]!;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
        best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
    }
    return best;
}

describe('hazard line fit', () => {
    test('a pond line becomes one closed smooth B-spline ring that stays within the tolerance of the staked line', () => {
        const line = pondLine(30);
        const geometry = hazardLineGeometry(line);
        expect(geometry.crs).toBe('EPSG:3006');
        expect(geometry.curveType).toBe('bspline');
        expect(geometry.rings).toHaveLength(1);
        const controls = geometry.rings[0]!.points;
        expect(controls.length).toBeGreaterThanOrEqual(8);
        // Smooth all round: no corner points, no bezier handles, and the ring is not closed by a repeated point.
        expect(controls.every(p => p.corner === undefined && p.hIn === undefined && p.hOut === undefined)).toBe(true);
        expect(controls[0]).not.toEqual(controls[controls.length - 1]);

        const curve = flattenRing(geometry.rings[0]!, 0.01, 'bspline');
        const worst = Math.max(...along(line).map(p => distToClosed(p, curve)));
        expect(worst).toBeLessThanOrEqual(HAZARD_LINE_FIT_TOLERANCE_M + 1e-6);
        // …and the curve does not wander off between the nodes either.
        const back = Math.max(...curve.filter((_, i) => i % 5 === 0).map(p => distToClosed(p, line)));
        expect(back).toBeLessThanOrEqual(2 * HAZARD_LINE_FIT_TOLERANCE_M);
    });

    test('a long creek line gets controls in proportion to its length and still fits', () => {
        const line = creekLine(700);
        const fit = fitHazardLine(line);
        expect(fit.perimeterM).toBeGreaterThan(1400);
        // Far more than the 20 controls a freehand trace stops at, far fewer than the line's nodes.
        expect(fit.controls.length).toBeGreaterThan(60);
        expect(fit.controls.length).toBeLessThan(line.length);
        expect(fit.maxDeviation).toBeLessThanOrEqual(HAZARD_LINE_FIT_TOLERANCE_M);
        const curve = flattenRing({ points: fit.controls }, 0.01, 'bspline');
        const samples = along(line).filter((_, i) => i % 7 === 0);
        expect(Math.max(...samples.map(p => distToClosed(p, curve)))).toBeLessThanOrEqual(HAZARD_LINE_FIT_TOLERANCE_M + 1e-6);
    });

    test('a ring given closed (last point repeated) fits the same as an open one', () => {
        const line = pondLine(12);
        const closed = [...line, line[0]!];
        expect(fitHazardLine(closed).controls).toEqual(fitHazardLine(line).controls);
    });

    test('a degenerate line is refused instead of stored', () => {
        expect(() => fitHazardLine([[E0, N0], [E0 + 1, N0]])).toThrow(/could not be fitted/);
    });
});
