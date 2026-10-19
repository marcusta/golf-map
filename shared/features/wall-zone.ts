/**
 * The ground a `wall` terrain edit shapes: a strip on one side of the wall's line (the water side), less the ground
 * that must stay (another pond's bank, a fall's sill). Used by `bun run terrain:wall` and, later, the terrain editor.
 * Points are EPSG:3006 metres.
 */
import polygonClipping, { type MultiPolygon, type Pair, type Polygon } from 'polygon-clipping';
import { unionRobust } from './centerline';

export type WallPt = { x: number; y: number };

const toPoly = (ring: readonly WallPt[]): Polygon => [ring.map((p) => [p.x, p.y] as [number, number]).concat([[ring[0].x, ring[0].y]])];

export function circleRing(c: WallPt, r: number, n = 16): WallPt[] {
    return Array.from({ length: n }, (_, k) => ({ x: c.x + r * Math.cos((2 * Math.PI * k) / n), y: c.y + r * Math.sin((2 * Math.PI * k) / n) }));
}

/**
 * A ring grown by `m`: the ring, a disc at every vertex and a band along every edge, unioned (on a snapped grid:
 * polygon-clipping trips over nearly coincident vertices). Vertices closer than m/4 are thinned first.
 */
export function grownRing(ring: readonly WallPt[], m: number): MultiPolygon {
    const pts: WallPt[] = [];
    for (const p of ring) if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) >= m / 4) pts.push(p);
    const closed = (r: readonly WallPt[]): Pair[] => toPoly(r)[0];
    const parts: Pair[][] = [closed(pts)];
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        parts.push(closed(circleRing(a, m, 10)));
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = (-(b.y - a.y) / L) * m, ny = ((b.x - a.x) / L) * m;
        parts.push(closed([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]));
    }
    return unionRobust(parts);
}

/** +1 when `ring` (the water) lies left of the line's first-to-last direction, -1 when right. */
export function wallSideOf(line: readonly WallPt[], ring: readonly WallPt[]): 1 | -1 {
    const c = { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
    const a = line[0], b = line[line.length - 1];
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0 ? 1 : -1;
}

/**
 * The strip `reachM` wide on `side` of `line` and `behindM` on its other side (the plateau the wall keeps on its own
 * slope), less each `keep` ring grown by `keepMarginM` and each `avoid` circle.
 * Returns the biggest piece left (its outer ring first, holes after) and how many small pieces were dropped. Worked
 * in metres round the line's first point: polygon-clipping loses its sweep line on 6.4e6-sized coordinates.
 */
export function wallZone(
    line: readonly WallPt[],
    side: 1 | -1,
    reachM: number,
    keep: readonly (readonly WallPt[])[] = [],
    keepMarginM = 3,
    avoid: readonly { x: number; y: number; r: number }[] = [],
    behindM = 0,
): { rings: WallPt[][]; dropped: number } | null {
    const o = line[0];
    const local = (r: readonly WallPt[]) => r.map((p) => ({ x: p.x - o.x, y: p.y - o.y }));
    line = local(line);
    const out: WallPt[] = [], back: WallPt[] = [];
    for (let i = 0; i < line.length; i++) {
        const p = line[i], q0 = line[Math.max(i - 1, 0)], q1 = line[Math.min(i + 1, line.length - 1)];
        const L = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1;
        const nx = (-(q1.y - q0.y) / L) * side, ny = ((q1.x - q0.x) / L) * side;
        out.push({ x: p.x + nx * reachM, y: p.y + ny * reachM });
        back.push({ x: p.x - nx * behindM, y: p.y - ny * behindM });
    }
    let zone: MultiPolygon = [toPoly([...(behindM > 0 ? back : line), ...out.reverse()])];
    for (const ring of keep) zone = polygonClipping.difference(zone, grownRing(local(ring), keepMarginM));
    for (const c of avoid) zone = polygonClipping.difference(zone, [toPoly(circleRing({ x: c.x - o.x, y: c.y - o.y }, c.r))]);
    if (zone.length === 0) return null;
    const biggest = zone.reduce((best, p) => (p[0].length > best[0].length ? p : best));
    return { rings: biggest.map((r) => r.slice(0, -1).map(([x, y]) => ({ x: x + o.x, y: y + o.y }))), dropped: zone.length - 1 };
}
