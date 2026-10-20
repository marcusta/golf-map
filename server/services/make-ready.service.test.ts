// MakeReadyService against the real migrated DB and service graph (the real
// CourseCheckService too), with the seams the GSPro suites use: a stand-in
// Unity editor (it answers `golfmap.course.ready` and `golfmap.course.check`
// by writing their reports as the real commands do), a decoded Arborist
// document handed in (no wrapper key, no .dat decoding) and a small surface
// map written as golfmap.surfaces.export writes it. No Unity, no Python.
import { test, expect, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { ShapingService } from './shaping.service';
import { CourseCheckService, UNITY_REPORT } from './course-check.service';
import type { UnityBridge } from './unity-bridge';
import {
    MakeReadyService, PlayDistance, READY_SUMMARY, UNITY_READY_REPORT, type ArboristDoc, type MakeReadyJob,
} from './make-ready.service';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
});

async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

interface UnityOpts {
    /** What `golfmap.course.ready` finds (and fixes, with fix). */
    ready?: { findings: object[]; fixed?: object[]; counts?: Record<string, object> };
    /** The course check's errors. */
    checkErrors?: number;
}

/**
 * A Unity editor on the bridge contract, as a plain object: its active
 * course exports to `exportDir`; `golfmap.course.ready` writes
 * `make-ready.json` (golfmap-make-ready-v1) and answers the summary with its
 * first `limit` findings; `golfmap.course.check` writes `course-check.json`.
 */
function fakeUnity(exportDir: string, opts: UnityOpts = {}) {
    const calls: Array<{ command: string; args: any }> = [];
    const editor = {
        projectPath: path.join(exportDir, 'unity-project'),
        projectName: 'linkan_v4',
        async run(command: string, args: any = {}) {
            calls.push({ command, args });
            if (command === 'golfmap.course') return { active: { name: 'Linkan', exportFolder: exportDir } };
            if (command === 'golfmap.course.ready') {
                const findings = args.fix ? [] : (opts.ready?.findings ?? []);
                const fixed = args.fix ? (opts.ready?.fixed ?? []) : [];
                const report = {
                    format: 'golfmap-make-ready-v1', generated: new Date().toISOString(), scene: 'Linkan', marginM: args.marginM, fix: !!args.fix,
                    counts: opts.ready?.counts ?? {}, findings, fixed,
                };
                const file = path.join(exportDir, 'make-ready.json');
                await writeFile(file, JSON.stringify(report));
                return {
                    counts: report.counts, errors: findings.filter((f: any) => f.severity === 'error').length,
                    warnings: findings.filter((f: any) => f.severity === 'warn').length,
                    findings: findings.slice(0, args.limit), fixed, file,
                };
            }
            if (command === 'golfmap.course.check') {
                const errors = opts.checkErrors ?? 0;
                const file = path.join(exportDir, 'course-check.json');
                await writeFile(file, JSON.stringify({
                    format: 'golfmap-course-check-v1', generated: new Date().toISOString(), ok: errors === 0, errors, warnings: 0,
                    area: 'all course meshes', meshes: 12, counts: {}, findings: [],
                }));
                return { report: file };
            }
            if (command === 'golfmap.review.load') return { places: 0 };
            throw new Error(`unknown ${command}`);
        },
    };
    const bridge: UnityBridge = { editors: () => [editor] };
    return { calls, bridge };
}

const CLASSES = { 0: 'none', 1: 'deep', 2: 'rough', 3: 'semi', 4: 'fairway', 5: 'green', 6: 'tee', 7: 'bunker', 8: 'water' };

/**
 * The course's export folder as the refresh leaves it: the inner (100 m at
 * Unity 0,0) and outer (1 km from -450,-450) heightmap sidecars, so
 * Arborist's cells start at (-450, -450), and a 0.5 m surface map whose
 * playing field is the fairway strip x 0-20 m.
 */
async function writeCourseFiles(exportDir: string) {
    await writeFile(path.join(exportDir, 'linkan-inner-dem-100m.tif.json'), JSON.stringify({
        crs: 'EPSG:3006', square3006: [529000, 6487000, 529100, 6487100], sideM: 100, unity: { position: { x: 0, y: 0, z: 0 } },
    }));
    await writeFile(path.join(exportDir, 'linkan-outer-dem-1000m.tif.json'), JSON.stringify({
        crs: 'EPSG:3006', sideM: 1000, unity: { position: { x: -450, y: 0, z: -450 } },
    }));
    const w = 200, h = 200;
    const bytes = new Uint8Array(w * h).fill(1);
    for (let r = 0; r < h; r++) for (let c = 0; c < 40; c++) bytes[r * w + c] = 4;
    await writeFile(path.join(exportDir, 'linkan-inner-surfaces.bin'), bytes);
    await writeFile(path.join(exportDir, 'linkan-inner-surfaces.json'), JSON.stringify({
        format: 'golfmap-surfaces-v1', data: 'linkan-inner-surfaces.bin', width: w, height: h, cellM: 0.5, rowOrder: 'north-up',
        worldOrigin: [0, 0], classes: CLASSES,
    }));
}

/** Arborist's catalogue sizes: the juniper by address, the fern by label. */
async function writeSizes(dataDir: string) {
    await Bun.write(path.join(dataDir, 'arborist', 'catalog-sizes.json'), JSON.stringify({
        ok: true, result: { assets: [
            { address: 'Assets/Bushes/Juniper.prefab', label: 'Juniper_A', widthM: 1.2, heightM: 1.5 },
            { address: 'Assets/Ferns/Fern_01.prefab', label: 'Fern_01', widthM: 0.6, heightM: 0.4 },
        ] },
    }));
}

/** Instances at Unity world (x, 50): stored relative to the cells' corner (-450, -450). */
const at = (x: number, scale = 1) => ({ Position: { x: x + 450, y: 70, z: 500 }, Scale: { x: scale, y: scale, z: scale } });

function arboristDoc(): ArboristDoc {
    const item = (id: string, Name: string, VegetationType: string, ColliderType: string, Address = `Assets/${Name}.prefab`) =>
        ({ VegetationItemID: id, Name, VegetationType, ColliderType, Address });
    return {
        VSProSettings: { vegetationPackages: [
            { PackageName: 'GolfMap trees', VegetationInfoList: [
                item('oak', 'Oak', 'Tree', 'FromPrefab'),
                item('birch', 'Birch', 'Tree', 'Disabled'),
                item('birch-far', 'Birch (far)', 'Tree', 'Disabled'),
            ] },
            { PackageName: 'GolfMap lower', VegetationInfoList: [
                item('juniper', 'Juniper', 'Plant', 'Disabled', 'Assets/Bushes/Juniper.prefab'),
                item('fern', 'Fern_01 ', 'Plant', 'Disabled', 'Assets/Elsewhere/fern.prefab'),
                item('mystery', 'Mystery', 'Plant', 'Disabled'),
            ] },
        ] },
        PersistentVegetationPackage: { PersistentVegetationCellList: [{
            PersistentVegetationInfoList: [
                { VegetationItemID: 'oak', VegetationItemList: [at(30)] },
                // 31 m from play (near), 30 m west of the map (near: play runs to its edge), 71 m (far)
                { VegetationItemID: 'birch', VegetationItemList: [at(50), at(-30), at(90)] },
                // a billboard 20 m from play, and one far out beyond the map
                { VegetationItemID: 'birch-far', VegetationItemList: [at(40), at(300)] },
                // a big juniper on the fairway, a small one (0.36 x 0.45 m)
                { VegetationItemID: 'juniper', VegetationItemList: [at(10), at(15, 0.3)] },
                { VegetationItemID: 'fern', VegetationItemList: [at(5)] },
                { VegetationItemID: 'mystery', VegetationItemList: [at(5)] },
            ],
        }] },
    };
}

async function setup(opts: UnityOpts & { unity?: boolean; arborist?: boolean } = {}) {
    const ctx = await createTestDb(seedCourse);
    const exportDir = await tmp('make-ready-out-');
    await ctx.gsproExportService.setDir(TEST_COURSE_ID, exportDir);
    await writeCourseFiles(exportDir);
    if (opts.arborist !== false) {
        const courseDir = await tmp('gspro-course-');
        await writeFile(path.join(courseDir, 'arboristdata.dat'), 'wrapped');
        await ctx.gsproExportService.setCourseDir(TEST_COURSE_ID, courseDir);
    }
    const dataDir = await tmp('make-ready-data-');
    await writeSizes(dataDir);
    const unity = opts.unity === false ? null : fakeUnity(exportDir, opts);
    const bridge: UnityBridge = unity?.bridge ?? { editors: () => [] };
    const shaping = new ShapingService({
        courses: ctx.coursesService, exportSettings: ctx.gsproExportService, dataDir, workerUrl: 'http://127.0.0.1:9',
        timeouts: { pollMs: 20, startMs: 500, syncMs: 500 },
    });
    const courseCheck = new CourseCheckService({
        db: ctx.db, courses: ctx.coursesService, exports: ctx.gsproExportService, shaping, unityBridge: bridge,
    });
    const decoded: string[] = [];
    const svc = new MakeReadyService({
        courses: ctx.coursesService, exports: ctx.gsproExportService, courseCheck, dataDir, unityBridge: bridge,
        decodeArborist: async (dat) => { decoded.push(dat); return arboristDoc(); },
    });
    return { ctx, svc, exportDir, unity, decoded };
}

async function runToEnd(svc: MakeReadyService, opts: { fix?: boolean; marginM?: number } = {}): Promise<MakeReadyJob> {
    const started = await svc.run(TEST_COURSE_ID, opts);
    expect(started.status).toBe('running');
    await svc.whenIdle(TEST_COURSE_ID);
    return svc.job(started.id);
}

test('PlayDistance: metres to the playing field, across the map\'s edge, Infinity beyond the margin', () => {
    const w = 20, h = 10;   // 0.5 m cells: 10 x 5 m, play in the west 1 m
    const bytes = new Uint8Array(w * h).fill(1);
    for (let r = 0; r < h; r++) bytes[r * w] = bytes[r * w + 1] = 2;
    const d = new PlayDistance({ width: w, height: h, cellM: 0.5, data: 'x', worldOrigin: [100, 200], classes: { 1: 'deep', 2: 'rough' } }, bytes, 5);
    expect(d.cellM).toBe(1);
    expect(d.distanceM(100.5, 202)).toBe(0);
    expect(d.distanceM(104.2, 202)).toBe(4);
    expect(d.distanceM(95.5, 202)).toBe(5);      // west of the map: play runs to its edge
    expect(d.distanceM(100.5, 197.5)).toBe(3);   // south of the map
    expect(d.distanceM(109.5, 202)).toBe(Infinity);
});

test('a run checks the Unity scene, the Arborist file and the course check, and is not ready with errors', async () => {
    const t = await setup({
        ready: {
            counts: { trees: { objects: 120, near: 14, ok: 13, fixed: 0, findings: 1 }, water: { objects: 3, near: 2, ok: 2, fixed: 0, findings: 0 } },
            findings: [
                { category: 'trees', severity: 'error', objects: ['Tree_12'], note: 'no collider', unity: [1, 2, 3], epsg3006: [529001, 6487003] },
                { category: 'water', severity: 'warn', objects: ['Pond_3'], note: 'GSPrough, not GSPwater', unity: [4, 5, 6], epsg3006: [529004, 6487006] },
            ],
        },
    });
    const job = await runToEnd(t.svc);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['unity', 'done'], ['arborist', 'done'], ['check', 'done']]);

    const ready = t.unity!.calls.find(c => c.command === 'golfmap.course.ready')!;
    expect(ready.args).toEqual({ fix: false, marginM: 40, limit: 60 });

    const r = job.result!;
    expect(r.ready).toBe(false);
    expect(r.unity).toMatchObject({ skipped: null, report: path.join(t.exportDir, UNITY_READY_REPORT), errors: 1, warnings: 1, fixed: 0 });
    // Arborist: the birch without a collider and the billboard near play are errors, the big juniper a warning.
    expect(t.decoded).toHaveLength(1);
    expect(r.arborist).toMatchObject({ skipped: null, instances: 10, errors: 2, warnings: 1 });
    const trees = r.categories.find(c => c.category === 'arborist-trees')!;
    expect(trees).toEqual({ layer: 'arborist', category: 'arborist-trees', objects: 6, near: 4, ok: 1, fixed: 0, findings: 2 });
    expect(r.categories.find(c => c.category === 'arborist-bushes')).toMatchObject({ objects: 4, near: 4, ok: 2, findings: 1 });
    expect(r.categories.find(c => c.category === 'trees')).toMatchObject({ layer: 'unity', objects: 120, near: 14, ok: 13 });

    const arb = r.findings.filter(f => f.layer === 'arborist');
    const birch = arb.find(f => f.objects[0] === 'Birch')!;
    expect(birch).toMatchObject({ severity: 'error', category: 'arborist-trees', unity: [-30, 70, 50], epsg3006: [528970, 6487050] });
    expect(birch.note).toContain('2 instances within 40 m');
    expect(arb.find(f => f.objects[0] === 'Birch (far)')).toMatchObject({ severity: 'error', unity: [40, 70, 50] });
    expect(arb.find(f => f.objects[0] === 'Birch (far)')!.note).toContain('billboard-only');
    expect(arb.find(f => f.objects[0] === 'Juniper')).toMatchObject({ severity: 'warn', category: 'arborist-bushes' });
    expect(arb.find(f => f.objects[0] === 'Fern_01')).toBeUndefined();
    expect(arb.find(f => f.objects[0] === 'Mystery')!.severity).toBe('info');
    expect(arb.filter(f => f.note?.includes('asset bundles'))).toHaveLength(1);
    // Errors first, infos last.
    expect(r.findings.map(f => f.severity).join(',')).toMatch(/^(error,)+(warn,)+(info,?)+$/);

    // No course check before: one ran in Unity now, and its (zero) errors are folded in.
    expect(t.unity!.calls.some(c => c.command === 'golfmap.course.check')).toBe(true);
    expect(r.check).toMatchObject({ skipped: null, source: 'run', errors: 0, report: path.join(t.exportDir, UNITY_REPORT) });
    expect(r.errors).toBe(3);
    expect(r.warnings).toBe(2);

    // The board reads it back from the summary file.
    const status = await t.svc.status(TEST_COURSE_ID);
    expect(status.last).toMatchObject({ ready: false, errors: 3, warnings: 2, fix: false, marginM: 40 });
    expect(status.last!.categories).toHaveLength(4);
    expect((status.last as unknown as Record<string, unknown>).findings).toBeUndefined();
    expect(status.job!.id).toBe(job.id);
});

test('fix passes save, reports what Unity fixed, and a fresh course check report is taken as it is', async () => {
    const t = await setup({
        arborist: false,
        ready: { findings: [], fixed: [{ object: 'Tree_12', what: 'CapsuleCollider + GSPwood' }], counts: { trees: { objects: 120, near: 14, ok: 14, fixed: 1, findings: 0 } } },
    });
    // A course check made after the last mesh change (there is none on record).
    await writeFile(path.join(t.exportDir, UNITY_REPORT), JSON.stringify({
        format: 'golfmap-course-check-v1', generated: new Date(Date.now() - 600_000).toISOString(), ok: true, errors: 0, warnings: 2, counts: {},
    }));
    const job = await runToEnd(t.svc, { fix: true, marginM: 30 });
    expect(job.status).toBe('succeeded');
    expect(t.unity!.calls.find(c => c.command === 'golfmap.course.ready')!.args).toEqual({ fix: true, marginM: 30, limit: 60, save: true });
    expect(t.unity!.calls.some(c => c.command === 'golfmap.course.check')).toBe(false);
    const r = job.result!;
    expect(r.fixes).toEqual([{ object: 'Tree_12', what: 'CapsuleCollider + GSPwood' }]);
    expect(r.fixed).toBe(1);
    expect(r.arborist.skipped).toContain('no GSPro course folder');
    expect(job.phases.find(p => p.id === 'arborist')!.status).toBe('skipped');
    expect(r.check).toMatchObject({ source: 'report', errors: 0, warnings: 2 });
    expect(r).toMatchObject({ ready: true, errors: 0, warnings: 2, blockers: [], fix: true, marginM: 30 });
    const file = JSON.parse(await readFile(path.join(t.exportDir, READY_SUMMARY), 'utf8'));
    expect(file.format).toBe('golfmap-make-ready-summary-v1');
    expect(file.fixes).toHaveLength(1);
});

test('Unity closed: the scene and the course check are skipped with why, the Arborist file is still read, and it is not ready', async () => {
    const t = await setup({ unity: false });
    const job = await runToEnd(t.svc);
    expect(job.status).toBe('succeeded');
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['unity', 'skipped'], ['arborist', 'done'], ['check', 'skipped']]);
    const r = job.result!;
    expect(r.unity.skipped).toContain(`no open Unity editor imports from ${t.exportDir}`);
    expect(r.check.skipped).toContain('Unity is closed');
    expect(r.arborist.errors).toBe(2);
    expect(r.ready).toBe(false);
    expect(r.blockers).toHaveLength(2);
    expect((await t.svc.status(TEST_COURSE_ID)).last!.ready).toBe(false);
});

test('a second run of the course while one runs is refused', async () => {
    const t = await setup({ unity: false, arborist: false });
    await t.svc.run(TEST_COURSE_ID);
    await expect(t.svc.run(TEST_COURSE_ID)).rejects.toThrow('already running');
    await t.svc.whenIdle(TEST_COURSE_ID);
});
