// Kerb rounding where centerline roads meet. Each road's corridor is its own
// buffer (centerline.ts), so where a branch tees into a road, two roads meet
// end to end at a node, or two roads cross, the inside corners between them
// are sharp. Real kerbs are rounded there; these are the pieces that round
// them: for every corner between two neighbouring road arms at a junction,
// the patch between the two kerbs and a circular arc tangent to both. The
// kerbs are followed as they are (offsets of the roads' own lines), so a
// fillet on a curving road ends flush with its kerb instead of running on
// straight past it.
//
// Where a road ends and a narrower one carries on (end to end, near enough
// straight on), a taper narrows the wide road's width down to the narrow
// one's along the narrow road, instead of a step.
//
// The fillets are derived from the roads, never edited: the server keeps them
// as the course's generated `path` features of source ROAD_JUNCTIONS_SOURCE
// (so the GSPro SVG, iOS and the surface stack see them like any surface) and
// re-derives them whenever a road changes; the web draws its own live copy
// from the same function.

import type { Pair } from 'polygon-clipping';
import { flattenCenterline, unionRobust, type CorridorRing, type FeatureCenterline } from './centerline';

export const ROAD_JUNCTIONS_SOURCE = 'road-junctions';

/**
 * Per-road switch (a `path` attribute): `false` = no rounded kerbs next to
 * this road. Absent means on. A corner is rounded only when BOTH roads that
 * meet there have it on; the road still counts as an arm of the junction, so
 * the corners between the other roads there are rounded as before. Width
 * tapers are made either way.
 */
export const KERB_FILLETS_ATTRIBUTE = 'kerbFillets';

/** Whether a road's attributes let its junction corners be rounded (default on). */
export function kerbFilletsOn(attributes: object | null | undefined): boolean {
    return (attributes as Record<string, unknown> | null | undefined)?.[KERB_FILLETS_ATTRIBUTE] !== false;
}

export interface JunctionRoad {
    id: string;
    centerline: FeatureCenterline;
    /** False: no fillet in any corner beside this road (see KERB_FILLETS_ATTRIBUTE). Default true. */
    fillets?: boolean;
}

export interface JunctionFillet {
    /** The roads meeting at this junction. */
    roadIds: string[];
    /** One polygon: exterior first, then holes (EPSG:3006, closing point dropped). */
    rings: CorridorRing[];
}

/** A road's end this close to another road's corridor (m beyond its half width) joins it. */
const ATTACH_SLACK_M = 1.0;
/** Junction points this close together are one junction (m). */
const NODE_MERGE_M = 2.0;
/** Arms of one road this close in direction are one arm (rad). */
const SAME_ARM_RAD = (20 * Math.PI) / 180;
/** Neighbouring arms opening this wide (or wider) are straight on: no fillet (rad). */
const STRAIGHT_ON_RAD = (165 * Math.PI) / 180;
/** How far along a road its direction at a junction is measured (m). */
const ARM_REACH_M = 4;
/** Kerb radius: twice the wider road's half width, within these bounds (m). */
const MIN_KERB_RADIUS_M = 1.5;
const MAX_KERB_RADIUS_M = 8;
/** A fillet's tangent run along a kerb stops at this many radii (acute corners). */
const MAX_TANGENT_RADII = 3;
/** A fillet whose radius had to shrink below this is left out (m). */
const MIN_FILLET_RADIUS_M = 0.25;
/** Tries at a radius that fits (shorter roads, acute corners) before giving up. */
const RADIUS_TRIES = 8;
/** Fillets reach this far into the roads so they overlap instead of leaving slivers (m). */
const OVERLAP_M = 0.5;
const ARC_STEP_RAD = Math.PI / 16;
/** Junction polygons smaller than this are crumbs of a tangled centerline, not kerbs (m²). */
const MIN_PIECE_M2 = 0.05;
/** Two road ends meeting at least this close to straight on can taper (rad between their arms). */
const TAPER_STRAIGHT_RAD = (135 * Math.PI) / 180;
/** Half widths differing by less than this meet as they are: no taper (m). */
const TAPER_MIN_STEP_M = 0.1;
/** Taper length: this many times the difference in width, within these bounds (m). */
const TAPER_PER_WIDTH = 6;
const MIN_TAPER_M = 3;
const MAX_TAPER_M = 25;
/** Spacing of a taper's kerb points (m). */
const TAPER_STEP_M = 0.5;

type XY = { x: number; y: number };

interface Road {
    id: string;
    h: number;
    line: XY[];
    /** Cumulative length at each vertex. */
    at: number[];
    length: number;
    minX: number; minY: number; maxX: number; maxY: number;
}

/**
 * A road leaving a junction: along `dir` from `origin` (on its centerline),
 * `h` half wide. It starts `s` metres along the road and runs toward the
 * road's end (`sign` 1) or its start (-1); `end` when the road stops there.
 */
interface Arm {
    road: Road;
    s: number;
    sign: 1 | -1;
    end: boolean;
    origin: XY;
    dir: XY;
    h: number;
}

interface Node {
    at: XY;
    arms: Arm[];
}

function prepare(road: JunctionRoad): Road | null {
    const line = flattenCenterline(road.centerline.points);
    if (line.length < 2 || !(road.centerline.widthM > 0)) return null;
    const at = [0];
    for (let i = 1; i < line.length; i++) at.push(at[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
    const length = at[at.length - 1];
    if (length <= 0) return null;
    const h = road.centerline.widthM / 2;
    const pad = h + ATTACH_SLACK_M;
    return {
        id: road.id, h, line, at, length,
        minX: Math.min(...line.map(p => p.x)) - pad, maxX: Math.max(...line.map(p => p.x)) + pad,
        minY: Math.min(...line.map(p => p.y)) - pad, maxY: Math.max(...line.map(p => p.y)) + pad,
    };
}

/** The point `s` metres along the road (clamped to its ends). */
function pointAt(r: Road, s: number): XY {
    if (s <= 0) return r.line[0];
    if (s >= r.length) return r.line[r.line.length - 1];
    let i = 1;
    while (r.at[i] < s) i++;
    const t = (s - r.at[i - 1]) / (r.at[i] - r.at[i - 1]);
    const a = r.line[i - 1], b = r.line[i];
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** The point `s` metres along the road, straight on past either end. */
function pointAtExtended(r: Road, s: number): XY {
    if (s >= 0 && s <= r.length) return pointAt(r, s);
    const n = r.line.length;
    const [a, b, beyond] = s < 0 ? [r.line[1], r.line[0], -s] : [r.line[n - 2], r.line[n - 1], s - r.length];
    const d = unit({ x: b.x - a.x, y: b.y - a.y }) ?? { x: 0, y: 0 };
    return { x: b.x + d.x * beyond, y: b.y + d.y * beyond };
}

function unit(v: XY): XY | null {
    const l = Math.hypot(v.x, v.y);
    return l < 1e-9 ? null : { x: v.x / l, y: v.y / l };
}

/** Nearest point on the road's line: where, how far along, how far off. */
function nearest(r: Road, q: XY): { point: XY; s: number; dist: number } {
    let best = { point: r.line[0], s: 0, dist: Infinity };
    for (let i = 0; i < r.line.length - 1; i++) {
        const a = r.line[i], b = r.line[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
        const point = { x: a.x + t * dx, y: a.y + t * dy };
        const dist = Math.hypot(q.x - point.x, q.y - point.y);
        if (dist < best.dist) best = { point, s: r.at[i] + t * (r.at[i + 1] - r.at[i]), dist };
    }
    return best;
}

/** The arm leaving the road's start (`end` false) or end into the road. */
function endArm(r: Road, end: boolean): Arm | null {
    const origin = end ? r.line[r.line.length - 1] : r.line[0];
    const reach = Math.min(ARM_REACH_M, r.length / 2);
    const toward = pointAt(r, end ? r.length - reach : reach);
    const dir = unit({ x: toward.x - origin.x, y: toward.y - origin.y });
    return dir ? { road: r, s: end ? r.length : 0, sign: end ? -1 : 1, end: true, origin, dir, h: r.h } : null;
}

/**
 * The two arms of a road passing through the point `s` along it, each
 * pointing the way its own side runs (a road can turn a corner right at the
 * junction).
 */
function throughArms(r: Road, s: number): Arm[] {
    const origin = pointAt(r, s);
    const arms: Arm[] = [];
    for (const sign of [1, -1] as const) {
        const toward = pointAt(r, Math.max(0, Math.min(r.length, s + sign * ARM_REACH_M)));
        const dir = unit({ x: toward.x - origin.x, y: toward.y - origin.y });
        if (dir) arms.push({ road: r, s, sign, end: false, origin, dir, h: r.h });
    }
    return arms;
}

function overlaps(a: Road, b: Road): boolean {
    return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Where two roads' lines cross away from either's ends: points and distances along each. */
function crossings(a: Road, b: Road): Array<{ at: XY; sa: number; sb: number }> {
    const out: Array<{ at: XY; sa: number; sb: number }> = [];
    for (let i = 0; i < a.line.length - 1; i++) {
        const p = a.line[i], p2 = a.line[i + 1];
        const rx = p2.x - p.x, ry = p2.y - p.y;
        for (let j = 0; j < b.line.length - 1; j++) {
            const q = b.line[j], q2 = b.line[j + 1];
            const sx = q2.x - q.x, sy = q2.y - q.y;
            const den = rx * sy - ry * sx;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((q.x - p.x) * sy - (q.y - p.y) * sx) / den;
            const u = ((q.x - p.x) * ry - (q.y - p.y) * rx) / den;
            if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
            out.push({
                at: { x: p.x + t * rx, y: p.y + t * ry },
                sa: a.at[i] + t * (a.at[i + 1] - a.at[i]),
                sb: b.at[j] + u * (b.at[j + 1] - b.at[j]),
            });
        }
    }
    return out;
}

/** Every junction between the roads, with the arms leaving it. */
function junctionNodes(roads: Road[]): Node[] {
    const nodes: Node[] = [];
    const add = (at: XY, arms: Arm[]) => {
        const node = nodes.find(n => Math.hypot(n.at.x - at.x, n.at.y - at.y) <= NODE_MERGE_M);
        if (!node) {
            nodes.push({ at, arms: [...arms] });
            return;
        }
        for (const arm of arms) {
            const same = node.arms.some(a => a.road === arm.road
                && Math.acos(Math.max(-1, Math.min(1, a.dir.x * arm.dir.x + a.dir.y * arm.dir.y))) < SAME_ARM_RAD);
            if (!same) node.arms.push(arm);
        }
    };
    for (const a of roads) {
        for (const b of roads) {
            if (a === b || !overlaps(a, b)) continue;
            // An end of A on or in B: a tee into B's middle, or roads meeting end to end.
            for (const end of [false, true]) {
                const e = end ? a.line[a.line.length - 1] : a.line[0];
                const hit = nearest(b, e);
                if (hit.dist > b.h + ATTACH_SLACK_M) continue;
                const armA = endArm(a, end);
                if (!armA) continue;
                const nearEnd = Math.max(a.h, 1);
                if (hit.s <= nearEnd || hit.s >= b.length - nearEnd) {
                    const armB = endArm(b, hit.s > b.length / 2);
                    if (armB) add(hit.point, [armA, armB]);
                } else {
                    add(hit.point, [armA, ...throughArms(b, hit.s)]);
                }
            }
            // Lines crossing each other (each pair once).
            if (a.id < b.id) {
                for (const c of crossings(a, b)) {
                    if (c.sa <= a.h || c.sa >= a.length - a.h || c.sb <= b.h || c.sb >= b.length - b.h) continue;
                    add(c.at, [...throughArms(a, c.sa), ...throughArms(b, c.sb)]);
                }
            }
        }
    }
    return nodes;
}

/**
 * An arm's road as a polyline running outward from the junction, `u` metres
 * from the arm's origin at each point: from `back` metres behind the origin
 * (straight on past the road's end if need be) to `ahead` metres out, or the
 * road's far end if that comes first.
 */
interface ArmLine { pts: XY[]; u: number[] }

function armLine(arm: Arm, back: number, ahead: number): ArmLine {
    const r = arm.road;
    const far = arm.sign > 0 ? Math.min(ahead, r.length - arm.s) : Math.min(ahead, arm.s);
    const us = [-back, far];
    for (const s of r.at) {
        const u = (s - arm.s) * arm.sign;
        if (u > -back && u < far) us.push(u);
    }
    us.sort((a, b) => a - b);
    const line: ArmLine = { pts: [], u: [] };
    for (const u of us) {
        if (line.u.length && u - line.u[line.u.length - 1] < 1e-6) continue;
        line.pts.push(pointAtExtended(r, arm.s + arm.sign * u));
        line.u.push(u);
    }
    return line;
}

/** The line moved `d` to its left (`side` 1) or right (-1), point for point. */
function offsetLine(line: ArmLine, d: number, side: 1 | -1): XY[] {
    const { pts } = line;
    const n = pts.length;
    return pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const t = unit({ x: b.x - a.x, y: b.y - a.y }) ?? { x: 1, y: 0 };
        return { x: p.x - t.y * d * side, y: p.y + t.x * d * side };
    });
}

/** The point at `u` along an offset of `line` (`pts`, point for point). */
function atU(pts: XY[], line: ArmLine, u: number): XY {
    const us = line.u;
    let i = 1;
    while (i < us.length - 1 && us[i] < u) i++;
    const t = us[i] === us[i - 1] ? 0 : Math.max(0, Math.min(1, (u - us[i - 1]) / (us[i] - us[i - 1])));
    return { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) };
}

/**
 * Where two offset lines cross nearest their arms' origins (least |u1| + |u2|),
 * among the crossings at least `min1`/`min2` out along each.
 */
function meet(p: XY[], pl: ArmLine, q: XY[], ql: ArmLine, min1 = -Infinity, min2 = -Infinity):
    { at: XY; u1: number; u2: number } | null {
    let best: { at: XY; u1: number; u2: number } | null = null;
    for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], a2 = p[i + 1];
        const rx = a2.x - a.x, ry = a2.y - a.y;
        for (let j = 0; j < q.length - 1; j++) {
            const b = q[j], b2 = q[j + 1];
            const sx = b2.x - b.x, sy = b2.y - b.y;
            const den = rx * sy - ry * sx;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((b.x - a.x) * sy - (b.y - a.y) * sx) / den;
            const v = ((b.x - a.x) * ry - (b.y - a.y) * rx) / den;
            if (t < 0 || t > 1 || v < 0 || v > 1) continue;
            const u1 = pl.u[i] + t * (pl.u[i + 1] - pl.u[i]);
            const u2 = ql.u[j] + v * (ql.u[j + 1] - ql.u[j]);
            if (u1 < min1 || u2 < min2) continue;
            if (!best || Math.abs(u1) + Math.abs(u2) < Math.abs(best.u1) + Math.abs(best.u2)) best = { at: { x: a.x + t * rx, y: a.y + t * ry }, u1, u2 };
        }
    }
    return best;
}

/**
 * The fillet in the corner from arm `a1` counter-clockwise to arm `a2`
 * (opening `phi`): the patch between the two facing kerbs and the arc of the
 * kerb radius tangent to both, reaching OVERLAP_M into the roads. The arc's
 * centre is where the kerbs moved out by the radius cross, so it is tangent
 * to the kerbs as they are, curved or not.
 */
function fillet(a1: Arm, a2: Arm, phi: number): Pair[] | null {
    const radius = Math.min(MAX_KERB_RADIUS_M, Math.max(MIN_KERB_RADIUS_M, 2 * Math.max(a1.h, a2.h)));
    const maxRun = MAX_TANGENT_RADII * radius;
    // The kerbs' corner can lie behind an arm's origin (a branch stopping
    // short of the road, an obtuse corner); the lines reach back for it.
    const back = Math.min(40, (2 * Math.max(a1.h, a2.h) + ATTACH_SLACK_M) / Math.max(0.25, Math.sin(phi)));
    const ahead = back + maxRun + 2 * radius;
    const l1 = armLine(a1, back, ahead), l2 = armLine(a2, back, ahead);
    if (l1.pts.length < 2 || l2.pts.length < 2) return null;
    // a1's left and a2's right face each other across the corner.
    const in1 = Math.min(OVERLAP_M, a1.h), in2 = Math.min(OVERLAP_M, a2.h);
    const inset1 = offsetLine(l1, a1.h - in1, 1), inset2 = offsetLine(l2, a2.h - in2, -1);
    const corner = meet(inset1, l1, inset2, l2);
    if (!corner) return null;
    const kerb1 = offsetLine(l1, a1.h, 1), kerb2 = offsetLine(l2, a2.h, -1);
    let r = radius;
    for (let k = 0; k < RADIUS_TRIES && r >= MIN_FILLET_RADIUS_M; k++) {
        const c = meet(offsetLine(l1, a1.h + r, 1), l1, offsetLine(l2, a2.h + r, -1), l2, corner.u1, corner.u2);
        if (!c) {
            r *= 0.75; // the roads end before the arc fits
            continue;
        }
        const run = Math.max(c.u1 - corner.u1, c.u2 - corner.u2);
        if (run > maxRun) {
            r *= Math.min(0.95, (0.98 * maxRun) / run);
            continue;
        }
        const t1 = atU(kerb1, l1, c.u1), t2 = atU(kerb2, l2, c.u2);
        const start = Math.atan2(t1.y - c.at.y, t1.x - c.at.x);
        let sweep = Math.atan2(t2.y - c.at.y, t2.x - c.at.x) - start;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep <= -Math.PI) sweep += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD));
        const arcPts: Pair[] = [];
        for (let i = 1; i < steps; i++) {
            const ang = start + (sweep * i) / steps;
            arcPts.push([c.at.x + r * Math.cos(ang), c.at.y + r * Math.sin(ang)]);
        }
        const between = (pts: XY[], line: ArmLine, from: number, to: number): Pair[] =>
            pts.filter((_, i) => line.u[i] > from && line.u[i] < to).map(p => [p.x, p.y] as Pair);
        const s1 = atU(inset1, l1, c.u1), s2 = atU(inset2, l2, c.u2);
        const inner: Pair = [corner.at.x, corner.at.y];
        return [
            inner,
            ...between(inset1, l1, corner.u1, c.u1),
            [s1.x, s1.y],
            [t1.x, t1.y],
            ...arcPts,
            [t2.x, t2.y],
            [s2.x, s2.y],
            ...between(inset2, l2, corner.u2, c.u2).reverse(),
            inner,
        ];
    }
    return null;
}

/**
 * The taper where road end `wide` carries on as the narrower road end
 * `narrow`: along the narrow road, from the wide road's width where it stops
 * down to the narrow one's, easing in and out (smoothstep), over a length
 * that grows with the difference. Its middle eases the same way from the
 * wide road's line onto the narrow one's, so ends that meet a little to one
 * side leave no step.
 */
function taper(wide: Arm, narrow: Arm): Pair[] | null {
    const dh = wide.h - narrow.h;
    // Where the wide road stops, along the narrow one.
    const start = (wide.origin.x - narrow.origin.x) * narrow.dir.x + (wide.origin.y - narrow.origin.y) * narrow.dir.y;
    const available = (narrow.sign > 0 ? narrow.road.length - narrow.s : narrow.s) - Math.max(0, start);
    // Long enough, too, that the wide road's round end stays inside it.
    const wanted = Math.max(MIN_TAPER_M, TAPER_PER_WIDTH * 2 * dh, 1.2 * Math.sqrt(6 * wide.h * dh));
    const len = Math.min(MAX_TAPER_M, wanted, available);
    if (len < 1) return null;
    const from = Math.min(0, start) - OVERLAP_M, to = start + len;
    const line = armLine(narrow, -from, to);
    if (line.pts.length < 2) return null;
    // How far the wide road's line runs to the left of the narrow one's.
    const side = -(wide.origin.x - narrow.origin.x) * narrow.dir.y + (wide.origin.y - narrow.origin.y) * narrow.dir.x;
    const ease = (u: number) => {
        const t = Math.max(0, Math.min(1, (u - start) / len));
        return 1 - t * t * (3 - 2 * t);
    };
    const us = [...line.u];
    for (let u = from + TAPER_STEP_M; u < to; u += TAPER_STEP_M) us.push(u);
    us.sort((a, b) => a - b);
    const left: Pair[] = [], right: Pair[] = [];
    for (const u of us) {
        // The direction over about the taper's width: a kink in the line
        // would otherwise swing the wide kerbs out into a step.
        const k = ease(u);
        const w = narrow.h + dh * k;
        const p = atU(line.pts, line, u);
        const a = atU(line.pts, line, u - w), b = atU(line.pts, line, u + w);
        const d = unit({ x: b.x - a.x, y: b.y - a.y });
        if (!d) continue;
        const l = side * k + w, r = side * k - w;
        left.push([p.x - d.y * l, p.y + d.x * l]);
        right.push([p.x - d.y * r, p.y + d.x * r]);
    }
    if (left.length < 2) return null;
    const ring = [...left, ...right.reverse()];
    return [...ring, ring[0]];
}

/**
 * The kerb fillets of every junction between the roads: one polygon per
 * junction where three or more arms meet (a tee, a crossing, or ways meeting
 * at a node), plus the tapers where a road ends in a narrower one.
 * Deterministic for the same input.
 */
export function junctionFillets(input: readonly JunctionRoad[]): JunctionFillet[] {
    const roads = input.map(prepare).filter((r): r is Road => r !== null);
    const rounded = new Set(input.filter(r => r.fillets !== false).map(r => r.id));
    const out: JunctionFillet[] = [];
    for (const node of junctionNodes(roads)) {
        if (node.arms.length < 2 || new Set(node.arms.map(a => a.road.id)).size < 2) continue;
        const arms = [...node.arms].sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));
        const pieces: Pair[][] = [];
        for (let i = 0; arms.length >= 3 && i < arms.length; i++) {
            const a1 = arms[i], a2 = arms[(i + 1) % arms.length];
            let phi = Math.atan2(a2.dir.y, a2.dir.x) - Math.atan2(a1.dir.y, a1.dir.x);
            if (phi <= 0) phi += 2 * Math.PI;
            if (phi >= STRAIGHT_ON_RAD || phi < 1e-3) continue;
            if (!rounded.has(a1.road.id) || !rounded.has(a2.road.id)) continue;
            const piece = fillet(a1, a2, phi);
            if (piece) pieces.push(piece);
        }
        // Road ends meeting near enough straight on, one wider than the other.
        for (let i = 0; i < arms.length; i++) {
            for (let j = i + 1; j < arms.length; j++) {
                const a = arms[i], b = arms[j];
                if (!a.end || !b.end || a.road === b.road || Math.abs(a.h - b.h) < TAPER_MIN_STEP_M) continue;
                const cos = Math.max(-1, Math.min(1, a.dir.x * b.dir.x + a.dir.y * b.dir.y));
                if (Math.acos(cos) < TAPER_STRAIGHT_RAD) continue;
                const piece = a.h > b.h ? taper(a, b) : taper(b, a);
                if (piece) pieces.push(piece);
            }
        }
        if (pieces.length === 0) continue;
        // Union near the origin (the clipper's precision; see centerline.ts).
        const ox = node.at.x, oy = node.at.y;
        const union = unionRobust(pieces.map(ring => ring.map(([x, y]) => [x - ox, y - oy] as Pair)));
        for (const polygon of union) {
            if (Math.abs(ringArea(polygon[0])) < MIN_PIECE_M2) continue;
            out.push({
                roadIds: [...new Set(arms.map(a => a.road.id))].sort(),
                rings: polygon.map(ring => ({ points: ring.slice(0, -1).map(([x, y]) => ({ x: x + ox, y: y + oy })) })),
            });
        }
    }
    return out;
}

function ringArea(ring: Pair[]): number {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}
