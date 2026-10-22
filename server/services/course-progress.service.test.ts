// CourseProgressService against the real migrated DB and service graph (the
// real GSPro board, course check and make-ready status), with the seams the
// GSPro suites use: an empty Unity discovery folder (no editor open), a shaping
// worker URL nothing answers on, and the course's folders as temp dirs holding
// what each step leaves behind. No Unity, no Blender, no Python.
import { test, expect, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { AssetsService } from './assets.service';
import { TerrainEditsService } from './terrain-edits.service';
import { MapBuildService } from './map-build.service';
import { GsproExportService } from './gspro-export.service';
import { ShapingService } from './shaping.service';
import { GsproSyncService } from './gspro-sync.service';
import { CHECK_FORMAT, CourseCheckService, UNITY_REPORT } from './course-check.service';
import { MakeReadyService, READY_SUMMARY, SUMMARY_FORMAT } from './make-ready.service';
import { defaultUnityBridge } from './unity-bridge';
import { CourseProgressService, PERF_TARGET, type CourseProgress } from './course-progress.service';
import { GSPRO_TARGET_IDS } from '../../shared/gspro-targets';

const SITE_ID = 'site-progress';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
});

async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

async function setup() {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await tmp('progress-data-');
    const exportDir = await tmp('progress-out-');
    const courseDir = await tmp('progress-gspro-');
    const benchDir = await tmp('progress-bench-');
    const bridge = defaultUnityBridge(await tmp('progress-bridges-'));

    const courses = new CoursesService(ctx.db);
    const assets = new AssetsService(ctx.db, dataDir);
    const terrainEdits = new TerrainEditsService(ctx.db);
    const exports = new GsproExportService({ db: ctx.db, courses, assets, dataDir, terrainEdits, pipelineDir: '/pipeline', unityBridge: bridge });
    await exports.setDir(TEST_COURSE_ID, exportDir);
    const shaping = new ShapingService({
        courses, exportSettings: exports, dataDir, pipelineDir: '/pipeline', unityBridge: bridge, layersRoot: await tmp('progress-layers-'),
        // Nothing answers on port 1, and the launcher can never start Blender from a test.
        workerUrl: 'http://127.0.0.1:1', workerLauncher: ['bun', '--version'],
    });
    const mapBuild = new MapBuildService({ db: ctx.db, assets, dataDir, pipelineDir: '/pipeline', terrainEdits });
    const sync = new GsproSyncService({ db: ctx.db, courses, exports, shaping, mapBuild, dataDir, terrainEdits, unityBridge: bridge });
    const check = new CourseCheckService({ db: ctx.db, courses, exports, shaping, unityBridge: bridge });
    const ready = new MakeReadyService({ courses, exports, courseCheck: check, dataDir, unityBridge: bridge });
    const progress = new CourseProgressService({ db: ctx.db, courses, exports, sync, check, ready, dataDir, benchDir });
    return { ctx, db: ctx.db, assets, exports, progress, dataDir, exportDir, courseDir, benchDir };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const stepOf = (p: CourseProgress, id: string) => p.steps.find(s => s.id === id)!;

/** A built site with its active photo cleaned, the GSPro course folder and the OPCD name set. */
async function builtCourse(t: Setup) {
    await t.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await t.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const sources = path.join(t.dataDir, 'sources', SITE_ID);
    await mkdir(sources, { recursive: true });
    for (const name of ['dem.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif']) await writeFile(path.join(sources, name), '');
    await t.assets.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
        filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify({ activeOrtho: 'orto-l2-2025' }),
    });
    await t.exports.setCourseDir(TEST_COURSE_ID, t.courseDir);
    await t.exports.setOpcdCourseName(TEST_COURSE_ID, 'Linkan GK');
}

async function checkReport(t: Setup, errors: number, warnings: number) {
    await writeFile(path.join(t.exportDir, UNITY_REPORT), JSON.stringify({
        format: CHECK_FORMAT, generated: new Date().toISOString(), ok: errors === 0, errors, warnings, findings: [],
    }));
}

async function readySummary(t: Setup, ready: boolean) {
    await writeFile(path.join(t.exportDir, READY_SUMMARY), JSON.stringify({
        format: SUMMARY_FORMAT, at: new Date().toISOString(), ready, blockers: [], errors: ready ? 0 : 3, warnings: 0, fixed: 0, fix: false,
        marginM: 40, categories: [], findings: [], fixes: [],
    }));
}

/** The GSPro build at `builtAt`, GreenKeeper's benchmark card at `cardAt`, and the bench run that wrote it. */
async function builtAndBenched(t: Setup, builtAt: Date, cardAt: Date, scores: { scoreAvg: number; worstHoleScore: number }) {
    const gspcrse = path.join(t.courseDir, 'Linkan_scene.gspcrse');
    const card = path.join(t.courseDir, 'linkan_scene_benchmark.jpg');
    await writeFile(gspcrse, '');
    await writeFile(card, '');
    await utimes(gspcrse, builtAt, builtAt);
    await utimes(card, cardAt, cardAt);
    const run = path.join(t.benchDir, '20261015-0833-linkan');
    await mkdir(run, { recursive: true });
    const seconds = 540;
    await writeFile(path.join(run, 'greenkeeper.json'), JSON.stringify({
        label: 'linkan', started: new Date(cardAt.getTime() - (seconds + 60) * 1000).toISOString(), seconds, ...scores, targetFps: 90,
    }));
}

test('a course that is only drawn: set-up names what is missing and nothing after it is done', async () => {
    const t = await setup();
    const p = await t.progress.progress(TEST_COURSE_ID);

    const board = GSPRO_TARGET_IDS.flatMap(id => (id === 'shapes' ? [id, 'opcd'] : [id]));
    expect(p.steps.map(s => s.id)).toEqual(['setup', 'map', 'photo-clean', ...board, 'check', 'ready', 'build', 'perf']);
    expect(p.name).toBe('Linkan');
    expect(stepOf(p, 'setup')).toMatchObject({ state: 'todo', detail: 'missing: map area, GSPro course folder, OPCD name' });
    expect(stepOf(p, 'map').state).toBe('todo');
    expect(stepOf(p, 'photo-clean')).toMatchObject({ state: 'todo', detail: 'no photo yet' });
    for (const id of GSPRO_TARGET_IDS) expect(['todo', 'blocked']).toContain(stepOf(p, id).state);
    expect(stepOf(p, 'opcd')).toMatchObject({ state: 'todo', detail: 'no SVG export yet' });
    expect(stepOf(p, 'check')).toMatchObject({ state: 'todo', manual: 'bun run course:check -- Linkan' });
    expect(stepOf(p, 'ready')).toMatchObject({ state: 'todo', manual: 'bun run course:ready -- Linkan' });
    expect(stepOf(p, 'build')).toMatchObject({ state: 'todo', detail: 'no GSPro course folder' });
    expect(stepOf(p, 'perf')).toMatchObject({ state: 'todo', detail: 'no flyover benchmark yet' });
});

test('a built, checked and benchmarked course reads each step from what it left behind', async () => {
    const t = await setup();
    await builtCourse(t);
    await checkReport(t, 0, 2);
    await readySummary(t, true);
    const built = new Date(Date.now() - 2 * 3600_000);
    await builtAndBenched(t, built, new Date(Date.now() - 3600_000), { scoreAvg: 95, worstHoleScore: 91 });

    const p = await t.progress.progress(TEST_COURSE_ID);
    expect(stepOf(p, 'setup')).toMatchObject({ state: 'done', detail: '2 holes' });
    expect(stepOf(p, 'map').state).toBe('done');
    expect(stepOf(p, 'photo-clean')).toMatchObject({ state: 'done', detail: 'orto-l2-2025' });
    expect(stepOf(p, 'check')).toMatchObject({ state: 'done', detail: '2 warnings' });
    expect(stepOf(p, 'ready').state).toBe('done');
    expect(stepOf(p, 'build').state).toBe('done');
    expect(stepOf(p, 'perf')).toMatchObject({ state: 'done', detail: 'score 95 · worst hole 91' });
    expect((await t.progress.courses()).map(c => c.id)).toEqual([TEST_COURSE_ID]);
});

test('errors fail Check and Ready, a low worst hole fails the score, and a build after the flyover makes it stale', async () => {
    const t = await setup();
    await builtCourse(t);
    await checkReport(t, 4, 1);
    await readySummary(t, false);
    await builtAndBenched(t, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 3600_000), { scoreAvg: 96, worstHoleScore: PERF_TARGET - 12 });

    let p = await t.progress.progress(TEST_COURSE_ID);
    expect(stepOf(p, 'check')).toMatchObject({ state: 'failed', detail: '4 errors, 1 warning' });
    expect(stepOf(p, 'ready')).toMatchObject({ state: 'failed', detail: '3 errors' });
    expect(stepOf(p, 'perf')).toMatchObject({ state: 'failed', detail: `score 96 · worst hole ${PERF_TARGET - 12} (target ${PERF_TARGET})` });

    const rebuilt = new Date();
    await utimes(path.join(t.courseDir, 'Linkan_scene.gspcrse'), rebuilt, rebuilt);
    p = await t.progress.progress(TEST_COURSE_ID);
    expect(stepOf(p, 'perf')).toMatchObject({ state: 'stale', detail: `score 96 · worst hole ${PERF_TARGET - 12}; built again since` });
});
