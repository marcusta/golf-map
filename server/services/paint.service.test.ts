// PaintService against the real migrated DB, the real pipeline Python (shape_paintpreview.py, gspro.py
// shaping-paint) and a stand-in Unity editor on the bridge protocol that answers golfmap.paint.meshes /
// .preview / .clear the way the GolfMap commands do. No Unity, no Blender.
import { test, expect, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { ShapingService, type ShapingApplyOptions, type ShapingJob } from './shaping.service';
import { defaultUnityBridge } from './unity-bridge';
import {
    PAINT_LAYER_FILE, PAINT_LAYER_LIVE, PaintError, PaintService, normaliseStroke, paintJson, strokeBox,
} from './paint.service';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
}, 60_000);

async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

/** The test frame: the inner square's SW corner is Unity's origin (Unity x = E - E0, z = N - N0). */
const E0 = 529000;
const N0 = 6487000;
const ROUGH = 'Spline_hole_1_3_Rough_-_Mesh';
const FAIRWAY = 'Spline_hole_1_4_Fairway_-_Mesh';

/** A flat grid mesh as golfmap.paint.meshes sends it: Unity world positions, red colours, triangles. */
function gridMesh(object: string, x0: number, z0: number, nx: number, nz: number) {
    const pos: number[] = [];
    const col: number[] = [];
    const tri: number[] = [];
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            pos.push(x0 + i, 0, z0 + j);
            col.push(1, 0, 0, 1);
        }
    }
    for (let j = 0; j < nz - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i;
            tri.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
        }
    }
    const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    return {
        object, surface: object.includes('Rough') ? 'Rough' : 'Fairway', vertexCount: nx * nz,
        positions: b64(new Float32Array(pos)), colors: b64(new Float32Array(col)), triangles: b64(new Int32Array(tri)),
    };
}

function decodeColours(b64: string): number[][] {
    const buf = Buffer.from(b64, 'base64');
    const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const out: number[][] = [];
    for (let i = 0; i < f.length; i += 4) out.push([f[i]!, f[i + 1]!, f[i + 2]!, f[i + 3]!]);
    return out;
}

/** A Unity editor whose active course exports to `exportFolder`, holding a rough (x 0..20, z 0..10) and a fairway beyond it. */
function fakeEditor(exportFolder: string) {
    const calls: Array<{ command: string; args: any }> = [];
    const meshes = [gridMesh(ROUGH, 0, 0, 21, 11), gridMesh(FAIRWAY, 40, 0, 5, 5)];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (req.headers.get('X-Bridge-Token') !== 'tok') return Response.json({ ok: false, error: 'token' }, { status: 403 });
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            const args = await req.json();
            calls.push({ command, args });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder } } });
            if (command === 'golfmap.paint.meshes') {
                const [minE, minN, maxE, maxN] = args.within as number[];
                const hit = meshes.filter(m => {
                    const x0 = m.object === ROUGH ? 0 : 40;
                    const x1 = m.object === ROUGH ? 20 : 44;
                    const z1 = m.object === ROUGH ? 10 : 4;
                    return x0 + E0 <= maxE! && x1 + E0 >= minE! && N0 <= maxN! && z1 + N0 >= minN!;
                });
                return Response.json({ ok: true, result: { course: 'Linkan', meshes: hit } });
            }
            if (command === 'golfmap.paint.preview') {
                return Response.json({ ok: true, result: { previewed: args.objects.map((o: any) => o.object), skipped: [] } });
            }
            if (command === 'golfmap.paint.clear') return Response.json({ ok: true, result: { cleared: args.objects ?? [] } });
            return Response.json({ ok: false, error: `unknown ${command}` });
        },
    });
    cleanup.push(() => server.stop(true));
    return { calls, server };
}

async function setup(opts: { unity?: boolean; layerLive?: boolean } = {}) {
    const ctx = await createTestDb(seedCourse);
    const exportDir = await tmp('paint-out-');
    await ctx.gsproExportService.setDir(TEST_COURSE_ID, exportDir);
    await writeFile(path.join(exportDir, 'linkan-inner-dem-100m.tif.json'), JSON.stringify({
        square3006: [E0, N0, E0 + 100, N0 + 100], minM: 0, unity: { position: { x: 0, y: 0, z: 0 } },
    }));
    const discovery = await tmp('bridges-');
    const project = await tmp('unity-proj-');
    let editor: ReturnType<typeof fakeEditor> | null = null;
    if (opts.unity !== false) {
        editor = fakeEditor(path.relative(path.join(project, 'Assets'), exportDir));
        writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({
            pid: process.pid, port: editor.server.port, token: 'tok', projectPath: project, projectName: 'linkan_v4', unityVersion: '2018.2.8f1', started: '',
        }));
    }
    const docsRoot = await tmp('paint-docs-');
    const shaping = new ShapingService({ courses: ctx.coursesService, exportSettings: ctx.gsproExportService, dataDir: await tmp('paint-data-'), layersRoot: docsRoot });
    const applied: Array<{ courseId: string; opts: ShapingApplyOptions | undefined }> = [];
    const svc = new PaintService({
        courses: ctx.coursesService, exportSettings: ctx.gsproExportService,
        // The shaping apply is its own suite's; here it only has to be asked for.
        shaping: {
            layersDir: id => shaping.layersDir(id),
            apply: async (courseId, o) => {
                applied.push({ courseId, opts: o });
                return { id: 'req-1', status: 'running' } as ShapingJob;
            },
        },
        unityBridge: defaultUnityBridge(discovery), layerLive: opts.layerLive ?? false,
    });
    const docsDir = path.join(docsRoot, 'linkan');
    return { ctx, svc, exportDir, editor, docsDir, applied };
}

/** A 10 m black line across the rough, 2 m wide with a 2 m feather. */
const LINE = {
    geometry: 'line' as const, points3006: [[E0 + 5, N0 + 5], [E0 + 15, N0 + 5]] as [number, number][],
    widthM: 2, featherM: 2, channel: 'black' as const,
};

const exists = (p: string) => stat(p).then(() => true, () => false);

test('the switch is off: Unity still paints by rules', () => {
    expect(PAINT_LAYER_LIVE).toBe(false);
}, 60_000);

test('a dry run fetches the meshes in the stroke box, computes the colours and sends the preview, writing nothing', async () => {
    const t = await setup();
    const r = await t.svc.stroke(TEST_COURSE_ID, LINE, { dryRun: true });

    const fetch = t.editor!.calls.find(c => c.command === 'golfmap.paint.meshes')!;
    expect(fetch.args.within).toEqual([E0 + 2, N0 + 2, E0 + 18, N0 + 8]);
    expect(r.preview.status).toBe('shown');
    expect(r.preview.meshes).toBe(1);
    expect(r.preview.previewed).toEqual([ROUGH]);

    const sent = t.editor!.calls.find(c => c.command === 'golfmap.paint.preview')!;
    expect(sent.args.objects).toHaveLength(1);
    const colours = decodeColours(sent.args.objects[0].colors);
    expect(colours).toHaveLength(21 * 11);
    // Unity (10, 5) is on the line: black; (10, 9) is 4 m off it: red as the FBX has it
    expect(colours[5 * 21 + 10]).toEqual([0, 0, 0, 1]);
    expect(colours[9 * 21 + 10]).toEqual([1, 0, 0, 1]);
    // in the feather: between
    const fade = colours[7 * 21 + 10]![0]!;
    expect(fade).toBeGreaterThan(0);
    expect(fade).toBeLessThan(1);

    expect(r.saved).toBe(false);
    expect(r.id).toBe('stroke-1');
    expect(await exists(path.join(t.docsDir, 'paint.json'))).toBe(false);
}, 60_000);

test('a save writes paint.json and checks the layer without writing it while the layer is not live', async () => {
    const t = await setup();
    const r = await t.svc.stroke(TEST_COURSE_ID, LINE);
    expect(r.saved).toBe(true);
    expect(r.preview.status).toBe('shown');
    const doc = JSON.parse(await readFile(path.join(t.docsDir, 'paint.json'), 'utf8'));
    expect(doc.format).toBe('golfmap-paint-v1');
    expect(doc.strokes).toEqual([{ id: 'stroke-1', ...LINE }]);
    expect(r.layer.written).toBe(false);
    expect(r.layer.note).toContain('not live');
    expect(r.layer.ops).toBe(2); // the lake bed (on by default) and the stroke
    expect(await exists(path.join(t.docsDir, 'shaping', PAINT_LAYER_FILE))).toBe(false);

    const list = await t.svc.list(TEST_COURSE_ID);
    expect(list.strokes.map(s => s.id)).toEqual(['stroke-1']);
    expect(list.layerLive).toBe(false);
}, 60_000);

test('with the layer live a save regenerates 90-paint.gen.json with the stroke as an op', async () => {
    const t = await setup({ layerLive: true });
    const r = await t.svc.stroke(TEST_COURSE_ID, { ...LINE, id: 'path-wear' });
    expect(r.layer.written).toBe(true);
    const layer = JSON.parse(await readFile(path.join(t.docsDir, 'shaping', PAINT_LAYER_FILE), 'utf8'));
    expect(layer.ops.map((o: any) => o.id)).toEqual(['paint-lakebed', 'paint-stroke-path-wear']);
    expect(layer.ops[1].rule).toMatchObject({ kind: 'stroke', geometry: 'line', channel: 'black', widthM: 2 });
}, 60_000);

/** The colour Unity was sent for the rough's vertex at Unity (10, 5), on both lines, in the last preview. */
function previewedAtLine(editor: ReturnType<typeof fakeEditor>): number[] {
    const sent = editor.calls.filter(c => c.command === 'golfmap.paint.preview').at(-1)!;
    return decodeColours(sent.args.objects[0].colors)[5 * 21 + 10]!.map(v => Math.round(v * 255) / 255);
}

test('layer not live: the FBX colours carry no rule paint, so every enabled stroke goes on top of them', async () => {
    const t = await setup();
    await t.svc.stroke(TEST_COURSE_ID, LINE); // black
    await t.svc.stroke(TEST_COURSE_ID, { ...LINE, id: 'b', channel: 'blue', strength: 0.5 }, { dryRun: true });
    // black, then half way to blue
    expect(previewedAtLine(t.editor!)).toEqual([0, 0, 128 / 255, 1]);
}, 60_000);

test('layer live: only what the change adds goes on the FBX colours; a removal goes back to the FBX until the sync', async () => {
    const t = await setup({ layerLive: true });
    await t.svc.stroke(TEST_COURSE_ID, LINE);
    const b = await t.svc.stroke(TEST_COURSE_ID, { ...LINE, id: 'b', channel: 'blue', strength: 0.5 }, { dryRun: true });
    // red as the FBX has it (stroke-1 is in it already), half way to blue; no other preview cleared
    expect(previewedAtLine(t.editor!)).toEqual([128 / 255, 0, 128 / 255, 1]);
    expect(b.preview.cleared).toEqual([]);
    expect(t.editor!.calls.some(c => c.command === 'golfmap.paint.clear')).toBe(false);

    const replaced = await t.svc.stroke(TEST_COURSE_ID, { ...LINE, id: 'stroke-1', channel: 'green' });
    expect(previewedAtLine(t.editor!)).toEqual([0, 1, 0, 1]);
    expect(replaced.warnings).toContain("stroke-1: the old version's paint stays visible until the next sync");

    const previews = t.editor!.calls.filter(c => c.command === 'golfmap.paint.preview').length;
    const removed = await t.svc.remove(TEST_COURSE_ID, 'stroke-1');
    expect(t.editor!.calls.filter(c => c.command === 'golfmap.paint.preview')).toHaveLength(previews);
    expect(t.editor!.calls.at(-1)).toEqual({ command: 'golfmap.paint.clear', args: { objects: [ROUGH] } });
    expect(removed.preview.cleared).toEqual([ROUGH]);
    expect(removed.warnings).toContain('stroke-1: shows after the next sync (--sync); until then the meshes there are back to their FBX');
    const layer = JSON.parse(await readFile(path.join(t.docsDir, 'shaping', PAINT_LAYER_FILE), 'utf8'));
    expect(layer.ops.map((o: any) => o.id)).toEqual(['paint-lakebed']);
}, 60_000);

test('with Unity closed the change is saved and the preview reported skipped', async () => {
    const t = await setup({ unity: false });
    const r = await t.svc.stroke(TEST_COURSE_ID, LINE);
    expect(r.saved).toBe(true);
    expect(r.preview.status).toBe('skipped');
    expect(r.warnings.some(w => w.startsWith('preview skipped: Unity closed'))).toBe(true);
}, 60_000);

test('a bad stroke or rule is refused before anything is written', async () => {
    const t = await setup();
    await expect(t.svc.stroke(TEST_COURSE_ID, { ...LINE, channel: 'purple' as 'black' })).rejects.toThrow(PaintError);
    await expect(t.svc.stroke(TEST_COURSE_ID, { ...LINE, mode: 'overlay' })).rejects.toThrow('black has no overlay');
    // the engine's own check (shape_paintrules.normalise)
    await expect(t.svc.ruleSet(TEST_COURSE_ID, { id: 'walls', kind: 'edge', edge: 'wall' })).rejects.toThrow("edge 'wall' is not supported");
    expect(await exists(path.join(t.docsDir, 'paint.json'))).toBe(false);
}, 60_000);

test('remove puts a mesh the stroke painted back to its FBX colours; rules are set, disabled and removed by id', async () => {
    const t = await setup();
    await t.svc.stroke(TEST_COURSE_ID, LINE);
    const removed = await t.svc.remove(TEST_COURSE_ID, 'stroke-1');
    expect(removed.preview.cleared).toEqual([ROUGH]);
    expect((await t.svc.list(TEST_COURSE_ID)).strokes).toEqual([]);

    const rule = { id: 'rough-roads', kind: 'road' as const, channel: 'black', surfaces: ['Rough', 'Deep'] };
    await t.svc.ruleSet(TEST_COURSE_ID, rule);
    // a rule previews over the whole inner square
    expect(t.editor!.calls.filter(c => c.command === 'golfmap.paint.meshes').at(-1)!.args.within).toEqual([E0, N0, E0 + 100, N0 + 100]);
    await t.svc.ruleDisable(TEST_COURSE_ID, 'rough-roads');
    expect((await t.svc.list(TEST_COURSE_ID)).rules).toEqual([{ ...rule, enabled: false }]);
    await t.svc.remove(TEST_COURSE_ID, 'rough-roads');
    expect((await t.svc.list(TEST_COURSE_ID)).rules).toEqual([]);
    await expect(t.svc.remove(TEST_COURSE_ID, 'nope')).rejects.toThrow("No paint rule or stroke 'nope'");
}, 60_000);

test('sync asks for the shaping apply after the save; edits to one course run one at a time', async () => {
    const t = await setup({ unity: false });
    const [a, b] = await Promise.all([
        t.svc.stroke(TEST_COURSE_ID, LINE, { sync: true }),
        t.svc.stroke(TEST_COURSE_ID, { ...LINE, channel: 'blue' }),
    ]);
    expect(a.sync).toEqual({ jobId: 'req-1', status: 'running' });
    expect(t.applied).toEqual([{ courseId: TEST_COURSE_ID, opts: { note: 'paint stroke stroke-1' } }]);
    expect(a.warnings).toContain('sync: the paint layer is not live yet, so this sync does not paint');
    expect([a.id, b.id]).toEqual(['stroke-1', 'stroke-2']);
    expect((await t.svc.list(TEST_COURSE_ID)).strokes.map(s => s.channel)).toEqual(['black', 'blue']);
}, 60_000);

test('an existing paint.json keeps its rules and notes; short arrays stay on one line', async () => {
    const t = await setup({ unity: false });
    const before = {
        format: 'golfmap-paint-v1', notes: ['keep me'],
        rules: [{ id: 'bunker-surround', enabled: false, kind: 'edge', edge: 'bunker', surfaces: ['Rough'], channel: 'blue', mode: 'overlay', widthM: 2.2 }],
    };
    await Bun.write(path.join(t.docsDir, 'paint.json'), paintJson(before));
    await t.svc.stroke(TEST_COURSE_ID, { geometry: 'circle', centre3006: [E0 + 10.004, N0 + 5], radiusM: 3, channel: 'green', strength: 0.5 });
    const text = await readFile(path.join(t.docsDir, 'paint.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ ...before, strokes: [{ id: 'stroke-1', geometry: 'circle', centre3006: [E0 + 10, N0 + 5], radiusM: 3, channel: 'green', strength: 0.5 }] });
    expect(text).toContain('"surfaces": ["Rough"],');
    expect(text).toContain(`"centre3006": [${E0 + 10}, ${N0 + 5}],`);
}, 60_000);

test('normaliseStroke and strokeBox', () => {
    expect(() => normaliseStroke({ id: 'a b', geometry: 'line', channel: 'red' })).toThrow('needs an id');
    expect(() => normaliseStroke({ id: 'a', geometry: 'line', points3006: [[1, 2]], channel: 'red' })).toThrow('>= 2');
    expect(() => normaliseStroke({ id: 'a', geometry: 'polygon', points3006: [[1, 2], [3, 4], [5, 6]], channel: 'red', widthM: 2 })).toThrow("line's width");
    expect(() => normaliseStroke({ id: 'a', geometry: 'circle', centre3006: [1, 2], radiusM: 1, channel: 'red', colour: 1 })).toThrow('unknown key');
    expect(normaliseStroke({ id: 'a', geometry: 'polygon', points3006: [[1, 2], [3, 4], [5, 6]], channel: 'red', surfaces: ['rough'], enabled: true }))
        .toEqual({ id: 'a', geometry: 'polygon', points3006: [[1, 2], [3, 4], [5, 6]], channel: 'red', surfaces: ['Rough'] });
    expect(strokeBox({ id: 'c', geometry: 'circle', centre3006: [100, 200], radiusM: 2, channel: 'red' })).toEqual([97.5, 197.5, 102.5, 202.5]);
    expect(strokeBox({ id: 'p', geometry: 'polygon', points3006: [[0, 0], [10, 0], [0, 10]], featherM: 0, channel: 'red' })).toEqual([0, 0, 10, 10]);
}, 60_000);
