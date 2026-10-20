import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { AssetsService } from './assets.service';
import { GsproExportService, defaultRunner, venvPython, type ExportRunner } from './gspro-export.service';
import { ArboristService, terrainsSquare, type ArboristCourse } from './arborist.service';
import { defaultUnityBridge, type UnityEditor } from './unity-bridge';

/**
 * The Arborist step for real: `pipeline/arborist.py` (the venv's Python) and
 * its wrapper (`arborist-wrap.ps1`, PowerShell 7) write and read the file
 * here, against small fixture inputs in temp folders. The wrapper is plain
 * AES with whatever 16-byte key it is given, so the tests bring a key of
 * their own: GSPro's stays out of the repo and is not needed.
 */
const PIPELINE = path.resolve(import.meta.dir, '..', '..', 'pipeline');
const PYTHON = venvPython(PIPELINE);
/** arborist.py starts `pwsh` itself, so ask its Python whether it can (Bun does not see the Store's pwsh alias). */
function pythonStartsPwsh(): boolean {
    const probe = "import subprocess, sys; sys.exit(subprocess.run(['pwsh', '-NoProfile', '-Command', 'exit 0']).returncode)";
    try {
        return Bun.spawnSync([PYTHON, '-c', probe], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
    } catch {
        return false;
    }
}
const MISSING = !existsSync(PYTHON) ? `the pipeline venv (${PYTHON})` : !pythonStartsPwsh() ? 'PowerShell 7 (pwsh) on PATH' : '';
if (MISSING) console.warn(`arborist.service.test: the tests that run arborist.py are skipped, they need ${MISSING}`);
const real = defaultRunner(PYTHON);

/** A w x h RGBA PNG of one colour (a zones mask the size of a postage stamp). */
function png(w: number, h: number, rgba: [number, number, number, number]): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(w, 0);
    header.writeUInt32BE(h, 4);
    header.set([8, 6, 0, 0, 0], 8);   // 8 bits, RGBA
    const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, () => Buffer.from(rgba))]);
    const pixels = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const tint = (name: string) => ({ PropertyName: name, ColorValue: 'RGBA(1.000, 1.000, 1.000, 1.000)', FloatValue: 0 });
/** A species library of two: a bush and a fir with a billboard, named as Arborist's catalogue names its NatureManufacture copies. */
const LIBRARY = {
    PackageName: 'GolfMap library', BiomeType: 'Default', BiomeSortOrder: 1, TextureMaskGroupList: [],
    VegetationInfoList: [
        { Name: 'MeadowEnv_bush_grey_willow_02', VegetationItemID: 'lib-willow', VegetationType: 'Plant', MinScale: 0.8, MaxScale: 1.2, SampleDistance: 1,
          ShaderControllerSettings: { ControlerPropertyList: [tint('TintColor1'), tint('TintColor2')] } },
        { Name: 'MountainEnv_Fir_02_S ', VegetationItemID: 'lib-fir', VegetationType: 'Tree', BillboardTexture: 'baked', MinScale: 1, MaxScale: 1, SampleDistance: 5,
          ShaderControllerSettings: { ControlerPropertyList: [tint('HealthyColorTint'), tint('BarkColor')] } },
    ],
};
/** A course file as it is before golf-map writes: someone else's package, which must survive. */
const BASE = {
    VSProSettings: {
        terrains: [{ Name: 'Terrain (Inner)', TerrainSourceID: 0 }], totalPrefabs: 1,
        vegetationPackages: [{ PackageName: 'Hand made in Arborist', BiomeType: 'Default', VegetationInfoList: [{ Name: 'Kept', VegetationItemID: 'kept-1' }], TextureMaskGroupList: [] }],
    },
    PersistentVegetationPackage: { PersistentVegetationCellList: [] },
    catalogVersion: 20250709005421,
};
const PALETTE = {
    format: 'golfmap-grass-v1', prefabItemsInVsp: ['heather'],
    palettes: [{ key: 'shrub', items: [
        { name: 'Tall rough - green base', texture: 'grass.png' },   // texture grass: the course's own VSP
        { name: 'Shrub thicket - grey willow round', prefab: 'Assets/NM/Bushes/prefab_grey_willow_02.prefab', sampleDistance: 4, healthy: '#96a4cb' },
        { name: 'Woodland heath - heather', prefab: 'Assets/NM/Plants/prefab_heather_01.prefab' },
        { name: 'Shrub thicket - juniper', prefab: 'Assets/NM/Bushes/prefab_juniper_07.prefab' },   // no such species in the library
    ] }],
};

/** A course's folders with everything the Arborist step reads, 200 m inner terrain and a 400 m outer round it. */
async function fixture(opts: { key?: boolean } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arborist-'));
    const dirs = { data: path.join(root, 'data'), docs: path.join(root, 'docs'), exportDir: path.join(root, 'export'), courseDir: path.join(root, 'Courses', 'Linkan_scene'), out: path.join(root, 'out') };
    for (const dir of [path.join(dirs.data, 'arborist'), path.join(dirs.docs, 'linkan'), dirs.exportDir, dirs.courseDir]) await mkdir(dir, { recursive: true });
    const key = path.join(dirs.data, 'arborist-wrapper.key');
    if (opts.key !== false) await writeFile(key, crypto.getRandomValues(new Uint8Array(16)));
    await writeFile(path.join(dirs.data, 'arborist', 'GolfMap library.biome'), JSON.stringify(LIBRARY));
    await writeFile(path.join(dirs.data, 'arborist', 'catalog-sizes.json'), JSON.stringify({ ok: true, result: { assets: [{ label: 'MountainEnv_Fir_02_S ', heightM: 5 }] } }));
    await writeFile(path.join(dirs.docs, 'linkan', 'arborist-species.json'), JSON.stringify({ species: {}, trees: {}, vsp: [] }));
    await writeFile(path.join(dirs.docs, 'linkan', 'grass-palette.json'), JSON.stringify(PALETTE));
    await writeZonesExport(dirs.exportDir);
    await writeFile(path.join(dirs.exportDir, 'linkan-inner-dem-200m.tif.json'), JSON.stringify({ sideM: 200, unity: { position: { x: 0, y: 0, z: 0 } } }));
    await writeFile(path.join(dirs.exportDir, 'linkan-outer-dem-400m.tif.json'), JSON.stringify({ sideM: 400, unity: { position: { x: -100, y: -3, z: -100 } } }));
    const course: ArboristCourse = { name: 'Linkan', exportDir: dirs.exportDir, courseDir: dirs.courseDir };
    return { ...dirs, key, course };
}

async function writeZonesExport(dir: string) {
    await writeFile(path.join(dir, 'linkan-inner-zones-0.png'), png(4, 4, [0, 255, 0, 0]));
    await writeFile(path.join(dir, 'linkan-inner-zones.json'), JSON.stringify({
        format: 'unity-zones-v2', plot: { sizeM: 200 }, masks: [{ file: 'linkan-inner-zones-0.png', resolution: 4 }],
        items: [{ item: 'Tall rough - green base', texture: 0, channel: 0 }, { item: 'Shrub thicket - grey willow round', texture: 0, channel: 1 }],
    }));
}

/** The course folder's arboristdata.dat, wrapped with the fixture's key by arborist.py itself. */
async function writeBase(f: Awaited<ReturnType<typeof fixture>>) {
    const json = path.join(f.data, 'base.json');
    await writeFile(json, JSON.stringify(BASE));
    const { code, stderr } = await real([path.join(PIPELINE, 'arborist.py'), 'encode', json, path.join(f.courseDir, 'arboristdata.dat'), '--key-file', f.key], PIPELINE);
    expect(stderr + code).toBe('0');
}

async function decode(dat: string, key: string): Promise<any> {
    const json = `${dat}.json`;
    const { code, stderr } = await real([path.join(PIPELINE, 'arborist.py'), 'decode', dat, json, '--key-file', key], PIPELINE);
    expect(stderr + code).toBe('0');
    return JSON.parse((await readFile(json, 'utf8')).replace(/^\uFEFF/, ''));
}

const packages = (doc: any) => Object.fromEntries(doc.VSProSettings.vegetationPackages.map((p: any) => [p.PackageName, p]));

/** A Unity editor whose `golfmap.trees.dump` writes these planted trees to the file it is asked for. */
function editorWithTrees(calls: string[]): UnityEditor {
    const tree = (catalogue: string, instances: number[][]) => ({
        catalogue, name: 'Fir_02_S', prefab: 'Assets/Trees/Fir-NM/Fir_02_S.prefab', widthM: 4, heightM: 10, colours: {}, instances,
    });
    return {
        projectPath: 'D:/unity/linkan', projectName: 'linkan_v4',
        async run(command, args = {}) {
            calls.push(command);
            if (command !== 'golfmap.trees.dump') throw new Error(`unexpected ${command}`);
            await writeFile(String(args.file), JSON.stringify({ format: 'golfmap-planted-trees-v1', items: [
                tree('GolfMap imported trees', [[50, 12, 60, 1, 1, 1, 0, 0, 0, 1], [150.5, 13, 20, 1.2, 1.2, 1.2, 0, 0.7071, 0, 0.7071]]),
                tree('GolfMap imported trees (billboards)', [[-50, 4, -60, 1, 1, 1, 0, 0, 0, 1]]),
            ] }));
            return { file: args.file, catalogues: [{ trees: 2 }, { trees: 1 }] };
        },
    };
}

test.skipIf(!!MISSING)('lower vegetation, then the trees out of Unity: both packages are in the file GSPro reads, beside what was there', async () => {
    const f = await fixture();
    await writeBase(f);
    const svc = new ArboristService({ dataDir: f.data, pipelineDir: PIPELINE, courseDocsRoot: f.docs, runner: real });
    const calls: string[] = [];

    const result = await svc.generate(f.course, { trees: true, editor: editorWithTrees(calls) });
    expect(result.error).toBeNull();
    expect(result.written).toEqual(['lower vegetation', 'trees']);
    const dat = path.join(f.courseDir, 'arboristdata.dat');
    expect(result.report).toEqual([
        `Arborist lower vegetation written: 1 items, 1 mask textures (${dat})`,
        `warning: no Arborist species for 1 item(s) (add them to ${path.join(f.docs, 'linkan', 'arborist-species.json')}):`,
        '  Shrub thicket - juniper (prefab_juniper_07)',
        "left to the course's own VSP (the palette's prefabItemsInVsp): Woodland heath - heather",
        'Arborist trees written: 3 trees of 2 species, from 3 planted in Unity (linkan_v4)',
        "Arborist trees: no .GKD with the course boundary in the GSPro course folder, so no far rule or ring: only the outer terrain's trees are billboards",
    ]);
    expect(calls).toEqual(['golfmap.trees.dump']);
    expect(await readFile(path.join(f.courseDir, 'arboristversion.dat'), 'utf8')).toBe('20250709005421');

    const doc = await decode(dat, f.key);
    const byName = packages(doc);
    expect(Object.keys(byName)).toEqual(['Hand made in Arborist', 'GolfMap lower vegetation', 'GolfMap trees']);
    expect(byName['Hand made in Arborist'].VegetationInfoList).toEqual(BASE.VSProSettings.vegetationPackages[0]!.VegetationInfoList);
    expect(doc.VSProSettings.totalPrefabs).toBe(4);

    // The bush: a clone of its Arborist species with the palette's spacing and colour, spread by the mask's G channel.
    const lower = byName['GolfMap lower vegetation'];
    expect(lower.VegetationInfoList.map((i: any) => i.Name)).toEqual(['Shrub thicket - grey willow round']);
    const willow = lower.VegetationInfoList[0];
    expect(willow.SampleDistance).toBe(4);
    expect(willow.EnableRuntimeSpawn).toBe(true);
    expect(willow.ShaderControllerSettings.ControlerPropertyList[0].ColorValue).toBe('RGBA(0.588, 0.643, 0.796, 1.000)');
    expect(lower.TextureMaskGroupList).toHaveLength(1);
    const mask = lower.TextureMaskGroupList[0].TextureMaskList[0];
    expect([mask.Width, mask.Height, mask.TextureRect.width]).toEqual([4, 4, 200]);
    expect(willow.TextureMaskDensityRuleList[0].TextureMaskGroupID).toBe(lower.TextureMaskGroupList[0].TextureMaskGroupID);
    expect(willow.TextureMaskDensityRuleList[0].TextureMaskPropertiesList[0].IntValue).toBe(2);   // PNG channel G

    // The trees: where Unity has them, relative to the terrains' south-west corner (-100, -100), at twice the
    // model's scale (a 10 m fir on Arborist's 5 m model); the outer terrain's tree is the billboard-only copy.
    const trees = byName['GolfMap trees'];
    expect(trees.VegetationInfoList.map((i: any) => i.Name).sort()).toEqual(['MountainEnv_Fir_02_S', 'MountainEnv_Fir_02_S (far)']);
    const far = trees.VegetationInfoList.find((i: any) => i.Name.endsWith('(far)'));
    expect(far.RenderDistanceFactor).toBe(0);
    const stored = doc.PersistentVegetationPackage.PersistentVegetationCellList
        .flatMap((c: any) => c.PersistentVegetationInfoList.flatMap((i: any) => i.VegetationItemList.map((t: any) => ({ cell: c.cellIndex, item: i.VegetationItemID, ...t }))));
    expect(stored.map((t: any) => [t.cell, t.Position.x, t.Position.y, t.Position.z, t.Scale.y]).sort()).toEqual([
        [0, 50, 4, 40, 2],          // (-50, -60): cell 0 of the 4 x 4 grid
        [5, 150, 12, 160, 2],       // (50, 60): x cell 1, z cell 1
        [9, 250.5, 13, 120, 2.4],   // (150.5, 20): x cell 2, z cell 1
    ]);
    expect(stored.find((t: any) => t.cell === 0).item).toBe(far.VegetationItemID);

    // A second run replaces golf-map's two packages and their trees; nothing doubles.
    const again = await svc.generate(f.course, { trees: true, editor: editorWithTrees(calls) });
    expect(again.error).toBeNull();
    const second = await decode(dat, f.key);
    expect(Object.keys(packages(second))).toEqual(['Hand made in Arborist', 'GolfMap lower vegetation', 'GolfMap trees']);
    expect(second.PersistentVegetationPackage.PersistentVegetationCellList.flatMap((c: any) => c.PersistentVegetationInfoList.flatMap((i: any) => i.VegetationItemList))).toHaveLength(3);
}, 120_000);

test.skipIf(!!MISSING)('Update vegetation with Unity closed: zones exported only, the Arborist lower vegetation written, its trees left', async () => {
    const f = await fixture();
    await writeBase(f);
    const runs: string[] = [];
    // The vegetation generators and gspro.py zones are stand-ins (their own tests run them); arborist.py is real.
    const runner: ExportRunner = async (args, cwd, opts) => {
        const script = path.basename(args[0]!);
        runs.push(script === 'gspro.py' || script === 'arborist.py' ? `${script} ${args[1]}` : script);
        if (script === 'arborist.py') return real(args, cwd, opts);
        const out = args[args.indexOf('--out') + 1]!;
        if (script === 'gspro.py') await writeZonesExport(path.dirname(out));
        else await writeFile(out, JSON.stringify({ type: 'FeatureCollection', features: [] }));
        return { code: 0, stdout: script === 'gspro.py' ? '  wrote linkan-inner-zones.json\n' : '', stderr: '' };
    };
    const ctx = await createTestDb(seedCourse);
    await ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: [529028, 6486667, 531082, 6488721] }) }).where('id', '=', TEST_COURSE_ID).execute();
    const svc = new GsproExportService({
        db: ctx.db, courses: new CoursesService(ctx.db), assets: new AssetsService(ctx.db, f.data), dataDir: f.data,
        pipelineDir: PIPELINE, courseDocsRoot: f.docs, runner, arboristOutDir: f.out,
        unityBridge: defaultUnityBridge(await mkdtemp(path.join(os.tmpdir(), 'bridges-'))),   // no editor publishes itself here
    });
    await svc.setDir(TEST_COURSE_ID, f.exportDir);
    await svc.setCourseDir(TEST_COURSE_ID, f.courseDir);
    await writeFile(path.join(f.exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
    await writeFile(path.join(f.exportDir, 'linkan-inner-surfaces.json'), '{}');

    const job = await svc.start(TEST_COURSE_ID, { kind: 'vegetation', terrain: 'inner' });
    expect(job.label).toBe('inner vegetation, planted for GSPro');
    await svc.whenIdle(TEST_COURSE_ID);
    const done = svc.job(job.id);
    expect(done.error).toBeNull();
    expect(runs).toEqual(['grass_zones.py', 'woodland_floor_zones.py', 'rock_shore_zones.py', 'creek_bank_zones.py', 'gspro.py zones', 'arborist.py lower']);
    const report = done.result!.report;
    const out = path.join(f.out, 'arboristdata.dat');
    // The last line is the phase timings (Time: ...).
    expect(report.slice(-7, -1)).toEqual([
        expect.stringMatching(/^Unity: not open, zones exported only - no open Unity editor imports from .* \(none is open\)/),
        `Arborist lower vegetation written: 1 items, 1 mask textures (${out})`,
        `warning: no Arborist species for 1 item(s) (add them to ${path.join(f.docs, 'linkan', 'arborist-species.json')}):`,
        '  Shrub thicket - juniper (prefab_juniper_07)',
        "left to the course's own VSP (the palette's prefabItemsInVsp): Woodland heath - heather",
        "Arborist trees: skipped, Unity is not open (the trees' positions and ground heights come from its scene); the file keeps the trees as last generated",
    ]);
    expect(report.at(-1)).toMatch(/^Time: /);

    // Written to the trial folder; the course folder's own file is the base and is left as it was.
    expect(Object.keys(packages(await decode(out, f.key)))).toEqual(['Hand made in Arborist', 'GolfMap lower vegetation']);
    expect(Object.keys(packages(await decode(path.join(f.courseDir, 'arboristdata.dat'), f.key)))).toEqual(['Hand made in Arborist']);
}, 120_000);

test('what the Arborist step lacks is said plainly, one thing at a time, and nothing runs', async () => {
    const f = await fixture({ key: false });
    const runs: string[][] = [];
    const svc = new ArboristService({ dataDir: f.data, pipelineDir: PIPELINE, courseDocsRoot: f.docs, runner: async args => { runs.push(args); return { code: 0, stdout: '', stderr: '' }; } });
    const failure = async (course: ArboristCourse = f.course) => (await svc.generate(course, { trees: true, editor: null })).error;

    expect(await failure({ ...f.course, courseDir: null })).toMatch(/^Arborist file not written: set the GSPro course folder first/);
    expect(await failure()).toBe(`Arborist file not written: no arboristdata.dat in ${f.courseDir} yet. golf-map only replaces its own packages in it; the first file is made by hand (docs/gspro/arborist.md)`);
    await writeFile(path.join(f.courseDir, 'arboristdata.dat'), 'x');
    expect(await failure()).toBe(`Arborist file not written: no wrapper key at ${f.key} (16 bytes, kept out of the repo; docs/gspro/arborist.md, "What GSPro reads")`);
    await writeFile(f.key, 'sixteen bytes!!!');
    await Bun.file(path.join(f.exportDir, 'linkan-inner-zones.json')).delete();
    expect(await failure()).toBe(`Arborist lower vegetation not written: no zones export yet (${path.join(f.exportDir, 'linkan-inner-zones.json')}) - plant once first`);
    expect(runs).toHaveLength(0);

    // A course without a species file is not an Arborist course: one line, no error.
    const other = await svc.generate({ ...f.course, name: 'Other' }, { trees: true, editor: null });
    expect(other).toEqual({ used: false, written: [], error: null, report: [`Arborist: not used by this course (no ${path.join(f.docs, 'other', 'arborist-species.json')})`] });

    // arborist.py's own refusal comes through as its last line.
    await writeZonesExport(f.exportDir);
    const refusing = new ArboristService({ dataDir: f.data, pipelineDir: PIPELINE, courseDocsRoot: f.docs, runner: async () => ({ code: 1, stdout: '', stderr: 'Traceback ...\nKeyError: \'palettes\'\n' }) });
    expect((await refusing.generate(f.course, { trees: false })).error).toBe("Arborist lower vegetation not written: KeyError: 'palettes'");
});

test('the terrains square is the union of the heightmap sidecars in the export folder', async () => {
    const f = await fixture();
    expect(await terrainsSquare(f.exportDir, 'linkan')).toEqual([-100, -100, 300, 300]);
    await Bun.file(path.join(f.exportDir, 'linkan-outer-dem-400m.tif.json')).delete();
    expect(await terrainsSquare(f.exportDir, 'linkan')).toEqual([0, 0, 200, 200]);
    expect(await terrainsSquare(f.exportDir, 'vreta')).toBeNull();
});

test('one rule for a routed course: a routing file left on a course without `routing` rules is removed, and the Arborist trees wait for a planting', async () => {
    const f = await fixture();
    const routing = path.join(f.exportDir, 'linkan-inner-routing.json');
    const leftOver = JSON.stringify({ format: 'golfmap-routing-v1', routes: { a: 'billboard' } });
    const svc = new ArboristService({ dataDir: f.data, pipelineDir: PIPELINE, courseDocsRoot: f.docs, runner: real });
    await writeFile(path.join(f.docs, 'linkan', 'vegetation-rules.json'), JSON.stringify({ format: 'golfmap-vegetation-rules-v1', generators: {} }));

    // The trees export routes again (routeIfRouted): with no rules, the old file goes.
    await writeFile(routing, leftOver);
    expect(await svc.routeIfRouted(f.course, { dryRun: true })).toEqual([]);
    expect(existsSync(routing)).toBe(true);
    const lines = await svc.routeIfRouted(f.course);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('Routing removed: Linkan has no `routing`');
    expect(existsSync(routing)).toBe(false);

    // Writing the Arborist trees with one left over: Unity's VSP was planted routed, so it must plant again first.
    await writeBase(f);
    await writeFile(routing, leftOver);
    await expect(svc.trees(f.course, editorWithTrees([]))).rejects.toThrow(/planted by the routing of a routed course/);
    expect(existsSync(routing)).toBe(false);
}, 60_000);
