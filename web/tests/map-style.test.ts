import { test, expect } from 'bun:test';
import {
    buildEditorStyle,
    tileUrlTemplate,
    boundsToArray,
    ORTHO_SOURCE_ID,
    ORTHO_LAYER_ID,
    TERRAIN_SOURCE_ID,
    HILLSHADE_SOURCE_ID,
    HILLSHADE_LAYER_ID,
    BACKGROUND_LAYER_ID,
} from '../src/map/map-style';
import type { TileManifest } from '../src/map/tileset.service';

const MANIFEST: TileManifest = {
    bounds: { west: 15.6954, south: 58.3431, east: 15.7489, north: 58.3712 },
    layers: {
        ortho: { minzoom: 14, maxzoom: 20 },
        terrain: { minzoom: 12, maxzoom: 17 },
    },
    elevation: { min: 53.28, max: 98.5 },
    generatedAt: '2026-07-04T08:28:59Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
};

test('tileUrlTemplate produces proxied XYZ URLs with the version param', () => {
    expect(tileUrlTemplate('C-1', 'ortho', 'jpg', 'V9'))
        .toBe('/tiles/C-1/ortho/{z}/{x}/{y}.jpg?v=V9');
    expect(tileUrlTemplate('C-1', 'terrain', 'png', 'V9'))
        .toBe('/tiles/C-1/terrain/{z}/{x}/{y}.png?v=V9');
});

test('boundsToArray orders west, south, east, north', () => {
    expect(boundsToArray(MANIFEST.bounds)).toEqual([15.6954, 58.3431, 15.7489, 58.3712]);
});

test('buildEditorStyle assembles ortho + terrain sources from the manifest', () => {
    const style = buildEditorStyle('C-1', MANIFEST, 'V9');
    expect(style.version).toBe(8);

    const ortho = style.sources[ORTHO_SOURCE_ID] as any;
    expect(ortho.type).toBe('raster');
    expect(ortho.tiles).toEqual(['/tiles/C-1/ortho/{z}/{x}/{y}.jpg?v=V9']);
    expect(ortho.minzoom).toBe(14);
    expect(ortho.maxzoom).toBe(20);
    expect(ortho.bounds).toEqual([15.6954, 58.3431, 15.7489, 58.3712]);
    expect(ortho.attribution).toBe('© Lantmäteriet, CC BY 4.0');

    const terrain = style.sources[TERRAIN_SOURCE_ID] as any;
    expect(terrain.type).toBe('raster-dem');
    expect(terrain.tiles).toEqual(['/tiles/C-1/terrain/{z}/{x}/{y}.png?v=V9']);
    expect(terrain.encoding).toBe('mapbox');
    expect(terrain.minzoom).toBe(12);
    expect(terrain.maxzoom).toBe(17);
    expect(terrain.bounds).toEqual([15.6954, 58.3431, 15.7489, 58.3712]);

    // Hillshade gets its own raster-dem source (same tiles) — sharing the
    // 3D-terrain source degrades rendering quality (MapLibre warning).
    const hillshadeDem = style.sources[HILLSHADE_SOURCE_ID] as any;
    expect(hillshadeDem.type).toBe('raster-dem');
    expect(hillshadeDem.tiles).toEqual(['/tiles/C-1/terrain/{z}/{x}/{y}.png?v=V9']);
});

test('buildEditorStyle layers: dark background, ortho, hidden hillshade', () => {
    const style = buildEditorStyle('C-1', MANIFEST, 'V9');
    const ids = style.layers.map(l => l.id);
    expect(ids).toEqual([BACKGROUND_LAYER_ID, ORTHO_LAYER_ID, HILLSHADE_LAYER_ID]);

    const bg = style.layers[0] as any;
    expect(bg.type).toBe('background');
    expect(bg.paint['background-color']).toBe('#0b0e11');

    const ortho = style.layers[1] as any;
    expect(ortho.type).toBe('raster');
    expect(ortho.source).toBe(ORTHO_SOURCE_ID);

    const hillshade = style.layers[2] as any;
    expect(hillshade.type).toBe('hillshade');
    expect(hillshade.source).toBe(HILLSHADE_SOURCE_ID);
    expect(hillshade.layout.visibility).toBe('none');
});

test('buildEditorStyle omits attribution when the manifest has none', () => {
    const style = buildEditorStyle('C-1', { ...MANIFEST, attribution: undefined }, 'V9');
    expect((style.sources[ORTHO_SOURCE_ID] as any).attribution).toBeUndefined();
});

test('terrain is not baked into the style — applied at runtime via setTerrain', () => {
    const style = buildEditorStyle('C-1', MANIFEST, 'V9');
    expect(style.terrain).toBeUndefined();
});
