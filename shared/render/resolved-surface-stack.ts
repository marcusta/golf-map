import polygonClipping, { type MultiPolygon as ClippingMultiPolygon } from 'polygon-clipping';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

type SurfaceGeometry = Polygon | MultiPolygon;
type BBox = readonly [west: number, south: number, east: number, north: number];
const difference = polygonClipping.difference as (
    subject: ClippingMultiPolygon,
    ...occluders: ClippingMultiPolygon[]
) => ClippingMultiPolygon;

// Resolution costs O(features × overlapping occluders × vertices) of synchronous
// main-thread clipping — ~50 s for a full course if every toggle recomputes it.
// The input collection is a cached Computed replaced wholesale on geometry/
// visibility changes, so identity keying is exact and repeated nice-mode
// entries (every switch away from the draw sub-mode) are free.
const resolvedCache = new WeakMap<FeatureCollection, FeatureCollection>();

/**
 * Remove every pixel covered by a higher stack entry from each lower entry.
 * The result has disjoint polygons, so a later semi-transparent render blends
 * once with the orthophoto instead of compounding at overlaps.
 *
 * Each feature is only differenced against the higher entries whose bounding
 * boxes intersect its own — disjoint-bbox differences are no-ops, and golf
 * features are spatially local (a green overlaps its fringe and bunkers, not
 * the other 680 features), so this bounds the per-feature work to a handful
 * of occluders instead of the whole stack above it.
 *
 * Non-polygon features (creeks/paths drawn as lines) pass through unchanged
 * after the resolved polygons — they render on dedicated line layers, so
 * their position in the collection doesn't matter.
 */
export function resolveSurfaceStack(source: FeatureCollection): FeatureCollection {
    const cached = resolvedCache.get(source);
    if (cached) return cached;

    const isSurface = (feature: Feature): feature is Feature<SurfaceGeometry> =>
        feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon';
    const passthrough = source.features.filter(feature => !isSurface(feature));
    const topDown = source.features
        .filter(isSurface)
        .sort((a, b) => stackKey(b) - stackKey(a));
    const occluders: Array<{ shape: ClippingMultiPolygon; bbox: BBox }> = [];
    const resolved: Feature<Geometry>[] = [];

    for (const feature of topDown) {
        const subject = toClippingMultiPolygon(feature.geometry);
        const bbox = bboxOf(subject);
        const overlapping = occluders
            .filter(occluder => bboxesIntersect(occluder.bbox, bbox))
            .map(occluder => occluder.shape);
        const visible = clip(subject, overlapping);
        if (visible.length > 0) {
            resolved.push({
                ...feature,
                geometry: {
                    type: 'MultiPolygon',
                    coordinates: visible as unknown as MultiPolygon['coordinates'],
                },
            });
        }
        occluders.push({ shape: subject, bbox });
    }

    const result: FeatureCollection = {
        type: 'FeatureCollection',
        features: [...resolved, ...passthrough],
    };
    resolvedCache.set(source, result);
    return result;
}

/**
 * difference() with degenerate-geometry tolerance: polygon-clipping throws on
 * NaN/empty/self-degenerate rings, and one bad ring anywhere in the batch
 * would otherwise cost the whole nice-mode render. Retry one occluder at a
 * time so only the bad pairing is skipped, and stop early once nothing of the
 * subject remains visible.
 */
function clip(subject: ClippingMultiPolygon, occluders: ClippingMultiPolygon[]): ClippingMultiPolygon {
    if (occluders.length === 0) return subject;
    try {
        return difference(subject, ...occluders);
    } catch {
        let visible = subject;
        for (const occluder of occluders) {
            try {
                visible = difference(visible, occluder);
            } catch {
                // Skip the degenerate pairing; the occluder still renders on top.
            }
            if (visible.length === 0) break;
        }
        return visible;
    }
}

function toClippingMultiPolygon(geometry: SurfaceGeometry): ClippingMultiPolygon {
    return (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as unknown as ClippingMultiPolygon;
}

function bboxOf(shape: ClippingMultiPolygon): BBox {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const polygon of shape) {
        for (const ring of polygon) {
            for (const [x, y] of ring) {
                if (x < west) west = x;
                if (x > east) east = x;
                if (y < south) south = y;
                if (y > north) north = y;
            }
        }
    }
    return [west, south, east, north];
}

function bboxesIntersect(a: BBox, b: BBox): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function stackKey(feature: Feature): number {
    return typeof feature.properties?.stackKey === 'number' ? feature.properties.stackKey : 0;
}
