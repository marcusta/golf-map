// Pure MapLibre style assembly for the editor map. No maplibre-gl runtime
// import (types only) so these functions are unit-testable under bun test —
// MapLibre itself cannot run in happy-dom.
import type { StyleSpecification, LayerSpecification, RasterSourceSpecification } from 'maplibre-gl';
import { BASE_PATH } from '@basics/core/client/base';
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
/** Lidar canopy display raster (pre-coloured, transparent where no trees). */
export const CANOPY_COLOR_SOURCE_ID = 'course-canopy-color';
export const CANOPY_COLOR_LAYER_ID = 'course-canopy-color';
/** Canopy display opacity — lets the ortho read through the tree crowns. */
export const CANOPY_COLOR_OPACITY = 0.7;
/** Lidar DSM (ground + canopy) raster-dem — the `surface` 3D terrain mode. */
export const SURFACE_SOURCE_ID = 'course-surface';
export const BACKGROUND_LAYER_ID = 'editor-background';

/**
 * Which raster-dem drives MapLibre's 3D terrain: `ground` (the bare-earth
 * DEM, TERRAIN_SOURCE_ID — default) or `surface` (the lidar DSM incl. tree
 * canopy, SURFACE_SOURCE_ID; only offered when the manifest has the layer).
 * Visual only — ElevationService always samples the ground DEM.
 */
export type TerrainMode = 'ground' | 'surface';

/** Raster-dem source id for a terrain mode. */
export function terrainSourceId(mode: TerrainMode): string {
    return mode === 'surface' ? SURFACE_SOURCE_ID : TERRAIN_SOURCE_ID;
}

/** Base color outside tile coverage. */
export const BACKGROUND_COLOR = '#0b0e11';

/** Hard ceiling; ortho overzooms past its native maxzoom up to here. */
export const EDITOR_MAX_ZOOM = 22;

/** Per-vintage ortho source/layer ids (non-active vintages get a suffix). */
export function orthoSourceId(collection: string): string {
    return `${ORTHO_SOURCE_ID}-${collection}`;
}
export function orthoLayerId(collection: string): string {
    return `${ORTHO_LAYER_ID}-${collection}`;
}

/**
 * XYZ tile URL template for a course layer. Same-origin (`/tiles` is proxied
 * to the API server by vite — see web/vite.config.ts). The `?v=` param is
 * mandatory: the server sends immutable cache headers on tile bytes.
 *
 * `collection` selects a non-active ortho vintage tiled under
 * `ortho/<collection>/`; omit it for the flat (build-time active) ortho tree.
 *
 * BASE_PATH carries the deploy prefix ('' at the root, '/golf-map' behind the
 * sig-infra Caddy path route). MapLibre resolves these templates against the
 * document origin, so a bare '/tiles/…' would leave the prefix off and 404 —
 * and unlike a failed fetch it surfaces only as blank map tiles.
 */
export function tileUrlTemplate(
    mapKey: string,
    layer: 'ortho' | 'ortho-sim' | 'terrain' | 'hillshade' | 'canopy' | 'canopy-color' | 'surface',
    ext: 'jpg' | 'png' | 'webp',
    version: string,
    collection?: string,
): string {
    // mapKey = the site id (the shared map's on-disk/URL key), not the course id.
    const query = collection ? `?v=${version}&c=${collection}` : `?v=${version}`;
    return `${BASE_PATH}/tiles/${mapKey}/${layer}/{z}/{x}/{y}.${ext}${query}`;
}

/** Manifest bounds → MapLibre `[west, south, east, north]` array. */
export function boundsToArray(bounds: TileBounds): [number, number, number, number] {
    return [bounds.west, bounds.south, bounds.east, bounds.north];
}

/**
 * Assemble the editor map style for one course: dark empty background
 * (the ortho IS the basemap), ortho raster layer, terrain raster-dem
 * source (Terrain-RGB, `encoding: 'mapbox'`), and a hidden hillshade
 * layer toggled via MapService.setHillshade(). When the manifest carries the
 * lidar layers, also a hidden `canopy-color` raster (MapService.setCanopy())
 * above the hillshade and a `surface` raster-dem source for the DSM terrain
 * mode (MapService.setTerrainMode()).
 *
 * 3D terrain itself is NOT declared in the style — MapService applies it
 * with `setTerrain()` once the style has loaded, so exaggeration stays a
 * runtime-adjustable signal.
 */
export function buildEditorStyle(
    mapKey: string,
    manifest: TileManifest,
    version: string,
): StyleSpecification {
    const bounds = boundsToArray(manifest.bounds);
    const orthoCommon = {
        type: 'raster' as const,
        tileSize: 256,
        minzoom: manifest.layers.ortho.minzoom,
        maxzoom: manifest.layers.ortho.maxzoom,
        bounds,
        ...(manifest.attribution ? { attribution: manifest.attribution } : {}),
    };

    // One ortho raster source+layer per persisted vintage so the client can
    // switch between them by toggling layer visibility — no server re-tile.
    // The active (build-time) vintage is served from the flat ortho tree; the
    // others from ortho/<collection>/ (via ?c=). Only the active layer starts
    // visible, so MapLibre only fetches a vintage's tiles once it's shown. When
    // the manifest carries ≤1 vintage, fall back to a single flat ortho layer.
    const vintages = manifest.orthoVintages ?? [];
    const active = manifest.activeOrtho ?? vintages[0]?.collection;
    const orthoSources: Record<string, RasterSourceSpecification> = {};
    const orthoLayers: LayerSpecification[] = [];
    if (vintages.length > 1) {
        for (const v of vintages) {
            const isActive = v.collection === active;
            orthoSources[orthoSourceId(v.collection)] = {
                ...orthoCommon,
                tiles: [tileUrlTemplate(mapKey, 'ortho', 'jpg', version, isActive ? undefined : v.collection)],
            };
            orthoLayers.push({
                id: orthoLayerId(v.collection),
                type: 'raster',
                source: orthoSourceId(v.collection),
                layout: { visibility: isActive ? 'visible' : 'none' },
            });
        }
    } else {
        orthoSources[ORTHO_SOURCE_ID] = { ...orthoCommon, tiles: [tileUrlTemplate(mapKey, 'ortho', 'jpg', version)] };
        orthoLayers.push({ id: ORTHO_LAYER_ID, type: 'raster', source: ORTHO_SOURCE_ID });
    }

    const sources: StyleSpecification['sources'] = {
        ...orthoSources,
        [TERRAIN_SOURCE_ID]: {
            type: 'raster-dem',
            tiles: [tileUrlTemplate(mapKey, 'terrain', 'png', version)],
            tileSize: 256,
            minzoom: manifest.layers.terrain.minzoom,
            maxzoom: manifest.layers.terrain.maxzoom,
            bounds,
            encoding: 'mapbox',
        },
    };

    // Hillshade layer. Prefer the pipeline-baked OPAQUE grayscale raster (a real
    // image, every pixel valued — matches QGIS `gdaldem hillshade`). Fall back
    // to MapLibre's translucent client-side hillshade for courses built before
    // the baked layer existed (until they're rebuilt).
    const bakedHillshade = manifest.layers.hillshade;
    let hillshadeLayer: LayerSpecification;
    if (bakedHillshade) {
        sources[HILLSHADE_SOURCE_ID] = {
            type: 'raster',
            tiles: [tileUrlTemplate(mapKey, 'hillshade', 'webp', version)],
            tileSize: 256,
            minzoom: bakedHillshade.minzoom,
            maxzoom: bakedHillshade.maxzoom,
            bounds,
        };
        hillshadeLayer = {
            id: HILLSHADE_LAYER_ID,
            type: 'raster',
            source: HILLSHADE_SOURCE_ID,
            layout: { visibility: 'none' },
        };
    } else {
        sources[HILLSHADE_SOURCE_ID] = {
            type: 'raster-dem',
            tiles: [tileUrlTemplate(mapKey, 'terrain', 'png', version)],
            tileSize: 256,
            minzoom: manifest.layers.terrain.minzoom,
            maxzoom: manifest.layers.terrain.maxzoom,
            bounds,
            encoding: 'mapbox',
        };
        hillshadeLayer = {
            id: HILLSHADE_LAYER_ID,
            type: 'hillshade',
            source: HILLSHADE_SOURCE_ID,
            layout: { visibility: 'none' },
            paint: { 'hillshade-exaggeration': 0.6 },
        };
    }

    // Lidar canopy display raster: above ortho + hillshade, below every vector
    // overlay (tools append their layers after the style's, so last-in-style
    // is still under them). Hidden until toggled.
    const canopyColor = manifest.layers['canopy-color'];
    const canopyLayers: LayerSpecification[] = [];
    if (canopyColor) {
        sources[CANOPY_COLOR_SOURCE_ID] = {
            type: 'raster',
            tiles: [tileUrlTemplate(mapKey, 'canopy-color', 'png', version)],
            tileSize: 256,
            minzoom: canopyColor.minzoom,
            maxzoom: canopyColor.maxzoom,
            bounds,
        };
        canopyLayers.push({
            id: CANOPY_COLOR_LAYER_ID,
            type: 'raster',
            source: CANOPY_COLOR_SOURCE_ID,
            layout: { visibility: 'none' },
            paint: { 'raster-opacity': CANOPY_COLOR_OPACITY },
        });
    }

    // Lidar DSM as an alternative 3D-terrain source. Declared only — no
    // layer reads it until setTerrain() points at it, so its tiles aren't
    // fetched in `ground` mode.
    const surface = manifest.layers.surface;
    if (surface) {
        sources[SURFACE_SOURCE_ID] = {
            type: 'raster-dem',
            tiles: [tileUrlTemplate(mapKey, 'surface', 'png', version)],
            tileSize: 256,
            minzoom: surface.minzoom,
            maxzoom: surface.maxzoom,
            bounds,
            encoding: 'mapbox',
        };
    }

    return {
        version: 8,
        sources,
        layers: [
            {
                id: BACKGROUND_LAYER_ID,
                type: 'background',
                paint: { 'background-color': BACKGROUND_COLOR },
            },
            ...orthoLayers,
            hillshadeLayer,
            ...canopyLayers,
        ],
    };
}
