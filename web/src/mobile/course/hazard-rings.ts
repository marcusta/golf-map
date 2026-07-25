import { wgs84ToSweref99tm } from '../../geo/transform';
import { DEFAULT_HAZARD_TYPES } from '../../../../shared/strategy';
import type { BrowseHazardTarget } from '../../planner/browse-ladder';
import type {
    CourseFeatureFeatureCollection,
    CourseFeatureGeoJsonFeature,
} from '../../../../shared/api/course-features.gen';

const HAZARD_TYPES = new Set(DEFAULT_HAZARD_TYPES);

/** Human labels per hazard feature type (falls back to a title-cased type). */
const HAZARD_LABELS: Record<string, string> = {
    water: 'Water',
    water_creek: 'Creek',
    bunker: 'Bunker',
    penalty_yellow: 'Penalty',
    penalty_red: 'Penalty',
    oob: 'Out of bounds',
    outside: 'Out of bounds',
    trees: 'Trees',
    deep_rough: 'Deep rough',
};

/** Project one WGS84 outer ring (`[lng, lat]` pairs) to EPSG:3006 `{x, y}`. */
function projectRing(coords: number[][]): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    for (const [lng, lat] of coords) {
        const { x, y } = wgs84ToSweref99tm(lat, lng);
        points.push({ x, y });
    }
    return points;
}

/**
 * Hazard rings from the RESOLVED course GeoJSON (WGS84), projected to the flat
 * CRS the distance engine works in. Only the corridor-obstacle types
 * (`DEFAULT_HAZARD_TYPES`, shared with the desktop lie map) are kept, and only
 * each polygon's OUTER ring — enough for the front/carry edge readout, which
 * is a ray/ring intersection. Pure: no framework, no network.
 */
export function hazardRingsFromGeojson(
    fc: CourseFeatureFeatureCollection | null,
): BrowseHazardTarget[] {
    if (!fc) return [];
    const out: BrowseHazardTarget[] = [];
    for (const feature of fc.features) {
        const type = feature.properties.type;
        if (!HAZARD_TYPES.has(type)) continue;
        const label = HAZARD_LABELS[type] ?? type;
        for (const [ringIndex, ring] of polygonOuterRings(feature).entries()) {
            const points = projectRing(ring);
            if (points.length < 3) continue;
            out.push({
                id: `${feature.id}:${ringIndex}`,
                label,
                ring: { points, kind: type },
            });
        }
    }
    return out;
}

/** The outer ring of every polygon in a (Multi)Polygon feature. */
function polygonOuterRings(feature: CourseFeatureGeoJsonFeature): number[][][] {
    if (feature.geometry.type === 'Polygon') {
        const outer = feature.geometry.coordinates[0];
        return outer ? [outer] : [];
    }
    // MultiPolygon: coordinates is Polygon[]; take each polygon's outer ring.
    return feature.geometry.coordinates
        .map(polygon => polygon[0])
        .filter((ring): ring is number[][] => Array.isArray(ring));
}
