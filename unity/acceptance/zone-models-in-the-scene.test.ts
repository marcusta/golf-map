// Acceptance C1 and C2 (Unity half), zone palettes on the model library: after Update vegetation, the course's
// own VSP lower-vegetation package holds exactly the zone items whose model is a vsp model, Arborist's holds
// exactly those whose model is an arborist model, and each VSP item wears its model's look. Run for real against
// the open Omberg editor (unity/mcp/bridge.ts) and the app's own export; it plants Omberg's inner lower
// vegetation (--force: the whole import and apply), which is what the course wants anyway.
//
//   bun test unity/acceptance/zone-models-in-the-scene.test.ts      (Unity open on Omberg_lidar_scene)
//
// The zone palettes (grass-palette.json) refer to models ({"name", "model", placement and size keys}); a model's
// renderer decides who draws the item (pipeline/tests/acceptance/test_zone_models_omberg.py has the format).
// Unity's copy of grass-palette.json is generated from the repo's like models.json and palette.json
// (`bun run models -- sync`). golfmap.vsp lists a package's mesh items as "plants" ({name, spawning, prefab})
// beside its texture items ("grass"); a distance copy is "<item> @<m>m", a height twin "<item> @height".
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickBridge, run, type BridgeInfo } from '../mcp/bridge';
import { loadModelLibrary } from '../../shared/vegetation/tree-models';

const REPO = path.resolve(import.meta.dir, '..', '..');
const COURSE = 'Ombergs Golfklubb';
const DOCS = path.join(REPO, 'docs', 'gspro', 'ombergs-golfklubb');
const ZONES = 'D:/gspro_courses/omberg-opcd/ombergs-golfklubb-inner-zones.json';
const LOWER = 'GolfMap lower vegetation';

interface ZoneItem { name: string; model: string }
interface Palette { palettes: { key: string; items: ZoneItem[] }[]; prefabItems?: unknown; prefabItemsInVsp?: unknown }
interface VspPackage { name: string; grass: { name: string }[]; plants?: { name: string; prefab: string }[] }

let unity: BridgeInfo;

function sh(cmd: string[]) {
    const p = Bun.spawnSync(cmd, { cwd: REPO });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const baseName = (name: string) => name.replace(/ @(\d+(\.\d+)?m|height)$/, '');

beforeAll(() => {
    unity = pickBridge('omberg');   // throws when no Omberg editor answers: this test needs the real one
});

describe('C1 + C2: each zone item is drawn by its model renderer, wearing its model look', () => {
    test('Update vegetation: VSP holds the vsp models items, Arborist the arborist models, nothing twice', async () => {
        const palette = JSON.parse(readFileSync(path.join(DOCS, 'grass-palette.json'), 'utf8')) as Palette;
        expect(palette.prefabItems).toBeUndefined();
        expect(palette.prefabItemsInVsp).toBeUndefined();
        const byId = new Map(loadModelLibrary(DOCS).models.map((m) => [m.id, m]));
        const items = palette.palettes.flatMap((p) => p.items);
        for (const item of items) expect(byId.has(item.model)).toBe(true);
        const renderer = (item: ZoneItem) => byId.get(item.model)!.renderer;

        const out = mkdtempSync(path.join(os.tmpdir(), 'zone-models-'));
        const updated = sh(['bun', 'run', 'gspro:export', '--', COURSE, 'vegetation:inner', '--force', '--arborist-out', out]);
        expect(updated.code).toBe(0);

        // Unity's palette is the repo's.
        const listed = await run(unity, 'golfmap.vegpalette.list', {}) as { grassPalette: string; entries: { name: string; kind: string; values: Record<string, unknown> }[] };
        const unityPalette = JSON.parse(readFileSync(path.join(unity.projectPath, listed.grassPalette), 'utf8'));
        expect(unityPalette).toEqual(palette);

        // VSP: exactly the vsp models' items (with their distance copies and height twins), as grass or as plants.
        const systems = await run(unity, 'golfmap.vsp', {}) as { packages: VspPackage[] }[];
        const lower = systems.flatMap((s) => s.packages).filter((p) => p.name === LOWER);
        expect(lower.length).toBe(1);
        const plants = lower[0]!.plants ?? [];
        const inVsp = new Set([...lower[0]!.grass.map((g) => baseName(g.name)), ...plants.map((p) => baseName(p.name))]);
        const vspItems = items.filter((i) => renderer(i) === 'vsp');
        expect([...inVsp].sort()).toEqual([...new Set(vspItems.map((i) => i.name))].sort());
        // A mesh item draws its model's prefab, or the course-local copy with the model's material floats.
        const wrongPrefab = plants.filter((p) => baseName(p.name) === p.name).flatMap((plant) => {
            const model = byId.get(vspItems.find((i) => i.name === plant.name)!.model)!;
            const ok = plant.prefab === model.unity?.path || plant.prefab.endsWith(`/Grass/Prefabs/${plant.name}.prefab`);
            return ok ? [] : [`${plant.name}: ${plant.prefab} is not ${model.id}'s ${model.unity?.path}`];
        });
        expect(wrongPrefab).toEqual([]);

        // Arborist: exactly the arborist models' items the zones export places; none of VSP's.
        const zoned = new Set((JSON.parse(readFileSync(ZONES, 'utf8')) as { items: { item: string }[] }).items.map((r) => r.item));
        const dump = sh(['pipeline/.venv/Scripts/python.exe', '-c',
            'import sys, json; sys.path.insert(0, "pipeline/tests/acceptance"); from lower_digest import lower_package; '
            + `print(json.dumps([i["Name"] for i in lower_package(r"${path.join(out, 'arboristdata.dat')}")["VegetationInfoList"]]))`]);
        expect(dump.code).toBe(0);
        const inArborist = JSON.parse(dump.out.trim().split('\n').pop()!) as string[];
        const arboristItems = items.filter((i) => renderer(i) === 'arborist' && zoned.has(i.name)).map((i) => i.name);
        expect(arboristItems.length).toBeGreaterThan(0);
        expect([...inArborist].sort()).toEqual([...new Set(arboristItems)].sort());
        expect(inArborist.filter((n) => inVsp.has(n))).toEqual([]);

        // C2: every VSP item wears its model's colours (the look is set once, on the model).
        const entry = new Map(listed.entries.map((e) => [e.name, e]));
        for (const item of vspItems) {
            const look = byId.get(item.model)!.look ?? {};
            for (const key of ['healthy', 'dry'] as const) {
                if (look[key] === undefined) continue;
                expect(`${item.name} ${key} ${entry.get(item.name)?.values[key]}`).toBe(`${item.name} ${key} ${look[key]}`);
            }
        }
    }, 1_800_000);
});
