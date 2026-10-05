import polygonClipping, { type MultiPolygon as ClippingMultiPolygon } from 'polygon-clipping';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

type SurfaceGeometry = Polygon | MultiPolygon;
type BBox = readonly [west: number, south: number, east: number, north: number];
const difference = polygonClipping.difference as (
    subject: ClippingMultiPolygon,
    ...occluders: ClippingMultiPolygon[]
) => ClippingMultiPolygon;

// Resolution costs O(features × overlapping occluders × vertices) of clipping —
// ~10 s for a course whose roughs carry thousands of vertices each. Two caches
// keep repeats cheap: the whole result by collection identity (the web's input
// is a Computed replaced wholesale on geometry/visibility changes, so identity
// keying is exact), and each feature's clip by the CONTENT of it and of its
// overlapping occluders (`createSurfaceStackResolver`), so after one edit only
// the features under or over the edited one are clipped again.
const resolvedCache = new WeakMap<FeatureCollection, FeatureCollection>();

/**
 * Polygon feature types that are overlays rather than playing surfaces: they
 * pass through untouched and never occlude what is under them.
 *
 * `oob` is here because it is painted as a boundary line, not a fill
 * (OUTLINE_ONLY_TYPES in web/src/draw/feature-palette.ts): the ring is drawn
 * around the whole property and sits high in the stack, so treating it as a
 * surface would clip every fairway and green on the course out of existence.
 * The penalty areas are rules lines too (staked round water and ground that
 * are surfaces of their own): trimmed as a surface, a higher feature — or a
 * course-level shape stacked over every hole — hides the line the Furniture
 * tool edits, and the area would cut the water it marks out from under it.
 */
const OVERLAY_TYPES = new Set(['vegetation_zone', 'tree_area', 'oob', 'penalty_yellow', 'penalty_red']);

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
 * their position in the collection doesn't matter. So do vegetation zones:
 * they are an authoring overlay on top of the surfaces (like the generated
 * tree canopy, which lives in its own collection), not a surface of their
 * own, so they neither get clipped nor clip anything.
 */
export function resolveSurfaceStack(source: FeatureCollection): FeatureCollection {
    const cached = resolvedCache.get(source);
    if (cached) return cached;
    const result = defaultResolver(source);
    resolvedCache.set(source, result);
    return result;
}

/**
 * `resolveSurfaceStack` without the identity cache and with its own
 * per-feature memo: a feature's visible part is reused when its geometry and
 * the geometries of the higher surfaces overlapping it are unchanged — by
 * content, so it survives structured cloning into a worker. The memo keeps
 * only the entries the last call used.
 */
export function createSurfaceStackResolver(): (source: FeatureCollection) => FeatureCollection {
    let memo = new Map<string, ClippingMultiPolygon>();
    return source => {
        const used = new Map<string, ClippingMultiPolygon>();
        const result = resolve(source, (subject, overlapping, run) => {
            const key = [subject.key, ...overlapping.map(o => o.key)].join('|');
            const visible = memo.get(key) ?? used.get(key) ?? run();
            used.set(key, visible);
            return visible;
        });
        memo = used;
        return result;
    };
}

const defaultResolver = createSurfaceStackResolver();

interface Shape {
    shape: ClippingMultiPolygon;
    bbox: BBox;
    /** Content fingerprint of `shape` (the memo key's parts). */
    key: string;
}

function resolve(
    source: FeatureCollection,
    clipMemo: (subject: Shape, overlapping: Shape[], run: () => ClippingMultiPolygon) => ClippingMultiPolygon,
): FeatureCollection {
    const isSurface = (feature: Feature): feature is Feature<SurfaceGeometry> =>
        (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon')
        && !OVERLAY_TYPES.has(feature.properties?.type as string);
    const passthrough = source.features.filter(feature => !isSurface(feature));
    const topDown = source.features
        .filter(isSurface)
        .sort((a, b) => stackKey(b) - stackKey(a));
    const occluders: Shape[] = [];
    const resolved: Feature<Geometry>[] = [];

    for (const feature of topDown) {
        const shape = toClippingMultiPolygon(feature.geometry);
        const subject: Shape = { shape, bbox: bboxOf(shape), key: fingerprint(shape) };
        const overlapping = occluders.filter(occluder => bboxesIntersect(occluder.bbox, subject.bbox));
        const visible = clipMemo(subject, overlapping, () => clip(shape, overlapping.map(o => o.shape)));
        if (visible.length > 0) {
            resolved.push({
                ...feature,
                geometry: {
                    type: 'MultiPolygon',
                    coordinates: visible as unknown as MultiPolygon['coordinates'],
                },
            });
        }
        occluders.push(subject);
    }

    return {
        type: 'FeatureCollection',
        features: [...resolved, ...passthrough],
    };
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

/** Hash of every coordinate's bits in two 32-bit lanes, plus the vertex count. */
function fingerprint(shape: ClippingMultiPolygon): string {
    const bits = new Float64Array(1);
    const words = new Uint32Array(bits.buffer);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57, vertices = 0;
    const mix = (value: number): void => {
        bits[0] = value;
        for (let i = 0; i < 2; i++) {
            h1 = Math.imul(h1 ^ words[i]!, 2654435761);
            h2 = Math.imul(h2 ^ words[i]!, 1597334677);
        }
    };
    for (const polygon of shape) {
        mix(polygon.length);
        for (const ring of polygon) {
            mix(ring.length);
            for (const point of ring) {
                mix(point[0]);
                mix(point[1]);
                vertices++;
            }
        }
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${vertices}`;
}

function bboxesIntersect(a: BBox, b: BBox): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function stackKey(feature: Feature): number {
    return typeof feature.properties?.stackKey === 'number' ? feature.properties.stackKey : 0;
}
