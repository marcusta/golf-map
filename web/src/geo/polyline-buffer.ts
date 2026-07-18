// Open-polyline → ribbon buffering (T50). The Hydrografi Direkt proxy
// returns creek CENTERLINES raw; the import wizard buffers them into
// `water_creek` ribbon polygons client-side before feeding the shared
// GeoJSON mapping/preview/accept flow.
//
// Pure function, EPSG:3006 meters in/out, dependency-free (kept out of
// draw-state.ts, whose offset machinery — offsetRingPoints — is for CLOSED
// rings; an open line needs both sides plus end caps).

/** Positions closer than this (meters) are merged before buffering. */
const DEDUPE_EPS_M = 1e-6;

/** Miter length clamp at sharp corners (matches draw-state's offset op). */
const MITER_LIMIT = 4;

interface Vec {
    x: number;
    y: number;
}

function norm(v: Vec): Vec {
    const len = Math.hypot(v.x, v.y);
    return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

/**
 * Per-vertex unit(ish) normal of an OPEN polyline: endpoints take their
 * single edge's perpendicular; interior vertices average the two adjacent
 * edge normals, miter-lengthened (clamped) at sharp corners so the ribbon
 * keeps its width through bends.
 */
function openVertexNormal(points: number[][], index: number): Vec {
    const edgeNormal = (a: number[], b: number[]): Vec =>
        norm({ x: -(b[1] - a[1]), y: b[0] - a[0] }); // 90° CCW of the edge direction

    if (index === 0) return edgeNormal(points[0], points[1]);
    if (index === points.length - 1) return edgeNormal(points[points.length - 2], points[points.length - 1]);

    const nIn = edgeNormal(points[index - 1], points[index]);
    const nOut = edgeNormal(points[index], points[index + 1]);
    const avg = norm({ x: nIn.x + nOut.x, y: nIn.y + nOut.y });
    const dot = nIn.x * nOut.x + nIn.y * nOut.y;
    if (dot < 0.5 && dot > -0.999) {
        const miter = Math.min(1 / Math.sqrt((1 + dot) / 2), MITER_LIMIT);
        return { x: avg.x * miter, y: avg.y * miter };
    }
    return avg;
}

/**
 * Buffer an open polyline into a ribbon polygon of total width `widthM`
 * (widthM/2 per side, butt caps): one side offset forward, the other
 * offset backward, closed into a single explicitly-closed GeoJSON-style
 * ring. Consecutive duplicate positions are merged first; returns null
 * for degenerate input (fewer than 2 distinct points, or width <= 0).
 */
export function bufferPolyline(points: number[][], widthM: number): number[][] | null {
    if (!(widthM > 0)) return null;

    const pts: number[][] = [];
    for (const p of points) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > DEDUPE_EPS_M) pts.push(p);
    }
    if (pts.length < 2) return null;

    const half = widthM / 2;
    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
        const n = openVertexNormal(pts, i);
        left.push([pts[i][0] + n.x * half, pts[i][1] + n.y * half]);
        right.push([pts[i][0] - n.x * half, pts[i][1] - n.y * half]);
    }

    const ring = [...left, ...right.reverse()];
    ring.push([ring[0][0], ring[0][1]]); // explicit GeoJSON closure
    return ring;
}
