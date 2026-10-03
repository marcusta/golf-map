// Identity-keyed caches for flattened feature outlines.
//
// Hit-testing (click, mousedown, marquee, edge insertion) used to flatten
// every visible feature's rings on every call, including a full
// bspline -> bezier conversion for spline features. The draw state treats
// geometry objects as immutable: every edit in draw/draw-state.ts goes
// through cloneGeometry and returns a new object. So a geometry, ring, or
// converted ring can be keyed on object identity, and an edit invalidates
// its entry by producing a new key.
//
// Entries also record the flatten tolerance and curve type they were built
// with; a lookup with a different tolerance or curve type rebuilds the entry.
//
// This cache is independent of FeaturesService's wgs84RingsCache (render
// side, WGS84 coordinates); this one holds EPSG:3006 coordinates for
// editor math.
//
// Below the ring level sits a per-segment cache (`cachedSegment`), used by
// bezier.ts flattenRing. A drag edit (draw-state moveAnchor and friends)
// shares every untouched AnchorPoint object with the drag-start geometry,
// so the segment cache, keyed on the segment's start AnchorPoint, re-flattens
// only the one or two segments touching the moved anchor. Each entry also
// stores the segment's control values and is reused only when they match,
// so a point object mutated in place costs a cache miss, never a stale
// outline.

import type { Bbox, CurveType, FeatureGeometry, PathRing } from './bezier';
import { flattenRing, flattenSegment } from './bezier';
import { bsplineRingToBezierWithMap, type BsplineBezier } from './bspline';

export interface FlatRing {
    /** Flattened, implicitly closed polyline (flattenRing output). */
    readonly pts: ReadonlyArray<readonly [number, number]>;
    /** Bbox of `pts`; null for an empty ring. */
    readonly bbox: Bbox | null;
}

export interface FlatCache {
    readonly tol: number;
    readonly curveType: CurveType | undefined;
    /** rings[0] is the outer ring, the rest are holes. */
    readonly rings: readonly FlatRing[];
    /** Bbox of the outer ring (null when there is none or it is empty). */
    readonly bbox: Bbox | null;
}

interface RingEntry extends FlatRing {
    readonly tol: number;
    readonly curveType: CurveType | undefined;
}

const ringCache = new WeakMap<PathRing, RingEntry>();
const geometryCache = new WeakMap<FeatureGeometry, FlatCache>();
const bsplineCache = new WeakMap<PathRing, BsplineBezier>();

let stats = { hits: 0, misses: 0 };
let segStats = { hits: 0, misses: 0 };

/** flatGeometry hit/miss counters (tests and benchmarks). */
export function flatCacheStats(): { hits: number; misses: number } {
    return { ...stats };
}

/** Per-segment flatten hit/miss counters (tests and benchmarks). */
export function segmentCacheStats(): { hits: number; misses: number } {
    return { ...segStats };
}

export function resetFlatCacheStats(): void {
    stats = { hits: 0, misses: 0 };
    segStats = { hits: 0, misses: 0 };
}

// ─── Per-segment flatten cache ────────────────────────────────────────────

/** One flattened cubic segment: its start anchor plus interior samples. */
interface SegEntry {
    slot: number;
    tol: number;
    straight: boolean;
    ax: number; ay: number;
    p1x: number; p1y: number;
    p2x: number; p2y: number;
    bx: number; by: number;
    pts: Array<[number, number]>;
}

/** Entries per key object; tolerances and b-spline corner copies share a key. */
const MAX_ENTRIES_PER_KEY = 6;

const bezierSegCache = new WeakMap<object, SegEntry[]>();
const bsplineSegCache = new WeakMap<object, SegEntry[]>();

/**
 * Flattened points of one cubic segment (a, p1, p2, b), start anchor
 * first, end anchor excluded: the slice flattenRing emits for that
 * segment. `key` is the AnchorPoint the segment belongs to and `slot`
 * separates several segments keyed on one object (b-spline corner copies).
 * A miss flattens with bezier.ts flattenSegment.
 *
 * The returned array and its tuples are shared between calls; callers
 * copy them into their own output and never mutate them.
 */
export function cachedSegment(
    spline: boolean,
    key: object,
    slot: number,
    tol: number,
    straight: boolean,
    ax: number, ay: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    bx: number, by: number,
): Array<[number, number]> {
    const cache = spline ? bsplineSegCache : bezierSegCache;
    let list = cache.get(key);
    let reuse: SegEntry | undefined;
    if (list) {
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (e.slot !== slot || e.tol !== tol) continue;
            if (
                e.straight === straight &&
                e.ax === ax && e.ay === ay && e.bx === bx && e.by === by &&
                e.p1x === p1x && e.p1y === p1y && e.p2x === p2x && e.p2y === p2y
            ) {
                segStats.hits++;
                return e.pts;
            }
            reuse = e;
            break;
        }
    } else {
        list = [];
        cache.set(key, list);
    }
    segStats.misses++;
    const pts = flattenSegment(straight, ax, ay, p1x, p1y, p2x, p2y, bx, by, tol);
    if (reuse) {
        reuse.straight = straight;
        reuse.ax = ax; reuse.ay = ay; reuse.p1x = p1x; reuse.p1y = p1y;
        reuse.p2x = p2x; reuse.p2y = p2y; reuse.bx = bx; reuse.by = by;
        reuse.pts = pts;
    } else {
        if (list.length >= MAX_ENTRIES_PER_KEY) list.shift();
        list.push({ slot, tol, straight, ax, ay, p1x, p1y, p2x, p2y, bx, by, pts });
    }
    return pts;
}

function bboxOf(pts: ReadonlyArray<readonly [number, number]>): Bbox | null {
    if (pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
        const x = pts[i][0], y = pts[i][1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
}

/** Flattened ring + bbox, cached on the ring object. */
export function flatRing(ring: PathRing, tol: number, curveType?: CurveType): FlatRing {
    const hit = ringCache.get(ring);
    if (hit && hit.tol === tol && hit.curveType === curveType) return hit;
    const pts = flattenRing(ring, tol, curveType);
    const entry: RingEntry = { pts, bbox: bboxOf(pts), tol, curveType };
    ringCache.set(ring, entry);
    return entry;
}

/** Flattened rings + outer bbox for a whole geometry, cached on the geometry object. */
export function flatGeometry(geometry: FeatureGeometry, tol: number): FlatCache {
    const hit = geometryCache.get(geometry);
    if (hit && hit.tol === tol && hit.curveType === geometry.curveType && hit.rings.length === geometry.rings.length) {
        stats.hits++;
        return hit;
    }
    stats.misses++;
    const rings = geometry.rings.map(ring => flatRing(ring, tol, geometry.curveType));
    const entry: FlatCache = { tol, curveType: geometry.curveType, rings, bbox: rings[0]?.bbox ?? null };
    geometryCache.set(geometry, entry);
    return entry;
}

/** bsplineRingToBezierWithMap, cached on the control ring object. */
export function bsplineBezierCached(ring: PathRing): BsplineBezier {
    let hit = bsplineCache.get(ring);
    if (!hit) {
        hit = bsplineRingToBezierWithMap(ring);
        bsplineCache.set(ring, hit);
    }
    return hit;
}
