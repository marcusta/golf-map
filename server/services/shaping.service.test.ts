// ShapingService against a stand-in shaping worker on its real HTTP contract
// (testing/fake-shaping-worker.ts: in-process, or spawned as a real process
// for the on-demand start) and a stand-in Unity editor on the bridge
// protocol. The pipeline is the runner seam (as in the GSPro export tests): it
// writes the layer files gspro.py shaping-global would.
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { test, expect, afterEach } from 'bun:test';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { startFakeShapingWorker, type FakeShapingWorker } from '../testing/fake-shaping-worker';
import { ShapingService, objectName } from './shaping.service';
import { defaultUnityBridge } from './unity-bridge';
import type { ExportRunner } from './gspro-export.service';

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

/** A Unity editor whose active course exports to `exportFolder`, on the bridge protocol. */
function fakeEditor(exportFolder: string, opts: { rejectOnly?: boolean; refreshMs?: number; steps?: object[] } = {}) {
    const calls: Array<{ command: string; args: any }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (req.headers.get('X-Bridge-Token') !== 'tok') return Response.json({ ok: false, error: 'token' }, { status: 403 });
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            const args = await req.json();
            calls.push({ command, args });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder } } });
            if (command === 'golfmap.course.refresh') {
                if (opts.rejectOnly && 'only' in args) return Response.json({ ok: false, error: "unknown argument 'only' for golfmap.course.refresh" });
                await Bun.sleep(opts.refreshMs ?? 0);
                return Response.json({ ok: true, result: { steps: opts.steps ?? [{ id: 'meshes.sync', status: 'done' }], only: args.only ?? null } });
            }
            return Response.json({ ok: false, error: `unknown ${command}` });
        },
    });
    cleanup.push(() => server.stop(true));
    return { calls, server };
}

async function setup(opts: {
    worker?: FakeShapingWorker; workerUrl?: string; workerLauncher?: string[]; unity?: 'ours' | 'none' | 'reject-only';
    library?: unknown; runner?: ExportRunner; editor?: { refreshMs?: number; steps?: object[] };
} = {}) {
    const ctx = await createTestDb(seedCourse);
    const exportDir = await tmp('shaping-export-');
    await ctx.gsproExportService.setDir(TEST_COURSE_ID, exportDir);
    const project = await tmp('unity-proj-');
    const discovery = await tmp('bridges-');
    let editor: ReturnType<typeof fakeEditor> | null = null;
    if (opts.unity !== 'none') {
        editor = fakeEditor(path.relative(path.join(project, 'Assets'), exportDir), { rejectOnly: opts.unity === 'reject-only', ...opts.editor });
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
    const svc = new ShapingService({
        courses: ctx.coursesService, exportSettings: ctx.gsproExportService, dataDir,
        pipelineDir: '/pipeline', runner: opts.runner ?? layers.runner, unityBridge: defaultUnityBridge(discovery),
        workerUrl: opts.worker?.url ?? opts.workerUrl ?? 'http://127.0.0.1:9', workerLauncher: opts.workerLauncher,
        layersRoot, recipeLibrary, dbPath: '/data/app.sqlite',
        timeouts: { pollMs: 25, startMs: 20_000, loadMs: 20_000, syncMs: 20_000, unitySec: 30 },
    });
    cleanup.push(() => svc.stopWorker());
    return { ctx, svc, exportDir, project, layersRoot, recipeLibrary, layers, editor, dataDir };
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

async function run(svc: ShapingService, opts: { dryRun?: boolean; skipUnity?: boolean } = {}) {
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

    await t.svc.stopWorker();
    expect((await t.svc.status(TEST_COURSE_ID)).worker.reachable).toBe(false);
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
    expect(started.phases.map(p => [p.id, p.status])).toEqual([['layers', 'running'], ['worker', 'pending'], ['blender', 'pending'], ['unity', 'pending']]);
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
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['layers', 'done'], ['worker', 'done'], ['blender', 'done'], ['unity', 'done']]);
    expect(job.phases[1]!.detail).toBe('cold start: Blender started and loaded linkan_svg_1.conformed.blend');
    expect(job.phases[2]!.detail).toBe('3 object(s) re-shaped, 3 FBX exported');
    expect(job.phases.every(p => typeof p.seconds === 'number')).toBe(true);
    expect(job.phases[1]!.seconds!).toBeGreaterThanOrEqual(0.5);
    expect(job.phases[3]!.seconds!).toBeGreaterThanOrEqual(0.3);
    expect(job.seconds).toBeGreaterThanOrEqual(job.phases[1]!.seconds! + job.phases[3]!.seconds!);
    expect(job.result!.unitySteps).toEqual(steps);
    expect(job.finishedAt).not.toBeNull();

    // Warm: the worker holds the course; nothing changed, so Unity is skipped (and says why).
    const again = await run(t.svc);
    expect(again.phases.map(p => [p.id, p.status])).toEqual([['layers', 'done'], ['worker', 'done'], ['blender', 'done'], ['unity', 'skipped']]);
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
    expect(job.phases.map(p => p.status)).toEqual(['done', 'failed', 'pending', 'pending']);
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
    await fetch(`${worker.url}/load`, { method: 'POST', body: JSON.stringify({ blend: path.join(t.exportDir, 'linkan_svg_1.conformed.blend'), layersDir, fbxFolder: await tmp('fbx-') }) });
    const job = await run(t.svc);
    expect(job.error).toBeNull();
    expect(job.result!.changedObjects).toEqual(['Spline_recipe-10', 'Spline_recipe-11', 'Spline_tees']);
    expect(job.result!.unityReport).toBeNull();
    expect(job.result!.warnings.some(w => w.startsWith('Unity not refreshed: no open Unity editor imports from'))).toBe(true);
});

test('one apply at a time; a pipeline failure fails the job with its last words; no .blend is a clear failure', async () => {
    const worker = startFakeShapingWorker();
    cleanup.push(() => worker.stop());
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner = layersRunner({ global: [TEES], features: [] });
    const t = await setup({ worker, runner: async (args, cwd) => { await gate; return inner.runner(args, cwd); } });
    await blends(t.exportDir);

    const first = await t.svc.apply(TEST_COURSE_ID);
    await expect(t.svc.apply(TEST_COURSE_ID)).rejects.toBeInstanceOf(ConflictError);
    expect((await t.svc.status(TEST_COURSE_ID)).job!.status).toBe('running');
    release();
    await t.svc.whenIdle();
    expect(t.svc.job(first.id).status).toBe('succeeded');

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

test('status with nothing on the worker URL: unreachable, no job', async () => {
    const t = await setup();
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.worker).toMatchObject({ url: 'http://127.0.0.1:9', reachable: false, state: null, spawnedPid: null });
    expect(status.job).toBeNull();
    await expect(t.svc.status('no-such-course')).rejects.toBeInstanceOf(NotFoundError);
});
