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

import type { Bbox, CurveType, FeatureGeometry, PathRing } from './bezier';
import { flattenRing } from './bezier';
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

/** Hit/miss counters (tests and benchmarks). */
export function flatCacheStats(): { hits: number; misses: number } {
    return { ...stats };
}

export function resetFlatCacheStats(): void {
    stats = { hits: 0, misses: 0 };
}

function bboxOf(pts: ReadonlyArray<readonly [number, number]>): Bbox | null {
    if (pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
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
