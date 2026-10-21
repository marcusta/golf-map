// The look keys - what belongs to a zone item's model, not to the item - are listed once (VSP_LOOK_KEYS); Unity's
// twins must read the same keys: GolfMapVegPalette.LookRoles (+ the "mat:" roles = material) and the look reads of
// GolfMapGrass.Load / ResolveModel.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CourseModels, ModelLibrary } from './tree-models';
import { PALETTE_KEYS, VSP_LOOK_KEYS, ZONE_ITEM_KEYS, setModelLook, setPaletteKeys, setZoneItem, zoneModels, type ZonePaletteDoc } from './zone-models';

const EDITOR = path.resolve(import.meta.dir, '..', '..', 'unity', 'Editor', 'GolfMap');
const sorted = (keys: Iterable<string>) => [...new Set(keys)].sort();

test("Unity's look roles are VSP_LOOK_KEYS (material = the shader-float roles)", () => {
    const source = readFileSync(path.join(EDITOR, 'GolfMapVegPalette.cs'), 'utf8');
    const roles = /LookRoles = new HashSet<string> \{([^}]*)\}/.exec(source)![1]!.match(/"([^"]+)"/g)!.map((q) => q.slice(1, -1));
    expect(sorted([...roles, 'material'])).toEqual(sorted(VSP_LOOK_KEYS));
});

test("GolfMapGrass reads a zone item's look keys from the look, the rest from the item", () => {
    const source = readFileSync(path.join(EDITOR, 'GolfMapGrass.cs'), 'utf8');
    const fromLook = [...source.matchAll(/(?:look\.(?:String|Bool|Object|Number)\(|F\(look, )"([^"]+)"/g)].map((m) => m[1]!);
    expect(sorted(fromLook)).toEqual(sorted(VSP_LOOK_KEYS));
    const fromItem = [...source.matchAll(/F\(i, "([^"]+)"/g)].map((m) => m[1]!);
    expect(fromItem.length).toBeGreaterThan(0);
    for (const key of fromItem) expect(ZONE_ITEM_KEYS as readonly string[]).toContain(key);
});

const LIBRARY: ModelLibrary = {
    format: 'golfmap-models-v1',
    models: [
        { id: 'vsp:texture:Rustic Grass_15', renderer: 'vsp', form: 'grass', heightM: 0, crownWidthM: 0, look: { healthy: '#5e9154' } },
        { id: 'arborist:MountainEnv_bush_hazel_01', renderer: 'arborist', form: 'shrub', heightM: 2.4, crownWidthM: 2.1 },
        { id: 'arborist:CE_DA_Forest_Tree_16018', renderer: 'arborist', form: 'tree', kind: 'broadleaf', heightM: 20, crownWidthM: 12 },
    ],
};
const COURSE: CourseModels = { format: 'golfmap-models-v1', models: [] };
const PALETTES = (): ZonePaletteDoc => ({
    format: 'golfmap-grass-v1',
    palettes: [{ key: 'rough_tall', package: 'GolfMap lower vegetation', tintAreaScale: 30, distanceFalloff: 0.15, items: [
        { name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', sampleDistance: 0.4 },
        { name: 'Tall rough - gone', model: 'arborist:MountainEnv_bush_gone_01' },
        { name: 'Tall rough - no shape', model: 'not-an-id' },
    ] }],
});

test('a zone item whose model the library lacks is missing, with the renderer its id names; the others carry no missing', () => {
    const [p] = zoneModels(PALETTES(), LIBRARY);
    expect(p!.items).toEqual([
        { name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', renderer: 'vsp' },
        { name: 'Tall rough - gone', model: 'arborist:MountainEnv_bush_gone_01', renderer: 'arborist', missing: true },
        { name: 'Tall rough - no shape', model: 'not-an-id', renderer: '?', missing: true },
    ]);
    expect('missing' in p!.items[0]!).toBe(false);
});

test("models -- look refuses a placement or size key and points to models -- zone", () => {
    for (const key of [...ZONE_ITEM_KEYS, 'maxDensity']) {
        expect(() => setModelLook(COURSE, LIBRARY, 'vsp:texture:Rustic Grass_15', { [key]: 1 })).toThrow(/models -- zone/);
    }
    expect(setModelLook(COURSE, LIBRARY, 'vsp:texture:Rustic Grass_15', { randomDarkening: 0.3 }).look).toEqual({ healthy: '#5e9154', randomDarkening: 0.3 });
});

test('models -- zone --model refuses a model that is not lower vegetation, naming its form', () => {
    expect(() => setZoneItem(PALETTES(), 'rough_tall', 'Tall rough - green base', LIBRARY, { model: 'arborist:CE_DA_Forest_Tree_16018' }))
        .toThrow(/arborist:CE_DA_Forest_Tree_16018 is a broadleaf tree, not lower vegetation/);
    const { after } = setZoneItem(PALETTES(), 'rough_tall', 'Tall rough - green base', LIBRARY, { model: 'arborist:MountainEnv_bush_hazel_01' });
    expect(after.model).toBe('arborist:MountainEnv_bush_hazel_01');
});

test("a palette's own keys: set, removed with null, anything else refused; the items stay", () => {
    const { doc, report } = setPaletteKeys(PALETTES(), 'rough_tall', { tintAreaScale: 42, distanceFalloff: null, plantDistance: 250 });
    const [p] = doc.palettes;
    expect(p).toMatchObject({ key: 'rough_tall', tintAreaScale: 42, plantDistance: 250 });
    expect('distanceFalloff' in p!).toBe(false);
    expect(p!.items).toEqual(PALETTES().palettes[0]!.items);
    expect(report).toContain('  tintAreaScale: 30 -> 42');
    for (const key of ['sampleDistance', 'healthy', 'package', 'items']) expect(() => setPaletteKeys(PALETTES(), 'rough_tall', { [key]: 1 })).toThrow(/a zone palette holds only/);
    expect(() => setPaletteKeys(PALETTES(), 'rough_tall', { tintAreaScale: '#ffffff' })).toThrow(/must be a number/);
    expect(() => setPaletteKeys(PALETTES(), 'nope', { tintAreaScale: 1 })).toThrow(/No zone palette 'nope'/);
});

test("GolfMapGrass reads the palette's own keys from the palette (PALETTE_KEYS)", () => {
    const source = readFileSync(path.join(EDITOR, 'GolfMapGrass.cs'), 'utf8');
    const fromPalette = [...source.matchAll(/(?:p\.Number\(|F\(p, )"([^"]+)"/g)].map((m) => m[1]!);
    expect(sorted(fromPalette)).toEqual(sorted(PALETTE_KEYS));
});
