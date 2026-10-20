import { emptyCourseMeta, type GsproCourseMeta } from '../../shared/gspro-course-meta';
import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { GsproExportPanelComponent } from '../src/export/gspro-export-panel.component';
import { GsproExportService } from '../src/export/gspro-export.service';
import { GsproSyncService } from '../src/export/gspro-sync.service';
import type {
    GsproExportApi, GsproExportSettings, GsproOrthoSource, CourseTerrain, GsproExportJob, RamRoadsProposal,
} from '../../shared/api/gspro-export.gen';
import type { GsproSyncApi, GsproSyncJob, GsproTargetStatus, JobPhase } from '../../shared/api/gspro-sync.gen';
import { GSPRO_TARGETS, type GsproTargetId } from '../../shared/gspro-targets';
import { FeaturesService } from '../src/draw/features.service';
import { RamRoadsService, type RamRoadsClient } from '../src/export/ram-roads.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Render smoke for the GSPro dialog — its tabs, each with its targets' rows and
// that area's files (there are no per-component specs by design — TESTING.md —
// but the rows, the tabs, the folder field, the default hint and the report
// list are worth one throw-check through happy-dom). A hidden tab's buttons
// are still in the DOM, so the pins on them click them where they are.

afterEach(() => {
    _reset();
    di.reset();
});

const DEFAULT_DIR = 'C:\\Users\\marcus\\Downloads';

const SOURCES: GsproOrthoSource[] = [
    { source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', cleaned: false, active: true },
    { source: 'ortho-orto-l2-2025.cleaned.tif', collection: 'orto-l2-2025', cleaned: true, active: true },
    { source: 'ortho-orto-l2-2023.tif', collection: 'orto-l2-2023', cleaned: false, active: false },
];

/** What the server lays out for a built course: a 2010 m inner square and the 5 km outer one. */
const TERRAIN: CourseTerrain = {
    inner: {
        square: { minX: 529030, minY: 6486670, maxX: 531040, maxY: 6488680 }, sideM: 2010,
        centre: { x: 530035, y: 6487675 },
        wgs84: { west: 15.4987, south: 58.5196, east: 15.5335, north: 58.5378 },
    },
    outer: {
        square: { minX: 527535, minY: 6485175, maxX: 532535, maxY: 6490175 }, sideM: 5000,
        centre: { x: 530035, y: 6487675 },
        wgs84: { west: 15.473, south: 58.506, east: 15.559, north: 58.551 },
    },
};

const GKD_META: GsproCourseMeta = {
    ...emptyCourseMeta('Vreta'), city: 'Linköping', country: 'Sweden', designer: 'Fandorm',
    description: 'Oak parkland.', difficulty: 4.9, keywords: ['Parkland'],
};

function fakeApi(dir: string | null, run?: () => never, sources: GsproOrthoSource[] = SOURCES, terrain: CourseTerrain | null = TERRAIN) {
    let courseDir: string | null = null;
    let meta: GsproCourseMeta | null = null;
    // What GreenKeeper saved into the scene folder's .GKD.
    const gkd = { meta: GKD_META as GsproCourseMeta | null, ratings: [] as string[] };
    const metaCalls: (GsproCourseMeta | null)[] = [];
    const settings = (): GsproExportSettings => ({
        dir: dir ?? DEFAULT_DIR, isDefault: dir === null, defaultDir: DEFAULT_DIR,
        courseDir, gkdFile: courseDir ? `${courseDir.split('\\').pop()}.GKD` : null,
        meta, gkdMeta: courseDir ? gkd.meta : null, gkdRatings: courseDir ? gkd.ratings : [],
    });
    const gkdCalls: (string | null)[] = [];
    const orthoCalls: string[] = [];
    const outerCalls: string[] = [];
    const demCalls: string[] = [];
    const unityTerrainCalls: string[] = [];
    const hillshadeCalls: string[] = [];
    const treesCalls: string[] = [];
    const zonesCalls: string[] = [];
    const floorCalls: (string | undefined)[] = [];
    const svgCalls: { excludeFeatureIds?: string[]; variant?: string }[] = [];
    const handlers: Record<string, (input: any) => Promise<any>> = {
        async settings() { return settings(); },
        async setDir() { return settings(); },
        async setCourseDir({ dir: next }) { courseDir = next; return settings(); },
        async setMeta({ meta: next }) { meta = next; metaCalls.push(next); return settings(); },
        async readGkdMeta() { meta = gkd.meta; gkd.ratings = []; return settings(); },
        async runGkd() {
            if (run) run();
            gkdCalls.push(courseDir);
            return { path: `${courseDir}\\${settings().gkdFile}`, report: ['Wrote x.GKD', '18 holes, par 72'] };
        },
        async run({ excludeFeatureIds, variant }) {
            svgCalls.push({ excludeFeatureIds, variant });
            if (run) run();
            return { path: `${dir ?? DEFAULT_DIR}\\vreta.svg`, report: ['Wrote vreta.svg', '200 features in 19 layer(s)', 'warning: 5 outside'] };
        },
        async orthoSources() { return sources; },
        async runOrtho({ source, forestFloor, floorColor }) {
            if (run) run();
            orthoCalls.push(source);
            floorCalls.push(forestFloor ? floorColor : undefined);
            return { path: `${dir ?? DEFAULT_DIR}\\vreta-orto-l2-2025-8192.jpg`, report: ['rendering ortho-orto-l2-2025.tif', 'wrote vreta-orto-l2-2025-8192.jpg'] };
        },
        async terrain() {
            if (!terrain) throw new Error('Course has no map area to lay out the GSPro terrains for: build the course map first.');
            return terrain;
        },
        async runOuterOrtho({ collection }) {
            if (run) run();
            outerCalls.push(collection);
            return { path: `${dir ?? DEFAULT_DIR}\\vreta-outer-${collection}-8192.jpg`, report: [`fetched outer-ortho-${collection}.tif`, 'wrote x.jpg'] };
        },
        async runDem({ terrain: kind }) {
            if (run) run();
            demCalls.push(kind);
            return { path: `${dir ?? DEFAULT_DIR}\\vreta-${kind}-dem-2010m.tif`, report: ['Wrote x.tif', 'Wrote x.tif.json'] };
        },
        async runUnityTerrain({ terrain: kind }) {
            if (run) run();
            unityTerrainCalls.push(kind);
            return {
                path: `${dir ?? DEFAULT_DIR}\\vreta-${kind}-dem-2010m.raw`,
                report: [`Unity ${kind} (vreta_v4_2025_12_02): heights from vreta-${kind}-dem.tif.json`],
            };
        },
        async runHillshade({ terrain: kind }) {
            if (run) run();
            hillshadeCalls.push(kind);
            return { path: `${dir ?? DEFAULT_DIR}\\vreta-${kind}-hillshade-8192.jpg`, report: ['Wrote x.jpg'] };
        },
        async runTrees({ terrain: kind }) {
            if (run) run();
            treesCalls.push(kind);
            return { path: `${dir ?? DEFAULT_DIR}\\vreta-${kind}-trees.json`, report: ['Wrote x.json'] };
        },
        async runZones({ terrain: kind }) {
            if (run) run();
            zonesCalls.push(kind);
            return { path: `${dir ?? DEFAULT_DIR}\\vreta-${kind}-zones.json`, report: ['Wrote x.json'] };
        },
    };
    const api = jobApi(handlers);
    return { api, svgCalls, orthoCalls, outerCalls, demCalls, unityTerrainCalls, hillshadeCalls, treesCalls, zonesCalls, floorCalls, gkdCalls, metaCalls, gkd };
}


/**
 * Wrap per-kind handlers (the old synchronous fakes) as the job API: `start`
 * runs the handler and returns a finished job carrying its result, so every
 * existing expectation on paths, reports and errors still holds; `job`
 * serves the last one; `current` is null unless a test overrides it.
 */
function jobApi(h: Record<string, (input: any) => Promise<any>>, current: () => Promise<GsproExportJob | null> = async () => null): GsproExportApi {
    let last: GsproExportJob | null = null;
    return {
        settings: h.settings, setDir: h.setDir, setCourseDir: h.setCourseDir, setMeta: h.setMeta, readGkdMeta: h.readGkdMeta, orthoSources: h.orthoSources, terrain: h.terrain,
        async start(input) {
            const { courseId, kind } = input;
            const result = kind === 'svg' ? await h.run({ courseId, excludeFeatureIds: input.excludeFeatureIds, variant: input.variant })
                : kind === 'ortho' ? await h.runOrtho({ courseId, source: input.source, darken: input.darken, tint: input.tint, tintOpacity: input.tintOpacity, forestFloor: input.forestFloor, floorColor: input.floorColor })
                : kind === 'outer-ortho' ? await h.runOuterOrtho({ courseId, collection: input.collection, darken: input.darken, tint: input.tint, tintOpacity: input.tintOpacity })
                : kind === 'dem' ? await h.runDem({ courseId, terrain: input.terrain })
                : kind === 'unity-terrain' ? await h.runUnityTerrain({ courseId, terrain: input.terrain })
                : kind === 'hillshade' ? await h.runHillshade({ courseId, terrain: input.terrain })
                : kind === 'zones' ? await h.runZones({ courseId, terrain: input.terrain })
                : kind === 'gkd' ? await h.runGkd({ courseId })
                : await h.runTrees({ courseId, terrain: input.terrain });
            last = { id: `job-${kind}-${Date.now()}`, courseId, kind, label: kind, status: 'succeeded',
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result, error: null };
            return last;
        },
        async job({ jobId }) {
            if (!last || last.id !== jobId) throw new Error(`No export job ${jobId}`);
            return last;
        },
        current,
    };
}

// --- The status board behind the dialog (GsproSyncService) ---

const row = (patch: Partial<GsproTargetStatus> & { id: GsproTargetId }): GsproTargetStatus => ({
    label: GSPRO_TARGETS.find(t => t.id === patch.id)!.label,
    lastRun: hoursAgo(2),
    seconds: null,
    changedSince: { count: 0, kinds: [] },
    stale: false,
    manual: GSPRO_TARGETS.find(t => t.id === patch.id)!.manual,
    blocked: null,
    note: null,
    builds: [],
    ...patch,
});

/** The board's times are relative, so the fixture's are too. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** A board in the shape the dialog has to cope with: fresh, stale and blocked rows. */
const BOARD = (): GsproTargetStatus[] => [
    row({ id: 'terrain', seconds: 42 }),
    row({ id: 'photo', lastRun: null, stale: true, blocked: 'Build the map first' }),
    row({
        id: 'shapes', lastRun: hoursAgo(48), seconds: 12, stale: true,
        changedSince: { count: 14, kinds: ['bunker', 'path', 'tee'] },
        builds: [
            { snapshot: '2026-10-15_15-37-30', outcome: 'failed', opcdCreated: '2026-10-17 09:38', status: 'Draft', lastGood: false },
            { snapshot: '2026-10-15_13-17-34', outcome: 'ok', opcdCreated: '2026-10-17 07:17', status: 'Processing Complete', lastGood: true },
            { snapshot: '2026-10-15_13-10-26', outcome: null, opcdCreated: null, status: null, lastGood: false },
        ],
    }),
    row({ id: 'meshes' }),
    row({ id: 'vegetation' }),
    row({ id: 'trees', lastRun: null, stale: true }),
    row({ id: 'buildings' }),
    row({ id: 'props', note: '3 hand-placed props are kept on update' }),
    row({ id: 'creeks' }),
    row({ id: 'roads' }),
    row({ id: 'waterfalls' }),
    row({ id: 'course-file' }),
];

const PHASES: JobPhase[] = [
    { id: 'shapes-svg', label: 'Course SVG', status: 'done', detail: '200 features', seconds: 6 },
    { id: 'trees-files', label: 'Tree files', status: 'running', detail: null, seconds: null },
];

const RUNNING_JOB: GsproSyncJob = {
    id: 'sync-1', courseId: 'course-1', request: 'stale', targets: ['shapes', 'trees'], status: 'running',
    phase: 'trees-files', step: 'inner trees', phases: PHASES, queuedAt: hoursAgo(0),
    startedAt: hoursAgo(0), finishedAt: null, seconds: 8, results: [], error: null,
};

/** The sync server as a plain object; `job` always answers with what `update` started. */
function fakeSyncApi(opts: { targets?: GsproTargetStatus[]; statusJob?: GsproSyncJob | null; matched?: string | null } = {}) {
    const updates: string[] = [];
    let started: GsproSyncJob | null = null;
    const finished = (base: GsproSyncJob): GsproSyncJob => ({
        ...base, status: 'succeeded', finishedAt: '2026-10-14T12:00:40.000Z', seconds: 39,
        phases: base.phases.map(p => ({ ...p, status: 'done' as const })),
        results: base.targets.map(t => ({
            target: t, label: GSPRO_TARGETS.find(x => x.id === t)!.label, seconds: 10,
            report: [`${t}: written`], error: null,
        })),
    });
    const api: GsproSyncApi = {
        async status() {
            return {
                unity: {
                    editors: [{
                        projectName: 'vreta_v4_2025_12_02', projectPath: 'D:\\gspro_courses\\vreta_v4_2025_12_02',
                        activeCourse: 'Vreta', exportFolder: 'D:\\gspro_courses\\vreta-opcd',
                        matches: opts.matched !== null, error: null,
                    }],
                    matched: opts.matched === undefined ? 'vreta_v4_2025_12_02' : opts.matched,
                    exportDir: 'D:\\gspro_courses\\vreta-opcd',
                },
                worker: {
                    url: 'http://127.0.0.1:8777', reachable: true, state: 'loaded', phase: null, blend: null,
                    conformed: null, layersDir: null, appliedOps: null, lastRun: null, error: null, spawnedPid: null, job: null, log: null,
                },
                targets: opts.targets ?? BOARD(),
                job: started ?? opts.statusJob ?? null,
                queue: [],
            };
        },
        async update({ target }) {
            updates.push(target);
            const targets = target === 'stale'
                ? (opts.targets ?? BOARD()).filter(t => t.stale && t.blocked === null).map(t => t.id)
                : [target as GsproTargetId];
            started = { ...RUNNING_JOB, id: `sync-${updates.length}`, request: target, targets, status: 'running' };
            return started;
        },
        async job() {
            if (!started) throw new Error('no job');
            started = finished(started);
            return started;
        },
        async editors() { throw new Error('not used'); },
    };
    return { api, updates };
}

/** The roads proposal the server would make: two candidates, one road already R.A.M., two left out. */
const PROPOSAL = (): RamRoadsProposal => ({
    format: 'golfmap.ram-roads-proposal/1',
    course: { id: 'course-1', name: 'Vreta' },
    rules: { minDistanceM: 30 },
    candidates: [
        { featureId: 'f38', featureNo: 38, surface: 'gravel', widthM: 4, lengthM: 465.2, distanceToPlayM: 41.4, touches: [12], reason: 'far from play' },
        { featureId: 'f40', featureNo: 40, surface: 'asphalt', widthM: 6, lengthM: 120, distanceToPlayM: 75, touches: [], reason: 'far from play' },
    ],
    already: [12],
    rejected: [
        { featureNo: 7, featureId: 'f7', reason: 'no centerline' },
        { featureNo: null, featureId: 'abcdef0123456789', reason: '12 m from play' },
    ],
});

/** The roads half of the server: the proposal, and what Accept set. */
function fakeRamRoads() {
    const proposals: (number | undefined)[] = [];
    const renders: { featureIds: string[]; render: string }[] = [];
    const client: RamRoadsClient = {
        async ramRoadsProposal({ minDistanceM }) {
            proposals.push(minDistanceM);
            return PROPOSAL();
        },
        async setRoadRender({ featureIds, render, dryRun }) {
            renders.push({ featureIds, render });
            return { render, changed: featureIds, unchanged: [], dryRun: !!dryRun };
        },
    };
    return { client, proposals, renders };
}

async function mount(dir: string | null = null, run?: () => never, sources?: GsproOrthoSource[], terrain?: CourseTerrain | null,
    syncOpts?: Parameters<typeof fakeSyncApi>[0]) {
    const { api, orthoCalls, outerCalls, demCalls, unityTerrainCalls, hillshadeCalls, treesCalls, zonesCalls, floorCalls, gkdCalls, metaCalls, gkd } = fakeApi(dir, run, sources, terrain);
    const svc = new GsproExportService(api, 1);
    di.set(GsproExportService, svc);
    const { api: syncApi, updates } = fakeSyncApi(syncOpts);
    const sync = new GsproSyncService(syncApi, 1, 60_000);
    di.set(GsproSyncService, sync);
    const roads = fakeRamRoads();
    di.set(RamRoadsService, new RamRoadsService(roads.client));
    const host = document.createElement('div');
    new GsproExportPanelComponent({}).mount(host);
    return { host, svc, sync, updates, roads, orthoCalls, outerCalls, demCalls, unityTerrainCalls, hillshadeCalls, treesCalls, zonesCalls, floorCalls, gkdCalls, metaCalls, gkd };
}

/** The dialog opens for a course and the board's first read lands. */
async function open(svc: GsproExportService) {
    await svc.openFor('course-1', 'Vreta');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
}

test('the panel stays hidden until a course opens it', async () => {
    const { host, svc } = await mount();
    const root = host.querySelector('.gspro-export') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).not.toContain('show');

    await svc.openFor('course-1', 'Vreta');
    expect((host.querySelector('.gspro-export') as HTMLElement).className).toContain('show');
});

test('an unset folder shows blank with the default as placeholder and hint', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const input = host.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(DEFAULT_DIR);
    expect(host.textContent).toContain('Leave blank for the default');
    expect(host.textContent).toContain(DEFAULT_DIR);
});

test('a set folder is shown and the hint says it sticks to the course', async () => {
    const { host, svc } = await mount('D:\\gspro_courses\\vreta\\opcd');
    await svc.openFor('course-1', 'Vreta');

    expect((host.querySelector('input[type="text"]') as HTMLInputElement).value)
        .toBe('D:\\gspro_courses\\vreta\\opcd');
    expect(host.textContent).toContain('used every time you export it');
});

test('typing in the folder field feeds the service', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const input = host.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'D:\\typed';
    input.dispatchEvent(new Event('input'));
    expect(svc.dirDraft.peek()).toBe('D:\\typed');
});

test('the result section stays hidden until a run writes something', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');
    const section = () => host.querySelector('.gspro-export__path')?.parentElement as HTMLElement;
    expect(section().className).toContain('hidden');

    await svc.run();
    expect(section().className).not.toContain('hidden');
    expect(host.textContent).toContain('Wrote');
    // The exporter's own lines land in the list; the "Wrote …" line is the path.
    const lines = [...host.querySelectorAll('.gspro-export__report li')].map(li => li.textContent);
    expect(lines).toEqual(['200 features in 19 layer(s)', 'warning: 5 outside']);
});

test('a failure shows the error section and the run button recovers', async () => {
    const { host, svc } = await mount(null, () => { throw new Error('GSPro SVG export failed: no map area'); });
    await svc.openFor('course-1', 'Vreta');
    await svc.run();

    const error = host.querySelector('.error') as HTMLElement;
    expect(error.parentElement?.className).not.toContain('hidden');
    expect(error.textContent).toContain('no map area');

    const button = host.querySelector('[data-testid=gspro-run-svg]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Export SVG');
});

// --- The status board ---

test('the dialog is tabs of rows: a row per target in tab order, with its time and what changed', async () => {
    const { host, svc } = await mount();
    await open(svc);

    const dialog = host.querySelector('[data-testid=gspro-dialog]') as HTMLElement;
    expect(dialog.querySelector('h3')!.textContent).toBe('GSPro');
    const rows = [...host.querySelectorAll('[data-testid^=gspro-row-]')];
    // Every target once, grouped by tab: Nature takes the creeks, the R.A.M. roads and the waterfalls in with vegetation and trees.
    expect(rows.map(r => r.getAttribute('data-testid')).sort()).toEqual(GSPRO_TARGETS.map(t => `gspro-row-${t.id}`).sort());
    expect(rows.map(r => r.querySelector('.gspro-export__blabel')!.textContent!.trim().split(' ')[0]))
        .toEqual(['Terrain', 'Photo', 'Course', 'Meshes', 'Vegetation', 'Trees', 'Creeks', 'R.A.M.', 'Waterfalls', 'Buildings', 'Props', 'Course']);

    const status = (id: string) => host.querySelector(`[data-testid=gspro-status-${id}]`)!.textContent;
    expect(status('terrain')).toBe('2 h ago · up to date');
    expect(status('shapes')).toBe('2 days ago · 14 features changed (bunkers, paths, tees)');
    expect(status('trees')).toBe('never');
    // The absolute time is the title behind the relative one.
    expect(host.querySelector('[data-testid=gspro-status-terrain]')!.getAttribute('title'))
        .toContain('Last updated:');
});

test('stale rows are marked, a blocked row says why and cannot be updated', async () => {
    const { host, svc, updates } = await mount();
    await open(svc);

    const dot = (id: string) => (host.querySelector(`[data-testid=gspro-row-${id}] .gspro-export__dot`) as HTMLElement).className;
    expect(dot('shapes')).toContain('stale');
    expect(dot('terrain')).toContain('fresh');
    expect(dot('photo')).toContain('blocked');

    expect(host.querySelector('[data-testid=gspro-blocked-photo]')!.textContent).toBe('Build the map first');
    const photo = host.querySelector('[data-testid=gspro-update-photo]') as HTMLButtonElement;
    expect(photo.disabled).toBe(true);
    expect(photo.title).toBe('Build the map first');
    photo.click();
    expect(updates).toEqual([]);

    // Two rows are stale AND runnable — photo is stale but blocked, so the
    // header's count (and a "stale" run) leaves it out.
    const all = host.querySelector('[data-testid=gspro-update-stale]') as HTMLButtonElement;
    expect(all.textContent).toBe('Update all stale (2)');
    expect(all.disabled).toBe(false);
    expect(host.textContent).toContain('2 rows out of date.');
});

test('the manual step a row leaves behind shows under it', async () => {
    const { host, svc } = await mount();
    await open(svc);
    expect(host.querySelector('[data-testid=gspro-manual-shapes]')!.textContent)
        .toBe('then: Build the SVG in Blender (OPCD), then Update meshes');
    expect(host.querySelector('[data-testid=gspro-manual-buildings]')!.textContent)
        .toContain('then: Run GolfMap › Buildings › Plant from assignments');
    expect(host.querySelector('[data-testid=gspro-manual-terrain]')!.textContent).toBe('');
});

test("the Props row shows its note and the Buildings tab names the spec as the only permanent place for a hand move", async () => {
    const { host, svc } = await mount();
    await open(svc);

    expect(host.querySelector('[data-testid=gspro-note-props]')!.textContent)
        .toBe('3 hand-placed props are kept on update');
    // Only the row that has one: no other row carries a note line.
    const notes = [...host.querySelectorAll('[data-testid^=gspro-note-]')].filter(n => n.textContent !== '');
    expect(notes.map(n => n.getAttribute('data-testid'))).toEqual(['gspro-note-props']);

    const pane = host.querySelector('[data-testid=gspro-pane-buildings]')!;
    expect(pane.textContent).toContain('docs/gspro/vreta/*-props.gen.py');
    // The long "what keeps a hand move" explanation sits behind the Props head's (i) tip.
    const tips = [...pane.querySelectorAll('.info-tip__text')].map(tip => tip.textContent);
    expect(tips.some(tip => tip!.includes('only a place(...) call in the *-props.gen.py makes a hand move permanent'))).toBe(true);
});

test('Update runs one target and the header button runs every stale one', async () => {
    const { host, svc, sync, updates } = await mount();
    await open(svc);

    (host.querySelector('[data-testid=gspro-update-trees]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 20));
    expect(updates).toEqual(['trees']);
    expect(sync.job.peek()?.status).toBe('succeeded');
    expect(host.querySelector('[data-testid=gspro-job-status]')!.textContent).toContain('Updated');

    (host.querySelector('[data-testid=gspro-update-stale]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 20));
    expect(updates).toEqual(['trees', 'stale']);
});

test('a job the server is already running shows its phases, and no row can be updated under it', async () => {
    const { host, svc } = await mount(null, undefined, undefined, undefined, { statusJob: RUNNING_JOB });
    await open(svc);

    expect(host.querySelector('[data-testid=gspro-job]')!.className).not.toContain('hidden');
    expect(host.querySelector('[data-testid=gspro-job-status]')!.textContent).toContain('Updating');
    const phases = [...host.querySelectorAll('[data-testid=gspro-job-phases] li')].map(li => li.textContent);
    expect(phases).toEqual(['✓ Course SVG — 200 features (6 s)', '… Tree files']);
    expect((host.querySelector('[data-testid=gspro-update-trees]') as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector('[data-testid=gspro-update-stale]') as HTMLButtonElement).disabled).toBe(true);
});

test('a finished job shows each target\'s report, the last one open', async () => {
    const { host, svc } = await mount();
    await open(svc);

    (host.querySelector('[data-testid=gspro-update-stale]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 20));
    const reports = [...host.querySelectorAll('[data-testid=gspro-job-results] details')];
    expect(reports.map(d => d.querySelector('summary')!.textContent))
        .toEqual(['Course shapes — done in 10 s', 'Trees — done in 10 s']);
    // The last target's report is the one left open.
    expect((reports.at(-1) as HTMLDetailsElement).open).toBe(true);
    expect(reports.at(-1)!.querySelector('li')!.textContent).toBe('trees: written');
});

test('the Unity chip names the editor with this course active, or says it is not open', async () => {
    const { host, svc } = await mount();
    await open(svc);
    const chip = host.querySelector('[data-testid=gspro-unity-chip]') as HTMLElement;
    expect(chip.textContent).toBe('Unity: vreta_v4_2025_12_02 · course Vreta');
    expect(chip.className).toContain('matched');
    expect(chip.title).toContain('D:\\gspro_courses\\vreta-opcd');
    expect(host.querySelector('[data-testid=gspro-worker-chip]')!.textContent).toBe('Blender: loaded');

    di.reset();
    const other = await mount(null, undefined, undefined, undefined, { matched: null });
    await open(other.svc);
    const none = other.host.querySelector('[data-testid=gspro-unity-chip]') as HTMLElement;
    expect(none.textContent).toBe('Unity: not open for this course');
    expect(none.className).not.toContain('matched');
});

test('each tab shows its own rows, files and settings, and a tab with a stale row carries a dot', async () => {
    const { host, svc } = await mount();
    await open(svc);

    const pane = (id: string) => host.querySelector(`[data-testid=gspro-pane-${id}]`) as HTMLElement;
    const tab = (id: string) => host.querySelector(`[data-testid=gspro-tab-${id}]`) as HTMLButtonElement;
    expect([...host.querySelectorAll('[data-testid^=gspro-tab-]')].map(b => b.textContent))
        .toEqual(['Terrain', 'Photo', 'Course', 'Nature', 'Buildings', 'GreenKeeper', 'Course details']);
    // One pane at a time, Terrain first.
    expect(tab('terrain').getAttribute('aria-selected')).toBe('true');
    expect(pane('terrain').className).not.toContain('hidden');
    expect(pane('photo').className).toContain('hidden');

    tab('photo').click();
    expect(tab('photo').getAttribute('aria-selected')).toBe('true');
    expect(tab('terrain').getAttribute('aria-selected')).toBe('false');
    expect(pane('photo').className).not.toContain('hidden');
    expect(pane('terrain').className).toContain('hidden');
    // The Photo tab: its row, the vintage picker, the cleaning boxes, the JPEG buttons and the one into Unity.
    expect(pane('photo').querySelector('[data-testid=gspro-row-photo]')).not.toBeNull();
    expect(pane('photo').querySelector('[data-testid=gspro-ortho-source]')).not.toBeNull();
    expect(pane('photo').querySelector('.gspro-export__run-ortho')).not.toBeNull();
    expect(pane('photo').querySelector('.gspro-export__run-clean-ortho')).not.toBeNull();
    expect(pane('photo').querySelector('[data-testid=gspro-unity-ortho]')).not.toBeNull();

    // Each other tab holds its own rows and files.
    expect(pane('terrain').querySelector('.gspro-export__run-inner-dem')).not.toBeNull();
    expect(pane('terrain').querySelector('[data-testid=gspro-inner-unity]')).not.toBeNull();
    expect(pane('terrain').querySelector('[data-testid=gspro-outer-unity]')).not.toBeNull();
    expect(pane('terrain').querySelector('[data-testid=gspro-inner-sculpt]')).not.toBeNull();
    expect(pane('course').querySelector('[data-testid=gspro-row-shapes]')).not.toBeNull();
    expect(pane('course').querySelector('[data-testid=gspro-row-meshes]')).not.toBeNull();
    expect(pane('course').querySelector('[data-testid=gspro-run-svg]')).not.toBeNull();
    expect(pane('course').textContent).toContain('docs/gspro/Vreta/shaping');
    for (const id of ['vegetation', 'trees', 'creeks', 'roads', 'waterfalls']) expect(pane('nature').querySelector(`[data-testid=gspro-row-${id}]`)).not.toBeNull();
    expect(pane('nature').querySelector('.gspro-export__run-inner-zones')).not.toBeNull();
    expect(pane('nature').querySelector('.gspro-export__run-inner-trees')).not.toBeNull();
    expect(pane('nature').querySelector('.gspro-export__run-creeks')).not.toBeNull();
    expect(pane('buildings').querySelector('[data-testid=gspro-row-props]')).not.toBeNull();
    expect(pane('buildings').querySelector('.gspro-export__run-inner-buildings')).not.toBeNull();
    expect(pane('greenkeeper').querySelector('[data-testid=gspro-row-course-file]')).not.toBeNull();
    expect(pane('greenkeeper').querySelector('.gspro-export__run-gkd')).not.toBeNull();
    expect(pane('greenkeeper').querySelector('[data-testid=gspro-tee-sets]')).not.toBeNull();
    expect(pane('details').querySelector('[data-testid=gspro-meta]')).not.toBeNull();
    expect(pane('details').querySelector('[data-testid^=gspro-row-]')).toBeNull();

    // The stale rows' tabs (Course shapes, Trees) carry the dot; the rest do not.
    const dotted = [...host.querySelectorAll('[data-testid^=gspro-tab-]')]
        .filter(b => b.querySelector('.gspro-export__tab-dot.stale'))
        .map(b => b.getAttribute('data-testid'));
    expect(dotted).toEqual(['gspro-tab-course', 'gspro-tab-nature']);
});

test('the board opened from the command bar brings the export half with it', async () => {
    const { host, sync, svc } = await mount();
    await sync.openFor('course-1');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect((host.querySelector('.gspro-export') as HTMLElement).className).toContain('show');
    expect(svc.courseId.peek()).toBe('course-1');
    expect(sync.staleCount.peek()).toBe(2);

    (host.querySelector('.gspro-export__header button') as HTMLButtonElement).click();
    expect(sync.isOpen).toBe(false);
    expect(svc.isOpen).toBe(false);
});

// --- Orthophoto ---

test('the vintage picker lists the persisted orthophotos and preselects the one on the map', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const select = host.querySelector('[data-testid=gspro-ortho-source]') as HTMLSelectElement;
    expect(select.parentElement?.className).not.toContain('hidden');
    expect([...select.options].map(o => o.textContent)).toEqual([
        'orto-l2-2025 (shown on map)', 'orto-l2-2025 (cleaned)', 'orto-l2-2023',
    ]);
    expect(svc.orthoSource.peek()).toBe('ortho-orto-l2-2025.tif');
    expect(select.value).toBe('ortho-orto-l2-2025.tif');
    expect(host.textContent).toContain('8192 × 8192');

    const button = host.querySelector('.gspro-export__run-ortho') as HTMLButtonElement;
    expect(button.title).toBe('Export inner orthophoto JPEG');
    expect(button.disabled).toBe(false);
});

test('picking another vintage exports that one', async () => {
    const { host, svc, orthoCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const select = host.querySelector('[data-testid=gspro-ortho-source]') as HTMLSelectElement;
    select.value = 'ortho-orto-l2-2023.tif';
    select.dispatchEvent(new Event('change'));
    expect(svc.orthoSource.peek()).toBe('ortho-orto-l2-2023.tif');

    await svc.runOrtho();
    expect(orthoCalls).toEqual(['ortho-orto-l2-2023.tif']);
    expect(host.textContent).toContain('Wrote');
    expect(host.textContent).toContain('vreta-orto-l2-2025-8192.jpg');
    const lines = [...host.querySelectorAll('.gspro-export__report li')].map(li => li.textContent);
    expect(lines).toEqual(['rendering ortho-orto-l2-2025.tif', 'wrote vreta-orto-l2-2025-8192.jpg']);
});

test('a never-built course hides the picker, says why, and cannot export a JPEG', async () => {
    const { host, svc, orthoCalls } = await mount(null, undefined, []);
    await svc.openFor('course-1', 'Vreta');

    const select = host.querySelector('[data-testid=gspro-ortho-source]') as HTMLSelectElement;
    expect(select.parentElement?.className).toContain('hidden');
    expect(host.textContent).toContain('build its map first');
    const button = host.querySelector('.gspro-export__run-ortho') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    expect(await svc.runOrtho()).toBe(false);
    expect(orthoCalls).toEqual([]);
});

test('close hides the panel again', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');
    (host.querySelector('.gspro-export__header button') as HTMLButtonElement).click();
    expect((host.querySelector('.gspro-export') as HTMLElement).className).not.toContain('show');
});

// --- Terrains ---

test('the panel shows both terrain squares with their side and centre', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const text = host.textContent ?? '';
    expect(text).toContain('Inner terrain');
    expect(text).toContain('2010 m × 2010 m');
    expect(text).toContain('Outer terrain');
    expect(text).toContain('5000 m × 5000 m');
    expect(text).toContain('530\u2009035 E');
    expect(text).not.toContain('Terrains unavailable');
});

test('the outer orthophoto export uses the picked vintage\'s collection', async () => {
    const { host, svc, outerCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const button = host.querySelector('.gspro-export__run-outer-ortho') as HTMLButtonElement;
    expect(button.title).toBe('Export outer orthophoto JPEG');
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain('5000 m outer square');

    const select = host.querySelector('[data-testid=gspro-ortho-source]') as HTMLSelectElement;
    select.value = 'ortho-orto-l2-2023.tif';
    select.dispatchEvent(new Event('change'));
    button.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(outerCalls).toEqual(['orto-l2-2023']);
    expect(host.textContent).toContain('vreta-outer-orto-l2-2023-8192.jpg');
    const lines = [...host.querySelectorAll('.gspro-export__report li')].map(li => li.textContent);
    expect(lines).toEqual(['fetched outer-ortho-orto-l2-2023.tif', 'wrote x.jpg']);
});

test('the DEM buttons export the inner and the outer terrain', async () => {
    const { host, svc, demCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const inner = host.querySelector('.gspro-export__run-inner-dem') as HTMLButtonElement;
    const outer = host.querySelector('.gspro-export__run-outer-dem') as HTMLButtonElement;
    expect(inner.title).toBe('Export inner heightmap (RAW + GeoTIFF)');
    expect(outer.title).toBe('Export outer heightmap (RAW + GeoTIFF)');
    expect(inner.disabled).toBe(false);
    expect(outer.disabled).toBe(false);
    expect(host.textContent).toContain('TIF → RAW step, done');
    expect(host.textContent).toContain('4097 × 4097');

    inner.click();
    await svc.busy.peek(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    outer.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    expect(demCalls).toEqual(['inner', 'outer']);
    expect(host.textContent).toContain('vreta-outer-dem-2010m.tif');
});

test('the → Unity buttons put one terrain\'s heightmap onto its Unity terrain', async () => {
    const { host, svc, unityTerrainCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const inner = host.querySelector('[data-testid=gspro-inner-unity]') as HTMLButtonElement;
    const outer = host.querySelector('[data-testid=gspro-outer-unity]') as HTMLButtonElement;
    expect(inner.title).toBe('Inner heightmap → Unity');
    expect(outer.title).toBe('Outer heightmap → Unity');
    expect(inner.textContent).toBe('→ Unity');
    expect(inner.disabled).toBe(false);

    inner.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    outer.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    // The one-terrain step the Terrain row's Update does for both.
    expect(unityTerrainCalls).toEqual(['inner', 'outer']);
    expect(host.textContent).toContain('heights from vreta-outer-dem.tif.json');
});

test('the hillshade buttons render the inner and the outer terrain', async () => {
    const { host, svc, hillshadeCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const inner = host.querySelector('.gspro-export__run-inner-hillshade') as HTMLButtonElement;
    const outer = host.querySelector('.gspro-export__run-outer-hillshade') as HTMLButtonElement;
    expect(inner.title).toBe('Export inner hillshade JPEG');
    expect(outer.title).toBe('Export outer hillshade JPEG');
    expect(host.textContent).toContain('hillshade of the terrain');

    inner.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    outer.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    expect(hillshadeCalls).toEqual(['inner', 'outer']);
    expect(host.textContent).toContain('vreta-outer-hillshade-8192.jpg');
});

test('the trees buttons export the inner and the outer terrain', async () => {
    const { host, svc, treesCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const inner = host.querySelector('.gspro-export__run-inner-trees') as HTMLButtonElement;
    const outer = host.querySelector('.gspro-export__run-outer-trees') as HTMLButtonElement;
    expect(inner.title).toBe('Export inner trees');
    expect(outer.title).toBe('Export outer trees');
    expect(host.textContent).toContain('unity-trees file');

    inner.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    outer.click();
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    expect(treesCalls).toEqual(['inner', 'outer']);
    expect(host.textContent).toContain('vreta-outer-trees.json');
});

test('the footer shows what single-file export is running and what last ran', async () => {
    const { host, svc } = await mount();
    await open(svc);
    const note = () => host.querySelector('[data-testid=gspro-export-job]') as HTMLElement;
    expect(note().closest('.gspro-export__section')!.className).toContain('hidden');
    await svc.runDem('inner');
    expect(note().textContent).toMatch(/^Last export: dem, done in \d+ s$/);
    expect(note().closest('.gspro-export__section')!.className).not.toContain('hidden');
});

test('a course with no map area says why the terrains are unavailable and cannot export them', async () => {
    const { host, svc, demCalls, outerCalls } = await mount(null, undefined, [], null);
    await svc.openFor('course-1', 'Vreta');

    expect(host.textContent).toContain('Terrains unavailable: Course has no map area');
    for (const cls of ['run-inner-dem', 'run-outer-dem', 'run-outer-ortho', 'run-inner-hillshade', 'run-outer-hillshade', 'run-inner-trees', 'run-outer-trees']) {
        expect((host.querySelector(`.gspro-export__${cls}`) as HTMLButtonElement).disabled).toBe(true);
    }
    // The rest of the panel still works: folder + SVG export are unaffected.
    expect((host.querySelector('input[type="text"]') as HTMLInputElement).placeholder).toBe(DEFAULT_DIR);
    expect((host.querySelector('[data-testid=gspro-run-svg]') as HTMLButtonElement).disabled).toBe(false);
    expect(await svc.runDem('inner')).toBe(true);  // the server is the judge; the button just guards
    expect(demCalls).toEqual(['inner']);
    expect(outerCalls).toEqual([]);
});

test('the forest floor box is on, its colour and mix hide with it, and the pick reaches the cleaned export', async () => {
    const { host, svc, floorCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const box = [...host.querySelectorAll('.gspro-export__check')]
        .find(l => l.textContent?.includes('Forest floor'))!.querySelector('input') as HTMLInputElement;
    const fields = host.querySelector('.gspro-export__floor') as HTMLElement;
    const color = fields.querySelector('input[type="color"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(fields.className).not.toContain('hidden');
    expect(color.value).toBe('#505834');

    color.value = '#604830';
    color.dispatchEvent(new Event('input'));
    const button = host.querySelector('.gspro-export__run-clean-ortho') as HTMLButtonElement;
    button.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(fields.className).toContain('hidden');
    button.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(floorCalls).toEqual(['#604830', undefined]);
});

test('the cleaned section has the one-step button into Unity, enabled once a vintage is picked', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');
    const button = host.querySelector('[data-testid="gspro-unity-ortho"]') as HTMLButtonElement;
    expect(button.title).toBe('Inner cleaned photo → Unity meshes');
    expect(button.disabled).toBe(false);
});

test('the vegetation zone buttons export the inner and the outer terrain', async () => {
    const { host, svc, zonesCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const inner = host.querySelector('.gspro-export__run-inner-zones') as HTMLButtonElement;
    const outer = host.querySelector('.gspro-export__run-outer-zones') as HTMLButtonElement;
    expect(inner.title).toBe('Export inner vegetation zones');
    expect(outer.title).toBe('Export outer vegetation zones');
    inner.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    outer.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(zonesCalls).toEqual(['inner', 'outer']);
    expect(host.textContent).toContain('vreta-outer-zones.json');
});

// --- GreenKeeper course file ---

const SCENE = 'C:\\GSProV1\\Core\\GSP\\Courses\\Vreta_lidar_scene';

test('the GKD export waits for a GSPro course folder, saves it, and writes the GKD there', async () => {
    const { host, svc, gkdCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const button = host.querySelector('.gspro-export__run-gkd') as HTMLButtonElement;
    expect(button.textContent).toBe('Export GreenKeeper course file');
    expect(button.disabled).toBe(true);

    const field = [...host.querySelectorAll('input[type="text"]')]
        .find(i => (i as HTMLInputElement).placeholder.includes('Courses')) as HTMLInputElement;
    field.value = SCENE;
    field.dispatchEvent(new Event('input'));
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain('Saved with the course when you export.');

    button.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(gkdCalls).toEqual([SCENE]);
    expect(host.textContent).toContain(`Wrote ${SCENE}\\Vreta_lidar_scene.GKD`);
    expect(host.textContent).toContain('Writes Vreta_lidar_scene.GKD there.');
});

test('the GKD export without a course folder says what to set', async () => {
    const { svc, gkdCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');
    expect(await svc.runGkd()).toBe(false);
    expect(svc.error.peek()).toMatch(/Set the GSPro course folder first/);
    expect(gkdCalls).toEqual([]);
});

test('course details show from the .GKD, are kept when one changes, and a GreenKeeper edit is read back in', async () => {
    const { host, svc, metaCalls, gkd } = await mount();
    await svc.openFor('course-1', 'Vreta');
    const input = (id: string) => host.querySelector(`[data-testid="gspro-meta-${id}"]`) as HTMLInputElement;
    const hint = () => host.querySelector('[data-testid="gspro-meta-hint"]')!.textContent;
    const read = host.querySelector('[data-testid="gspro-meta-read"]') as HTMLButtonElement;
    const tick = () => new Promise(r => setTimeout(r, 0));

    // No folder, nothing kept: a blank form under the course's own name.
    expect(input('courseName').value).toBe('Vreta');
    expect(input('designer').value).toBe('');
    expect(read.className).toContain('hidden');

    // The folder's .GKD brings what was typed in GreenKeeper; nothing is kept until a field changes.
    svc.courseDirDraft.set(SCENE);
    await svc.saveCourseDir();
    expect(input('designer').value).toBe('Fandorm');
    expect(input('description').value).toBe('Oak parkland.');
    expect((host.querySelector('.gspro-export__keywords input:checked')!.parentElement as HTMLElement).textContent).toContain('Parkland');
    expect(hint()).toContain('shown from the .GKD');
    expect(metaCalls).toEqual([]);

    input('designer').value = 'Marcus';
    input('designer').dispatchEvent(new Event('change'));
    await tick();
    expect(metaCalls).toEqual([{ ...GKD_META, designer: 'Marcus' }]);
    expect(hint()).toContain('The .GKD has a different designer');
    expect(read.className).not.toContain('hidden');

    // Saved in GreenKeeper again: read it in, and the two agree.
    gkd.meta = { ...GKD_META, designer: 'Fandorm', homage: 'Vreta Kloster GK' };
    gkd.ratings = ['Yellow 71.5/135'];
    await svc.saveCourseDir();
    expect(hint()).toContain('The .GKD rates Yellow 71.5/135, which the course\'s tee sets do not.');
    read.click();
    await tick();
    await tick();
    expect(input('designer').value).toBe('Fandorm');
    expect(input('homage').value).toBe('Vreta Kloster GK');
    expect(hint()).toBe('');
    expect(read.className).toContain('hidden');
});

// --- SVG test variants ---

test('features are left out of the SVG from the filtered list and the map selection, and marked on the map', async () => {
    const geometry = { crs: 'EPSG:3006', rings: [{ points: [{ x: 530000, y: 6487000 }, { x: 530010, y: 6487000 }, { x: 530000, y: 6487010 }] }] };
    const item = (id: string, type: string) => ({
        id, courseId: 'course-1', holeId: null, layer: null, type, geometry, sortOrder: 0,
        source: null, generated: false, sourceRef: null, license: null, attributes: null, version: 1,
    }) as CourseFeature;
    const features = new FeaturesService({
        listByCourse: async () => [item('road-1', 'path'), item('road-2', 'path'), item('green-1', 'green'), item('oob-1', 'oob')],
    } as unknown as CourseFeaturesApi);
    di.set(FeaturesService, features);
    const { api, svgCalls } = fakeApi(null);
    const svc = new GsproExportService(api, 1, null);
    di.set(GsproExportService, svc);
    di.set(GsproSyncService, new GsproSyncService(fakeSyncApi().api, 1, 60_000));
    const host = document.createElement('div');
    new GsproExportPanelComponent({}).mount(host);
    await svc.openFor('course-1', 'Vreta');
    await new Promise(r => setTimeout(r, 0));  // the panel loads the course's features

    const list = () => [...host.querySelectorAll('[data-testid=gspro-svg-features] li')];
    expect(list()).toHaveLength(3);  // OOB is never in the SVG, so never offered

    const type = host.querySelector('select[aria-label=Type]') as HTMLSelectElement;
    type.value = 'path';
    type.dispatchEvent(new Event('change'));
    expect(list()).toHaveLength(2);
    (host.querySelector('[data-testid=gspro-exclude-shown]') as HTMLButtonElement).click();

    features.setSelection(['green-1']);
    (host.querySelector('[data-testid=gspro-exclude-selected]') as HTMLButtonElement).click();
    expect([...features.exportExcludedIds.peek()].sort()).toEqual(['green-1', 'road-1', 'road-2']);

    const variant = host.querySelector('[data-testid=gspro-svg-variant]') as HTMLInputElement;
    variant.value = 'bare';
    variant.dispatchEvent(new Event('input'));
    expect(host.textContent).toContain('Writes vreta-bare.svg');

    await svc.run();
    expect(svgCalls).toEqual([{ excludeFeatureIds: ['road-1', 'road-2', 'green-1'], variant: 'bare' }]);

    svc.close();
    expect(features.exportExcludedIds.peek().size).toBe(0);  // no marks once the panel is closed
});

test('bisecting the shown paths walks the steps to the culprit', async () => {
    const geometry = (x: number) => ({ crs: 'EPSG:3006', rings: [{ points: [{ x, y: 6487000 }, { x: x + 10, y: 6487000 }, { x, y: 6487010 }] }] });
    const item = (id: string, type: string, x: number) => ({
        id, courseId: 'course-1', holeId: null, layer: null, type, geometry: geometry(x), sortOrder: 0,
        source: null, generated: false, sourceRef: null, license: null, attributes: null, version: 1,
    }) as CourseFeature;
    const paths = ['road-a', 'road-b', 'road-c', 'road-d'].map((id, i) => item(id, 'path', 530000 + i * 100));
    const features = new FeaturesService({
        listByCourse: async () => [...paths, item('green-1', 'green', 530500)],
    } as unknown as CourseFeaturesApi);
    di.set(FeaturesService, features);
    const { api, svgCalls } = fakeApi(null);
    const svc = new GsproExportService(api, 1, null);
    di.set(GsproExportService, svc);
    di.set(GsproSyncService, new GsproSyncService(fakeSyncApi().api, 1, 60_000));
    const host = document.createElement('div');
    new GsproExportPanelComponent({}).mount(host);
    await svc.openFor('course-1', 'Vreta');
    await new Promise(r => setTimeout(r, 0));

    const type = host.querySelector('select[aria-label=Type]') as HTMLSelectElement;
    type.value = 'path';
    type.dispatchEvent(new Event('change'));
    const start = host.querySelector('[data-testid=gspro-bisect-start]') as HTMLButtonElement;
    expect(start.textContent).toBe('Bisect the 4 shown');
    start.click();
    await new Promise(r => setTimeout(r, 10));  // step 1 exports straight away

    const box = () => (host.querySelector('[data-testid=gspro-bisect]') as HTMLElement).textContent ?? '';
    expect(box()).toContain('Step 1: 4 suspects');
    expect(box()).toContain('vreta-bisect-1.svg leaves out 2 of them');
    // The culprit is road-c: Blender builds exactly when it is left out.
    const answer = async () => {
        const excluded = svgCalls.at(-1)?.excludeFeatureIds ?? [];
        const ok = excluded.includes('road-c');
        (host.querySelector(`[data-testid=gspro-bisect-${ok ? 'ok' : 'failed'}]`) as HTMLButtonElement).click();
        await new Promise(r => setTimeout(r, 10));
    };
    for (let i = 0; i < 3 && !svc.svgBisect.peek()?.result; i++) await answer();
    expect(svc.svgBisect.peek()?.result).toBe('confirmed');
    expect(box()).toContain('Found it: Path (roadc)');
    expect(svgCalls.map(c => c.variant)).toEqual(['bisect-1', 'bisect-2', 'bisect-3']);
});

// --- (i) tips ---

test('the long explanations sit behind (i) tips, not in the panel', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const visible = [...host.querySelectorAll('.hint')].map(h => h.textContent ?? '');
    for (const text of visible) expect(text.length).toBeLessThan(120);
    expect(visible.join(' ')).not.toContain('Light multiplier');
    expect(host.querySelectorAll('.info-tip').length).toBeGreaterThanOrEqual(12);
});

test('hovering or focusing an (i) shows its text in a popup, and leaving hides it', async () => {
    const { host, svc } = await mount();
    document.body.appendChild(host);
    try {
        await svc.openFor('course-1', 'Vreta');
        const tip = [...host.querySelectorAll('.info-tip')]
            .find(t => t.textContent?.includes('Light multiplier')) as HTMLElement;

        tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const popup = document.getElementById('info-tip-popup') as HTMLElement;
        expect(popup.style.display).toBe('block');
        expect(popup.textContent).toContain('Light multiplier for the -terrain twin');
        expect(tip.getAttribute('aria-describedby')).toBe('info-tip-popup');

        tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: host }));
        expect(popup.style.display).toBe('none');

        // A reactive tip: the outer orthophoto's names the outer square's side.
        const outer = host.querySelector('.gspro-export__row .info-tip') as HTMLElement;
        outer.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(popup.textContent).toContain('5000 m outer square');
        outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(popup.style.display).toBe('none');
    } finally {
        host.remove();
    }
});

test('the GSPro course folder is saved when the field is left and is back when the panel opens again', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const field = () => [...host.querySelectorAll('input[type="text"]')]
        .find(i => (i as HTMLInputElement).placeholder.includes('Courses')) as HTMLInputElement;
    field().value = SCENE;
    field().dispatchEvent(new Event('input'));
    field().dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 0));
    // Saving on leave must not disable the export button under the click that caused the blur.
    expect(svc.busy.peek()).toBe(false);
    expect(svc.settings.peek()?.courseDir).toBe(SCENE);

    svc.close();
    await svc.openFor('course-1', 'Vreta');
    expect(field().value).toBe(SCENE);
    expect(host.textContent).toContain('Writes Vreta_lidar_scene.GKD there.');
});

test('the Shapes row shows what OPCD made of each recent SVG export, the last good one marked', async () => {
    const { host, svc } = await mount();
    await open(svc);

    const line = host.querySelector('[data-testid=gspro-builds-shapes]')!;
    const marks = [...line.querySelectorAll('.gspro-export__build')];
    expect(marks.map(m => m.textContent)).toEqual(['15/10 15:37 ✗', '15/10 13:17 ✓', '15/10 13:10 ?']);
    expect(marks.map(m => m.className)).toEqual([
        'gspro-export__build failed', 'gspro-export__build ok last-good', 'gspro-export__build unknown',
    ]);
    expect(marks[1]!.getAttribute('title')).toBe('Export 2026-10-15_13-17-34: OPCD built (Processing Complete, created 2026-10-17 07:17 OPCD time) — last good');
    // No other row has a builds line.
    const lines = [...host.querySelectorAll('[data-testid^=gspro-builds-]')].filter(n => n.innerHTML !== '');
    expect(lines.map(n => n.getAttribute('data-testid'))).toEqual(['gspro-builds-shapes']);
});

test('the R.A.M. roads row updates like the others and folds its Propose step to one line', async () => {
    const { host, svc, updates } = await mount();
    await open(svc);

    const row = host.querySelector('[data-testid=gspro-row-roads]')!;
    expect(row.querySelector('.gspro-export__blabel')!.textContent!.trim()).toStartWith('R.A.M. roads');
    expect(host.querySelector('[data-testid=gspro-status-roads]')!.textContent).toBe('2 h ago · up to date');
    (host.querySelector('[data-testid=gspro-update-roads]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 20));
    expect(updates).toEqual(['roads']);

    // Folded: Propose and the min distance (30 m), nothing else shown.
    const step = row.querySelector('[data-testid=gspro-roads-propose]')!;
    expect((step.querySelector('[data-testid=gspro-roads-min-distance]') as HTMLInputElement).value).toBe('30');
    expect(step.querySelectorAll('[data-testid=gspro-roads-candidate]').length).toBe(0);
    expect(step.querySelector('[data-testid=gspro-roads-accept]')!.className).toContain('hidden');
    for (const id of ['summary', 'already', 'rejected', 'done', 'error']) {
        expect(step.querySelector(`[data-testid=gspro-roads-${id}]`)!.textContent).toBe('');
    }
});

test('Propose lists the candidates ticked, one line each; Accept sets the ticked ones to R.A.M. and says what is next', async () => {
    const { host, svc, roads } = await mount();
    await open(svc);
    const step = host.querySelector('[data-testid=gspro-roads-propose]')!;
    const q = (id: string) => step.querySelector(`[data-testid=gspro-roads-${id}]`) as HTMLElement;

    const distance = q('min-distance') as HTMLInputElement;
    distance.value = '40';
    distance.dispatchEvent(new Event('change'));
    (q('propose-run') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    expect(roads.proposals).toEqual([40]);

    const lines = [...step.querySelectorAll('[data-testid=gspro-roads-candidate]')];
    expect(lines.map(l => l.textContent)).toEqual([
        'path 38 · gravel · 465 m · 41 m from play',
        'path 40 · asphalt · 120 m · 75 m from play',
    ]);
    const boxes = lines.map(l => l.querySelector('input') as HTMLInputElement);
    expect(boxes.map(b => b.checked)).toEqual([true, true]);
    expect(q('summary').textContent).toBe('2 roads proposed');
    // Already-R.A.M. and left-out roads: one line each, the details in the title.
    expect(q('already').textContent).toBe('1 already R.A.M.');
    expect(q('already').title).toBe('path 12');
    expect(q('rejected').textContent).toBe('2 left out');
    expect(q('rejected').title).toBe('path 7: no centerline\npath abcdef01: 12 m from play');

    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event('change'));
    const accept = q('accept') as HTMLButtonElement;
    expect(accept.className).not.toContain('hidden');
    expect(accept.textContent).toBe('Accept 1 road');
    accept.click();
    await new Promise(r => setTimeout(r, 0));
    expect(roads.renders).toEqual([{ featureIds: ['f38'], render: 'ram' }]);
    expect(q('done').textContent).toBe('1 road set to R.A.M. — build the SVG in OPCD next');
    // The step folds back to its one line.
    expect(step.querySelectorAll('[data-testid=gspro-roads-candidate]').length).toBe(0);
    expect(q('accept').className).toContain('hidden');
});
