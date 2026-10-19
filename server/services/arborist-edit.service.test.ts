import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { defaultRunner, venvPython } from './gspro-export.service';
import {
    ArboristEditService, orientation, treeItemId, modelItem, type ArboristPlayer, type Placement, type TreeModel,
} from './arborist-edit.service';

/**
 * The Arborist edit loop for real: `pipeline/arborist.py edit` (the venv's Python) and its wrapper
 * (PowerShell 7) patch a course file here, with a key of the tests' own. Arborist itself is a stand-in
 * that answers the mod's commands and records them: the live change is its business, the files ours.
 */
const PIPELINE = path.resolve(import.meta.dir, '..', '..', 'pipeline');
const PYTHON = venvPython(PIPELINE);
function pythonStartsPwsh(): boolean {
    const probe = "import subprocess, sys; sys.exit(subprocess.run(['pwsh', '-NoProfile', '-Command', 'exit 0']).returncode)";
    try {
        return Bun.spawnSync([PYTHON, '-c', probe], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
    } catch {
        return false;
    }
}
const MISSING = !existsSync(PYTHON) ? `the pipeline venv (${PYTHON})` : !pythonStartsPwsh() ? 'PowerShell 7 (pwsh) on PATH' : '';
if (MISSING) console.warn(`arborist-edit.service.test: skipped, it needs ${MISSING}`);
const real = defaultRunner(PYTHON);
const t = MISSING ? test.skip : test;

const BUSH: TreeModel = { id: 'arborist:CE_Plants_buckthorn-bush', species: 'bush', renderer: 'arborist', heightM: 4, crownWidthM: 3, kind: 'broadleaf', form: 'shrub', look: { tint: '#4f5e44', saturation: 0.6 } };
const ELM: TreeModel = { id: 'arborist:S7_American_Elm', species: 'elm', renderer: 'arborist', heightM: 12, crownWidthM: 14, kind: 'broadleaf', form: 'tree' };
const OAK: TreeModel = { id: 'vsp:PF_Oak_small Terrain', species: 'oak', renderer: 'vsp', heightM: 10, crownWidthM: 8, kind: 'broadleaf', form: 'tree' };
const BUSH_ITEM = modelItem(BUSH);   // 'CE_Plants_buckthorn-bush [tint=#4f5e44,saturation=0.6]'
const ELM_ITEM = modelItem(ELM);

/** Inner terrain 200 m at the origin, outer 400 m round it: the square is (-100, -100)..(300, 300), 4 x 4 cells. */
const X0 = -100;

function placement(id: string, model: TreeModel, x: number, z: number, scale: number, yaw = 30): Placement {
    return {
        id, model: model.id, species: model.species, renderer: model.renderer, x, y: 10, z, rotationY: yaw, leanDeg: 2, leanDirectionY: 90,
        scale, widthScale: scale, q: orientation(yaw, 2, 90), heightM: model.heightM * scale, crownWidthM: model.crownWidthM * scale,
    };
}

const instance = (p: Placement) => ({
    Position: { x: p.x - X0, y: p.y, z: p.z - X0 }, Scale: { x: p.scale, y: p.scale, z: p.scale },
    Rotation: { x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] }, VegetationSourceID: 42, DistanceFalloff: 1,
});

const cellOf = (x: number, z: number) => Math.floor((x - X0) / 100) * 4 + Math.floor((z - X0) / 100);

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arborist-edit-'));
    const dirs = { data: path.join(root, 'data'), docs: path.join(root, 'docs'), exportDir: path.join(root, 'export'), courseDir: path.join(root, 'Courses', 'Linkan_scene') };
    for (const dir of [path.join(dirs.data, 'arborist'), path.join(dirs.docs, 'linkan'), dirs.exportDir, dirs.courseDir]) await mkdir(dir, { recursive: true });
    const key = path.join(dirs.data, 'arborist-wrapper.key');
    await writeFile(key, crypto.getRandomValues(new Uint8Array(16)));

    const bush = placement('epsg3006:1.50:2.50', BUSH, 95, 40, 0.6);       // 5 m west of a cell edge
    const elm = placement('epsg3006:3.50:4.50', ELM, 150, 150, 1.1);
    const oak = placement('epsg3006:5.50:6.50', OAK, 20, 20, 0.8);
    const added = placement('manual:abc123def456', BUSH, 60, 60, 0.5);
    await writeFile(path.join(dirs.exportDir, 'linkan-inner-placements.json'),
        `{"format":"golfmap-placements-v1","course":"Linkan","terrain":"inner","trees":"linkan-inner-trees.json","placements":[\n${[oak, bush, elm, added].map(p => JSON.stringify(p)).join(',\n')}]}`);
    await writeFile(path.join(dirs.exportDir, 'linkan-inner-trees.json'), JSON.stringify({
        format: 'unity-trees-v1', trees: [{ id: bush.id, x: 95.5, z: 40.5, h: 2.1, r: 1.0, k: 0, bush: true }, { id: elm.id, x: 150, z: 150, h: 13, r: 7, k: 0, bush: false }],
    }));
    const other = { id: 'epsg3006:9.50:9.50', op: 'delete', ox: 1, oz: 1, x: 0, z: 0, h: 0, r: 0, k: 0, bush: false, species: '', guid: '', model: '', sized: false, rotation: 0, rotationSet: false, dy: 0 };
    const addRecord = { ...other, id: added.id, op: 'add', ox: 60, oz: 60, x: 60, z: 60, h: 2, r: 0.75, bush: true, species: 'bush', model: BUSH.id, sized: true };
    await writeFile(path.join(dirs.exportDir, 'linkan-inner-tree-edits.json'), JSON.stringify({ format: 'golfmap-tree-edits-v1', trees: 'linkan-inner-trees.json', edits: [other, addRecord] }, null, 4));
    await writeFile(path.join(dirs.exportDir, 'linkan-inner-dem-200m.tif.json'), JSON.stringify({ sideM: 200, unity: { position: { x: 0, y: 0, z: 0 } } }));
    await writeFile(path.join(dirs.exportDir, 'linkan-outer-dem-400m.tif.json'), JSON.stringify({ sideM: 400, unity: { position: { x: -100, y: -3, z: -100 } } }));
    await writeFile(path.join(dirs.docs, 'linkan', 'models.json'), JSON.stringify({ format: 'golfmap-models-v1', models: [BUSH, ELM, OAK] }));
    await writeFile(path.join(dirs.docs, 'linkan', 'arborist-species.json'), JSON.stringify({ treeSettings: [] }));
    await writeFile(path.join(dirs.data, 'arborist', 'GolfMap library.biome'), JSON.stringify({ VegetationInfoList: [
        { Name: 'CE_Plants_buckthorn-bush', VegetationItemID: 'lib-bush', VegetationType: 'Plant' },
        { Name: 'S7_American_Elm', VegetationItemID: 'lib-elm', VegetationType: 'Tree', BillboardTexture: 'baked' },
    ] }));

    // The course file: the bush and the added bush as the buckthorn item, the elm not yet an item (it is left out of the ids too).
    const trees = [bush, added];
    const cells = new Map<number, any>();
    for (const p of trees) {
        const index = cellOf(p.x, p.z);
        const cell = cells.get(index) ?? { cellIndex: index, cellRect: { x: X0 + Math.floor((p.x - X0) / 100) * 100, y: X0 + Math.floor((p.z - X0) / 100) * 100, width: 100, height: 100 }, PersistentVegetationInfoList: [{ VegetationItemID: treeItemId(BUSH_ITEM), VegetationItemList: [] }] };
        cell.PersistentVegetationInfoList[0].VegetationItemList.push(instance(p));
        cells.set(index, cell);
    }
    const doc = {
        VSProSettings: { totalPrefabs: 1, vegetationPackages: [{ PackageName: 'GolfMap trees', VegetationInfoList: [{ Name: BUSH_ITEM, VegetationItemID: treeItemId(BUSH_ITEM) }] }] },
        PersistentVegetationPackage: { PersistentVegetationCellList: [...cells.values()] },
    };
    const json = path.join(root, 'base.json');
    await writeFile(json, JSON.stringify(doc));
    const enc = await real([path.join(PIPELINE, 'arborist.py'), 'encode', json, path.join(dirs.courseDir, 'arboristdata.dat'), '--key-file', key], PIPELINE);
    expect(enc.stderr + enc.code).toBe('0');
    await writeFile(path.join(dirs.courseDir, 'arboristdata.ids.json'), JSON.stringify({
        format: 'golfmap-arborist-ids-v1',
        drawn: [{ id: bush.id, model: BUSH.id, item: BUSH_ITEM, x: bush.x, z: bush.z }, { id: added.id, model: BUSH.id, item: BUSH_ITEM, x: added.x, z: added.z }],
        leftOut: [{ id: elm.id, model: ELM.id, reason: 'outside the terrains' }],
    }));

    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const reloads: string[] = [];
    const arborist = {
        missing: new Set<string>(),
        async call(command: string, args: Record<string, unknown> = {}) {
            calls.push({ command, args });
            if (command === 'ground') return { hit: true, y: 12.5, object: 'Terrain (Inner)' };
            if (command === 'veg.pick') return { point: [0.5, 0.5], instances: [{ item: 'Some grass', itemId: 'grass', position: [95, 10, 40], distance: 20 }, { item: 'CE_Plants_buckthorn-bush', itemId: treeItemId(BUSH_ITEM), position: [95.01, 10, 40], distance: 21 }] };
            if (command === 'veg.picked') return { picker: true, marked: { item: 'CE_Plants_buckthorn-bush', itemId: treeItemId(BUSH_ITEM), position: [60, 10, 60], distance: 9, when: '01:02:03' } };
            if (command === 'veg.edit') {
                const wanted = String(args.as ?? args.item);
                if (arborist.missing.has(wanted)) throw new Error(`The system has no item '${wanted}' (a new item needs the file reloaded).`);
                return { ms: 4 };
            }
            throw new Error(`no command ${command}`);
        },
    } satisfies ArboristPlayer & { missing: Set<string> };
    let up = true;
    const svc = new ArboristEditService({
        dataDir: dirs.data, pipelineDir: PIPELINE, courseDocsRoot: dirs.docs, runner: real,
        player: async () => (up ? arborist : null),
        reload: async (_player, scene) => { reloads.push(scene); return `reloaded ${scene}`; },
    });
    const course = { name: 'Linkan', exportDir: dirs.exportDir, courseDir: dirs.courseDir };
    const read = async () => {
        const dec = path.join(root, `dec-${Date.now()}.json`);
        const r = await real([path.join(PIPELINE, 'arborist.py'), 'decode', path.join(dirs.courseDir, 'arboristdata.dat'), dec, '--key-file', key], PIPELINE);
        expect(r.stderr + r.code).toBe('0');
        const doc = JSON.parse(await readFile(dec, 'utf8'));
        const byItem = new Map<string, { cell: number; x: number; z: number; y: number; sy: number; sx: number; q: number[] }[]>();
        for (const cell of doc.PersistentVegetationPackage.PersistentVegetationCellList) {
            for (const info of cell.PersistentVegetationInfoList) {
                for (const i of info.VegetationItemList) {
                    const list = byItem.get(info.VegetationItemID) ?? [];
                    list.push({ cell: cell.cellIndex, x: Math.round((i.Position.x + X0) * 1000) / 1000, z: Math.round((i.Position.z + X0) * 1000) / 1000, y: i.Position.y, sy: i.Scale.y, sx: i.Scale.x, q: [i.Rotation.x, i.Rotation.y, i.Rotation.z, i.Rotation.w] });
                    byItem.set(info.VegetationItemID, list);
                }
            }
        }
        return {
            byItem, items: doc.VSProSettings.vegetationPackages[0].VegetationInfoList.map((i: any) => i.Name) as string[],
            ids: JSON.parse(await readFile(path.join(dirs.courseDir, 'arboristdata.ids.json'), 'utf8')),
            placements: JSON.parse(await readFile(path.join(dirs.exportDir, 'linkan-inner-placements.json'), 'utf8')).placements as Placement[],
            edits: JSON.parse(await readFile(path.join(dirs.exportDir, 'linkan-inner-tree-edits.json'), 'utf8')).edits as any[],
        };
    };
    return { ...dirs, svc, course, calls, reloads, arborist, read, bush, elm, oak, added, down: () => { up = false; } };
}

t('a move is made live first and then saved everywhere: across a cell edge in the .dat, and as a tree edit for Unity', async () => {
    const f = await fixture();
    const r = await f.svc.edit(f.course, { id: f.bush.id }, { op: 'move', by: [8, 1] });

    // Live: the instance found where it stands, put where it goes, on Arborist's own ground.
    const live = f.calls.filter(c => c.command === 'veg.edit');
    expect(live).toEqual([{ command: 'veg.edit', args: {
        system: '/ArbVegetationStudioPro', item: treeItemId(BUSH_ITEM), at: [95, 10, 40],
        position: [103, 12.5, 41], scale: [0.6, 0.6, 0.6], rotation: f.bush.q,
    } }]);
    expect(f.calls.find(c => c.command === 'ground')).toEqual({ command: 'ground', args: { x: 103, z: 41 } });
    expect(r.live.done).toBe(true);
    expect(r.after?.position).toEqual([103, 12.5, 41]);

    const after = await f.read();
    expect(after.byItem.get(treeItemId(BUSH_ITEM))!.map(i => [i.cell, i.x, i.z, i.y])).toEqual(
        [[cellOf(60, 60), 60, 60, 10], [cellOf(103, 41), 103, 41, 12.5]]);
    expect(cellOf(103, 41)).not.toBe(cellOf(95, 40));
    expect(after.ids.drawn.find((d: any) => d.id === f.bush.id)).toEqual({ id: f.bush.id, model: BUSH.id, item: BUSH_ITEM, x: 103, z: 41 });
    const moved = after.placements.find(p => p.id === f.bush.id)!;
    expect([moved.x, moved.y, moved.z, moved.scale, moved.heightM]).toEqual([103, 12.5, 41, 0.6, 2.4]);
    expect(after.placements.map(p => p.id)).toEqual([f.oak.id, f.bush.id, f.elm.id, f.added.id]);   // the file keeps its order

    // The tree edit: its drawn size and model, in terrain-local metres, original position from the survey.
    const record = after.edits.find(e => e.id === f.bush.id);
    expect(record).toEqual({
        id: f.bush.id, op: 'modify', ox: 95.5, oz: 40.5, x: 103, z: 41, h: 2.4, r: 0.9, k: 0, bush: true,
        species: 'bush', guid: '', model: BUSH.id, sized: true, rotation: 0, rotationSet: false, dy: 0,
    });
    expect(after.edits.map(e => e.id)).toEqual(['epsg3006:9.50:9.50', f.added.id, f.bush.id]);
}, 60_000);

t('the tree nearest a point grows, and a turn keeps its lean and is recorded as a rotation', async () => {
    const f = await fixture();
    await f.svc.edit(f.course, { near: [96, 41] }, { op: 'resize', factor: 1.5 });
    const r = await f.svc.edit(f.course, { id: f.bush.id }, { op: 'rotate', by: 45 });
    expect(r.after?.rotationY).toBe(75);
    const after = await f.read();
    const [inst] = after.byItem.get(treeItemId(BUSH_ITEM))!.filter(i => i.x === 95);
    expect([inst!.sx, inst!.sy]).toEqual([0.9, 0.9]);
    const want = orientation(75, 2, 90);
    inst!.q.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 5));
    const record = after.edits.find(e => e.id === f.bush.id);
    expect([record.h, record.r, record.rotation, record.rotationSet, record.sized]).toEqual([3.6, 1.35, 75, true, true]);
}, 60_000);

t('a delete leaves the tree out everywhere; an added tree deleted again loses its record', async () => {
    const f = await fixture();
    await f.svc.edit(f.course, { id: f.bush.id }, { op: 'delete' });
    await f.svc.edit(f.course, { pick: 'mouse' }, { op: 'show' }).catch(e => expect(String(e)).toMatch(/no tree of an Arborist model under the mouse/));
    const marked = await f.svc.edit(f.course, { pick: 'marked' }, { op: 'delete' });   // the added bush, marked with P
    expect([marked.before?.id, marked.found]).toEqual([f.added.id, 'marked with P at 01:02:03: CE_Plants_buckthorn-bush, 9 m from the camera']);
    expect(f.calls.filter(c => c.command === 'veg.edit').map(c => c.args.delete)).toEqual([true, true]);
    const after = await f.read();
    expect(after.byItem.get(treeItemId(BUSH_ITEM)) ?? []).toEqual([]);
    expect(after.ids.drawn).toEqual([]);
    expect(after.ids.leftOut.map((l: any) => [l.id, l.reason])).toContainEqual([f.bush.id, 'deleted by hand (tree edit)']);
    expect(after.placements.map(p => p.id)).toEqual([f.oak.id, f.elm.id]);
    expect(after.edits.map(e => [e.id, e.op])).toEqual([['epsg3006:9.50:9.50', 'delete'], [f.bush.id, 'delete']]);
}, 60_000);

t('a swap to a model the file has no item for makes the item and reloads Arborist; a picked tree is found by its item and place', async () => {
    const f = await fixture();
    f.arborist.missing.add(treeItemId(ELM_ITEM));
    const r = await f.svc.edit(f.course, { pick: 'mouse' }, { op: 'swap', model: ELM.id });
    expect(r.found).toMatch(/under the mouse: CE_Plants_buckthorn-bush/);
    expect(r.live.done).toBe(false);
    expect(f.reloads).toEqual(['Linkan_scene']);
    const after = await f.read();
    expect(after.items).toEqual([BUSH_ITEM, ELM_ITEM]);
    expect(after.byItem.get(treeItemId(ELM_ITEM))!.map(i => [i.x, i.z, i.sy])).toEqual([[95, 40, 0.2]]);   // 2.4 m high as before
    const swapped = after.placements.find(p => p.id === f.bush.id)!;
    expect([swapped.model, swapped.species, swapped.heightM, swapped.crownWidthM]).toEqual([ELM.id, 'elm', 2.4, 2.8]);
    expect(after.edits.find(e => e.id === f.bush.id).model).toBe(ELM.id);
}, 60_000);

t('yM puts an added or moved tree at that world height and does not ask Arborist for the ground (a lily on the water)', async () => {
    const f = await fixture();
    const r = await f.svc.edit(f.course, null, { op: 'add', model: BUSH.id, at: [-40, 260], heightM: 3, yM: 13.37 });
    const id = r.after!.id;
    expect(f.calls.filter(c => c.command === 'ground')).toEqual([]);
    expect((await f.read()).placements.find(p => p.id === id)!.y).toBe(13.37);
    await f.svc.edit(f.course, { id }, { op: 'move', by: [1, 0], yM: 13.4 });
    expect(f.calls.filter(c => c.command === 'ground')).toEqual([]);
    expect((await f.read()).placements.find(p => p.id === id)).toMatchObject({ x: -39, y: 13.4 });
    await f.svc.edit(f.course, { id }, { op: 'move', by: [1, 0] });
    expect(f.calls.filter(c => c.command === 'ground')).toHaveLength(1);
    expect((await f.read()).placements.find(p => p.id === id)!.y).toBe(12.5);
}, 60_000);

t('an added tree stands on Arborist\'s ground with an id of its own; a dry run and a VSP tree change nothing', async () => {
    const f = await fixture();
    const dry = await f.svc.edit(f.course, { id: f.bush.id }, { op: 'move', to: [10, 10] }, { dryRun: true });
    expect([dry.dryRun, dry.saved, f.calls.filter(c => c.command === 'veg.edit')]).toEqual([true, [], []]);
    await expect(f.svc.edit(f.course, { id: f.oak.id }, { op: 'delete' })).rejects.toThrow(/Unity's VSP draws it/);
    await expect(f.svc.edit(f.course, { id: f.elm.id }, { op: 'delete' })).rejects.toThrow(/not drawn by Arborist: outside the terrains/);

    const r = await f.svc.edit(f.course, null, { op: 'add', model: BUSH.id, at: [-50, 250], heightM: 3, yaw: 90 });
    const id = r.after!.id;
    expect(id).toMatch(/^manual:[0-9a-f]{12}$/);
    const after = await f.read();
    expect(after.byItem.get(treeItemId(BUSH_ITEM))!.find(i => i.x === -50)).toMatchObject({ cell: cellOf(-50, 250), z: 250, y: 12.5, sy: 0.75 });
    expect(after.ids.drawn.at(-1)).toEqual({ id, model: BUSH.id, item: BUSH_ITEM, x: -50, z: 250 });
    expect(after.edits.at(-1)).toMatchObject({ id, op: 'add', ox: -50, oz: 250, x: -50, z: 250, h: 3, r: 1.125, bush: true, model: BUSH.id, rotation: 90, rotationSet: true });

    // Without Arborist the files are still written.
    f.down();
    const quiet = await f.svc.edit(f.course, { id }, { op: 'resize', heightM: 4 });
    expect(quiet.live.done).toBe(false);
    expect((await f.read()).placements.find(p => p.id === id)!.heightM).toBe(4);
}, 60_000);
