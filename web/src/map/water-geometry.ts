import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';

/**
 * Shore distances are capped here: the shader's depth tint and edge fade are
 * flat beyond it (exp(-25 / 3.5) < 0.001), and the cap bounds the edge search.
 */
export const SHORE_MAX_M = 25;

/**
 * Distance to the nearest ring edge, capped at SHORE_MAX_M. Edges are bucketed
 * in a SHORE_MAX_M grid, so a query reads its 3x3 cells instead of every edge
 * of every ring (which cost seconds per rebuild on a course's creeks).
 */
function shoreDistance(contours: Vector2[][]): (p: Vector2) => number {
    const cells = new Map<number, number[]>();
    const edges: number[] = [];
    const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
    for (const ring of contours) for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const e = edges.length;
        edges.push(a.x, a.y, b.x, b.y);
        const x1 = Math.floor(Math.max(a.x, b.x) / SHORE_MAX_M), y1 = Math.floor(Math.max(a.y, b.y) / SHORE_MAX_M);
        for (let cx = Math.floor(Math.min(a.x, b.x) / SHORE_MAX_M); cx <= x1; cx++) {
            for (let cy = Math.floor(Math.min(a.y, b.y) / SHORE_MAX_M); cy <= y1; cy++) {
                const key = cellKey(cx, cy);
                const bucket = cells.get(key);
                if (bucket) bucket.push(e); else cells.set(key, [e]);
            }
        }
    }
    return p => {
        let distanceSq = SHORE_MAX_M * SHORE_MAX_M;
        const px = Math.floor(p.x / SHORE_MAX_M), py = Math.floor(p.y / SHORE_MAX_M);
        for (let cx = px - 1; cx <= px + 1; cx++) for (let cy = py - 1; cy <= py + 1; cy++) {
            for (const e of cells.get(cellKey(cx, cy)) ?? []) {
                const ax = edges[e], ay = edges[e + 1];
                const dx = edges[e + 2] - ax, dy = edges[e + 3] - ay;
                const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy || 1)));
                distanceSq = Math.min(distanceSq, (p.x - ax - t * dx) ** 2 + (p.y - ay - t * dy) ** 2);
            }
        }
        return Math.sqrt(distanceSq);
    };
}

/** Triangulate islands and concave banks, then subdivide for terrain sampling. */
export function waterGeometry(rings: Vector2[][]): BufferGeometry {
    const contours = rings.map(r => {
        const points = [...r];
        if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
        return points;
    }).filter(r => r.length >= 3);
    const geometry = new BufferGeometry();
    if (!contours.length) return geometry;
    const points = contours.flat();
    const faces = ShapeUtils.triangulateShape(contours[0], contours.slice(1));
    const positions: number[] = [], shores: number[] = [];
    const shore = shoreDistance(contours);
    function emit(p: Vector2): void {
        positions.push(p.x, p.y, 0);
        shores.push(shore(p));
    }
    function triangle(a: Vector2, b: Vector2, c: Vector2, depth: number): void {
        const lengths = [a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a)];
        const longest = Math.max(...lengths);
        if (longest <= 64 || depth === 8) { emit(a); emit(b); emit(c); return; }
        if (lengths.indexOf(longest) === 1) { triangle(b, c, a, depth); return; }
        if (lengths.indexOf(longest) === 2) { triangle(c, a, b, depth); return; }
        const middle = a.clone().lerp(b, 0.5);
        triangle(a, middle, c, depth + 1);
        triangle(middle, b, c, depth + 1);
    }
    for (const [a, b, c] of faces) triangle(points[a], points[b], points[c], 0);
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('shore', new Float32BufferAttribute(shores, 1));
    return geometry;
}
