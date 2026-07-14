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
    orthoSourceId,
    orthoLayerId,
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

test('tileUrlTemplate appends ?c=<collection> for a non-active ortho vintage', () => {
    expect(tileUrlTemplate('C-1', 'ortho', 'jpg', 'V9', 'orto-l2-2023'))
        .toBe('/tiles/C-1/ortho/{z}/{x}/{y}.jpg?v=V9&c=orto-l2-2023');
});

test('buildEditorStyle: >1 vintage → one ortho layer each, only the active visible', () => {
    const manifest: TileManifest = {
        ...MANIFEST,
        orthoVintages: [
            { collection: 'orto-l2-2025', dates: ['2025-06-21'] },
            { collection: 'orto-l2-2023', dates: ['2023-04-21'] },
        ],
        activeOrtho: 'orto-l2-2025',
    };
    const style = buildEditorStyle('C-1', manifest, 'V9');

    // Active vintage → flat tree (no ?c); the other → ortho/<collection>/ via ?c.
    const active = style.sources[orthoSourceId('orto-l2-2025')] as any;
    expect(active.tiles).toEqual(['/tiles/C-1/ortho/{z}/{x}/{y}.jpg?v=V9']);
    const older = style.sources[orthoSourceId('orto-l2-2023')] as any;
    expect(older.tiles).toEqual(['/tiles/C-1/ortho/{z}/{x}/{y}.jpg?v=V9&c=orto-l2-2023']);

    // Both layers present, in manifest order, active shown / older hidden.
    const ids = style.layers.map(l => l.id);
    expect(ids).toEqual([
        BACKGROUND_LAYER_ID,
        orthoLayerId('orto-l2-2025'),
        orthoLayerId('orto-l2-2023'),
        HILLSHADE_LAYER_ID,
    ]);
    const activeLayer = style.layers.find(l => l.id === orthoLayerId('orto-l2-2025')) as any;
    const olderLayer = style.layers.find(l => l.id === orthoLayerId('orto-l2-2023')) as any;
    expect(activeLayer.layout?.visibility).toBe('visible');
    expect(olderLayer.layout.visibility).toBe('none');
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

test('buildEditorStyle: baked hillshade layer → opaque raster from hillshade tiles', () => {
    const manifest: TileManifest = {
        ...MANIFEST,
        layers: { ...MANIFEST.layers, hillshade: { minzoom: 14, maxzoom: 19 } },
    };
    const style = buildEditorStyle('C-1', manifest, 'V9');

    // Opaque raster source pointing at the baked hillshade WebP tiles.
    const src = style.sources[HILLSHADE_SOURCE_ID] as any;
    expect(src.type).toBe('raster');
    expect(src.tiles).toEqual(['/tiles/C-1/hillshade/{z}/{x}/{y}.webp?v=V9']);
    expect(src.maxzoom).toBe(19);

    const layer = style.layers.find(l => l.id === HILLSHADE_LAYER_ID) as any;
    expect(layer.type).toBe('raster');
    expect(layer.layout.visibility).toBe('none');
});

test('buildEditorStyle: no baked hillshade → falls back to client-side hillshade layer', () => {
    const style = buildEditorStyle('C-1', MANIFEST, 'V9'); // MANIFEST has no layers.hillshade
    const layer = style.layers.find(l => l.id === HILLSHADE_LAYER_ID) as any;
    expect(layer.type).toBe('hillshade');
    expect((style.sources[HILLSHADE_SOURCE_ID] as any).type).toBe('raster-dem');
});

test('buildEditorStyle omits attribution when the manifest has none', () => {
    const style = buildEditorStyle('C-1', { ...MANIFEST, attribution: undefined }, 'V9');
    expect((style.sources[ORTHO_SOURCE_ID] as any).attribution).toBeUndefined();
});

test('terrain is not baked into the style — applied at runtime via setTerrain', () => {
    const style = buildEditorStyle('C-1', MANIFEST, 'V9');
    expect(style.terrain).toBeUndefined();
});
