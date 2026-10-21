// Acceptance A1 and A3, run for real against the open Omberg editor (unity/mcp/bridge.ts) and the
// app's own Arborist writer (bun run gspro:export -- <course> arborist), into a scratch Arborist folder.
// It plants Omberg's inner trees; that planting is the one the course wants anyway. A3 removes its
// own tree edits and plants again afterwards.
//
//   bun test unity/acceptance/models-in-the-scene.test.ts      (Unity open on Omberg_lidar_scene)
//
// Placements: <export folder>/<prefix>-<terrain>-placements.json, golfmap-placements-v1, listed by
// golfmap.course under exports['inner-placements']. Arborist ids: arboristdata.ids.json beside the
// .dat (golfmap-arborist-ids-v1): every placement Arborist was handed, drawn or left out by the
// routing policy, with its tree id.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickBridge, run, type BridgeInfo } from '../mcp/bridge';

const REPO = path.resolve(import.meta.dir, '..', '..');
const COURSE = 'Ombergs Golfklubb';
const SQUARE_SW = { x: -1745, z: -1745 };          // Omberg's terrains square (outer 5000 m at -1745)
const S7_ELM_HEIGHT_M = 11.1583967;                 // data/arborist/catalog-sizes.json, first LOD
const BEECH = ['Forest_Large_beech_tree_03', 'Forest_Large_beech_tree_04', 'Forest_Large_beech_tree_05',
    'CE_DA_Forest_Tree_16018', 'CE_DA_Forest_Tree_18195', 'CE_DA_Forest_Tree_11164'];
const ELM = ['S7_American_Elm', 'CE_Oak_CE_Tall_Fanned_1', 'CE_Oak_CE_Tall_Fanned_2', 'CE_Oak_CE_Tall_Fanned_3'];
const ARBORIST_ONLY = [...BEECH, ...ELM];
const STAND_INS = ['Elm4-Tall PREFAB', 'Elm-Split PREFAB', 'Elm', 'Broadleaf Balanced'];
const GREEN_1 = { x: 790.6, z: 556 };

interface Placement { id: string; model: string; species: string; x: number; y: number; z: number; rotationY: number; scale: number }
interface ArboristIds { drawn: { id: string; model: string; item: string; x: number; z: number }[]; leftOut: { id: string; model: string; reason: string }[] }
interface DatTrees { items: { name: string; tint: string | null; barkTint: string | null }[]; instances: { item: string; x: number; y: number; z: number; yawDeg: number; scaleY: number }[] }

let unity: BridgeInfo;
const label = (model: string) => model.replace(/^arborist:/, '');
const isArboristOnly = (model: string) => ARBORIST_ONLY.includes(label(model));

async function placements(): Promise<Placement[]> {
    const course = await run(unity, 'golfmap.course', {});
    const file = course.active.exports['inner-placements']?.path;
    expect(file).toBeTruthy();
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.format).toBe('golfmap-placements-v1');
    return doc.placements;
}

/** Plant the inner trees, write the Arborist file into a scratch folder, read back all three sides. */
async function plantAndWrite() {
    await run(unity, 'golfmap.trees.plant', { terrain: 'inner', save: true }, 600);
    const out = mkdtempSync(path.join(os.tmpdir(), 'arborist-models-'));
    const proc = Bun.spawnSync(['bun', 'run', 'gspro:export', '--', COURSE, 'arborist', '--arborist-out', out], { cwd: REPO });
    expect(proc.exitCode).toBe(0);
    const python = path.join(REPO, 'pipeline', '.venv', 'Scripts', 'python.exe');
    const dat = Bun.spawnSync([python, path.join(REPO, 'pipeline', 'tests', 'acceptance', 'dat_instances.py'),
        path.join(out, 'arboristdata.dat'), String(SQUARE_SW.x), String(SQUARE_SW.z)], { cwd: path.join(REPO, 'pipeline') });
    expect(dat.exitCode).toBe(0);
    return {
        placements: await placements(),
        ids: JSON.parse(readFileSync(path.join(out, 'arboristdata.ids.json'), 'utf8')) as ArboristIds & { format: string },
        arborist: JSON.parse(dat.stdout.toString()) as DatTrees,
        stored: (await run(unity, 'golfmap.vsp.trees.stored', {})) as { items: Record<string, number> },
    };
}

beforeAll(() => {
    unity = pickBridge('omberg');   // throws when no Omberg editor answers: this test needs the real one
});

describe('A1: beech and elm are drawn by Arborist, oak by the course VSP', () => {
    test('every beech and elm placement reaches Arborist exactly once, none is in VSP', async () => {
        const { placements, ids, arborist, stored } = await plantAndWrite();

        const beech = placements.filter(p => p.species === 'beech');
        const elm = placements.filter(p => p.species === 'elm');
        expect(beech.length).toBeGreaterThan(100);
        expect(elm.length).toBeGreaterThan(20);
        expect(beech.every(p => BEECH.includes(label(p.model)))).toBe(true);
        expect(elm.every(p => ELM.includes(label(p.model)))).toBe(true);
        expect(placements.filter(p => p.species === 'oak').every(p => p.model.startsWith('vsp:PF_Oak'))).toBe(true);

        // The course's VSP holds no beech or elm, and no stand-in prefab; it still draws the Forst oaks.
        const storedNames = Object.keys(stored.items);
        expect(storedNames.filter(n => STAND_INS.includes(n) || ARBORIST_ONLY.some(l => n.includes(l)))).toEqual([]);
        expect(storedNames.filter(n => n.startsWith('PF_Oak')).reduce((sum, n) => sum + stored.items[n]!, 0)).toBeGreaterThan(0);

        // Arborist: every beech and elm placement once, drawn or left out by the routing policy, by tree id.
        expect(ids.format).toBe('golfmap-arborist-ids-v1');
        // (Arborist is also handed the outer terrain's trees since they are routed; this compares the inner ones.)
        const inner = new Set(placements.map(p => p.id));
        const handed = [...ids.drawn, ...ids.leftOut].filter(e => isArboristOnly(e.model) && inner.has(e.id));
        expect(handed.map(e => e.id).sort()).toEqual([...beech, ...elm].map(p => p.id).sort());
        expect(ids.leftOut.every(e => e.reason.length > 0)).toBe(true);
        for (const e of ids.drawn.filter(e => isArboristOnly(e.model) && inner.has(e.id))) {
            const p = placements.find(q => q.id === e.id)!;
            expect(e.model).toBe(p.model);
            expect(Math.abs(e.x - p.x) < 0.01 && Math.abs(e.z - p.z) < 0.01).toBe(true);
        }
        // ... and the .dat holds exactly those, at those places.
        for (const l of ARBORIST_ONLY) {
            const inDat = arborist.instances.filter(i => i.item.startsWith(l));
            const drawn = ids.drawn.filter(e => label(e.model) === l);
            expect(inDat.length).toBe(drawn.length);
            for (const e of drawn) expect(inDat.some(i => Math.abs(i.x - e.x) < 0.01 && Math.abs(i.z - e.z) < 0.01)).toBe(true);
        }
    }, 900_000);
});

describe('A3: a tree edit can move a tree to the other renderer', () => {
    const edited: string[] = [];

    afterAll(async () => {
        for (const id of edited) await run(unity, 'golfmap.trees.edit', { terrain: 'inner', id, op: 'revert' });
        if (edited.length) await plantAndWrite();
    }, 900_000);

    test('a Forst oak by green 1 becomes the darkened S7 elm, 16 m, turned 40 degrees, 2 m east', async () => {
        const before = await placements();
        const oaks = before.filter(p => p.species === 'oak' && p.model.startsWith('vsp:'));
        const t = oaks.reduce((a, b) => Math.hypot(a.x - GREEN_1.x, a.z - GREEN_1.z) <= Math.hypot(b.x - GREEN_1.x, b.z - GREEN_1.z) ? a : b);
        const oldItem = t.model.replace(/^vsp:/, '');
        await run(unity, 'golfmap.trees.edit', { terrain: 'inner', id: t.id, op: 'modify', model: 'arborist:S7_American_Elm', heightM: 16, rotationY: 40, x: t.x + 2, z: t.z });
        edited.push(t.id);

        const { placements: after, ids, arborist } = await plantAndWrite();
        const p = after.find(q => q.id === t.id)!;
        expect(p.model).toBe('arborist:S7_American_Elm');
        expect(p.x).toBeCloseTo(t.x + 2, 2);
        expect(p.z).toBeCloseTo(t.z, 2);
        expect(p.rotationY).toBeCloseTo(40, 1);

        // Gone from VSP where the oak stood ...
        const near = await run(unity, 'golfmap.vsp.trees.stored', { near: [t.x, t.z], radiusM: 0.5 }) as { instances: { item: string }[] };
        expect(near.instances.filter(i => i.item === oldItem)).toEqual([]);
        // ... and once in Arborist, by its tree id, as the elm Marcus approved.
        expect(ids.drawn.filter(e => e.id === t.id)).toHaveLength(1);
        const inDat = arborist.instances.filter(i => i.item.startsWith('S7_American_Elm') && Math.abs(i.x - (t.x + 2)) < 0.01 && Math.abs(i.z - t.z) < 0.01);
        expect(inDat).toHaveLength(1);
        expect(Math.abs(((inDat[0]!.yawDeg - 40 + 540) % 360) - 180)).toBeLessThan(0.5);
        expect(inDat[0]!.scaleY * S7_ELM_HEIGHT_M).toBeCloseTo(16, 1);
        const item = arborist.items.find(i => i.name === inDat[0]!.item)!;
        expect(item.tint).toBe('#868c90');
        expect(item.barkTint).toBe('#6e6862');
    }, 900_000);

    test('an added tree that names only its species and size gets the elm model of that size', async () => {
        const added = await run(unity, 'golfmap.trees.edit', { terrain: 'inner', op: 'add', x: 801, z: 640, species: 'elm', heightM: 16.8, crownWidthM: 17.9 }) as { id: string };
        edited.push(added.id);
        const { placements: after, ids } = await plantAndWrite();
        const p = after.find(q => q.id === added.id)!;
        expect(p.model).toBe('arborist:CE_Oak_CE_Tall_Fanned_2');
        expect(ids.drawn.filter(e => e.id === added.id)).toHaveLength(1);
    }, 900_000);
});
