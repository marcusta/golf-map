import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';

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
    function emit(p: Vector2): void {
        let distanceSq = Infinity;
        for (const ring of contours) for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const dx = b.x - a.x, dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
            distanceSq = Math.min(distanceSq, (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2);
        }
        positions.push(p.x, p.y, 0);
        shores.push(Math.sqrt(distanceSq));
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
