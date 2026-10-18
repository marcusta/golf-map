// ShapingService against a stand-in shaping worker on its real HTTP contract
// (testing/fake-shaping-worker.ts: in-process, or spawned as a real process
// for the on-demand start) and a stand-in Unity editor on the bridge
// protocol. The pipeline is the runner seam (as in the GSPro export tests): it
// writes the layer files gspro.py shaping-global would.
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { test, expect, afterEach } from 'bun:test';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { startFakeShapingWorker, type FakeShapingWorker } from '../testing/fake-shaping-worker';
import { ShapingService, objectName, isRockSlab, LATEST_LOG, LOG_KEEP_DAYS, type ShapingTimeouts } from './shaping.service';
import { defaultUnityBridge } from './unity-bridge';
import { GsproExportService, type ExportRunner } from './gspro-export.service';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
});

const tmp = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));

/** What gspro.py shaping-global writes, from ops the test sets. */
function layersRunner(initial: { global: object[]; features: object[] }) {
    const layers = { ...initial };
    const calls: string[][] = [];
    let fail: string | null = null;
    const runner: ExportRunner = async (args) => {
        calls.push(args);
        if (fail) return { code: 1, stdout: '', stderr: `Traceback\nSystemExit: error: ${fail}` };
        if (args[1] === 'svg') {  // --paths-only: the road surfaces file of the exported SVG
            const out = args[args.indexOf('--out') + 1]!;
            await writeFile(out.replace(/\.svg$/, '-paths.json'), '{}');
            return { code: 0, stdout: 'Wrote linkan-paths.json\n  roads_7: 1 piece(s) changed surface (asphalt -> gravel); now mixed\n  warning: the outline of roads_9 moved since the last SVG export\n', stderr: '' };
        }
        const dir = args[args.indexOf('--out-dir') + 1]!;
        const layer = (id: string, ops: object[]) => JSON.stringify({ format: 'golfmap-shaping-layer-v1', id, generated: true, ops });
        await writeFile(path.join(dir, '00-global.gen.json'), layer('global', layers.global));
        await writeFile(path.join(dir, '10-features.gen.json'), layer('features', layers.features));
        return { code: 0, stdout: `Wrote ${dir}/00-global.gen.json\n  ${layers.features.length} recipe op(s)\n`, stderr: '' };
    };
    return { runner, calls, layers, failWith: (msg: string | null) => { fail = msg; } };
}

const TEES = { id: 'tees', op: 'afrod.flattentees', select: { type: 'tee' } };
const recipe = (no: string, file = 'cesimgolf-Conway_Bunker_Standard.json') =>
    ({ id: `recipe-${no}`, op: 'afrod.recipe', select: { feature: `f-${no}` }, recipe: file, seed: parseInt(no, 16) });

/**
 * A rock slab op as the hand layer 20-rocks.json has it (the worker's stand-in
 * names its object `Spline_<id>`); `golfmap.cut_out` names the mesh `..._Rock_-_Mesh`.
 */
const SLAB = { id: 'hall_h11_north_Rock_-_Mesh', op: 'golfmap.cut_out', name: 'hall_h11_north', outline3006: [[530110.5, 6487074.6], [530112, 6487075.2], [530114.2, 6487074.9]] };
const SLAB_OBJECT = 'Spline_hall_h11_north_Rock_-_Mesh';

/**
 * The runner behind the planting (GsproExportService.plantVegetation): the
 * tall-rough generator writes one zone, `gspro.py zones` its file. Every run
 * lands in `events` as `plant:<script>`, in order with the Unity commands.
 */
function plantingRunner(events: string[], fail: boolean): ExportRunner {
    return async (args) => {
        const script = path.basename(args[0]!);
        events.push(`plant:${script}${args[1] === 'zones' ? ' zones' : ''}`);
        const out = args[args.indexOf('--out') + 1]!;
        if (script === 'grass_zones.py') {
            if (fail) return { code: 1, stdout: '', stderr: 'Traceback\nSystemExit: error: boom, no surface map' };
            await writeFile(out, JSON.stringify({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [[[529500, 6487500], [529510, 6487500], [529510, 6487510], [529500, 6487500]]] },
                    properties: { type: 'vegetation_zone', source: 'tall-grass', zoneType: 'rough_tall', weight: 1, feather: 1, noise: 0 },
                }],
            }));
            return { code: 0, stdout: '  grass_zones.py: 1 zones\n', stderr: '' };
        }
        await writeFile(out, '{}');
        return { code: 0, stdout: '  wrote zones\n', stderr: '' };
    };
}

/** A Unity editor whose active course exports to `exportFolder`, on the bridge protocol. */
function fakeEditor(exportFolder: string, opts: { rejectOnly?: boolean; refreshMs?: number; steps?: object[]; events?: string[]; failSurfaces?: boolean } = {}) {
    const calls: Array<{ command: string; args: any }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (req.headers.get('X-Bridge-Token') !== 'tok') return Response.json({ ok: false, error: 'token' }, { status: 403 });
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            const args = await req.json();
            calls.push({ command, args });
            if (command !== 'golfmap.course') opts.events?.push(`unity:${command}`);
            if (command === 'golfmap.surfaces.export') {
                if (opts.failSurfaces) return Response.json({ ok: false, error: 'no terrain named Inner in the scene' });
                return Response.json({ ok: true, result: { terrain: args.terrain, cell: 0.5 } });
            }
            if (command === 'golfmap.zones.import') return Response.json({ ok: true, result: { status: 'Imported 1 zone groups' } });
            if (command === 'golfmap.grass.apply') return Response.json({ ok: true, result: { system: 'Inner VSP', items: [{}], log: [] } });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder } } });
            if (command === 'golfmap.course.refresh') {
                if (opts.rejectOnly && 'only' in args) return Response.json({ ok: false, error: "unknown argument 'only' for golfmap.course.refresh" });
                await Bun.sleep(opts.refreshMs ?? 0);
                return Response.json({ ok: true, result: { steps: opts.steps ?? [{ id: 'meshes.sync', status: 'done' }], only: args.only ?? null } });
            }
            if (command === 'golfmap.paths.materials') {
                return Response.json({ ok: true, result: { look: 'surface', changed: 3, meshesPerSurface: { asphalt: 4, gravel: 2 }, problems: ['Spline_roads_7_B_Concrete_-_Blend: no neighbour found'] } });
            }
            return Response.json({ ok: false, error: `unknown ${command}` });
        },
    });
    cleanup.push(() => server.stop(true));
    return { calls, server };
}

async function setup(opts: {
    worker?: FakeShapingWorker; workerUrl?: string; workerLauncher?: string[]; unity?: 'ours' | 'none' | 'reject-only';
    library?: unknown; runner?: ExportRunner; editor?: { refreshMs?: number; steps?: object[]; failSurfaces?: boolean };
    plantFails?: boolean; token?: string; timeouts?: Partial<ShapingTimeouts>; queueDir?: string;
} = {}) {
    const ctx = await createTestDb(seedCourse);
    const exportDir = await tmp('shaping-export-');
    await ctx.gsproExportService.setDir(TEST_COURSE_ID, exportDir);
    const project = await tmp('unity-proj-');
    const discovery = await tmp('bridges-');
    /** Unity commands (except the course probe) and planting runs, in the order they happened. */
    const events: string[] = [];
    let editor: ReturnType<typeof fakeEditor> | null = null;
    if (opts.unity !== 'none') {
        editor = fakeEditor(path.relative(path.join(project, 'Assets'), exportDir), { rejectOnly: opts.unity === 'reject-only', events, ...opts.editor });
        writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({
            pid: process.pid, port: editor.server.port, token: 'tok', projectPath: project, projectName: 'linkan_v4', unityVersion: '2018.2.8f1', started: '',
        }));
    }
    const layersRoot = await tmp('shaping-layers-');
    const libDir = await tmp('recipes-');
    const recipeLibrary = path.join(libDir, 'library.json');
    if (opts.library !== undefined) await writeFile(recipeLibrary, JSON.stringify(opts.library));
    const layers = layersRunner({ global: [TEES], features: [recipe('10'), recipe('11')] });
    const dataDir = await tmp('shaping-data-');
    // The export service the planting runs through: its runner is the vegetation generators' stand-in, its Unity bridge the same editor.
    const exporter = new GsproExportService({
        db: ctx.db, courses: ctx.coursesService, assets: ctx.assetsService, dataDir, terrainEdits: ctx.terrainEditsService,
        pipelineDir: '/pipeline', runner: plantingRunner(events, opts.plantFails === true), unityBridge: defaultUnityBridge(discovery),
    });
    const svc = new ShapingService({
        courses: ctx.coursesService, exportSettings: exporter, dataDir,
        pipelineDir: '/pipeline', runner: opts.runner ?? layers.runner, unityBridge: defaultUnityBridge(discovery),
        workerUrl: opts.worker?.url ?? opts.workerUrl ?? 'http://127.0.0.1:9', workerLauncher: opts.workerLauncher,
        token: opts.token, layersRoot, recipeLibrary, dbPath: '/data/app.sqlite', queueDir: opts.queueDir,
        timeouts: { pollMs: 25, startMs: 20_000, loadMs: 20_000, syncMs: 20_000, unitySec: 30, heartbeatMs: 50, ...opts.timeouts },
    });
    cleanup.push(() => svc.stopWorker());
    return { ctx, svc, exportDir, project, layersRoot, recipeLibrary, layers, editor, dataDir, events };
}

/** What the planting needs of the course: its square (georeference) and the inner heightmap's sidecar in the export folder. */
async function plantable(t: Awaited<ReturnType<typeof setup>>) {
    await t.ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: [529028, 6486667, 531082, 6488721] }) })
        .where('id', '=', TEST_COURSE_ID).execute();
    await writeFile(path.join(t.exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
}

/** Three .blend files: an old source, its conformed cache, and a newer source not prepared yet. */
async function blends(dir: string) {
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    for (const [name, age] of [['linkan_svg_1.blend', 30], ['linkan_svg_1.conformed.blend', 20], ['linkan_svg_2.blend', 10]] as const) {
        await writeFile(path.join(dir, name), '');
        await utimes(path.join(dir, name), at(age), at(age));
    }
    return path.join(dir, 'linkan_svg_1.conformed.blend');
}

async function run(svc: ShapingService, opts: { dryRun?: boolean; skipUnity?: boolean; paths?: boolean; save?: boolean } = {}) {
    const job = await svc.apply(TEST_COURSE_ID, opts);
    expect(job.status).toBe('running');
    await svc.whenIdle();
    return svc.job(job.id);
}

test('apply: layers for the course, the worker loads its newest conformed .blend and syncs, Unity refreshes only what changed', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    const conformed = await blends(t.exportDir);
    const layersDir = path.join(t.layersRoot, 'linkan', 'shaping');
    const fbx = path.join(t.project, 'Assets', 'fbx');

    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    // (a) shaping-global into the course's layer folder, with the library and the server's database
    const args = t.layers.calls[0]!;
    expect(args.slice(0, 4)).toEqual([path.join('/pipeline', 'gspro.py'), 'shaping-global', '--course', TEST_COURSE_ID]);
    expect(args[args.indexOf('--out-dir') + 1]).toBe(layersDir);
    expect(args[args.indexOf('--library') + 1]).toBe(t.recipeLibrary);
    expect(args[args.indexOf('--db') + 1]).toBe('/data/app.sqlite');
    // (b) the worker held nothing: /load with the course's paths, then /sync
    expect(worker.calls.filter(c => c.route !== '/status').map(c => c.route)).toEqual(['/load', '/sync']);
    expect(worker.calls.find(c => c.route === '/load')!.body).toEqual({ blend: conformed, layersDir, fbxFolder: fbx });
    // (c) Unity: just the changed objects
    const r = job.result!;
    expect(r.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
    expect(t.editor!.calls.map(c => c.command)).toEqual(['golfmap.course', 'golfmap.course.refresh']);
    expect(t.editor!.calls[1]!.args).toEqual({ only: 'Spline_recipe-10,Spline_recipe-11,Spline_tees' });
    // (d) the result
    expect((await readdir(fbx)).sort()).toEqual(r.exported.slice().sort());
    expect(r.places).toHaveLength(3);
    expect(r.unityReport).toEqual({ steps: [{ id: 'meshes.sync', status: 'done' }], only: 'Spline_recipe-10,Spline_recipe-11,Spline_tees' });
    expect(r.unityError).toBeNull();
    expect(r.layers).toContain('2 recipe op(s)');
    expect(r.blend).toBe(conformed);
    expect(r.fbxFolder).toBe(fbx);
    expect(r.seconds).toBeGreaterThanOrEqual(0);
    expect(r.warnings).toContain('1 seam gap under 1 mm');
    expect(r.warnings.some(w => w.startsWith('linkan_svg_2.blend is newer than the conformed cache linkan_svg_1.conformed.blend'))).toBe(true);

    // Nothing changed: no reload, nothing for Unity.
    const again = await run(t.svc);
    expect(again.result!.changedObjects).toEqual([]);
    expect(again.result!.warnings).toContain('Unity not refreshed: no object changed');
    expect(worker.calls.filter(c => c.route === '/load')).toHaveLength(1);
    expect(t.editor!.calls.filter(c => c.command === 'golfmap.course.refresh')).toHaveLength(1);

    // One bunker's recipe changed: only its object.
    t.layers.layers.features = [recipe('10'), recipe('11', 'golfmap-pot.json')];
    const third = await run(t.svc);
    expect(third.result!.changedObjects).toEqual(['Spline_recipe-11']);
    expect(t.editor!.calls.at(-1)!.args).toEqual({ only: 'Spline_recipe-11' });

    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.worker.reachable).toBe(true);
    expect(status.worker.state).toBe('ready');
    expect(status.worker.blend).toBe(conformed);
    expect(status.worker.layersDir).toBe(layersDir);
    expect(status.job!.id).toBe(third.id);
    expect(status.job!.status).toBe('succeeded');
});

test('the worker is started on demand with the course\'s paths when nothing answers on its URL', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);
    const script = path.join(import.meta.dir, '..', 'testing', 'fake-shaping-worker.ts');
    const t = await setup({ workerUrl: `http://127.0.0.1:${port}`, workerLauncher: [process.execPath, script] });
    const conformed = await blends(t.exportDir);
    expect((await t.svc.status(TEST_COURSE_ID)).worker.reachable).toBe(false);

    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.worker.reachable).toBe(true);
    expect(status.worker.spawnedPid).toBeGreaterThan(0);
    const argv = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { argv: string[] };
    const layersDir = path.join(t.layersRoot, 'linkan', 'shaping');
    expect(argv.argv).toEqual(['--port', String(port), '--blend', conformed, '--layers', layersDir, '--fbx-folder', path.join(t.project, 'Assets', 'fbx')]);

    // One log per spawn, both streams in it, with `latest.json` naming the current one; the old one is pruned.
    const logs = path.join(t.dataDir, 'shaping-worker');
    const names = (await readdir(logs)).filter(n => n.endsWith('.log'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\d-\\d{6}(-${status.worker.spawnedPid})?\\.log$`));
    expect(await Bun.file(path.join(logs, names[0]!)).text()).toContain(`fake shaping worker on ${port}`);
    expect(JSON.parse(await Bun.file(path.join(logs, LATEST_LOG)).text())).toMatchObject({ file: names[0]!, pid: status.worker.spawnedPid });
    expect(status.worker.log).toBe(path.join(logs, names[0]!));

    await t.svc.stopWorker();
    expect((await t.svc.status(TEST_COURSE_ID)).worker.reachable).toBe(false);
});

test('worker logs older than two weeks are pruned on the next spawn, and a live one is kept', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);
    const script = path.join(import.meta.dir, '..', 'testing', 'fake-shaping-worker.ts');
    const t = await setup({ workerUrl: `http://127.0.0.1:${port}`, workerLauncher: [process.execPath, script] });
    await blends(t.exportDir);
    const logs = path.join(t.dataDir, 'shaping-worker');
    await mkdir(logs, { recursive: true });
    const old = path.join(logs, '2000-01-01-120000-42.log');
    const young = path.join(logs, '2000-01-02-120000-43.log');
    for (const [file, days] of [[old, LOG_KEEP_DAYS + 1], [young, LOG_KEEP_DAYS - 1]] as const) {
        await writeFile(file, 'older run\n');
        const at = new Date(Date.now() - days * 24 * 3600_000);
        await utimes(file, at, at);
    }

    const job = await run(t.svc);
    expect(job.error).toBeNull();
    const names = (await readdir(logs)).filter(n => n.endsWith('.log')).sort();
    expect(names).toContain(path.basename(young));
    expect(names).not.toContain(path.basename(old));
    await t.svc.stopWorker();
});

test('the job reports its phases live — layers, the cold start with its seconds, Blender, Unity — and ends done with timings', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);
    const script = path.join(import.meta.dir, '..', 'testing', 'fake-shaping-worker.ts');
    process.env.FAKE_SHAPING_LOAD_MS = '600';
    cleanup.push(() => { delete process.env.FAKE_SHAPING_LOAD_MS; });
    const steps = [{ id: 'meshes.sync', status: 'done', seconds: 0.2 }, { id: 'terrain.conform', status: 'done', seconds: 0.1 }];
    const t = await setup({ workerUrl: `http://127.0.0.1:${port}`, workerLauncher: [process.execPath, script], editor: { refreshMs: 300, steps } });
    await blends(t.exportDir);

    // What a client polling the job sees, change by change.
    const started = await t.svc.apply(TEST_COURSE_ID);
    expect(started.phases.map(p => [p.id, p.status])).toEqual([['layers', 'running'], ['worker', 'pending'], ['blender', 'pending'], ['unity', 'pending'], ['vegetation', 'pending']]);
    const seen: string[] = [];
    const seconds: number[] = [];
    let job = started;
    while (job.status === 'running') {
        const line = `${job.phase}: ${job.phases.find(p => p.id === job.phase)?.detail}`;
        if (seen.at(-1) !== line) seen.push(line);
        if (job.phase === 'worker') seconds.push(job.phases[1]!.seconds!);
        await Bun.sleep(5);
        job = t.svc.job(started.id);
    }
    expect(seen).toContain('worker: cold start: Blender loading linkan_svg_1.conformed.blend: opening linkan_svg_1.conformed.blend');
    const order = ['layers', 'worker', 'blender', 'unity'].map(id => seen.findIndex(l => l.startsWith(`${id}:`)));
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
    expect(seen).toContain('unity: refreshing 3 object(s) in linkan_v4');
    // The cold start's seconds count up while it runs, and the step line carries them.
    expect(Math.max(...seconds)).toBeGreaterThanOrEqual(0.5);

    expect(job.status).toBe('succeeded');
    expect(job.step).toBe('done');
    expect(job.phase).toBeNull();
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['layers', 'done'], ['worker', 'done'], ['blender', 'done'], ['unity', 'done'], ['vegetation', 'skipped']]);
    expect(job.phases[1]!.detail).toBe('cold start: Blender started and loaded linkan_svg_1.conformed.blend');
    expect(job.phases[2]!.detail).toBe('3 object(s) re-shaped, 3 FBX exported');
    expect(job.phases[4]!.detail).toBe('no rock slab changed');
    expect(job.phases.filter(p => p.status !== 'skipped').every(p => typeof p.seconds === 'number')).toBe(true);
    expect(job.phases[1]!.seconds!).toBeGreaterThanOrEqual(0.5);
    expect(job.phases[3]!.seconds!).toBeGreaterThanOrEqual(0.3);
    expect(job.seconds).toBeGreaterThanOrEqual(job.phases[1]!.seconds! + job.phases[3]!.seconds!);
    expect(job.result!.unitySteps).toEqual(steps);
    expect(job.finishedAt).not.toBeNull();

    // Warm: the worker holds the course; nothing changed, so Unity is skipped (and says why).
    const again = await run(t.svc);
    expect(again.phases.map(p => [p.id, p.status])).toEqual([['layers', 'done'], ['worker', 'done'], ['blender', 'done'], ['unity', 'skipped'], ['vegetation', 'skipped']]);
    expect(again.phases[1]!.detail).toBe('already loaded (linkan_svg_1.conformed.blend)');
    expect(again.phases[3]!.detail).toBe('Unity not refreshed: no object changed');
    expect(again.phases[3]!.seconds).toBeNull();
    expect(again.result!.unitySteps).toEqual([]);
    await t.svc.stopWorker();
});

test('a failed phase is marked failed with the error; the later ones stay pending', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    const job = await run(t.svc); // no .blend
    expect(job.status).toBe('failed');
    expect(job.phase).toBe('worker');
    expect(job.phases.map(p => p.status)).toEqual(['done', 'failed', 'pending', 'pending', 'pending']);
    expect(job.phases[1]!.detail).toMatch(/No \.blend in the export folder/);
    expect(job.step).toMatch(/^failed \(starting the shaping worker\): No \.blend/);
});

test('a Unity bridge that does not take only= gets the whole refresh, with a warning', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker, unity: 'reject-only' });
    await blends(t.exportDir);
    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(t.editor!.calls.filter(c => c.command === 'golfmap.course.refresh').map(c => c.args))
        .toEqual([{ only: 'Spline_recipe-10,Spline_recipe-11,Spline_tees' }, {}]);
    expect(job.result!.unityReport).toEqual({ steps: [{ id: 'meshes.sync', status: 'done' }], only: null });
    expect(job.result!.warnings.some(w => w.startsWith('this Unity bridge does not take only= yet'))).toBe(true);
});

test('the Unity refresh only= also names the objects whose FBX the worker removed, so meshes.sync prunes them', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);
    t.layers.layers.global = [];
    t.layers.layers.features = [{ ...recipe('10'), removesFbx: ['Spline_hole_1_10_Bunker_-_Blend', 'Spline_hole_1_10_Bunker_-_Blend.001'] }];
    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10']);
    expect(job.result!.removed).toEqual(['Spline_hole_1_10_Bunker_-_Blend.fbx', 'Spline_hole_1_10_Bunker_-_Blend.001.fbx']);
    expect(t.editor!.calls.at(-1)).toEqual({ command: 'golfmap.course.refresh',
        args: { only: 'Spline_recipe-10,Spline_hole_1_10_Bunker_-_Blend,Spline_hole_1_10_Bunker_-_Blend.001' } });
    expect(objectName('D:\\u\\Assets\\fbx\\Spline_x.FBX')).toBe('Spline_x');
});

test('paths: the surfaces file is rewritten before the layers, and Unity gets the path look on every path mesh, also when Blender changed nothing', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await t.ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: [529028, 6486667, 531082, 6488721] }) })
        .where('id', '=', TEST_COURSE_ID).execute();
    await blends(t.exportDir);

    // A road went mixed: the worker re-shapes, the refresh leaves the path look to the whole-course run after it.
    const job = await run(t.svc, { paths: true });
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    const [svg, global] = t.layers.calls;
    expect(svg![1]).toBe('svg');  // the export service's own command (its pipeline folder)
    expect(svg![svg!.indexOf('--out') + 1]).toBe(path.join(t.exportDir, 'linkan.svg'));
    expect(svg![svg!.indexOf('--db') + 1]).toBe('/data/app.sqlite');
    expect(svg!.at(-1)).toBe('--paths-only');
    expect(global![1]).toBe('shaping-global');
    expect(job.result!.pathSurfaces[1]).toBe('roads_7: 1 piece(s) changed surface (asphalt -> gravel); now mixed');
    expect(t.editor!.calls.filter(c => c.command !== 'golfmap.course')).toEqual([
        { command: 'golfmap.course.refresh', args: { only: 'Spline_recipe-10,Spline_recipe-11,Spline_tees', skip: 'paths.materials' } },
        { command: 'golfmap.paths.materials', args: {} },
    ]);
    expect(job.result!.pathMaterials).toMatchObject({ changed: 3, meshesPerSurface: { asphalt: 4, gravel: 2 } });
    expect(job.result!.warnings).toEqual(expect.arrayContaining([
        'warning: the outline of roads_9 moved since the last SVG export',
        'path materials: Spline_roads_7_B_Concrete_-_Blend: no neighbour found',
    ]));
    expect(job.phases.find(p => p.id === 'unity')!.detail).toBe('3 object(s) refreshed, path materials applied in linkan_v4');

    // Again, nothing for Blender to do (a whole road given another surface): the path look still goes in.
    t.editor!.calls.length = 0;
    const again = await run(t.svc, { paths: true });
    expect(again.result!.changedObjects).toEqual([]);
    expect(t.editor!.calls.filter(c => c.command !== 'golfmap.course')).toEqual([{ command: 'golfmap.paths.materials', args: {} }]);
    expect(again.phases.find(p => p.id === 'unity')).toMatchObject({ status: 'done', detail: 'no object changed, path materials applied in linkan_v4' });

    // Without paths that run leaves Unity alone, as before.
    t.editor!.calls.length = 0;
    const plain = await run(t.svc);
    expect(t.editor!.calls.filter(c => c.command !== 'golfmap.course')).toEqual([]);
    expect(plain.result!.pathSurfaces).toEqual([]);
    expect(plain.result!.pathMaterials).toBeNull();
});

test('a changed rock slab: after the Unity refresh the surface map is exported, then the vegetation is planted again; a run without one skips the phase', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);
    await plantable(t);

    // No slab among the changes: nothing for the grass.
    const plain = await run(t.svc);
    expect(plain.error).toBeNull();
    expect(plain.phases.find(p => p.id === 'vegetation')).toMatchObject({ status: 'skipped', detail: 'no rock slab changed', seconds: null });
    expect(plain.result!.vegetation).toEqual([]);
    expect(t.events).toEqual(['unity:golfmap.course.refresh']);

    // A slab joins: the refresh (its own report has no surface map step), then golfmap.surfaces.export, then the planting.
    t.events.length = 0;
    t.layers.layers.features = [recipe('10'), recipe('11'), SLAB];
    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.result!.changedObjects).toEqual([SLAB_OBJECT]);
    expect(t.events).toEqual([
        'unity:golfmap.course.refresh', 'unity:golfmap.surfaces.export',
        'plant:grass_zones.py', 'plant:gspro.py zones', 'unity:golfmap.zones.import', 'unity:golfmap.grass.apply',
    ]);
    expect(t.editor!.calls.find(c => c.command === 'golfmap.surfaces.export')!.args).toEqual({ terrain: 'inner' });
    expect(t.editor!.calls.find(c => c.command === 'golfmap.course.refresh' && c.args.only === SLAB_OBJECT)).toBeDefined();
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['layers', 'done'], ['worker', 'done'], ['blender', 'done'], ['unity', 'done'], ['vegetation', 'done']]);
    expect(job.phases[4]!.detail).toBe(`1 rock slab(s): surface map exported, grass planted in linkan_v4`);
    expect(job.phases[4]!.seconds).toBeGreaterThanOrEqual(0);
    expect(job.result!.vegetation).toContain('Unity (linkan_v4): grass palettes applied (1 items on Inner VSP)');
    expect(job.result!.vegetation.at(-1)).toBe('Save the scene in Unity to keep it.');
    expect(job.result!.warnings.filter(w => w.startsWith('Surface map and grass'))).toEqual([]);
    expect(isRockSlab(SLAB_OBJECT)).toBe(true);
    expect(isRockSlab('Spline_hall_1_Rock_-_Blend')).toBe(false);
});

test('a changed rock slab whose refresh already exported the surface map is not exported twice', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker, editor: { steps: [{ id: 'meshes.sync', status: 'done' }, { id: 'surfaces.export', status: 'done', seconds: 4.2 }] } });
    await blends(t.exportDir);
    await plantable(t);
    t.layers.layers.global = [];
    t.layers.layers.features = [SLAB];

    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(t.events).toEqual(['unity:golfmap.course.refresh', 'plant:grass_zones.py', 'plant:gspro.py zones', 'unity:golfmap.zones.import', 'unity:golfmap.grass.apply']);
    expect(job.phases[4]!.detail).toBe('1 rock slab(s): surface map from the refresh, grass planted in linkan_v4');

    // A surface map the refresh left pending (status is not done) is exported here.
    const pending = await setup({ worker, editor: { steps: [{ id: 'surfaces.export', status: 'pending' }] } });
    await blends(pending.exportDir);
    await plantable(pending);
    pending.layers.layers.global = [];
    pending.layers.layers.features = [SLAB];
    await run(pending.svc);
    expect(pending.events.slice(0, 2)).toEqual(['unity:golfmap.course.refresh', 'unity:golfmap.surfaces.export']);
});

test('a failing planting fails the job with a clear message (so does a failing surface map export, which stops before the planting)', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker, plantFails: true });
    await blends(t.exportDir);
    await plantable(t);
    t.layers.layers.features = [recipe('10'), SLAB];

    const job = await run(t.svc);
    expect(job.status).toBe('failed');
    expect(job.phase).toBe('vegetation');
    expect(job.phases.map(p => p.status)).toEqual(['done', 'done', 'done', 'done', 'failed']);
    expect(job.error).toMatch(new RegExp(`^Rock slab\\(s\\) changed \\(${SLAB_OBJECT}\\) but the vegetation planting failed: .*boom, no surface map`));
    expect(job.phases[4]!.detail).toBe(job.error);
    expect(job.step).toMatch(/^failed \(surface map and grass\): Rock slab/);
    expect(job.result).toBeNull();
    expect(t.events).toEqual(['unity:golfmap.course.refresh', 'unity:golfmap.surfaces.export', 'plant:grass_zones.py']);

    const broken = await setup({ worker, editor: { failSurfaces: true } });
    await blends(broken.exportDir);
    await plantable(broken);
    broken.layers.layers.features = [SLAB];
    const failed = await run(broken.svc);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/but the surface map export in Unity \(golfmap\.surfaces\.export\) failed: .*no terrain named Inner/);
    expect(broken.events).toEqual(['unity:golfmap.course.refresh', 'unity:golfmap.surfaces.export']);
});

test('a changed rock slab with Unity closed or on a dry run: the phase is skipped and says why, nothing is exported or planted', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const closed = await setup({ worker, unity: 'none' });
    await blends(closed.exportDir);
    await plantable(closed);
    closed.layers.layers.global = [];
    closed.layers.layers.features = [SLAB];
    // Loaded earlier (while Unity was open), as in the test above.
    const layersDir = path.join(closed.layersRoot, 'linkan', 'shaping');
    await mkdir(layersDir, { recursive: true });
    // `?wait=1`: the blocking form of the job, so the load is done when the apply starts.
    await fetch(`${worker.url}/load?wait=1`, { method: 'POST', body: JSON.stringify({ blend: path.join(closed.exportDir, 'linkan_svg_1.conformed.blend'), layersDir, fbxFolder: await tmp('fbx-') }) });

    const job = await run(closed.svc);
    expect(job.error).toBeNull();
    expect(job.phases.map(p => p.status)).toEqual(['done', 'done', 'done', 'skipped', 'skipped']);
    const why = `Surface map and grass not updated for 1 rock slab(s): ${SLAB_OBJECT}: Unity was not refreshed`;
    expect(job.phases[4]!.detail).toBe(why);
    expect(job.result!.warnings).toContain(why);
    expect(job.result!.warnings.some(w => w.startsWith('Unity not refreshed: no open Unity editor imports from'))).toBe(true);
    expect(closed.events).toEqual([]);

    const dry = await setup({ worker });
    await blends(dry.exportDir);
    await plantable(dry);
    dry.layers.layers.features = [SLAB];
    const planned = await run(dry.svc, { dryRun: true });
    expect(planned.error).toBeNull();
    expect(planned.phases[4]).toMatchObject({ status: 'skipped', detail: `dry run: the surface map and the grass would be redone for 1 rock slab(s): ${SLAB_OBJECT}` });
    expect(dry.events).toEqual(['unity:golfmap.course.refresh']);
    expect(planned.result!.vegetation).toEqual([]);
});

test('dry run: the worker and Unity plan only', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);
    const job = await run(t.svc, { dryRun: true });
    expect(job.dryRun).toBe(true);
    expect(worker.calls.find(c => c.route === '/sync')!.body).toEqual({ dryRun: true });
    expect(job.result!.exported).toEqual([]);
    expect(t.editor!.calls.at(-1)).toEqual({ command: 'golfmap.course.refresh', args: { only: 'Spline_recipe-10,Spline_recipe-11,Spline_tees', dryRun: true } });
});

test('with Unity closed: a loaded worker still syncs and the refresh is reported skipped; a worker that must load needs an FBX folder', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker, unity: 'none' });
    await blends(t.exportDir);

    const refused = await run(t.svc);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/no FBX folder to export into: open the course's Unity project .*or set GOLFMAP_SHAPING_FBX_FOLDER/);
    expect(worker.calls.some(c => c.route === '/load')).toBe(false);

    // Loaded earlier (e.g. while Unity was open): the sync runs, Unity is skipped.
    const layersDir = path.join(t.layersRoot, 'linkan', 'shaping');
    await fetch(`${worker.url}/load?wait=1`, { method: 'POST', body: JSON.stringify({ blend: path.join(t.exportDir, 'linkan_svg_1.conformed.blend'), layersDir, fbxFolder: await tmp('fbx-') }) });
    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
    expect(job.result!.unityReport).toBeNull();
    expect(job.result!.warnings.some(w => w.startsWith('Unity not refreshed: no open Unity editor imports from'))).toBe(true);
});

test('applies while a run is going queue, and ONE next run serves them all; a pipeline failure fails the job with its last words; no .blend is a clear failure', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner = layersRunner({ global: [TEES], features: [] });
    const t = await setup({ worker, runner: async (args, cwd) => { await gate; return inner.runner(args, cwd); } });
    await blends(t.exportDir);

    const first = await t.svc.apply(TEST_COURSE_ID, { note: 'bd-1' });
    expect(first.queued).toBe(false);
    expect(first.phases[0]!.status).toBe('running');
    const second = await t.svc.apply(TEST_COURSE_ID, { note: 'bd-2' });
    const third = await t.svc.apply(TEST_COURSE_ID, { note: 'bd-3' });
    expect(second).toMatchObject({ queued: true, status: 'running', runId: null, note: 'bd-2' });
    expect(second.step).toMatch(/^queued behind the run for /);
    expect(third.queued).toBe(true);
    expect((await t.svc.status(TEST_COURSE_ID)).job!.id).toBe(first.id);
    release();
    await t.svc.whenIdle();
    expect(t.svc.job(first.id).status).toBe('succeeded');
    const [s2, s3] = [t.svc.job(second.id), t.svc.job(third.id)];
    expect(s2.status).toBe('succeeded');
    expect(s2.runId).not.toBe(t.svc.job(first.id).runId);
    expect(s3.runId).toBe(s2.runId);
    expect(worker.calls.filter(c => c.route === '/sync')).toHaveLength(2);
    expect(s2.slice!.whole).toBe(true);

    inner.failWith('course Linkan has no features');
    const failed = await run(t.svc);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Shaping layers \(gspro.py shaping-global\) failed: .*has no features/);

    inner.failWith(null);
    const empty = await setup({ worker });
    const noBlend = await run(empty.svc);
    expect(noBlend.error).toMatch(/No \.blend in the export folder/);
    await expect(t.svc.apply('no-such-course')).rejects.toBeInstanceOf(NotFoundError);
    expect(() => t.svc.job('nope')).toThrow(NotFoundError);
});

test('two processes share the queue: the one holding the lease serves the other\'s request, which follows it from the files', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner = layersRunner({ global: [TEES], features: [recipe('10')] });
    const a = await setup({ worker, runner: async (args, cwd) => { await gate; return inner.runner(args, cwd); } });
    await blends(a.exportDir);
    const queueDir = path.join(a.dataDir, 'shaping-queue');
    const bRuns: string[][] = [];
    const b = await setup({ worker, queueDir, runner: async (args) => { bRuns.push(args); return { code: 0, stdout: '', stderr: '' }; } });

    const mine = await a.svc.apply(TEST_COURSE_ID, { note: 'bd-1' });
    const theirs = await b.svc.apply(TEST_COURSE_ID, { note: 'bd-2 tee', region: [530000, 6487000, 530050, 6487050] });
    expect(theirs.queued).toBe(true);
    release();
    await a.svc.whenIdle();
    await b.svc.whenIdle();

    const served = b.svc.job(theirs.id);
    expect(served.status).toBe('succeeded');
    expect(served.runId).not.toBe(a.svc.job(mine.id).runId);
    expect(served.result!.changedObjects).toEqual([]);   // the first run already re-shaped what changed
    expect(served.slice).toMatchObject({ whole: false, changedObjects: [] });
    expect(bRuns).toEqual([]);   // B never ran a layer generation: A served it
    expect(worker.calls.filter(c => c.route === '/sync')).toHaveLength(2);
});

test('a lease left by a process that died is taken over, and the request it was running is served again', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);
    const dir = path.join(t.dataDir, 'shaping-queue');
    await mkdir(path.join(dir, 'requests'), { recursive: true });
    const orphan = {
        id: 'orphan-1', courseId: TEST_COURSE_ID, note: 'left behind', region: null, featureIds: [],
        flags: { dryRun: false, paths: false, save: false, skipUnity: false },
        createdAt: new Date(Date.now() - 60_000).toISOString(), pid: 999_999, state: 'running', runId: 'gone', ok: null, error: null,
    };
    await writeFile(path.join(dir, 'requests', 'orphan-1.json'), JSON.stringify(orphan));
    await writeFile(path.join(dir, 'lease.json'), JSON.stringify({ token: 'dead', pid: 999_999, since: orphan.createdAt, heartbeat: Date.now() - 600_000 }));

    const job = await run(t.svc);
    expect(job.status).toBe('succeeded');
    const left = JSON.parse(await Bun.file(path.join(dir, 'requests', 'orphan-1.json')).text());
    expect(left).toMatchObject({ state: 'done', ok: true, runId: job.runId });
    expect(await Bun.file(path.join(dir, 'lease.json')).exists()).toBe(false);
});

test('recipes: the library for a surface with its default; [] while there is no library', async () => {
    expect(await (await setup()).svc.recipes('bunker')).toEqual([]);
    const t = await setup({ library: { recipes: [
        { id: 'conway', name: 'Conway bunker', file: 'cesimgolf-Conway_Bunker_Standard.json', author: 'cesimgolf', surfaces: ['bunker'], default: true, paint: { mesh: { red: 'lip' } } },
        { id: 'pond', name: 'Pond', file: 'golfmap-pond.json', author: 'golfmap', surfaces: ['lake', 'creek', 'moat'], default: 'lake', notes: 'soft banks' },
        { id: 'broken', name: 'no file' },
    ] } });
    expect(await t.svc.recipes('bunker')).toEqual([
        { id: 'conway', name: 'Conway bunker', file: 'cesimgolf-Conway_Bunker_Standard.json', author: 'cesimgolf', surfaces: ['bunker'], default: true, params: [] },
    ]);
    expect(await t.svc.recipes('creek')).toEqual([
        { id: 'pond', name: 'Pond', file: 'golfmap-pond.json', author: 'golfmap', surfaces: ['lake', 'creek'], notes: 'soft banks', params: [] },
    ]);
    expect((await t.svc.recipes('lake'))[0]!.default).toBe(true);
    expect((await t.svc.recipes()).map(r => r.id)).toEqual(['conway', 'pond']);
    expect(await t.svc.recipes('path')).toEqual([]);
});

test("recipes: each entry's declared params (without the engine's maps); malformed ones are dropped", async () => {
    // Params as SHAPING-PLAN.md "Composite and parameterised recipes" declares them; test data only.
    const maps = [{ step: 'bunkerstudio.shape', field: 'depth', mode: 'set' }];
    const t = await setup({ library: { recipes: [
        { id: 'studio', name: 'Studio bunker', file: 'golfmap-studio-bunker.json', author: 'golfmap', surfaces: ['bunker'], params: [
            { id: 'depth', label: 'Depth', unit: 'm', min: 0.2, max: 1.2, step: 0.05, default: 0.45, maps },
            { id: 'lipHeight', label: 'Lip height', unit: '×', min: 0.5, max: 2, step: 0.1, default: 1,
                maps: [{ step: 'bunkereditlip', field: 'bunker_lip_depth', mode: 'scale' }] },
            { id: 'edgeDirt', min: 0, max: 1, default: 0.3 },
            { id: 'depth', label: 'Depth again', min: 0, max: 2, default: 1 },
            { id: 'seed', label: 'Seed', min: 0, max: 99, default: 1 },
            { id: 'faceSteepness', label: 'Upside down', min: 2, max: 1, default: 1.5 },
            { id: 'highSideStrength', label: 'Default outside', min: 0, max: 1, default: 2 },
            { id: 'lipRaggedness', label: 'Bad step', min: 0, max: 1, default: 0.5, step: 0 },
            { label: 'No id', min: 0, max: 1, default: 0 },
            'junk',
        ] },
        { id: 'plain', name: 'Plain', file: 'plain.json', author: 'golfmap', surfaces: ['bunker'], params: 'nope' },
    ] } });
    const [studio, plain] = await t.svc.recipes('bunker');
    expect(studio!.params).toEqual([
        { id: 'depth', label: 'Depth', unit: 'm', min: 0.2, max: 1.2, step: 0.05, default: 0.45 },
        { id: 'lipHeight', label: 'Lip height', unit: '×', min: 0.5, max: 2, step: 0.1, default: 1 },
        { id: 'edgeDirt', label: 'edgeDirt', min: 0, max: 1, default: 0.3 },
    ]);
    expect(plain!.params).toEqual([]);
});

test('the worker protocol: a POST answers with a job id at once, /status and /job/<id> carry it, ?wait=1 answers the run itself', async () => {
    // A load that takes a moment, so the answer really does come back before the work is done.
    const worker = startFakeShapingWorker({ loadMs: 300 });
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    const layersDir = path.join(t.layersRoot, 'linkan', 'shaping');
    await mkdir(layersDir, { recursive: true });
    await writeFile(path.join(layersDir, '00-global.gen.json'), JSON.stringify({ format: 'golfmap-shaping-layer-v1', ops: [TEES] }));
    const post = (route: string, body: unknown) =>
        fetch(`${worker.url}${route}`, { method: 'POST', body: JSON.stringify(body) });

    // /load as a job: {job, kind, state} with 202, and /status carries it until it is done.
    const load = await post('/load', { blend: path.join(t.exportDir, 'x.conformed.blend'), layersDir, fbxFolder: await tmp('fbx-') });
    expect(load.status).toBe(202);
    const started = await load.json() as { job: string; kind: string; state: string };
    expect(started).toEqual({ job: '1', kind: 'load', state: 'running' });
    // A second job while one goes is refused, not queued.
    expect((await post('/sync', {})).status).toBe(409);

    for (;;) {
        const status = await (await fetch(`${worker.url}/status`)).json() as any;
        expect(status.job.id).toBe(started.job);
        if (status.job.state !== 'running') {
            expect(status.job).toMatchObject({ id: '1', kind: 'load', state: 'succeeded', phase: null, error: null });
            expect(typeof status.job.startedAt).toBe('string');
            expect(status.job.seconds).toBeGreaterThanOrEqual(0);
            expect(status.job.result).toMatchObject({ layersDir, appliedOps: 1 });
            break;
        }
        await Bun.sleep(5);
    }
    expect(await (await fetch(`${worker.url}/job/1`)).json()).toMatchObject({ id: '1', kind: 'load', state: 'succeeded' });
    expect((await fetch(`${worker.url}/job/nope`)).status).toBe(404);

    // `?wait=1`: the old blocking shape, the run as the answer.
    const run = await (await post('/sync?wait=1', {})).json() as { changedObjects: string[] };
    expect(run.changedObjects).toEqual(['Spline_tees']);
    expect(await (await fetch(`${worker.url}/job/2`)).json()).toMatchObject({ id: '2', kind: 'sync', state: 'succeeded' });
});

test('a worker that wants a token: the service sends it, and without it the job fails saying so', async () => {
    const worker = startFakeShapingWorker({ token: 'sekret' });
    cleanup.push(() => worker.stop());
    const t = await setup({ worker, token: 'sekret' });
    await blends(t.exportDir);

    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.worker.reachable).toBe(true);
    expect(status.worker.job).toMatchObject({ kind: 'sync', state: 'succeeded' });

    // The same worker without the secret: every call is refused.
    const blind = await setup({ worker });
    await blends(blind.exportDir);
    const refused = await run(blind.svc);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/X-Golfmap-Token is missing or wrong/);
    expect((await blind.svc.status(TEST_COURSE_ID)).worker.state).toBe('error');
    expect((await fetch(`${worker.url}/status`, { headers: { 'X-Golfmap-Token': 'sekret' } })).ok).toBe(true);
});

test("another course's worker on the port is waited for, never taken over mid-run", async () => {
    const worker = startFakeShapingWorker({ loadMs: 400 });
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);
    const otherLayers = await tmp('other-layers-');
    const other = (n: number) => path.join(otherLayers, `other_${n}.conformed.blend`);

    // It holds another course and is busy loading a third: ours has to wait.
    await fetch(`${worker.url}/load?wait=1`, { method: 'POST', body: JSON.stringify({ blend: other(1), layersDir: otherLayers, fbxFolder: await tmp('fbx-') }) });
    await fetch(`${worker.url}/load`, { method: 'POST', body: JSON.stringify({ blend: other(2), layersDir: otherLayers, fbxFolder: await tmp('fbx-') }) });

    const started = await t.svc.apply(TEST_COURSE_ID);
    const seen: string[] = [];
    let job = started;
    while (job.status === 'running') {
        const detail = job.phases.find(p => p.id === job.phase)?.detail;
        if (detail && seen.at(-1) !== detail) seen.push(detail);
        await Bun.sleep(10);
        job = t.svc.job(started.id);
    }
    expect(job.error).toBeNull();
    // The line names the .blend it is busy on, with the worker's own phase after it.
    expect(seen.some(l => l.startsWith(`another course's worker is busy on ${other(1)} — waiting`))).toBe(true);
    // Only once it was idle did ours load — and no /load went in while it was busy.
    const loads = worker.calls.filter(c => c.route === '/load').map(c => c.body.blend);
    expect(loads).toEqual([other(1), other(2), path.join(t.exportDir, 'linkan_svg_1.conformed.blend')]);
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
});

test('save: the Unity refresh of a job started with save saves the scene, and the planting after a slab too', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);
    await plantable(t);
    t.layers.layers.features = [recipe('10'), SLAB];

    const job = await run(t.svc, { save: true });
    expect(job.error).toBeNull();
    const refresh = t.editor!.calls.find(c => c.command === 'golfmap.course.refresh')!;
    expect(refresh.args).toMatchObject({ save: true });
    expect(t.editor!.calls.find(c => c.command === 'golfmap.zones.import')!.args).toMatchObject({ save: true });
    expect(t.editor!.calls.find(c => c.command === 'golfmap.grass.apply')!.args).toMatchObject({ save: true });
    // The surface map export is not one of the commands that take `save` (unity/README.md).
    expect(t.editor!.calls.find(c => c.command === 'golfmap.surfaces.export')!.args).toEqual({ terrain: 'inner' });

    // Without it, nothing is saved: the operator's own Ctrl+S, as before.
    t.editor!.calls.length = 0;
    t.layers.layers.features = [recipe('11'), SLAB];
    await run(t.svc);
    expect(t.editor!.calls.every(c => c.args.save === undefined)).toBe(true);
});

test('a /status blip while the worker syncs is ridden out; past the grace the job says it stopped answering', async () => {
    // The worker's /status drops out for the first polls of the sync — what bpy holding the GIL
    // (the 5 s timeout), or a blip to a worker on another machine, looks like. The sync goes on.
    const worker = startFakeShapingWorker({ syncMs: 400, statusOutages: 4 });
    cleanup.push(() => worker.stop());
    const t = await setup({ worker });
    await blends(t.exportDir);

    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
    // The polls that were dropped really did happen during the sync.
    expect(worker.calls.filter(c => c.route === '/status').length).toBeGreaterThan(4);
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['layers', 'done'], ['worker', 'done'], ['blender', 'done'], ['unity', 'done'], ['vegetation', 'skipped']]);

    // With no grace at all the first blip ends the wait, and the message says what it was.
    const flaky = startFakeShapingWorker({ syncMs: 400, statusOutages: 1 });
    cleanup.push(() => flaky.stop());
    const strict = await setup({ worker: flaky, timeouts: { unreachableMs: 0 } });
    await blends(strict.exportDir);
    const failed = await run(strict.svc);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^The shaping worker stopped answering during the sync \(0 s with no answer about job \d+\): HTTP 503$/);
    expect(failed.phase).toBe('blender');
});

test('status with nothing on the worker URL: unreachable, no job', async () => {
    const t = await setup();
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.worker).toMatchObject({ url: 'http://127.0.0.1:9', reachable: false, state: null, spawnedPid: null });
    expect(status.job).toBeNull();
    await expect(t.svc.status('no-such-course')).rejects.toBeInstanceOf(NotFoundError);
});
