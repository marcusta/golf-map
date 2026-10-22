// Which hole a drawn feature belongs to, from the holes' furniture: the tees, the
// aim points and the green centre. A course drawn before its holes were laid out
// (Landeryd: every shape "Others") gets its shapes proposed onto the holes, the
// propose -> accept step HoleAssignmentService runs for the web and the CLI.
//
// Every hole on the site takes part (a sibling course's holes too), so a shape
// between two courses' holes is never handed to the wrong one; only the course's
// own holes are proposed. Rules, in order:
//   - a green holds a hole's green centre, a tee a hole's tee point (within
//     FURNITURE_SLACK_M). Neither holding one -> no hole (a practice green, a
//     course without furniture yet). Holding two holes' -> ambiguous;
//   - everything else votes: points spread over the shape go to the hole whose
//     play line (back tee -> aim points -> green centre) is nearest, within
//     CORRIDOR_M. The hole with at least MAJORITY of the votes wins; a shape no
//     hole's corridor reaches, or one shared out between holes (a big rough), stays
//     course-wide.
// All coordinates are EPSG:3006 metres.

export type Xy = [number, number];

export interface AssignHole {
    id: string;
    courseId: string;
    number: number;
    tees: Xy[];
    aims: Xy[];
    /** The green centre; a hole without one has no play line and takes no shapes. */
    green: Xy | null;
}

export interface AssignFeature {
    id: string;
    type: string;
    /** Flattened outer rings (holes in a shape do not change where it lies). */
    rings: Xy[][];
}

export type HoleMatch =
    | { kind: 'hole'; holeId: string; share: number }
    | { kind: 'none'; reason: string }
    | { kind: 'ambiguous'; reason: string; holeIds: string[] };

/** A green/tee this close to a hole's green centre/tee point holds it (the furniture is clicked, the shape drawn). */
export const FURNITURE_SLACK_M = 3;
/** A point further than this from every play line belongs to no hole. */
export const CORRIDOR_M = 70;
/** Share of a shape's points one hole needs. */
export const MAJORITY = 0.6;
/** Points per shape the vote samples, at most. */
const MAX_SAMPLES = 4000;

/** Back tee (furthest from the green) -> aim points -> green centre. Null without a green. */
export function playLine(hole: AssignHole): Xy[] | null {
    if (!hole.green) return null;
    const g = hole.green;
    const back = hole.tees.reduce<Xy | null>((best, t) => (!best || dist(t, g) > dist(best, g) ? t : best), null);
    return [...(back ? [back] : []), ...hole.aims, g];
}

/** Which hole `feature` belongs to among `holes` (every hole on the site). */
export function matchHole(feature: AssignFeature, holes: AssignHole[]): HoleMatch {
    const rings = feature.rings.filter((r) => r.length >= 3);
    if (!rings.length) return { kind: 'none', reason: 'no outline' };
    if (feature.type === 'green' || feature.type === 'tee') {
        const what = feature.type === 'green' ? 'green centre' : 'tee';
        const held = holes.filter((h) => (feature.type === 'green' ? (h.green ? [h.green] : []) : h.tees)
            .some((p) => rings.some((r) => pointInRing(p, r) || distToRing(p, r) <= FURNITURE_SLACK_M)));
        if (held.length === 1) return { kind: 'hole', holeId: held[0]!.id, share: 1 };
        if (!held.length) return { kind: 'none', reason: `holds no hole's ${what}` };
        return { kind: 'ambiguous', reason: `holds the ${what} of ${held.length} holes`, holeIds: held.map((h) => h.id) };
    }
    const lines = holes.map((h) => ({ hole: h, line: playLine(h) })).filter((l): l is { hole: AssignHole; line: Xy[] } => !!l.line);
    if (!lines.length) return { kind: 'none', reason: 'no hole has a green' };
    const samples = samplePoints(rings);
    const votes = new Map<string, number>();
    for (const p of samples) {
        let best: AssignHole | null = null;
        let bestD = CORRIDOR_M;
        for (const { hole, line } of lines) {
            const d = distToPolyline(p, line);
            if (d <= bestD) { bestD = d; best = hole; }
        }
        if (best) votes.set(best.id, (votes.get(best.id) ?? 0) + 1);
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { kind: 'none', reason: `further than ${CORRIDOR_M} m from every play line` };
    const [topId, top] = ranked[0]!;
    const share = top / samples.length;
    if (share >= MAJORITY) return { kind: 'hole', holeId: topId, share };
    return {
        kind: 'ambiguous',
        reason: `split between holes (${ranked.slice(0, 3).map(([, n]) => `${Math.round((100 * n) / samples.length)}%`).join(', ')})`,
        holeIds: ranked.slice(0, 3).map(([id]) => id),
    };
}

/** Share of a rough's outline that must lie inside the enclosing shapes for it to be an island. */
export const ISLAND_SHARE = 0.95;
/** Feature types whose outline encloses a rough island. */
export const ENCLOSING_TYPES: readonly string[] = ['semi_rough', 'fairway'];

/**
 * A rough island: (almost) all of its outline lies inside the outer rings of the
 * enclosing shapes (a semi drawn round it, with or without a hole cut for it).
 * `enclosers` are those shapes' outer rings.
 */
export function isIsland(rings: Xy[][], enclosers: Xy[][]): boolean {
    const outline = rings.flat();
    if (!outline.length || !enclosers.length) return false;
    const inside = outline.filter((p) => enclosers.some((r) => pointInRing(p, r))).length;
    return inside / outline.length >= ISLAND_SHARE;
}

/** The outer ring of a shape: its largest. */
export function outerRing(rings: Xy[][]): Xy[] | null {
    let best: Xy[] | null = null;
    let bestA = 0;
    for (const r of rings) {
        const a = Math.abs(ringArea(r));
        if (r.length >= 3 && a > bestA) { bestA = a; best = r; }
    }
    return best;
}

/** Points spread evenly over the shape (its rings even-odd), the vertices when it is too thin to hold a grid point. */
export function samplePoints(rings: Xy[][]): Xy[] {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) for (const [x, y] of r) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const area = rings.reduce((sum, r) => sum + Math.abs(ringArea(r)), 0);
    const step = Math.max(0.5, Math.sqrt(area / MAX_SAMPLES));
    const out: Xy[] = [];
    for (let x = minX + step / 2; x < maxX; x += step) {
        for (let y = minY + step / 2; y < maxY; y += step) {
            if (rings.filter((r) => pointInRing([x, y], r)).length % 2 === 1) out.push([x, y]);
        }
    }
    return out.length ? out : rings.flat();
}

function dist(a: Xy, b: Xy): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function distToSegment(p: Xy, a: Xy, b: Xy): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToPolyline(p: Xy, line: Xy[]): number {
    if (line.length === 1) return dist(p, line[0]!);
    let d = Infinity;
    for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, distToSegment(p, line[i]!, line[i + 1]!));
    return d;
}

function distToRing(p: Xy, ring: Xy[]): number {
    let d = Infinity;
    for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!));
    return d;
}

function pointInRing(p: Xy, ring: Xy[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function ringArea(ring: Xy[]): number {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!, [x2, y2] = ring[(i + 1) % ring.length]!;
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}
