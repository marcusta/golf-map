// Pure MapLibre style assembly for the editor map. No maplibre-gl runtime
// import (types only) so these functions are unit-testable under bun test —
// MapLibre itself cannot run in happy-dom.
import type { StyleSpecification } from 'maplibre-gl';
import type { TileBounds, TileManifest } from './tileset.service';

/** Source/layer ids — stable public constants downstream tools may reference. */
export const ORTHO_SOURCE_ID = 'course-ortho';
export const ORTHO_LAYER_ID = 'course-ortho';
export const TERRAIN_SOURCE_ID = 'course-terrain';
/**
 * Separate raster-dem source (same tiles) for the hillshade layer —
 * MapLibre warns about degraded rendering quality when hillshade shares
 * the 3D-terrain source. Tile bytes are shared via the HTTP cache.
 */
export const HILLSHADE_SOURCE_ID = 'course-hillshade-dem';
export const HILLSHADE_LAYER_ID = 'course-hillshade';
export const BACKGROUND_LAYER_ID = 'editor-background';

/** Hard ceiling; ortho overzooms past its native maxzoom up to here. */
export const EDITOR_MAX_ZOOM = 22;

/**
 * XYZ tile URL template for a course layer. Same-origin (`/tiles` is proxied
 * to the API server by vite — see web/vite.config.ts). The `?v=` param is
 * mandatory: the server sends immutable cache headers on tile bytes.
 */
export function tileUrlTemplate(
    courseId: string,
    layer: 'ortho' | 'terrain',
    ext: 'jpg' | 'png',
    version: string,
): string {
    return `/tiles/${courseId}/${layer}/{z}/{x}/{y}.${ext}?v=${version}`;
}

/** Manifest bounds → MapLibre `[west, south, east, north]` array. */
export function boundsToArray(bounds: TileBounds): [number, number, number, number] {
    return [bounds.west, bounds.south, bounds.east, bounds.north];
}

/**
 * Assemble the editor map style for one course: dark empty background
 * (the ortho IS the basemap), ortho raster layer, terrain raster-dem
 * source (Terrain-RGB, `encoding: 'mapbox'`), and a hidden hillshade
 * layer toggled via MapService.setHillshade().
 *
 * 3D terrain itself is NOT declared in the style — MapService applies it
 * with `setTerrain()` once the style has loaded, so exaggeration stays a
 * runtime-adjustable signal.
 */
export function buildEditorStyle(
    courseId: string,
    manifest: TileManifest,
    version: string,
): StyleSpecification {
    const bounds = boundsToArray(manifest.bounds);
    return {
        version: 8,
        sources: {
            [ORTHO_SOURCE_ID]: {
                type: 'raster',
                tiles: [tileUrlTemplate(courseId, 'ortho', 'jpg', version)],
                tileSize: 256,
                minzoom: manifest.layers.ortho.minzoom,
                maxzoom: manifest.layers.ortho.maxzoom,
                bounds,
                ...(manifest.attribution ? { attribution: manifest.attribution } : {}),
            },
            [TERRAIN_SOURCE_ID]: {
                type: 'raster-dem',
                tiles: [tileUrlTemplate(courseId, 'terrain', 'png', version)],
                tileSize: 256,
                minzoom: manifest.layers.terrain.minzoom,
                maxzoom: manifest.layers.terrain.maxzoom,
                bounds,
                encoding: 'mapbox',
            },
            [HILLSHADE_SOURCE_ID]: {
                type: 'raster-dem',
                tiles: [tileUrlTemplate(courseId, 'terrain', 'png', version)],
                tileSize: 256,
                minzoom: manifest.layers.terrain.minzoom,
                maxzoom: manifest.layers.terrain.maxzoom,
                bounds,
                encoding: 'mapbox',
            },
        },
        layers: [
            {
                id: BACKGROUND_LAYER_ID,
                type: 'background',
                paint: { 'background-color': '#0b0e11' },
            },
            {
                id: ORTHO_LAYER_ID,
                type: 'raster',
                source: ORTHO_SOURCE_ID,
            },
            {
                id: HILLSHADE_LAYER_ID,
                type: 'hillshade',
                source: HILLSHADE_SOURCE_ID,
                layout: { visibility: 'none' },
                paint: { 'hillshade-exaggeration': 0.6 },
            },
        ],
    };
}
