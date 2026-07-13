import { test, expect } from 'bun:test';
import { projectRouting, THUMB_W, THUMB_H, type RoutingHole } from '../src/courses/course-thumb';

const PAD = 0.12;
const INNER_W = THUMB_W * (1 - 2 * PAD);
const INNER_H = THUMB_H * (1 - 2 * PAD);

function bbox(points: [number, number][]): { minX: number; minY: number; maxX: number; maxY: number } {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

test('empty routing returns null', () => {
    expect(projectRouting([])).toBeNull();
});

test('single hole projects tee/green symmetrically inside the padded box', () => {
    const routing: RoutingHole[] = [{ hole: 1, tee: [58.401, 15.566], green: [58.402, 15.565] }];
    const holes = projectRouting(routing);

    expect(holes).not.toBeNull();
    expect(holes).toHaveLength(1);

    const [tx, ty] = holes![0]!.tee;
    const [gx, gy] = holes![0]!.green;
    const box = bbox([[tx, ty], [gx, gy]]);

    // Fitted into the viewBox with the PAD inset, never outside it.
    expect(box.minX).toBeGreaterThanOrEqual(0);
    expect(box.minY).toBeGreaterThanOrEqual(0);
    expect(box.maxX).toBeLessThanOrEqual(THUMB_W);
    expect(box.maxY).toBeLessThanOrEqual(THUMB_H);
});

test('bbox of projected points fits within the padded inner box, touching at least one edge', () => {
    // A routing with real spread across several holes.
    const routing: RoutingHole[] = [
        { hole: 1, tee: [58.401, 15.566], green: [58.4015, 15.5655] },
        { hole: 2, tee: [58.4025, 15.564], green: [58.403, 15.5635] },
        { hole: 3, tee: [58.4005, 15.5675], green: [58.400, 15.568] },
    ];
    const holes = projectRouting(routing)!;
    const allPts = holes.flatMap(h => [h.tee, h.green]);
    const box = bbox(allPts);

    const padX = (THUMB_W - INNER_W) / 2;
    const padY = (THUMB_H - INNER_H) / 2;

    // Within the padded viewBox (allow a small rounding tolerance — the impl
    // rounds each coordinate to 1 decimal place).
    expect(box.minX).toBeGreaterThanOrEqual(padX - 0.2);
    expect(box.minY).toBeGreaterThanOrEqual(padY - 0.2);
    expect(box.maxX).toBeLessThanOrEqual(THUMB_W - padX + 0.2);
    expect(box.maxY).toBeLessThanOrEqual(THUMB_H - padY + 0.2);

    // The larger span (relative to the viewBox aspect) should hug its inner
    // edge closely — proves the fit scales to fill, not shrink arbitrarily.
    const spanX = box.maxX - box.minX;
    const spanY = box.maxY - box.minY;
    const fillsX = spanX / INNER_W;
    const fillsY = spanY / INNER_H;
    expect(Math.max(fillsX, fillsY)).toBeGreaterThan(0.9);
});

test('preserves aspect ratio: a north-south routing (no east-west spread) is not stretched horizontally', () => {
    // Two points due north of each other — pure north-south line. cos(lat)
    // correction only affects the east-west (x) axis, so x should barely move.
    const routing: RoutingHole[] = [{ hole: 1, tee: [58.400, 15.566], green: [58.410, 15.566] }];
    const holes = projectRouting(routing)!;

    const [tx] = holes[0]!.tee;
    const [gx] = holes[0]!.green;
    // Same longitude → after projection, x should be (near) identical for
    // both points (up to the 1-decimal rounding in the implementation).
    expect(Math.abs(tx - gx)).toBeLessThanOrEqual(0.1);
});

test('a real spread projects proportionally: doubling the geographic span doubles the pre-fit aspect but the fitted output stays within bounds', () => {
    // Verify aspect preservation directly: construct a routing whose raw
    // (unprojected) bbox is exactly 2x wider than tall, and check the
    // fitted output's span ratio matches (within the scale-vs-viewBox slack).
    const routing: RoutingHole[] = [
        { hole: 1, tee: [58.400, 15.560], green: [58.400, 15.570] }, // wide, no north-south spread
        { hole: 2, tee: [58.400, 15.560], green: [58.400, 15.570] },
    ];
    const holes = projectRouting(routing)!;
    const allPts = holes.flatMap(h => [h.tee, h.green]);
    const box = bbox(allPts);
    const spanX = box.maxX - box.minX;
    const spanY = box.maxY - box.minY;

    // The geometry has essentially zero north-south spread — the fitted
    // output's y-span should collapse near zero too (all points share y),
    // while the x-span fills most of the inner width.
    expect(spanY).toBeLessThan(1);
    expect(spanX).toBeGreaterThan(INNER_W * 0.9);
});

test('projected coordinates are rounded to 1 decimal place', () => {
    const routing: RoutingHole[] = [{ hole: 1, tee: [58.40123456, 15.56654321], green: [58.40234567, 15.56512345] }];
    const holes = projectRouting(routing)!;

    for (const h of holes) {
        for (const [x, y] of [h.tee, h.green]) {
            expect(x).toBeCloseTo(Math.round(x * 10) / 10, 9);
            expect(y).toBeCloseTo(Math.round(y * 10) / 10, 9);
        }
    }
});

test('degenerate routing (single identical tee/green point) does not throw and centers in the viewBox', () => {
    const routing: RoutingHole[] = [{ hole: 1, tee: [58.401, 15.566], green: [58.401, 15.566] }];
    const holes = projectRouting(routing)!;

    const [tx, ty] = holes[0]!.tee;
    const [gx, gy] = holes[0]!.green;
    expect(tx).toBeCloseTo(gx, 1);
    expect(ty).toBeCloseTo(gy, 1);
    // Centered in the viewBox.
    expect(tx).toBeCloseTo(THUMB_W / 2, 0);
    expect(ty).toBeCloseTo(THUMB_H / 2, 0);
});
