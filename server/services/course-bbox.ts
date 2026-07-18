// The course's map-area bbox authority chain ("site owns the map"),
// shared by the external-data fetch proxies (HydroService T50,
// OsmService T53):
//
//   1. course.georeference_json `{ bbox: [minX, minY, maxX, maxY] }`
//      (EPSG:3006, written by the tile pipeline / SVG import flow);
//   2. else the course's site's tile_manifest asset metaJson `bounds`
//      (WGS84 — the DB row, not the tile file, so it works wherever the
//      asset registry does);
//   3. else a clear ConflictError — there is no map area to fetch for.

import { ConflictError } from '@basics/core/server/auth';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from './geo';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';

export interface BboxWgs84 {
    west: number;
    south: number;
    east: number;
    north: number;
}

export type Bbox3006 = [minX: number, minY: number, maxX: number, maxY: number];

/**
 * Resolve the course's map-area bbox as WGS84 (for external APIs' lon/lat
 * bbox filters) + EPSG:3006 (for clipping). `purpose` names the caller's
 * data source in the 409 message ("fetch water for", "fetch OSM features
 * for", …).
 */
export async function resolveCourseMapBbox(
    courses: CoursesService,
    assets: AssetsService,
    courseId: string,
    purpose: string,
): Promise<{ wgs84: BboxWgs84; sweref: Bbox3006 }> {
    const course = await courses.get(courseId);

    const georef = parseGeoreferenceBbox(course.georeferenceJson);
    if (georef) {
        const corners = [
            sweref99tmToWgs84(georef[0], georef[1]),
            sweref99tmToWgs84(georef[2], georef[1]),
            sweref99tmToWgs84(georef[2], georef[3]),
            sweref99tmToWgs84(georef[0], georef[3]),
        ];
        return {
            wgs84: {
                west: Math.min(...corners.map(c => c.lon)),
                south: Math.min(...corners.map(c => c.lat)),
                east: Math.max(...corners.map(c => c.lon)),
                north: Math.max(...corners.map(c => c.lat)),
            },
            sweref: georef,
        };
    }

    if (course.siteId) {
        const siteAssets = await assets.listBySite(course.siteId);
        const manifest = siteAssets.find(a => a.kind === 'tile_manifest');
        const bounds = parseManifestBounds(manifest?.metaJson);
        if (bounds) {
            const corners = [
                wgs84ToSweref99tm(bounds.south, bounds.west),
                wgs84ToSweref99tm(bounds.south, bounds.east),
                wgs84ToSweref99tm(bounds.north, bounds.east),
                wgs84ToSweref99tm(bounds.north, bounds.west),
            ];
            return {
                wgs84: bounds,
                sweref: [
                    Math.min(...corners.map(c => c.x)),
                    Math.min(...corners.map(c => c.y)),
                    Math.max(...corners.map(c => c.x)),
                    Math.max(...corners.map(c => c.y)),
                ],
            };
        }
    }

    throw new ConflictError(
        `Course has no map area to ${purpose}: no georeference bbox and its site has `
        + 'no tile manifest. Build the course map (Set map area) first.',
    );
}

/** `{ bbox: [minX, minY, maxX, maxY] }` (EPSG:3006) from georeference_json. */
function parseGeoreferenceBbox(georeferenceJson: string | null): Bbox3006 | null {
    if (!georeferenceJson) return null;
    try {
        const parsed = JSON.parse(georeferenceJson) as { bbox?: unknown };
        const bbox = parsed.bbox;
        if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(n => typeof n === 'number')) {
            return [bbox[0], bbox[1], bbox[2], bbox[3]];
        }
    } catch {
        // fall through
    }
    return null;
}

/** WGS84 `bounds` from a tile_manifest asset's metaJson. */
function parseManifestBounds(metaJson: string | null | undefined): BboxWgs84 | null {
    if (!metaJson) return null;
    try {
        const parsed = JSON.parse(metaJson) as { bounds?: Record<string, unknown> };
        const b = parsed.bounds;
        if (
            b && typeof b.west === 'number' && typeof b.south === 'number'
            && typeof b.east === 'number' && typeof b.north === 'number'
        ) {
            return { west: b.west, south: b.south, east: b.east, north: b.north };
        }
    } catch {
        // fall through
    }
    return null;
}
