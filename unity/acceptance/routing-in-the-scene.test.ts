// Acceptance B1 and B3 (model library, second delivery): the routing policy decides before planting,
// so the course's VSP never takes a tree Arborist draws and nothing is trimmed afterwards.
// Run for real against the open Omberg editor (unity/mcp/bridge.ts) and the app's own exports;
// it routes and plants Omberg's inner trees, which is the planting the course wants anyway.
//
//   bun test unity/acceptance/routing-in-the-scene.test.ts      (Unity open on Omberg_lidar_scene)
//
// Routing: `bun run arborist -- route <course>` writes <export>/<prefix>-<terrain>-routing.json
// (golfmap-routing-v1: routes {treeId: "own" | "billboard" | "out"}, listed by golfmap.course as
// exports['inner-routing']): "own" = drawn by its model's renderer, "billboard" = Arborist billboard
// whatever the model, "out" = left out (outerKeep). The rules are the course's vegetation-rules.json `routing`.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickBridge, run, type BridgeInfo } from '../mcp/bridge';

const REPO = path.resolve(import.meta.dir, '..', '..');
const COURSE = 'Ombergs Golfklubb';
const SPECIES_FILE = path.join(REPO, 'docs', 'gspro', 'ombergs-golfklubb', 'arborist-species.json');
const LEGACY_TRIM_FILE = path.join(REPO, 'data', 'arborist', 'ombergs-golfklubb-vsp-far.json');
// Prefabs of the species that are Arborist models from this delivery on (they must never be in VSP).
const MOVED_PREFABS = /Poplar|Forest_pine|Fir_0|dwarf_pine/;

interface Placement { id: string; model: string; species: string; x: number; z: number }
interface ArboristIds { drawn: { id: string; model: string }[]; leftOut: { id: string; model: string; reason: string }[] }

let unity: BridgeInfo;

function sh(cmd: string[]) {
    const p = Bun.spawnSync(cmd, { cwd: REPO });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

async function exportPath(key: string): Promise<string> {
    const course = await run(unity, 'golfmap.course', {});
    const file = course.active.exports[key]?.path;
    expect(file).toBeTruthy();
    return file;
}

beforeAll(() => {
    unity = pickBridge('omberg');   // throws when no Omberg editor answers: this test needs the real one
});

describe('B1 + B3: Omberg routes before planting, no trim, one renderer per tree', () => {
    test('route, plant and write Arborist: every placement drawn exactly once, poplars/pines/firs only in Arborist', async () => {
        const trimBefore = existsSync(LEGACY_TRIM_FILE) ? statSync(LEGACY_TRIM_FILE).mtimeMs : null;

        const routed = sh(['bun', 'run', 'arborist', '--', 'route', COURSE]);
        expect(routed.code).toBe(0);
        await run(unity, 'golfmap.trees.plant', { terrain: 'inner', save: true }, 600);
        const out = mkdtempSync(path.join(os.tmpdir(), 'arborist-routing-'));
        const exported = sh(['bun', 'run', 'gspro:export', '--', COURSE, 'arborist', '--arborist-out', out]);
        expect(exported.code).toBe(0);

        // No trim: the export asks for none and the legacy trim list is not written.
        expect(exported.out).not.toContain('golfmap.vsp.trees.trim');
        expect(existsSync(LEGACY_TRIM_FILE) ? statSync(LEGACY_TRIM_FILE).mtimeMs : null).toBe(trimBefore);

        const routing = JSON.parse(readFileSync(await exportPath('inner-routing'), 'utf8')) as { format: string; routes: Record<string, string> };
        expect(routing.format).toBe('golfmap-routing-v1');
        const placements = (JSON.parse(readFileSync(await exportPath('inner-placements'), 'utf8')) as { placements: Placement[] }).placements;
        const ids = JSON.parse(readFileSync(path.join(out, 'arboristdata.ids.json'), 'utf8')) as ArboristIds;
        const stored = (await run(unity, 'golfmap.vsp.trees.stored', {})) as { items: Record<string, number>; total: number };

        // Every placement is routed.
        for (const p of placements) expect(['own', 'billboard', 'out']).toContain(routing.routes[p.id]);

        // The course's VSP holds exactly the vsp models routed "own", item by item.
        const inVsp = placements.filter(p => p.model.startsWith('vsp:') && routing.routes[p.id] === 'own');
        const wanted: Record<string, number> = {};
        for (const p of inVsp) { const item = p.model.slice(4); wanted[item] = (wanted[item] ?? 0) + 1; }
        expect(stored.items).toEqual(wanted);
        expect(stored.total).toBe(inVsp.length);

        // Arborist is handed every other placement, once, drawn or left out; none of the VSP ones.
        const vspIds = new Set(inVsp.map(p => p.id));
        const handed = [...ids.drawn, ...ids.leftOut].map(e => e.id);
        expect(new Set(handed).size).toBe(handed.length);
        expect(handed.filter(id => vspIds.has(id))).toEqual([]);
        expect(handed.sort()).toEqual(placements.filter(p => !vspIds.has(p.id)).map(p => p.id).sort());
        // ... and left out exactly where the routing said "out".
        expect(ids.leftOut.map(e => e.id).sort()).toEqual(placements.filter(p => routing.routes[p.id] === 'out').map(p => p.id).sort());

        // B3: poplars, pines and firs are Arborist models; none is in VSP, none is hidden there either.
        const moved = placements.filter(p => ['poplar', 'pine', 'conifer'].includes(p.species));
        expect(moved.length).toBeGreaterThan(300);
        expect(moved.every(p => p.model.startsWith('arborist:'))).toBe(true);
        expect(Object.keys(stored.items).filter(n => MOVED_PREFABS.test(n))).toEqual([]);
        const vsp = await run(unity, 'golfmap.vsp.trees', {}) as { hiddenItems: string[] }[];
        expect(vsp.flatMap(s => s.hiddenItems ?? [])).toEqual([]);
        for (const species of ['poplar', 'pine', 'conifer']) {
            const placed = moved.filter(p => p.species === species).map(p => p.id).sort();
            const inArborist = handed.filter(id => placed.includes(id)).sort();
            expect(inArborist).toEqual(placed);
        }

        // The species file keeps looks only: no keep list, no prefab-to-Arborist mapping.
        const speciesFile = JSON.parse(readFileSync(SPECIES_FILE, 'utf8')) as Record<string, unknown>;
        expect(speciesFile.vsp).toBeUndefined();
        expect(speciesFile.trees).toBeUndefined();
        expect(speciesFile.billboardBeyondM).toBeUndefined();
        expect(speciesFile.outerKeep).toBeUndefined();
    }, 900_000);
});
