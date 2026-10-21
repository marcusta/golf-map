// The look keys - what belongs to a zone item's model, not to the item - are listed once (VSP_LOOK_KEYS); Unity's
// twins must read the same keys: GolfMapVegPalette.LookRoles (+ the "mat:" roles = material) and the look reads of
// GolfMapGrass.Load / ResolveModel.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { VSP_LOOK_KEYS, ZONE_ITEM_KEYS } from './zone-models';

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
