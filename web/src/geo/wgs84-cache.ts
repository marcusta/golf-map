// Identity-keyed EPSG:3006 -> WGS84 point cache for the render path.
//
// bezier.ts flattenRing builds each ring from per-segment slices held in a
// segment cache, so an unchanged segment hands back the same [x, y] tuple
// objects on every call. A drag edit re-flattens only the segments that
// touch the moved anchor; every other tuple keeps its identity. Keying the
// reprojection on the tuple object means a re-render of an edited feature
// reprojects only the new points.
//
// The cache assumes flattened tuples are never mutated in place. Nothing in
// the flatten path does that: cachedSegment builds fresh tuples on a miss.

import { sweref99tmToWgs84 } from './transform';

const pointCache = new WeakMap<readonly [number, number], readonly [number, number]>();

let stats = { hits: 0, misses: 0 };

/** pointWgs84 hit/miss counters (tests and benchmarks). */
export function wgs84CacheStats(): { hits: number; misses: number } {
    return { ...stats };
}

/** Reset the counters. The cache itself is a WeakMap and is never cleared. */
export function resetWgs84CacheStats(): void {
    stats = { hits: 0, misses: 0 };
}

/** One EPSG:3006 point as a WGS84 [lon, lat] tuple, cached on tuple identity. */
export function pointWgs84(p: readonly [number, number]): readonly [number, number] {
    const hit = pointCache.get(p);
    if (hit) {
        stats.hits++;
        return hit;
    }
    stats.misses++;
    const { lat, lon } = sweref99tmToWgs84(p[0], p[1]);
    const out: readonly [number, number] = [lon, lat];
    pointCache.set(p, out);
    return out;
}

/**
 * A flattened EPSG:3006 ring as WGS84 [lon, lat] tuples. The result array is
 * fresh; its tuples are shared with the cache and must not be mutated.
 */
export function ringWgs84(flatRing: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
    const out: Array<readonly [number, number]> = new Array(flatRing.length);
    for (let i = 0; i < flatRing.length; i++) out[i] = pointWgs84(flatRing[i]);
    return out;
}
