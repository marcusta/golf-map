import { test, expect, describe } from 'bun:test';
import { pointWgs84, ringWgs84, wgs84CacheStats, resetWgs84CacheStats } from '../src/geo/wgs84-cache';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import { flattenRing, type FeatureGeometry } from '../src/geo/bezier';
import { geometryToWgs84Rings, FLATTEN_TOLERANCE_M } from '../src/draw/features.service';

const base = wgs84ToSweref99tm(58.4015, 15.5658);

function square(half: number, dx = 0): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: base.x - half + dx, y: base.y - half },
                { x: base.x + half + dx, y: base.y - half, hIn: { x: base.x + dx, y: base.y - half - 4 } },
                { x: base.x + half + dx, y: base.y + half },
                { x: base.x - half + dx, y: base.y + half },
            ],
        }],
    };
}

describe('pointWgs84', () => {
    test('matches sweref99tmToWgs84 as [lon, lat] and returns the same tuple on a repeat call', () => {
        const p: readonly [number, number] = [base.x + 1, base.y + 2];
        const out = pointWgs84(p);
        const { lat, lon } = sweref99tmToWgs84(p[0], p[1]);
        expect(out).toEqual([lon, lat]);
        expect(pointWgs84(p)).toBe(out);
    });

    test('keys on tuple identity: an equal but distinct tuple is a miss', () => {
        resetWgs84CacheStats();
        pointWgs84([base.x, base.y]);
        pointWgs84([base.x, base.y]);
        expect(wgs84CacheStats()).toEqual({ hits: 0, misses: 2 });
    });
});

describe('ringWgs84', () => {
    test('an unchanged flattened ring is all cache hits', () => {
        const geometry = square(10);
        const ring = geometry.rings[0]!;
        const flat1 = flattenRing(ring, FLATTEN_TOLERANCE_M, geometry.curveType);
        resetWgs84CacheStats();
        const first = ringWgs84(flat1);
        expect(wgs84CacheStats()).toEqual({ hits: 0, misses: flat1.length });

        // flattenRing hands back the same segment tuples for the same anchors.
        const flat2 = flattenRing(ring, FLATTEN_TOLERANCE_M, geometry.curveType);
        expect(flat2).not.toBe(flat1);
        resetWgs84CacheStats();
        const second = ringWgs84(flat2);
        expect(wgs84CacheStats()).toEqual({ hits: flat2.length, misses: 0 });
        expect(second).toEqual(first);
    });

    test('geometryToWgs84Rings on a new geometry object reuses the points of untouched segments', () => {
        const g1 = square(10);
        geometryToWgs84Rings(g1);
        // Same anchor objects except the third, which moved: the two segments touching it re-flatten.
        const pts = g1.rings[0]!.points;
        const g2: FeatureGeometry = { ...g1, rings: [{ points: [pts[0]!, pts[1]!, { x: pts[2]!.x + 3, y: pts[2]!.y }, pts[3]!] }] };
        resetWgs84CacheStats();
        const rings = geometryToWgs84Rings(g2);
        const { hits, misses } = wgs84CacheStats();
        expect(hits).toBeGreaterThan(0);
        expect(misses).toBeGreaterThan(0);
        expect(hits + misses).toBe(rings[0]!.length - 1); // closure point is not a lookup
        // The output still equals a fresh reprojection.
        const flat = flattenRing(g2.rings[0]!, FLATTEN_TOLERANCE_M);
        expect(rings[0]!.slice(0, -1)).toEqual(flat.map(([x, y]) => {
            const { lat, lon } = sweref99tmToWgs84(x, y);
            return [lon, lat];
        }));
    });
});
