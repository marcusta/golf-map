// Ring-extent along the play line — the tapped-shape readout (tap/click a
// bunker / water / green / tree area → its near "front" and far "carry"
// distances measured along the hole's routed play line from the current
// origin).
//
// Unlike carry.ts's hazardsAlongLine (a ray/ring intersection that only sees
// rings the shot line actually crosses), this PROJECTS every ring vertex onto
// the play-line polyline, so a shape beside the line still answers with the
// chainage window you'd have to cover to be level with / past it. Exact
// mirror of the iOS `HazardCarries.nearLines` projection math, minus the
// corridor / ahead gating — a tapped shape was chosen explicitly, so it is
// never filtered out (only a shape entirely BEHIND the origin returns null).
//
// Pure planar geometry in projected meters (EPSG:3006-style {x, y}).

import { DEFAULT_HAZARD_TYPES, pointInRing, type FlatRing } from './corridor';
import { type Vec2 } from './ellipse';
import { rayRingIntersections } from './ray';

/**
 * Feature types the tap-a-shape readout hit-tests: every corridor obstacle
 * (bunker / water / trees / penalty / OOB / …) plus the green itself. Shared
 * so web (desktop + mobile) and the iOS port answer taps on the same shapes.
 */
export const TAPPABLE_RING_TYPES: readonly string[] = [...DEFAULT_HAZARD_TYPES, 'green'];

/** Which side of the play line a ring sits on (facing along the line). */
export type RingSide = 'on-line' | 'left' | 'right';

/** Centroid perpendicular distance under which a ring reads as on-line. */
const ON_LINE_PERP_M = 3;

export interface RingLineExtent {
    /** Near-edge distance along the line from its start, meters (≥ 0). */
    frontM: number;
    /** Far-edge distance along the line from its start, meters. */
    carryM: number;
    /** Side of the line the ring centroid sits on (on-line within 3 m). */
    side: RingSide;
    /** Ring vertex centroid, planar meters — the point a UI focuses. */
    centroid: Vec2;
    /** The play-line point `frontM` measures to — the near-edge marker. */
    frontPoint: Vec2;
    /** The play-line point `carryM` measures to — the far-edge marker. */
    carryPoint: Vec2;
}

/**
 * The chainage window a ring occupies along the nearest of several play
 * lines (each a polyline: origin → forward aims → green; callers usually
 * pass the routed line and the direct origin→green line). The ring is
 * measured along whichever line its centroid sits closest to. Null when
 * the ring is degenerate, no line has ≥ 2 points, or the ring lies
 * entirely behind every line's start.
 */
export function ringExtentAlongLines(
    lines: readonly (readonly Vec2[])[],
    ring: FlatRing,
): RingLineExtent | null {
    if (ring.points.length < 3) return null;
    const polylines = lines.filter(line => line.length >= 2);
    if (polylines.length === 0) return null;

    let cx = 0;
    let cy = 0;
    for (const p of ring.points) {
        cx += p.x;
        cy += p.y;
    }
    const centroid: Vec2 = { x: cx / ring.points.length, y: cy / ring.points.length };

    let bestPerp = Infinity;
    let chosen: RingLineExtent | null = null;
    for (const line of polylines) {
        const c = projectOntoPolyline(centroid, line);
        if (c === null || c.perp >= bestPerp) continue;
        let alongMin = Infinity;
        let alongMax = -Infinity;
        for (const p of ring.points) {
            const v = projectOntoPolyline(p, line);
            if (v === null) continue;
            alongMin = Math.min(alongMin, v.along);
            alongMax = Math.max(alongMax, v.along);
        }
        // Entirely behind this line's start — not measurable along it.
        if (alongMax <= 0) continue;
        bestPerp = c.perp;
        const frontM = Math.max(0, alongMin);
        chosen = {
            frontM,
            carryM: alongMax,
            side: c.perp < ON_LINE_PERP_M ? 'on-line' : c.lateral >= 0 ? 'right' : 'left',
            centroid,
            frontPoint: pointAlongPolyline(line, frontM),
            carryPoint: pointAlongPolyline(line, alongMax),
        };
    }
    return chosen;
}

/** One hazard ring near a play line, with its chainage window along it. */
export interface HazardNearLine {
    ring: FlatRing;
    /** Near-edge chainage along the chosen line, meters (≥ 0). */
    frontM: number;
    /** Far-edge chainage along the chosen line, meters. */
    carryM: number;
    /** Side of the line the ring centroid sits on (on-line within 3 m). */
    side: RingSide;
    /** Ring vertex centroid, planar meters — the point a UI focuses. */
    centroid: Vec2;
    /** The play-line point `frontM` measures to. */
    frontPoint: Vec2;
    /** The play-line point `carryM` measures to. */
    carryPoint: Vec2;
}

export interface HazardsNearLinesOptions {
    /** Max lateral distance (perp from a line) a ring still counts, meters. Default 35. */
    corridorHalfWidthM?: number;
    /** How far past a line's end a ring still counts (greenside bunkers). Default 0. */
    extraAheadM?: number;
    /** Max rows returned (nearest-first). Default 6. */
    cap?: number;
}

/**
 * Hazard rings near ANY of several play lines — the ladder variant, exact
 * mirror of iOS `HazardCarries.nearLines`. Unlike carry.ts's
 * `hazardsAlongLine` (ray/ring intersection — only rings the line actually
 * crosses), every ring is PROJECTED onto its nearest line, so a fairway
 * bunker BESIDE the line still answers with the chainage window you'd cover
 * to be level with / past it, tagged with its side. A ring is included when
 * its centroid is within `corridorHalfWidthM` of some line, part of it lies
 * ahead of that line's start, and its near edge is no further than the
 * line's length + `extraAheadM`. Sorted nearest-first, capped.
 */
export function hazardsNearLines(
    lines: readonly (readonly Vec2[])[],
    hazards: readonly FlatRing[],
    options: HazardsNearLinesOptions = {},
): HazardNearLine[] {
    const corridorHalfWidthM = options.corridorHalfWidthM ?? 35;
    const extraAheadM = options.extraAheadM ?? 0;
    const cap = options.cap ?? 6;
    const polylines = lines.filter(line => line.length >= 2);
    if (polylines.length === 0 || hazards.length === 0) return [];
    const lengths = polylines.map(polylineLength);

    const out: HazardNearLine[] = [];
    for (const ring of hazards) {
        if (ring.points.length < 3) continue;
        let cx = 0;
        let cy = 0;
        for (const p of ring.points) {
            cx += p.x;
            cy += p.y;
        }
        const centroid: Vec2 = { x: cx / ring.points.length, y: cy / ring.points.length };

        let bestPerp = Infinity;
        let chosen: HazardNearLine | null = null;
        for (let i = 0; i < polylines.length; i++) {
            const line = polylines[i];
            const c = projectOntoPolyline(centroid, line);
            if (c === null || c.perp > corridorHalfWidthM || c.perp >= bestPerp) continue;
            let alongMin = Infinity;
            let alongMax = -Infinity;
            for (const p of ring.points) {
                const v = projectOntoPolyline(p, line);
                if (v === null) continue;
                alongMin = Math.min(alongMin, v.along);
                alongMax = Math.max(alongMax, v.along);
            }
            // Ahead of the line's start and not entirely past its (extended) end.
            if (alongMax <= 0 || alongMin > lengths[i] + extraAheadM) continue;
            bestPerp = c.perp;
            const frontM = Math.max(0, alongMin);
            chosen = {
                ring,
                frontM,
                carryM: alongMax,
                side: c.perp < ON_LINE_PERP_M ? 'on-line' : c.lateral >= 0 ? 'right' : 'left',
                centroid,
                frontPoint: pointAlongPolyline(line, frontM),
                carryPoint: pointAlongPolyline(line, alongMax),
            };
        }
        if (chosen) out.push(chosen);
    }
    return out
        .sort((a, b) => a.frontM - b.frontM || a.carryM - b.carryM)
        .slice(0, cap);
}

/**
 * The window a ring occupies along the RAY from `origin` through `through`
 * (normally the tapped point inside the ring) — the default tap-a-shape
 * readout: "if I hit at that shape, it's `frontM` to reach it and `carryM`
 * to carry it". `frontPoint`/`carryPoint` are the ray's entry/exit points ON
 * the ring boundary, so a UI can print the figures at the shape's own lips.
 * An origin standing inside the ring reads front 0 (at the origin), carry =
 * the exit. `side` is always 'on-line' — the ray points at the shape, so a
 * left/right tag is meaningless. Null for a degenerate ring/ray or a ray
 * that misses (numerically possible when `through` sits exactly on an edge).
 */
export function ringExtentAlongRay(
    origin: Vec2,
    through: Vec2,
    ring: FlatRing,
): RingLineExtent | null {
    if (ring.points.length < 3) return null;
    const dx = through.x - origin.x;
    const dy = through.y - origin.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    const dir = { x: dx / length, y: dy / length };

    const hits = rayRingIntersections(origin, dir, ring.points);
    if (hits.length === 0) return null;
    const originInside = pointInRing(origin, ring.points);
    const frontM = originInside ? 0 : Math.min(...hits);
    const carryM = Math.max(...hits);

    let cx = 0;
    let cy = 0;
    for (const p of ring.points) {
        cx += p.x;
        cy += p.y;
    }
    return {
        frontM,
        carryM,
        side: 'on-line',
        centroid: { x: cx / ring.points.length, y: cy / ring.points.length },
        frontPoint: { x: origin.x + dir.x * frontM, y: origin.y + dir.y * frontM },
        carryPoint: { x: origin.x + dir.x * carryM, y: origin.y + dir.y * carryM },
    };
}

/**
 * The point `meters` of chainage along a polyline. Chainage past the end
 * extrapolates along the last segment's direction (a tapped ring can extend
 * beyond the green) — mirroring how `projectOntoPolyline` reads unclamped
 * `along` values past the line.
 */
function pointAlongPolyline(poly: readonly Vec2[], meters: number): Vec2 {
    let remaining = meters;
    for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (seg === 0) continue;
        const last = i === poly.length - 2;
        if (remaining <= seg || last) {
            const t = remaining / seg;
            return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        }
        remaining -= seg;
    }
    return poly[0];
}

/**
 * Perpendicular distance from `q` to a polyline (nearest segment, clamped) —
 * the ownership classifier for untagged hazard rings: a ring belongs to the
 * hole whose routed play line its centroid sits closest to (mirror of iOS
 * `nearestRouteNumber`). Infinity for a degenerate polyline.
 */
export function distanceToPolyline(q: Vec2, poly: readonly Vec2[]): number {
    return projectOntoPolyline(q, poly)?.perp ?? Infinity;
}

function polylineLength(poly: readonly Vec2[]): number {
    let total = 0;
    for (let i = 0; i < poly.length - 1; i++) {
        total += Math.hypot(poly[i + 1].x - poly[i].x, poly[i + 1].y - poly[i].y);
    }
    return total;
}

/**
 * Project `q` onto a polyline: cumulative `along` distance from the start,
 * signed `lateral` on the nearest segment (right of travel positive), and
 * perpendicular distance. `along` is unclamped on the nearest segment so
 * points past either end read as beyond it — mirror of the private Swift
 * `HazardCarries.project`.
 */
function projectOntoPolyline(
    q: Vec2,
    poly: readonly Vec2[],
): { along: number; lateral: number; perp: number } | null {
    if (poly.length < 2) return null;
    let bestPerp = Infinity;
    let bestAlong = 0;
    let bestLateral = 0;
    let cumulative = 0;
    for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const seg = Math.hypot(dx, dy);
        if (seg === 0) continue;
        const ux = dx / seg;
        const uy = dy / seg;
        const ex = q.x - a.x;
        const ey = q.y - a.y;
        const proj = ex * ux + ey * uy; // unclamped along this segment
        const clamped = Math.max(0, Math.min(seg, proj));
        const perp = Math.hypot(q.x - (a.x + ux * clamped), q.y - (a.y + uy * clamped));
        if (perp < bestPerp) {
            bestPerp = perp;
            bestAlong = cumulative + proj;
            bestLateral = ex * uy + ey * -ux; // right-hand normal
        }
        cumulative += seg;
    }
    if (bestPerp === Infinity) return null;
    return { along: bestAlong, lateral: bestLateral, perp: bestPerp };
}
