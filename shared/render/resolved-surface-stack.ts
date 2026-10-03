import polygonClipping, { type MultiPolygon as ClippingMultiPolygon } from 'polygon-clipping';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

type SurfaceGeometry = Polygon | MultiPolygon;
type BBox = readonly [west: number, south: number, east: number, north: number];
const difference = polygonClipping.difference as (
    subject: ClippingMultiPolygon,
    ...occluders: ClippingMultiPolygon[]
) => ClippingMultiPolygon;

// Clipping cost scales with features x bbox-overlapping occluders x vertices.
// Measured on data/app.sqlite (web/tests/surface-stack-bench.test.ts): 1.5 s
// for the largest course (689 features, 307k vertices), 90-150 ms for an
// 18-hole course of 120-190 features, 20-30 ms for the worst single hole.
//
// Two memo levels keep repeat work off the main thread:
// - per collection (`resolvedCache`): `FeaturesService.geojson` is identity-
//   stable, so a Draw <-> nice flip with no edit in between resolves nothing.
// - per surface (`surfaceCache`): keyed by the coordinates array, which
//   `geometryToWgs84Rings` caches per geometry object. A surface is clipped
//   again only when its own coordinates or its list of bbox-overlapping
//   occluders changed, so an edit re-clips the edited surface and the
//   surfaces under it, not the whole course. Visibility toggles and reorders
//   rebuild every Feature object but keep the coordinates, so they hit too.
const resolvedCache = new WeakMap<FeatureCollection, FeatureCollection>();

type Surface = { shape: ClippingMultiPolygon; bbox: BBox };
type ResolvedSurface = {
    /** Coordinates of the occluders `visible` was clipped against, in order. */
    occluders: readonly object[];
    /** Null when nothing of the surface stays visible. */
    geometry: MultiPolygon | null;
    input: Feature;
    output: Feature | null;
};
const shapeCache = new WeakMap<object, Surface>();
const surfaceCache = new WeakMap<object, ResolvedSurface>();

/** Work counters for tests and the bench. Not reset by the module. */
export const surfaceStackStats = { resolves: 0, clips: 0 };

/**
 * Remove every pixel covered by a higher stack entry from each lower entry.
 * The result has disjoint polygons, so a later semi-transparent render blends
 * once with the orthophoto instead of compounding at overlaps.
 *
 * Each feature is only differenced against the higher entries whose bounding
 * boxes intersect its own. Disjoint-bbox differences are no-ops, and golf
 * features are spatially local (a green overlaps its fringe and bunkers, not
 * the other 680 features), so this bounds the per-feature work to a handful
 * of occluders instead of the whole stack above it.
 *
 * Non-polygon features (creeks/paths drawn as lines) pass through unchanged
 * after the resolved polygons. They render on dedicated line layers, so
 * their position in the collection doesn't matter.
 */
export function resolveSurfaceStack(source: FeatureCollection): FeatureCollection {
    const cached = resolvedCache.get(source);
    if (cached) return cached;
    surfaceStackStats.resolves++;

    const isSurface = (feature: Feature): feature is Feature<SurfaceGeometry> =>
        feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon';
    const passthrough = source.features.filter(feature => !isSurface(feature));
    const topDown = source.features
        .filter(isSurface)
        .sort((a, b) => stackKey(b) - stackKey(a));
    const occluders: Array<Surface & { key: object }> = [];
    const resolved: Feature<Geometry>[] = [];

    for (const feature of topDown) {
        const key = feature.geometry.coordinates;
        const surface = surfaceOf(feature.geometry);
        const overlapping = occluders.filter(occluder => bboxesIntersect(occluder.bbox, surface.bbox));
        const overlappingKeys = overlapping.map(occluder => occluder.key);
        let entry = surfaceCache.get(key);
        if (!entry || !sameKeys(entry.occluders, overlappingKeys)) {
            surfaceStackStats.clips++;
            const visible = clip(surface.shape, overlapping.map(occluder => occluder.shape));
            entry = {
                occluders: overlappingKeys,
                geometry: visible.length > 0
                    ? { type: 'MultiPolygon', coordinates: visible as unknown as MultiPolygon['coordinates'] }
                    : null,
                input: feature,
                output: null,
            };
            surfaceCache.set(key, entry);
        }
        if (entry.geometry) {
            // Reuse the output Feature while the input Feature is unchanged,
            // so unchanged surfaces keep their identity across resolves.
            if (entry.input !== feature || !entry.output) {
                entry.input = feature;
                entry.output = { ...feature, geometry: entry.geometry };
            }
            resolved.push(entry.output);
        }
        occluders.push({ ...surface, key });
    }

    const result: FeatureCollection = {
        type: 'FeatureCollection',
        features: [...resolved, ...passthrough],
    };
    resolvedCache.set(source, result);
    return result;
}

function surfaceOf(geometry: SurfaceGeometry): Surface {
    let surface = shapeCache.get(geometry.coordinates);
    if (!surface) {
        const shape = toClippingMultiPolygon(geometry);
        surface = { shape, bbox: bboxOf(shape) };
        shapeCache.set(geometry.coordinates, surface);
    }
    return surface;
}

function sameKeys(a: readonly object[], b: readonly object[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
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
