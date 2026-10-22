// CourseCheckService against the real migrated DB and service graph, with the
// two seams the GSPro suites use: a stand-in Unity editor on the bridge
// protocol (it answers `golfmap.course.check` by writing a report as the real
// command does) and the fake shaping worker (testing/fake-shaping-worker.ts,
// whose `/check` writes the Blender layer's report). No Unity, no Blender.
import { test, expect, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { ConflictError } from '@basics/core/server/auth';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { startFakeShapingWorker } from '../testing/fake-shaping-worker';
import { ShapingService } from './shaping.service';
import { defaultUnityBridge } from './unity-bridge';
import { SYNC_RECORD_FILE, SYNC_RECORD_FORMAT } from './gspro-sync.service';
import { BLENDER_REPORT, CourseCheckService, UNITY_REPORT } from './course-check.service';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
});

async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

/** The seeded course is "Linkan": its prefix, and so its boundary file. */
const BOUNDARY = 'linkan-oob.json';

/**
 * A Unity editor whose active course exports to `exportFolder`. Its
 * `golfmap.course.check` writes `<exportDir>/course-check.json` the way
 * GolfMapCourseCheck does (two errors, one warning, an info) and answers the
 * summary with the report path; `holdCheck` keeps it from answering.
 */
function fakeEditor(exportFolder: string, exportDir: string, opts: { holdCheck?: Promise<void> } = {}) {
    const calls: Array<{ command: string; args: any }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (req.headers.get('X-Bridge-Token') !== 'tok') return Response.json({ ok: false, error: 'token' }, { status: 403 });
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            const args = await req.json();
            calls.push({ command, args });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder } } });
            if (command === 'golfmap.course.check') {
                if (opts.holdCheck) await opts.holdCheck;
                const findings = [
                    { type: 'crack', severity: 'error', hole: '3', note: '12 cm crack', objects: ['Spline_hole_3_1a_Fairway_-_Mesh'], points: 4, unity: [1, 2, 3], epsg3006: [529100.5, 6487100.25] },
                    { type: 'info-thing', severity: 'info', hole: null, note: 'fyi', objects: [], points: 1, unity: [0, 0, 0] },
                    { type: 'step', severity: 'warn', hole: '3', note: '3 cm step', objects: ['A', 'B'], points: 9, unity: [4, 5, 6], epsg3006: [529104, 6487106] },
                    { type: 'gap', severity: 'error', hole: null, note: 'gap over the terrain', objects: [], points: 30, unity: [7, 8, 9], epsg3006: [529107, 6487109] },
                ];
                const report = {
                    format: 'golfmap-course-check-v1', scene: 'Linkan', generated: new Date().toISOString(),
                    ok: false, errors: 2, warnings: 1, hole: args.hole ?? null,
                    area: args.all ? 'all course meshes' : `${path.basename(args.boundary)} + ${args.marginM} m`,
                    meshes: 412, cellM: args.cell ?? 0.5,
                    counts: { crack: { findings: 1, severity: 'error', points: 4 }, gap: { findings: 1, severity: 'error', points: 30 }, step: { findings: 1, severity: 'warn', points: 9 } },
                    seconds: { objects: 2.1, grid: 20.4, seams: 28, total: 30.2 },
                    findings,
                };
                const file = path.join(exportDir, 'course-check.json');
                await writeFile(file, JSON.stringify(report));
                const { findings: _all, ...summary } = report;
                return Response.json({ ok: true, result: { ...summary, report: file, findings: findings.slice(0, 1) } });
            }
            if (command === 'golfmap.review.load') return Response.json({ ok: true, result: { places: 3 } });
            return Response.json({ ok: false, error: `unknown ${command}` });
        },
    });
    cleanup.push(() => server.stop(true));
    return { calls, server };
}

async function setup(opts: { unity?: boolean; worker?: 'ours' | 'other' | 'none'; holdCheck?: Promise<void> } = {}) {
    const ctx = await createTestDb(seedCourse);
    const exportDir = await tmp('course-check-out-');
    await ctx.gsproExportService.setDir(TEST_COURSE_ID, exportDir);
    const discovery = await tmp('bridges-');
    const project = await tmp('unity-proj-');
    let editor: ReturnType<typeof fakeEditor> | null = null;
    if (opts.unity !== false) {
        editor = fakeEditor(path.relative(path.join(project, 'Assets'), exportDir), exportDir, { holdCheck: opts.holdCheck });
        writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({
            pid: process.pid, port: editor.server.port, token: 'tok', projectPath: project, projectName: 'linkan_v4', unityVersion: '2018.2.8f1', started: '',
        }));
    }
    // The worker, loaded with this course's .blend (or another folder's): one layer op, so its check finds one step.
    let workerUrl = 'http://127.0.0.1:9';
    let worker: ReturnType<typeof startFakeShapingWorker> | null = null;
    if ((opts.worker ?? 'none') !== 'none') {
        const layersDir = await tmp('course-check-layers-');
        await writeFile(path.join(layersDir, '00-global.gen.json'), JSON.stringify({ ops: [{ id: 'tee-1a' }] }));
        const blendDir = opts.worker === 'ours' ? exportDir : await tmp('other-course-');
        worker = startFakeShapingWorker({ blend: path.join(blendDir, 'linkan_svg_3.blend'), layersDir });
        cleanup.push(() => worker!.stop());
        workerUrl = worker.url;
    }
    const dataDir = await tmp('course-check-data-');
    const shaping = new ShapingService({
        courses: ctx.coursesService, exportSettings: ctx.gsproExportService, dataDir, workerUrl,
        timeouts: { pollMs: 20, startMs: 5000, syncMs: 5000 },
    });
    const svc = new CourseCheckService({
        db: ctx.db, courses: ctx.coursesService, exports: ctx.gsproExportService, shaping, unityBridge: defaultUnityBridge(discovery),
    });
    // Until the fake worker's own load is through.
    if (worker) for (let i = 0; i < 100 && (await shaping.workerStatus()).state !== 'ready'; i++) await Bun.sleep(10);
    return { ctx, svc, exportDir, editor, worker };
}

/** A drawn course boundary: a 100 m B-spline square of control points. */
async function drawBoundary(t: Awaited<ReturnType<typeof setup>>) {
    const pts = [[529000, 6487000], [529100, 6487000], [529100, 6487100], [529000, 6487100]].map(([x, y]) => ({ x: x! + 0.123456, y: y! + 0.987654 }));
    await t.ctx.courseFeaturesService.create({
        courseId: TEST_COURSE_ID, type: 'oob', geometry: { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points: pts }] },
    });
}

test('writeBoundary flattens the oob feature into <prefix>-oob.json, rounded to the centimetre', async () => {
    const t = await setup({ unity: false });
    await drawBoundary(t);
    const written = await t.svc.writeBoundary(TEST_COURSE_ID);
    expect(written.path).toBe(path.join(t.exportDir, BOUNDARY));
    expect(written.rings).toBe(1);
    const doc = JSON.parse(await readFile(written.path!, 'utf8'));
    expect(doc.format).toBe('golfmap-oob-v1');
    expect(doc.crs).toBe('EPSG:3006');
    expect(doc.rings).toHaveLength(1);
    const ring = doc.rings[0] as number[][];
    expect(ring.length).toBe(written.points);
    // A B-spline of four control points is a rounded square, well inside them, and many points at 0.2 m.
    expect(ring.length).toBeGreaterThan(20);
    for (const [e, n] of ring) {
        expect(Math.round(e! * 100) / 100).toBe(e!);
        expect(e!).toBeGreaterThan(529000);
        expect(e!).toBeLessThan(529100.2);
        expect(n!).toBeGreaterThan(6487000);
        expect(n!).toBeLessThan(6487101);
    }
});

test('writeBoundary writes nothing for a course without an oob feature', async () => {
    const t = await setup({ unity: false });
    expect(await t.svc.writeBoundary(TEST_COURSE_ID)).toEqual({ path: null, rings: 0, points: 0 });
    expect(await stat(path.join(t.exportDir, BOUNDARY)).catch(() => null)).toBeNull();
});

test('run checks in Unity inside the boundary, opens the Review window, then checks the worker\'s shaped course', async () => {
    const t = await setup({ worker: 'ours' });
    await drawBoundary(t);
    const started = await t.svc.run(TEST_COURSE_ID, { hole: 3, cellM: 0.25 });
    expect(started.status).toBe('running');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.phases.map(p => [p.id, p.status])).toEqual([
        ['boundary', 'done'], ['unity', 'done'], ['review', 'done'], ['blender', 'skipped'],
    ]);

    const check = t.editor!.calls.find(c => c.command === 'golfmap.course.check')!;
    expect(check.args).toMatchObject({ boundary: path.join(t.exportDir, BOUNDARY), marginM: 50, bufferM: 100, cell: 0.25, hole: '3' });
    expect(check.args.playLines).toBeUndefined();
    expect(check.args.all).toBeUndefined();
    const review = t.editor!.calls.find(c => c.command === 'golfmap.review.load')!;
    expect(review.args.path).toBe(path.join(t.exportDir, UNITY_REPORT));

    // The Unity layer's findings come from the report file (all of them), errors first, no infos.
    const unity = job.result!.unity!;
    expect(unity).toMatchObject({ layer: 'unity', ok: false, errors: 2, warnings: 1, hole: '3', meshes: 412, seconds: 30.2 });
    expect(unity.findings.map(f => f.type)).toEqual(['crack', 'gap', 'step']);
    expect(unity.findings[0]).toMatchObject({ hole: '3', objects: ['Spline_hole_3_1a_Fairway_-_Mesh'], epsg3006: [529100.5, 6487100.25] });
    expect(unity.counts).toContainEqual({ type: 'gap', findings: 1, severity: 'error', points: 30 });
    // A one-hole check has no Blender counterpart.
    expect(job.result!.blenderSkipped).toContain('per-hole');
    expect(t.worker!.calls.some(c => c.route === '/check')).toBe(false);

    // The whole course: the Blender layer too, its report beside Unity's.
    await t.svc.whenIdle(TEST_COURSE_ID);
    const whole = await t.svc.run(TEST_COURSE_ID, { marginM: 20 });
    await t.svc.whenIdle(TEST_COURSE_ID);
    const done = t.svc.job(whole.id);
    expect(done.status).toBe('succeeded');
    expect(done.phases.find(p => p.id === 'blender')!.status).toBe('done');
    const body = t.worker!.calls.find(c => c.route === '/check')!.body;
    // The play lines come from the pipeline's database, which this in-memory course is not in: no play lines, so the
    // drawn boundary decides (and both layers get the play buffer for when there are some).
    expect(done.result!.playLines.path).toBeNull();
    expect(body).toEqual({ marginM: 20, bufferM: 100, out: path.join(t.exportDir, BLENDER_REPORT), boundary: path.join(t.exportDir, BOUNDARY) });
    expect(done.result!.blender).toMatchObject({ layer: 'blender', errors: 1, warnings: 0, area: `${BOUNDARY} + 20 m`, seconds: 0.2 });
    expect(done.result!.blender!.findings[0]).toMatchObject({ type: 'seam-step', objects: ['Spline_tee-1a'] });

    // The board's status reads both reports back from disk.
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.boundary).toBe(path.join(t.exportDir, BOUNDARY));
    expect(status.unity).toMatchObject({ errors: 2, warnings: 1, report: path.join(t.exportDir, UNITY_REPORT) });
    expect(status.blender).toMatchObject({ errors: 1, report: path.join(t.exportDir, BLENDER_REPORT) });
    expect(status.job!.id).toBe(whole.id);
    expect(status.meshesChangedSince).toBe(false);
});

test('status says when the meshes changed after the last Unity check', async () => {
    const t = await setup({ unity: false });
    expect(await t.svc.status(TEST_COURSE_ID)).toEqual({
        boundary: null, unity: null, blender: null, meshesChangedAt: null, meshesChangedSince: false, job: null,
    });
    const checkedAt = new Date(Date.now() - 3600_000).toISOString();
    await writeFile(path.join(t.exportDir, UNITY_REPORT), JSON.stringify({
        format: 'golfmap-course-check-v1', generated: checkedAt, ok: true, errors: 0, warnings: 3, area: 'x + 50 m',
        counts: { step: { findings: 3, severity: 'warn', points: 12 } }, seconds: { total: 31 },
    }));
    const before = await t.svc.status(TEST_COURSE_ID);
    expect(before.unity).toMatchObject({ at: checkedAt, ok: true, errors: 0, warnings: 3, seconds: 31, hole: null });
    expect(before.meshesChangedSince).toBe(false);

    // A Meshes update that finished after the check (the board's record: its start + how long it took).
    const lastRun = new Date(Date.now() - 1800_000).toISOString();
    await writeFile(path.join(t.exportDir, SYNC_RECORD_FILE), JSON.stringify({
        format: SYNC_RECORD_FORMAT, targets: { meshes: { lastRun, seconds: 60 } },
    }));
    const after = await t.svc.status(TEST_COURSE_ID);
    expect(after.meshesChangedAt).toBe(new Date(Date.parse(lastRun) + 60_000).toISOString());
    expect(after.meshesChangedSince).toBe(true);
});

test('no Unity editor and no worker: both layers are skipped with their reasons, and the check runs over every mesh', async () => {
    const t = await setup({ unity: false });
    const started = await t.svc.run(TEST_COURSE_ID);
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('succeeded');
    expect(job.phases.map(p => p.status)).toEqual(['done', 'skipped', 'skipped', 'skipped']);
    expect(job.phases[0]!.detail).toContain('no oob drawn');
    expect(job.result!.unity).toBeNull();
    expect(job.result!.unitySkipped).toContain(`no open Unity editor imports from ${t.exportDir}`);
    expect(job.result!.blenderSkipped).toContain('not running');
});

test('the worker holding another course is skipped; without an oob the Unity check is asked for every mesh', async () => {
    const t = await setup({ worker: 'other' });
    await t.svc.run(TEST_COURSE_ID);
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.status(TEST_COURSE_ID).then(s => s.job!);
    expect((await job).result!.blenderSkipped).toContain('not this course');
    expect(t.worker!.calls.some(c => c.route === '/check')).toBe(false);
    expect(t.editor!.calls.find(c => c.command === 'golfmap.course.check')!.args).toMatchObject({ all: true, marginM: 50 });
});

test('a second check of the course while one runs is refused', async () => {
    let open!: () => void;
    const hold = new Promise<void>(r => { open = r; });
    const t = await setup({ holdCheck: hold });
    await mkdir(t.exportDir, { recursive: true });
    await t.svc.run(TEST_COURSE_ID, { blender: false });
    await expect(t.svc.run(TEST_COURSE_ID)).rejects.toBeInstanceOf(ConflictError);
    open();
    await t.svc.whenIdle(TEST_COURSE_ID);
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.job!.status).toBe('succeeded');
    expect(status.job!.result!.blenderSkipped).toContain('not asked for');
});
