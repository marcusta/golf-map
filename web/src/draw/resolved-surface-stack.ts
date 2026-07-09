import polygonClipping, { type MultiPolygon as ClippingMultiPolygon } from 'polygon-clipping';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

type SurfaceGeometry = Polygon | MultiPolygon;
const difference = polygonClipping.difference as (
    subject: ClippingMultiPolygon,
    ...occluders: ClippingMultiPolygon[]
) => ClippingMultiPolygon;

/**
 * Remove every pixel covered by a higher stack entry from each lower entry.
 * The result has disjoint polygons, so a later semi-transparent render blends
 * once with the orthophoto instead of compounding at overlaps.
 */
export function resolveSurfaceStack(source: FeatureCollection): FeatureCollection {
    const topDown = source.features
        .filter((feature): feature is Feature<SurfaceGeometry> =>
            feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon')
        .sort((a, b) => stackKey(b) - stackKey(a));
    const occluders: ClippingMultiPolygon[] = [];
    const resolved: Feature<Geometry>[] = [];

    for (const feature of topDown) {
        const subject = toClippingMultiPolygon(feature.geometry);
        const visible = occluders.length === 0 ? subject : difference(subject, ...occluders);
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

    return { type: 'FeatureCollection', features: resolved };
}

function toClippingMultiPolygon(geometry: SurfaceGeometry): ClippingMultiPolygon {
    return (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as unknown as ClippingMultiPolygon;
}

function stackKey(feature: Feature): number {
    return typeof feature.properties?.stackKey === 'number' ? feature.properties.stackKey : 0;
}
