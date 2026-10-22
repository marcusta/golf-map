// Where a tee lies from its scorecard length: the length runs along the line of
// play, tee -> aim points -> green centre, measured flat (how a course is
// measured). From the first aim point (the dogleg; the green centre on a hole
// without aim points) the rest of the line is fixed, so the tee lies on a circle
// round it whose radius is the length left; where that circle crosses a drawn
// tee shape is the tee. TeePlacementService runs this for every hole and set.
//
// Which tee shape, when the circle crosses more than one (Vreta has 15 such
// cases): a shape on this hole, then one on no hole, and only then one on another
// hole (Vreta's hole 5 red tee stands on a box drawn on hole 4; that spot comes
// back marked `otherHole` for the user to confirm); within a rank, the one most
// in line with the hole's line back from the first aim point (towards the back
// tee). A shape that is not this hole's further off that line than WINDOW_DEG is
// left out. Two of the same rank within AMBIGUOUS_DEG of each other are left to
// the user. The tee goes on the middle of the circle's arc across the shape.
//
// All coordinates are EPSG:3006 metres; angles are radians unless named _DEG.

export type Xy = [number, number];

export interface PlacementHole {
    id: string;
    /** In play order. */
    aims: Xy[];
    /** The green centre; a hole without one gets no tees. */
    green: Xy | null;
    /** Every tee on the hole, any set: the back one says where the line runs back to. */
    tees: Xy[];
}

export interface PlacementShape {
    id: string;
    /** The hole the shape is on; null = Others. */
    holeId: string | null;
    /** Outer ring, flattened. */
    ring: Xy[];
}

export interface Spot {
    xy: Xy;
    /** The tee shape it lies on; null for a spot on no shape (missed). */
    shapeId: string | null;
}

export type Placement =
    /** `otherHole`: the only shape on the circle is another hole's (a shared tee box, or one on the wrong hole). */
    | { kind: 'spot'; spot: Spot; ambiguous: boolean; alternatives: Spot[]; otherHole: string | null }
    /** The circle crosses no tee shape; `spot` = where it crosses the line back, when that is known. */
    | { kind: 'missed'; spot: Spot | null }
    /** The length is shorter than the line from the first aim point to the green. */
    | { kind: 'too-short' }
    | { kind: 'no-green' };

/** A tee this close to its length is where the card says. */
export const OK_M = 2;
/** A shape on no hole further than this off the hole's line back is another hole's. */
export const WINDOW_DEG = 45;
/** Two candidate shapes this close in angle are a call for the user. */
export const AMBIGUOUS_DEG = 15;
/** Spots closer than this are the same place (two sets sharing a tee). */
const SAME_SPOT_M = 5;
/** The shortest length left from the first aim point that is still a tee shot. */
const MIN_RADIUS_M = 5;

const dist = (a: Xy, b: Xy) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleOf = (from: Xy, to: Xy) => Math.atan2(to[1] - from[1], to[0] - from[0]);
const onCircle = (c: Xy, r: number, a: number): Xy => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** Angle between two directions, degrees 0..180. */
export function angleDiffDeg(a: number, b: number): number {
    let d = Math.abs(a - b) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return (d * 180) / Math.PI;
}

/** The first point a tee plays to (first aim point, else the green centre) and the line's length from there to the green. */
export function lineFromFirst(hole: PlacementHole): { first: Xy; rest: number } | null {
    if (!hole.green) return null;
    const pts = [...hole.aims, hole.green];
    let rest = 0;
    for (let i = 0; i + 1 < pts.length; i++) rest += dist(pts[i]!, pts[i + 1]!);
    return { first: pts[0]!, rest };
}

/** A tee's length as a card measures it: tee -> aim points -> green centre, flat. Null without a green. */
export function teeLength(hole: PlacementHole, tee: Xy): number | null {
    const line = lineFromFirst(hole);
    return line ? dist(tee, line.first) + line.rest : null;
}

/** Point in ring (even-odd). */
export function inRing(p: Xy, ring: Xy[]): boolean {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
}

/** The arcs of the circle (centre `c`, radius `r`) inside `ring`: start angle and sweep, radians, counter-clockwise. */
export function arcSpans(c: Xy, r: number, ring: Xy[]): { from: number; sweep: number }[] {
    const angles: number[] = [];
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const a = ring[i]!, b = ring[(i + 1) % n]!;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const A = dx * dx + dy * dy;
        if (A === 0) continue;
        const fx = a[0] - c[0], fy = a[1] - c[1];
        const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
        const disc = B * B - 4 * A * C;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
            if (t >= 0 && t < 1) angles.push((Math.atan2(a[1] + t * dy - c[1], a[0] + t * dx - c[0]) + 2 * Math.PI) % (2 * Math.PI));
        }
    }
    if (!angles.length) return inRing(onCircle(c, r, 0), ring) ? [{ from: 0, sweep: 2 * Math.PI }] : [];
    angles.sort((x, y) => x - y);
    const spans: { from: number; sweep: number }[] = [];
    for (let i = 0; i < angles.length; i++) {
        const a0 = angles[i]!, a1 = i + 1 < angles.length ? angles[i + 1]! : angles[0]! + 2 * Math.PI;
        if (a1 - a0 < 1e-9) continue;
        if (inRing(onCircle(c, r, (a0 + a1) / 2), ring)) spans.push({ from: a0, sweep: a1 - a0 });
    }
    return spans;
}

/** Points along an arc, for drawing it. */
export function arcPoints(c: Xy, r: number, from: number, sweep: number, n = 24): Xy[] {
    return Array.from({ length: n + 1 }, (_, i) => onCircle(c, r, from + (sweep * i) / n));
}

/**
 * The direction from the first aim point back to the tees: to the hole's back tee (the one furthest from the
 * green), else to the furthest of the tee shapes on the hole; null when the hole has neither.
 */
export function lineBack(hole: PlacementHole, shapes: PlacementShape[]): number | null {
    const line = lineFromFirst(hole);
    if (!line) return null;
    const far = (pts: Xy[]) => pts.reduce<Xy | null>((best, p) => (!best || dist(p, hole.green!) > dist(best, hole.green!) ? p : best), null);
    const back = far(hole.tees) ?? far(shapes.filter((s) => s.holeId === hole.id).map(centroid));
    return back && dist(back, line.first) > 1 ? angleOf(line.first, back) : null;
}

/** Where the tee of `lengthM` lies on `hole`, among `shapes` (every tee shape of the course). */
export function placeTee(hole: PlacementHole, lengthM: number, shapes: PlacementShape[]): Placement {
    const line = lineFromFirst(hole);
    if (!line) return { kind: 'no-green' };
    const r = lengthM - line.rest;
    if (r < MIN_RADIUS_M) return { kind: 'too-short' };
    const back = lineBack(hole, shapes);

    const candidates: { spot: Spot; rank: number; offDeg: number; arcM: number; holeId: string | null }[] = [];
    for (const shape of shapes) {
        const rank = shape.holeId === hole.id ? 0 : shape.holeId === null ? 1 : 2;
        // Another hole's shape only by the line back.
        if (rank === 2 && back === null) continue;
        let best: { mid: number; offDeg: number; arcM: number } | null = null;
        for (const span of arcSpans(line.first, r, shape.ring)) {
            const mid = span.from + span.sweep / 2;
            const offDeg = back === null ? 0 : angleDiffDeg(mid, back);
            if (!best || offDeg < best.offDeg) best = { mid, offDeg, arcM: span.sweep * r };
        }
        if (!best || (rank > 0 && back !== null && best.offDeg > WINDOW_DEG)) continue;
        candidates.push({ spot: { xy: onCircle(line.first, r, best.mid), shapeId: shape.id }, rank, offDeg: best.offDeg, arcM: best.arcM, holeId: shape.holeId });
    }
    if (!candidates.length) {
        return { kind: 'missed', spot: back === null ? null : { xy: onCircle(line.first, r, back), shapeId: null } };
    }
    // Without a line back, the longest crossing first.
    candidates.sort((a, b) => a.rank - b.rank || a.offDeg - b.offDeg || b.arcM - a.arcM);
    const best = candidates[0]!;
    const others = candidates.slice(1).filter((c) => c.rank === best.rank && dist(c.spot.xy, best.spot.xy) > SAME_SPOT_M);
    const ambiguous = others.some((c) => back === null || c.offDeg - best.offDeg < AMBIGUOUS_DEG);
    return { kind: 'spot', spot: best.spot, ambiguous, alternatives: others.map((c) => c.spot), otherHole: best.rank === 2 ? best.holeId : null };
}

function centroid(shape: PlacementShape): Xy {
    const n = shape.ring.length || 1;
    return [shape.ring.reduce((s, p) => s + p[0], 0) / n, shape.ring.reduce((s, p) => s + p[1], 0) / n];
}
