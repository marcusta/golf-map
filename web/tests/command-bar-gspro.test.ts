import { test, expect, afterEach } from 'bun:test';
import { Router, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { CommandBarComponent, needsSceneSave, pushedIntoUnity } from '../src/app/command-bar.component';
import { ServerModeService } from '../src/app/server-mode.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { EditorModeService } from '../src/editor/editor-mode.service';
import { FeaturesService } from '../src/draw/features.service';
import { GsproSyncService } from '../src/export/gspro-sync.service';
import { PlantVegetationService } from '../src/zones/plant-vegetation.service';
import { CleanToolService } from '../src/clean/clean-tool.service';
import { ShapingService } from '../src/terrain-edit/shaping.service';
import { TerrainEditToolService } from '../src/terrain-edit/terrain-edit-tool.service';
import { DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { VEGETATION_TOOL_ID } from '../src/zones/vegetation-tool';
import { CLEAN_TOOL_ID } from '../src/clean/clean-tool.service';
import { FURNITURE_TOOL_ID } from '../src/furniture/furniture.service';
import { TERRAIN_EDIT_TOOL_ID } from '../src/terrain-edit/terrain-edit-tool.service';
import { GSPRO_TARGETS } from '../../shared/gspro-targets';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type {
    GsproSyncApi, GsproSyncJob, GsproSyncStatus, GsproTargetStatus,
} from '../../shared/api/gspro-sync.gen';
import type { GsproExportApi, GsproExportJob } from '../../shared/api/gspro-export.gen';
import { doneJob, fakeShapingApi, shapingJob } from './shaping-fakes';

// The command bar's GSPro group (docs/web-features.md, "The GSPro dialog is a
// status board"): the permanent board button with the stale count, and the
// contextual Update buttons of the active sub-mode — which show, what they
// are called, that they go off while a job runs, and which target each one
// asks the board for. The server is a plain fake object (no mocking library,
// TESTING.md); the result dialog is the house ConfirmService, answered here.

const COURSE_ID = 'c1';

const mounted: CommandBarComponent[] = [];
afterEach(() => {
    for (const c of mounted.splice(0)) c.destroy();
    document.body.textContent = '';
    di.reset?.();
    _reset();
});

function targetRow(patch: Partial<GsproTargetStatus> & { id: GsproTargetStatus['id'] }): GsproTargetStatus {
    return {
        label: GSPRO_TARGETS.find(t => t.id === patch.id)!.label,
        lastRun: null, seconds: null, changedSince: { count: 0, kinds: [] },
        stale: false, manual: null, blocked: null,
        ...patch,
    };
}

function syncJob(patch: Partial<GsproSyncJob> = {}): GsproSyncJob {
    return {
        id: 'job-1', courseId: COURSE_ID, request: 'terrain', targets: ['terrain'],
        status: 'succeeded', phase: null, step: 'Done', phases: [],
        queuedAt: '2026-10-14T12:00:00.000Z', startedAt: '2026-10-14T12:00:00.000Z',
        finishedAt: '2026-10-14T12:00:40.000Z', seconds: 40,
        results: [{ target: 'terrain', label: 'Terrain', seconds: 40, report: ['Inner: 2 cm moved', 'Unity (vreta_v4): terrain updated'], error: null }],
        error: null,
        ...patch,
    };
}

/** The board server: `status` answers the rows the test set, `update` the jobs in order. */
function fakeSync(opts: SetupOpts = {}) {
    const calls = { status: 0, update: [] as string[] };
    const jobs = opts.jobs ?? [syncJob()];
    let at = -1;
    const api: GsproSyncApi = {
        async status() {
            calls.status++;
            return {
                unity: { editors: [], matched: 'vreta_v4', exportDir: 'D:\\out' },
                worker: {
                    url: 'http://127.0.0.1:8777', reachable: true, state: 'loaded', phase: null,
                    blend: null, conformed: null, layersDir: null, appliedOps: null, lastRun: null,
                    job: null, error: null, spawnedPid: null, log: null,
                },
                targets: GSPRO_TARGETS.map(t => targetRow({ id: t.id, stale: (opts.stale ?? []).includes(t.id) })),
                job: at >= 0 ? jobs[Math.min(at, jobs.length - 1)] : null,
                queue: [],
            } satisfies GsproSyncStatus;
        },
        async update({ target }) {
            calls.update.push(target);
            if (opts.updateFails) throw opts.updateFails;
            at = 0;
            return jobs[0];
        },
        async job() {
            at = Math.min(at + 1, jobs.length - 1);
            return jobs[at];
        },
        async editors() {
            return { editors: [], matched: null, exportDir: 'D:\\out' };
        },
    };
    return { api, calls };
}

/** A finished vegetation export job, whose result may carry the server's `needsPlanting`. */
function plantJob(kind: 'vegetation' | 'vegetation-update', result: Record<string, unknown>): GsproExportJob {
    return {
        id: `${kind}-1`, courseId: COURSE_ID, kind, label: kind, status: 'succeeded',
        startedAt: '2026-10-14T12:00:00.000Z', finishedAt: '2026-10-14T12:00:20.000Z',
        result: result as unknown as GsproExportJob['result'], error: null,
    };
}

/** The vegetation half of the export server: one finished job per `start`, in order. */
function fakePlant(jobs: GsproExportJob[]) {
    const calls = { start: [] as string[] };
    let at = 0;
    const api = {
        async start(input: { kind: string }) {
            calls.start.push(input.kind);
            return jobs[Math.min(at++, jobs.length - 1)];
        },
        async job() { return jobs[Math.min(at - 1, jobs.length - 1)]; },
        async current() { return null; },
    } as unknown as GsproExportApi;
    return { api, calls };
}

function feature(id: string, type: string): CourseFeature {
    return {
        id, courseId: COURSE_ID, holeId: null, type,
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }] },
        sortOrder: 0, source: null, sourceRef: null, license: null, attributes: null, version: 1,
    } as unknown as CourseFeature;
}

/** Answers every result dialog, keeping what it was asked. */
class RecordingConfirm extends ConfirmService {
    readonly shown: Array<{ title: string; body: string; detail?: string }> = [];
    override confirm(opts: { title: string; body: string; detail?: string }): Promise<boolean> {
        this.shown.push({ title: opts.title, body: opts.body, detail: opts.detail });
        return Promise.resolve(true);
    }
}

interface SetupOpts {
    stale?: GsproTargetStatus['id'][];
    jobs?: GsproSyncJob[];
    /** The board refuses the update (a 409 by name, or another run holding it). */
    updateFails?: Error;
    /** The vegetation export jobs "Update vegetation" / "Update N zones" get, in order. */
    plantJobs?: GsproExportJob[];
}

function setup(opts: SetupOpts = {}) {
    const serverMode = new ServerModeService();
    serverMode.mode.set('builder');
    di.set(ServerModeService, serverMode);

    const router = new Router();
    router.navigate(`/course/${COURSE_ID}`);
    di.set(Router, router);

    const svc = new CourseDetailService({} as never, {} as never);
    svc.course.set({ id: COURSE_ID, name: 'Test', status: 'draft', revision: 1, version: 1, georeferenceJson: null } as never);
    di.set(CourseDetailService, svc);

    const { api, calls } = fakeSync(opts);
    // Poll and re-read fast: the test drives the job through its states.
    const sync = new GsproSyncService(api, 0, 1e9);
    di.set(GsproSyncService, sync);

    const shapingApi = fakeShapingApi([]);
    const shaping = new ShapingService(shapingApi, 0);
    di.set(ShapingService, shaping);
    di.set(TerrainEditToolService, new TerrainEditToolService({} as never, {} as never, 0, {} as never, shaping));

    const plant = fakePlant(opts.plantJobs ?? [plantJob('vegetation', { path: '', report: [] })]);
    di.set(PlantVegetationService, new PlantVegetationService(plant.api, 0));

    const clean = new CleanToolService();
    di.set(CleanToolService, clean);

    // The features the bar selects from, with a reload that touches no server.
    const features = new FeaturesService({ async list() { return []; } } as unknown as CourseFeaturesApi);
    di.set(FeaturesService, features);

    const confirm = new RecordingConfirm();
    di.set(ConfirmService, confirm);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const bar = new CommandBarComponent({ mode: 'create' });
    bar.mount(host);
    mounted.push(bar);

    const q = <T extends HTMLElement = HTMLButtonElement>(id: string) => host.querySelector(`[data-testid="${id}"]`) as T;
    /** The Update buttons on screen now, in bar order. */
    const shown = () => [...host.querySelectorAll<HTMLElement>('.cmdbar__gspro-btn')]
        .filter(b => b.dataset.off !== 'true')
        .map(b => b.textContent!.trim());
    const subMode = (toolId: string) => di.get(EditorModeService).activeToolId.set(toolId);
    return { host, q, shown, subMode, sync, shaping, shapingApi, confirm, calls, svc, features, clean, plant: plant.calls };
}

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('the GSPro button is always there and carries the stale count once the board is read', async () => {
    const { q, calls } = setup({ stale: ['terrain', 'photo', 'shapes', 'meshes', 'trees', 'creeks'] });
    const board = q('gspro-board-btn');
    expect(board).not.toBeNull();
    expect(board.title).toBe('Open the GSPro status board');

    // Read once when the course opens — no timer.
    await tick();
    expect(calls.status).toBe(1);
    expect(q('gspro-stale-badge').textContent!.trim()).toBe('· 6');
    expect(board.textContent).toContain('GSPro · 6');
});

test('each sub-mode offers its own Update buttons', async () => {
    const { shown, subMode, features } = setup();
    await tick();

    // Draw, nothing selected: the SVG.
    subMode(DRAW_TOOL_ID);
    expect(shown()).toEqual(['Update shapes', 'GSPro']);

    features.store.set([feature('p1', 'path'), feature('r1', 'rock_slab')]);
    features.select('p1');
    expect(shown()).toEqual(['Update paths', 'GSPro']);
    features.select('r1');
    expect(shown()).toEqual(['Update meshes (this feature)', 'GSPro']);
    features.setSelection([]);

    // Terrain: the terrain, and the meshes of the whole course or of the selection.
    subMode(TERRAIN_EDIT_TOOL_ID);
    expect(shown()).toEqual(['Update terrain', 'Update meshes', 'GSPro']);
    di.get(TerrainEditToolService).selectedFeatureIds.set(['b1']);
    expect(shown()).toEqual(['Update terrain', 'Update meshes (this feature)', 'GSPro']);
    di.get(TerrainEditToolService).selectedFeatureIds.set([]);

    subMode(VEGETATION_TOOL_ID);
    expect(shown()).toEqual(['Update vegetation', 'GSPro']);

    subMode(CLEAN_TOOL_ID);
    expect(shown()).toEqual(['Update photo', 'GSPro']);

    subMode(FURNITURE_TOOL_ID);
    expect(shown()).toEqual(['Update course file', 'GSPro']);

    // A sub-mode that changes nothing GSPro reads keeps the board button alone.
    subMode('measure');
    expect(shown()).toEqual(['GSPro']);
});

test('Update terrain runs that target, shows its report and re-reads the board', async () => {
    const { q, subMode, calls, confirm, sync } = setup({ stale: ['terrain'] });
    await tick();
    subMode(TERRAIN_EDIT_TOOL_ID);

    q('gspro-update-terrain-btn').click();
    await tick(10);

    expect(calls.update).toEqual(['terrain']);
    expect(confirm.shown).toHaveLength(1);
    expect(confirm.shown[0].title).toBe('Terrain updated');
    expect(confirm.shown[0].detail).toContain('Unity (vreta_v4): terrain updated');
    // The board was re-read at the end of the run (open or not).
    expect(calls.status).toBeGreaterThan(1);
    expect(sync.running.get()).toBe(false);
});

test('Update photo, Update course file and Update shapes ask for their own target', async () => {
    const { q, subMode, calls, confirm } = setup();
    await tick();

    subMode(CLEAN_TOOL_ID);
    q('gspro-update-photo-btn').click();
    await tick(10);

    subMode(FURNITURE_TOOL_ID);
    q('gspro-update-course-file-btn').click();
    await tick(10);

    subMode(DRAW_TOOL_ID);
    q('gspro-update-shapes-btn').click();
    await tick(10);

    expect(calls.update).toEqual(['photo', 'course-file', 'shapes']);
    // The manual step after an SVG export is the Blender build, as the board says.
    expect(confirm.shown[2].body).toContain('Build the SVG in Blender (OPCD), then Update meshes');
});

test('while a job runs every Update is off and the one that started it shows the step', async () => {
    const running = syncJob({ status: 'running', step: 'Exporting the heightmaps', results: [] });
    const { q, subMode, host } = setup({ jobs: [running, syncJob()] });
    await tick();
    subMode(TERRAIN_EDIT_TOOL_ID);
    const terrain = q('gspro-update-terrain-btn');
    const meshes = q('gspro-update-meshes-btn');

    terrain.click();
    await tick(); // the update request answered: the job is running
    expect(terrain.textContent).toContain('Exporting the heightmaps…');
    expect(terrain.getAttribute('aria-busy')).toBe('true');
    expect(terrain.disabled).toBe(true);
    expect(meshes.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="gspro-board-btn"]')!.disabled).toBe(false);

    await tick(10);
    expect(terrain.textContent).toContain('Update terrain');
    expect(terrain.getAttribute('aria-busy')).toBe('false');
    expect(terrain.disabled).toBe(false);
});

test('a refused update says why and leaves the board alone', async () => {
    const { q, subMode, confirm, sync } = setup({ jobs: [syncJob({ status: 'failed', error: 'no open Unity editor', results: [] })] });
    await tick();
    subMode(CLEAN_TOOL_ID);
    q('gspro-update-photo-btn').click();
    await tick(10);

    expect(confirm.shown[0].title).toBe('Could not update the photo');
    expect(confirm.shown[0].body).toBe('no open Unity editor');
    expect(sync.error.get()).toBe('no open Unity editor');
});

test('Update meshes (this feature) runs the shaping job for the selection and reports what Blender changed', async () => {
    const { q, subMode, shapingApi, confirm, shaping, calls } = setup();
    shapingApi.polls = [shapingJob(), doneJob(['Spline_hole_3_1c_Bunker_-_Mesh'])];
    await tick();
    subMode(TERRAIN_EDIT_TOOL_ID);
    di.get(TerrainEditToolService).selectedFeatureIds.set(['b1', 'b2']);

    const btn = q('gspro-update-meshes-feature-btn');
    expect(btn.textContent).toContain('Update meshes (2 features)');
    btn.click();
    await tick(20);

    expect(shapingApi.calls.apply).toEqual([{ courseId: COURSE_ID }]);
    // The panel shows the phases under the selection it was started for.
    expect(shaping.jobScope.get()).toBe('b1,b2');
    expect(confirm.shown[0].title).toBe('Meshes updated');
    expect(confirm.shown[0].detail).toContain('Spline_hole_3_1c_Bunker_-_Mesh');
    expect(calls.status).toBeGreaterThan(1); // the stale count follows
    // No board job was started: the shaping job is the chain here.
    expect(calls.update).toEqual([]);
});

test('needsSceneSave: only a report that touched Unity without saving still asks', () => {
    expect(needsSceneSave(['Unity (vreta_v4): 2 objects refreshed'])).toBe(true);
    expect(needsSceneSave(['Unity (vreta_v4): 2 objects refreshed', 'Saved Vreta.unity (3 s)'])).toBe(false);
    expect(needsSceneSave(['SVG: 142 shapes'])).toBe(false);
    expect(needsSceneSave([])).toBe(false);
});

test('a chain that pushed nothing into Unity never asks for the scene to be saved', () => {
    // The lines the chains write when there was no push: they all say "Unity".
    const nothing = [
        'Not in Unity: no open Unity editor imports from D:\\out (none is open)',
        'Still manual in Unity: Terrain › Export To OBJ for Blender, and the terrain conform once the meshes are rebuilt.',
        'The outer texture is written only: there is no Unity push for the outer terrain — set it on the terrain by hand once.',
        'Next in Unity: Run GolfMap › Buildings › Plant from assignments.',
    ];
    expect(pushedIntoUnity(nothing)).toBe(false);
    expect(needsSceneSave(nothing)).toBe(false);

    // A push writes its own line, behind a chain's per-terrain prefix or not.
    expect(pushedIntoUnity(['Unity (vreta_v4): golfmap.trees.plant — 4 120 stems'])).toBe(true);
    expect(pushedIntoUnity(['inner: Unity inner (vreta_v4): heights from vreta-inner-dem.json'])).toBe(true);
    expect(pushedIntoUnity(['inner: Unity (vreta_v4): imported vreta-inner-zones.json'])).toBe(true);
    expect(pushedIntoUnity(['Unity inner: skipped (nothing sculpted)'])).toBe(false);

    // With phases, they decide: `done` is a push, `skipped` is not — whatever the lines say.
    expect(pushedIntoUnity(nothing, [{ id: 'terrain:unity', status: 'done' }])).toBe(true);
    expect(pushedIntoUnity(['Unity (vreta_v4): golfmap.creeks.import — done'], [{ id: 'creeks:unity', status: 'skipped' }])).toBe(false);
    expect(pushedIntoUnity([], [{ id: 'meshes:unity', status: 'done' }])).toBe(true);
    expect(needsSceneSave([], [{ id: 'unity', status: 'done' }])).toBe(true);
    expect(needsSceneSave(['Saved Vreta.unity (3 s)'], [{ id: 'unity', status: 'done' }])).toBe(false);
    // A chain with no Unity phase at all falls back to its report.
    expect(pushedIntoUnity(nothing, [{ id: 'shapes:svg', status: 'done' }])).toBe(false);
});

test('Update terrain that reached no Unity editor does not ask for a scene save', async () => {
    const noUnity = syncJob({
        phases: [{ id: 'terrain:unity', label: 'Unity', status: 'skipped', detail: null, seconds: null }],
        results: [{
            target: 'terrain', label: 'Terrain', seconds: 12,
            report: [
                'Not in Unity: no open Unity editor imports from D:\\out (none is open)',
                'Still manual in Unity: Terrain › Export To OBJ for Blender, and the terrain conform once the meshes are rebuilt.',
            ],
            error: null,
        }],
    });
    const { q, subMode, confirm } = setup({ jobs: [noUnity] });
    await tick();
    subMode(TERRAIN_EDIT_TOOL_ID);

    q('gspro-update-terrain-btn').click();
    await tick(10);

    expect(confirm.shown[0].title).toBe('Terrain updated');
    expect(confirm.shown[0].body).not.toContain('Save the scene');
});

test('a refused update says why and shows no other job\'s results', async () => {
    const { q, subMode, confirm, sync } = setup({ updateFails: new Error('A GSPro update is already running: inner trees') });
    await tick();
    // The board still holds the last run's job, with its report.
    sync.job.set(syncJob({ id: 'job-other' }));
    subMode(CLEAN_TOOL_ID);

    q('gspro-update-photo-btn').click();
    await tick(10);

    expect(confirm.shown[0].title).toBe('Could not update the photo');
    expect(confirm.shown[0].body).toBe('A GSPro update is already running: inner trees');
    // Not the other job's "Unity (vreta_v4): terrain updated".
    expect(confirm.shown[0].detail).toBeUndefined();
});

test('Update meshes (this feature) shows the shaping job\'s step, not the board job\'s', async () => {
    const { q, subMode, shapingApi, sync } = setup();
    shapingApi.polls = [shapingJob(), doneJob(['Spline_hole_3_1c_Bunker_-_Mesh'])];
    await tick();
    // A finished board job is in hand: its step must not be what the button says.
    sync.job.set(syncJob({ step: 'Done' }));
    subMode(TERRAIN_EDIT_TOOL_ID);
    di.get(TerrainEditToolService).selectedFeatureIds.set(['b1']);

    const btn = q('gspro-update-meshes-feature-btn');
    btn.click();
    await tick();

    expect(btn.textContent).toContain('Blender sync…');
    expect(btn.textContent).not.toContain('Done…');
    await tick(20);
    expect(btn.textContent).toContain('Update meshes (this feature)');
});

test('Update meshes (this feature) is off while the recipe save is still in flight', async () => {
    const { q, subMode } = setup();
    await tick();
    subMode(TERRAIN_EDIT_TOOL_ID);
    const tool = di.get(TerrainEditToolService);
    tool.selectedFeatureIds.set(['b1']);
    const btn = q('gspro-update-meshes-feature-btn');
    expect(btn.disabled).toBe(false);

    tool.saving.set(true);
    expect(btn.disabled).toBe(true);
    btn.click();
    await tick(10);
    expect(di.get(ShapingService).job.peek()).toBeNull();  // nothing started

    tool.saving.set(false);
    expect(btn.disabled).toBe(false);
});

test('Update photo waits for the Clean tool\'s saves and stops when one failed', async () => {
    const { q, subMode, calls, confirm, clean } = setup();
    await tick();
    subMode(CLEAN_TOOL_ID);
    clean.saveState.set('error');
    clean.saveError.set('the photo could not be written');

    q('gspro-update-photo-btn').click();
    await tick(10);

    expect(calls.update).toEqual([]);
    expect(confirm.shown[0].title).toBe('Could not update the photo');
    expect(confirm.shown[0].body).toContain('not saved yet');

    // Saved: the chain runs.
    clean.saveState.set('saved');
    q('gspro-update-photo-btn').click();
    await tick(10);
    expect(calls.update).toEqual(['photo']);
});

test('Update zones the server cannot do on their own offers Update vegetation instead', async () => {
    const { q, subMode, features, confirm, plant } = setup({
        plantJobs: [
            plantJob('vegetation-update', {
                path: '', report: ['masks: nothing patched'],
                needsPlanting: true, reason: 'the zone type "oak scrub" is new here',
            }),
            plantJob('vegetation', { path: '', report: ['Unity (vreta_v4): imported vreta-inner-zones.json', 'Arborist lower vegetation written'] }),
        ],
    });
    await tick();
    subMode(VEGETATION_TOOL_ID);
    features.store.set([feature('z1', 'vegetation_zone')]);
    features.select('z1');

    q('update-zones-btn').click();
    await tick(20);

    expect(confirm.shown[0].title).toBe('These zones need Update vegetation');
    expect(confirm.shown[0].body).toContain('the zone type "oak scrub" is new here.');
    expect(confirm.shown[0].body).toContain('This needs Update vegetation');
    // Answered with OK (RecordingConfirm), so the whole planting ran.
    expect(plant.start).toEqual(['vegetation-update', 'vegetation']);
    expect(confirm.shown[1].title).toBe('Vegetation updated');
});
