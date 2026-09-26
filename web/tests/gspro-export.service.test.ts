import { test, expect, afterEach } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { GsproExportService, terrainLabel, jobLabel, DEFAULT_FLOOR_COLOR } from '../src/export/gspro-export.service';
import type { GsproExportApi, GsproExportSettings, GsproOrthoSource, CourseTerrain, GsproExportJob } from '../../shared/api/gspro-export.gen';

// GsproExportService against an in-memory fake of the export API injected
// through the constructor — real service, real signals. Mirrors the fake-API
// style of clubs.service.test.ts.

afterEach(() => _reset());

const DEFAULT_DIR = '/home/marcus/Downloads';

/** What a built site persists: two vintages, the newer one patched too. */
const SOURCES: GsproOrthoSource[] = [
    { source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', patched: false, active: true },
    { source: 'ortho-orto-l2-2025.patched.tif', collection: 'orto-l2-2025', patched: true, active: true },
    { source: 'ortho-orto-l2-2023.tif', collection: 'orto-l2-2023', patched: false, active: false },
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

/** Fake server: holds one folder per course, same null-means-default rule. */
function fakeApi(opts: { failRun?: string; failSetDir?: string; sources?: GsproOrthoSource[]; noTerrain?: boolean } = {}) {
    const dirs = new Map<string, string | null>();
    const calls = { svg: [] as { excludeFeatureIds?: string[]; variant?: string }[], settings: 0, setDir: 0, run: 0, runOrtho: [] as string[], runOuterOrtho: [] as string[], runDem: [] as string[], runHillshade: [] as string[], runTrees: [] as string[], runZones: [] as string[], terrain: 0, darken: [] as (number | undefined)[], tint: [] as [boolean | undefined, number | undefined][], floor: [] as [boolean | undefined, string | undefined, number | undefined][], buildings: [] as (boolean | undefined)[] };

    const settingsFor = (courseId: string): GsproExportSettings => {
        const dir = dirs.get(courseId) ?? null;
        return { dir: dir ?? DEFAULT_DIR, isDefault: dir === null, defaultDir: DEFAULT_DIR };
    };

    const handlers: Record<string, (input: any) => Promise<any>> = {
        async settings({ courseId }) {
            calls.settings++;
            return settingsFor(courseId);
        },
        async setDir({ courseId, dir }) {
            calls.setDir++;
            if (opts.failSetDir) throw new Error(opts.failSetDir);
            dirs.set(courseId, dir && dir.trim() ? dir.trim() : null);
            return settingsFor(courseId);
        },
        async run({ courseId, excludeFeatureIds, variant }) {
            calls.svg.push({ excludeFeatureIds, variant });
            calls.run++;
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta.svg`, report: ['Wrote x.svg', '200 features in 19 layer(s)'] };
        },
        async orthoSources() {
            return opts.sources ?? SOURCES;
        },
        async runOrtho({ courseId, source, darken, tint, tintOpacity, forestFloor, floorColor, floorMix, removeBuildings }) {
            calls.runOrtho.push(source);
            calls.buildings.push(removeBuildings);
            calls.darken.push(darken);
            calls.tint.push([tint, tintOpacity]);
            calls.floor.push([forestFloor, floorColor, floorMix]);
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta-orto-l2-2025-8192.jpg`, report: ['rendering ortho-orto-l2-2025.tif', 'wrote x.jpg'] };
        },
        async terrain() {
            calls.terrain++;
            if (opts.noTerrain) throw new Error('Course has no map area to lay out the GSPro terrains for: build the course map first.');
            return TERRAIN;
        },
        async runOuterOrtho({ courseId, collection, darken, tint, tintOpacity, forestFloor, floorColor, floorMix, removeBuildings }) {
            calls.runOuterOrtho.push(collection);
            calls.buildings.push(removeBuildings);
            calls.darken.push(darken);
            calls.tint.push([tint, tintOpacity]);
            calls.floor.push([forestFloor, floorColor, floorMix]);
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta-outer-${collection}-8192.jpg`, report: [`fetched outer-ortho-${collection}.tif`, 'wrote x.jpg'] };
        },
        async runDem({ courseId, terrain }) {
            calls.runDem.push(terrain);
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta-${terrain}-dem-${TERRAIN[terrain].sideM}m.tif`, report: ['Wrote x.tif', 'Wrote x.tif.json'] };
        },
        async runHillshade({ courseId, terrain }) {
            calls.runHillshade.push(terrain);
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta-${terrain}-hillshade-8192.jpg`, report: ['Wrote x.jpg  (8192×8192)'] };
        },
        async runTrees({ courseId, terrain }) {
            calls.runTrees.push(terrain);
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta-${terrain}-trees.json`, report: ['Wrote x.json', '120 trees'] };
        },
        async runZones({ courseId, terrain }) {
            calls.runZones.push(terrain);
            if (opts.failRun) throw new Error(opts.failRun);
            const { dir } = settingsFor(courseId);
            return { path: `${dir}/vreta-${terrain}-zones.json`, report: ['Wrote x.json', '14 zones'] };
        },
    };
    const api = jobApi(handlers);
    return { api, calls, dirs };
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
        settings: h.settings, setDir: h.setDir, orthoSources: h.orthoSources, terrain: h.terrain,
        async start(input) {
            const { courseId, kind } = input;
            const result = kind === 'svg' ? await h.run({ courseId, excludeFeatureIds: input.excludeFeatureIds, variant: input.variant })
                : kind === 'ortho' ? await h.runOrtho({ courseId, source: input.source, darken: input.darken, tint: input.tint, tintOpacity: input.tintOpacity, forestFloor: input.forestFloor, floorColor: input.floorColor, floorMix: input.floorMix, removeBuildings: input.removeBuildings })
                : kind === 'outer-ortho' ? await h.runOuterOrtho({ courseId, collection: input.collection, darken: input.darken, tint: input.tint, tintOpacity: input.tintOpacity, forestFloor: input.forestFloor, floorColor: input.floorColor, floorMix: input.floorMix, removeBuildings: input.removeBuildings })
                : kind === 'dem' ? await h.runDem({ courseId, terrain: input.terrain })
                : kind === 'hillshade' ? await h.runHillshade({ courseId, terrain: input.terrain })
                : kind === 'zones' ? await h.runZones({ courseId, terrain: input.terrain })
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

async function openService(opts: Parameters<typeof fakeApi>[0] = {}) {
    const { api, calls, dirs } = fakeApi(opts);
    const svc = new GsproExportService(api, 1);
    await svc.openFor('course-1', 'Vreta');
    return { svc, calls, dirs };
}

test('opening loads the course folder and marks the panel open', async () => {
    const { svc, calls } = await openService();
    expect(svc.isOpen).toBe(true);
    expect(svc.courseName.peek()).toBe('Vreta');
    expect(calls.settings).toBe(1);
    expect(svc.settings.peek()?.defaultDir).toBe(DEFAULT_DIR);
});

test('an unset folder shows as blank, so the placeholder can offer the default', async () => {
    const { svc } = await openService();
    expect(svc.settings.peek()?.isDefault).toBe(true);
    expect(svc.dirDraft.peek()).toBe('');
});

test('saving a folder persists it and it comes back on reopen', async () => {
    const { svc } = await openService();
    svc.dirDraft.set('D:/gspro_courses/vreta/opcd');
    expect(await svc.saveDir()).toBe(true);
    expect(svc.settings.peek()?.isDefault).toBe(false);

    await svc.openFor('course-1', 'Vreta');
    expect(svc.dirDraft.peek()).toBe('D:/gspro_courses/vreta/opcd');
});

test('the folder is per course', async () => {
    const { svc } = await openService();
    svc.dirDraft.set('D:/one');
    await svc.saveDir();

    await svc.openFor('course-2', 'Landeryd');
    expect(svc.dirDraft.peek()).toBe('');  // untouched course still on the default

    await svc.openFor('course-1', 'Vreta');
    expect(svc.dirDraft.peek()).toBe('D:/one');
});

test('blanking the folder resets that course to the default', async () => {
    const { svc } = await openService();
    svc.dirDraft.set('D:/one');
    await svc.saveDir();

    svc.dirDraft.set('   ');
    await svc.saveDir();
    expect(svc.settings.peek()?.isDefault).toBe(true);
    expect(svc.dirDraft.peek()).toBe('');
});

test('export saves the typed folder first, so an edited path is never ignored', async () => {
    const { svc, calls, dirs } = await openService();
    svc.dirDraft.set('D:/typed/but/not/saved');

    expect(await svc.run()).toBe(true);
    expect(calls.setDir).toBe(1);
    expect(dirs.get('course-1')).toBe('D:/typed/but/not/saved');
    expect(svc.lastPath.peek()).toBe('D:/typed/but/not/saved/vreta.svg');
});

test('a successful run reports where the file landed and what the exporter said', async () => {
    const { svc } = await openService();
    expect(await svc.run()).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta.svg`);
    expect(svc.report.peek()).toContain('200 features in 19 layer(s)');
    expect(svc.error.peek()).toBe('');
    expect(svc.busy.peek()).toBe(false);
});

test('a failed run surfaces the server message and clears busy', async () => {
    const { svc } = await openService({ failRun: 'GSPro SVG export failed: no course matching' });
    expect(await svc.run()).toBe(false);
    expect(svc.error.peek()).toMatch(/no course matching/);
    expect(svc.busy.peek()).toBe(false);
    expect(svc.lastPath.peek()).toBeNull();
});

test('a rejected folder stops the export before it runs', async () => {
    const { svc, calls } = await openService({ failSetDir: 'exists but is not a folder' });
    svc.dirDraft.set('D:/some/file.txt');
    expect(await svc.run()).toBe(false);
    expect(calls.run).toBe(0);
    expect(svc.error.peek()).toMatch(/not a folder/);
});

test('reopening clears the previous run so stale results are never shown', async () => {
    const { svc } = await openService();
    await svc.run();
    expect(svc.lastPath.peek()).not.toBeNull();

    await svc.openFor('course-2', 'Landeryd');
    expect(svc.lastPath.peek()).toBeNull();
    expect(svc.report.peek()).toEqual([]);
    expect(svc.error.peek()).toBe('');
});

// --- Orthophoto ---

test('opening lists the persisted vintages and picks the pristine one the map shows', async () => {
    const { svc } = await openService();
    expect(svc.orthoSources.peek()).toEqual(SOURCES);
    expect(svc.orthoSource.peek()).toBe('ortho-orto-l2-2025.tif');
});

test('with nothing shown on the map the newest vintage is picked', async () => {
    const { svc } = await openService({ sources: SOURCES.map(s => ({ ...s, active: false })) });
    expect(svc.orthoSource.peek()).toBe('ortho-orto-l2-2025.tif');
});

test('a never-built course has no vintages and nothing picked', async () => {
    const { svc, calls } = await openService({ sources: [] });
    expect(svc.orthoSources.peek()).toEqual([]);
    expect(svc.orthoSource.peek()).toBe('');
    expect(await svc.runOrtho()).toBe(false);
    expect(calls.runOrtho).toEqual([]);
});

test('runOrtho saves the folder, exports the picked vintage and reports the JPEG', async () => {
    const { svc, calls, dirs } = await openService();
    svc.dirDraft.set('D:/typed');
    svc.orthoSource.set('ortho-orto-l2-2023.tif');

    expect(await svc.runOrtho()).toBe(true);
    expect(dirs.get('course-1')).toBe('D:/typed');
    expect(calls.runOrtho).toEqual(['ortho-orto-l2-2023.tif']);
    expect(svc.lastPath.peek()).toBe('D:/typed/vreta-orto-l2-2025-8192.jpg');
    expect(svc.report.peek()).toEqual(['rendering ortho-orto-l2-2025.tif', 'wrote x.jpg']);
    expect(svc.busy.peek()).toBe(false);
});

test('an SVG run after an ortho run replaces the previous result, never mixing them', async () => {
    const { svc } = await openService();
    await svc.runOrtho();
    expect(svc.lastPath.peek()).toMatch(/\.jpg$/);
    await svc.run();
    expect(svc.lastPath.peek()).toMatch(/\.svg$/);
    expect(svc.report.peek()).toEqual(['Wrote x.svg', '200 features in 19 layer(s)']);
});

test('a failed ortho run surfaces the server message and clears the stale path', async () => {
    const { svc } = await openService({ failRun: 'GSPro orthophoto export failed: not a TIFF' });
    expect(await svc.runOrtho()).toBe(false);
    expect(svc.error.peek()).toMatch(/not a TIFF/);
    expect(svc.lastPath.peek()).toBeNull();
    expect(svc.busy.peek()).toBe(false);
});

test('closing marks the panel closed and drops the busy flag', async () => {
    const { svc } = await openService();
    svc.close();
    expect(svc.isOpen).toBe(false);
    expect(svc.busy.peek()).toBe(false);
});

test('saving or running with the panel closed is a no-op', async () => {
    const { svc, calls } = await openService();
    svc.close();
    expect(await svc.saveDir()).toBe(false);
    expect(await svc.run()).toBe(false);
    expect(calls.setDir).toBe(0);
    expect(calls.run).toBe(0);
});

// --- Terrains ---

test('opening loads the two terrain squares alongside the folder and vintages', async () => {
    const { svc, calls } = await openService();
    expect(calls.terrain).toBe(1);
    expect(svc.terrain.peek()).toEqual(TERRAIN);
    expect(svc.terrainNote.peek()).toBe('');
    expect(svc.terrain.peek()!.inner.sideM % 10).toBe(0);
    expect(svc.terrain.peek()!.outer.sideM).toBe(5000);
});

test('a course with no map area keeps the panel usable and notes why the terrains are missing', async () => {
    const { svc } = await openService({ noTerrain: true });
    expect(svc.terrain.peek()).toBeNull();
    expect(svc.terrainNote.peek()).toMatch(/no map area/);
    expect(svc.error.peek()).toBe('');            // not a panel-level failure
    expect(svc.settings.peek()).not.toBeNull();   // the folder still loaded
    expect(svc.orthoSource.peek()).toBe('ortho-orto-l2-2025.tif');
});

test('reopening for another course reloads the terrains and clears a stale note', async () => {
    const { svc } = await openService({ noTerrain: true });
    expect(svc.terrainNote.peek()).not.toBe('');
    svc.terrainNote.set('');  // (the fake keeps failing; the reset is what is under test)
    await svc.openFor('course-2', 'Landeryd');
    expect(svc.terrain.peek()).toBeNull();
    expect(svc.terrainNote.peek()).toMatch(/no map area/);
});

test('runOuterOrtho saves the folder and fetches the picked vintage by collection over the outer square', async () => {
    const { svc, calls, dirs } = await openService();
    svc.dirDraft.set('D:/typed');
    svc.orthoSource.set('ortho-orto-l2-2023.tif');
    expect(svc.pickedCollection).toBe('orto-l2-2023');

    expect(await svc.runOuterOrtho()).toBe(true);
    expect(dirs.get('course-1')).toBe('D:/typed');
    expect(calls.runOuterOrtho).toEqual(['orto-l2-2023']);
    expect(svc.lastPath.peek()).toBe('D:/typed/vreta-outer-orto-l2-2023-8192.jpg');
    expect(svc.report.peek()).toEqual(['fetched outer-ortho-orto-l2-2023.tif', 'wrote x.jpg']);
});

test('a patched pick still names the plain collection for the outer fetch', async () => {
    const { svc, calls } = await openService();
    svc.orthoSource.set('ortho-orto-l2-2025.patched.tif');
    expect(svc.pickedCollection).toBe('orto-l2-2025');
    await svc.runOuterOrtho();
    expect(calls.runOuterOrtho).toEqual(['orto-l2-2025']);
});

test('runOuterOrtho with nothing picked is a no-op', async () => {
    const { svc, calls } = await openService({ sources: [] });
    expect(svc.pickedCollection).toBe('');
    expect(await svc.runOuterOrtho()).toBe(false);
    expect(calls.runOuterOrtho).toEqual([]);
});

test('runDem exports the named terrain and reports the GeoTIFF', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runDem('inner')).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta-inner-dem-2010m.tif`);
    expect(await svc.runDem('outer')).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta-outer-dem-5000m.tif`);
    expect(calls.runDem).toEqual(['inner', 'outer']);
    expect(svc.report.peek()).toEqual(['Wrote x.tif', 'Wrote x.tif.json']);
    expect(svc.busy.peek()).toBe(false);
});

test('runHillshade exports the named terrain and reports the JPEG', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runHillshade('inner')).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta-inner-hillshade-8192.jpg`);
    expect(await svc.runHillshade('outer')).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta-outer-hillshade-8192.jpg`);
    expect(calls.runHillshade).toEqual(['inner', 'outer']);
    expect(calls.setDir).toBe(2);  // the folder is saved before each run
    expect(svc.busy.peek()).toBe(false);
});

test('runTrees exports the named terrain and reports the trees file', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runTrees('outer')).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta-outer-trees.json`);
    expect(calls.runTrees).toEqual(['outer']);
    expect(svc.report.peek()).toEqual(['Wrote x.json', '120 trees']);
});

test('the terrain texture brightness travels with both orthophoto exports, blank meaning the default', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runOrtho()).toBe(true);
    svc.terrainDarken.set(' 0,55 ');  // a comma decimal is fine
    expect(await svc.runOrtho()).toBe(true);
    expect(await svc.runOuterOrtho()).toBe(true);
    expect(calls.darken).toEqual([undefined, 0.55, 0.55]);
    // Nonsense never reaches the server.
    svc.terrainDarken.set('bright');
    expect(await svc.runOrtho()).toBe(false);
    expect(svc.error.peek()).toMatch(/between 0.05 and 1/);
    svc.terrainDarken.set('2');
    expect(await svc.runOuterOrtho()).toBe(false);
    expect(calls.darken).toHaveLength(3);
});

test('the surface tint travels with both orthophoto exports: on by default, a blank opacity meaning the default', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runOrtho()).toBe(true);
    svc.tintOpacity.set(' 0,25 ');
    expect(await svc.runOuterOrtho()).toBe(true);
    svc.tintTerrain.set(false);  // off: no tint fields at all, so the server writes no tinted twin
    expect(await svc.runOrtho()).toBe(true);
    expect(calls.tint).toEqual([[true, undefined], [true, 0.25], [undefined, undefined]]);
    // Nonsense never reaches the server.
    svc.tintTerrain.set(true);
    svc.tintOpacity.set('1.5');
    expect(await svc.runOrtho()).toBe(false);
    expect(svc.error.peek()).toMatch(/between 0 and 1/);
    expect(calls.tint).toHaveLength(3);
});

test('the forest floor travels with both cleaned orthophoto exports: on by default with the picked colour, a blank mix meaning the default', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runOrtho(true)).toBe(true);
    svc.floorColor.set('#604830');
    svc.floorMix.set(' 0,2 ');
    expect(await svc.runOuterOrtho(true)).toBe(true);
    svc.forestFloor.set(false);  // off: no floor fields at all, so the pipeline paints nothing
    expect(await svc.runOrtho(true)).toBe(true);
    expect(calls.floor).toEqual([[true, DEFAULT_FLOOR_COLOR, undefined], [true, '#604830', 0.2], [undefined, undefined, undefined]]);
    // Nonsense never reaches the server.
    svc.forestFloor.set(true);
    svc.floorMix.set('lots');
    expect(await svc.runOrtho(true)).toBe(false);
    expect(svc.error.peek()).toMatch(/photo mix must be a number between 0 and 1/);
    expect(calls.floor).toHaveLength(3);
});

test('building removal travels with both cleaned orthophoto exports, on by default', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runOrtho(true)).toBe(true);
    expect(await svc.runOuterOrtho(true)).toBe(true);
    svc.removeBuildings.set(false);
    expect(await svc.runOrtho(true)).toBe(true);
    expect(calls.buildings).toEqual([true, true, undefined]);
});

test('the plain orthophoto exports never ask for building removal or forest floor', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runOrtho()).toBe(true);
    expect(await svc.runOuterOrtho()).toBe(true);
    expect(calls.buildings).toEqual([undefined, undefined]);
    expect(calls.floor).toEqual([[undefined, undefined, undefined], [undefined, undefined, undefined]]);
    // A cleaned export with both boxes off has nothing to do and never reaches the server.
    svc.removeBuildings.set(false);
    svc.forestFloor.set(false);
    expect(await svc.runOrtho(true)).toBe(false);
    expect(svc.error.peek()).toMatch(/Remove buildings.*Forest floor/);
    expect(calls.buildings).toHaveLength(2);
});

test('runZones exports the named terrain and reports the zones file', async () => {
    const { svc, calls } = await openService();
    expect(await svc.runZones('inner')).toBe(true);
    expect(svc.lastPath.peek()).toBe(`${DEFAULT_DIR}/vreta-inner-zones.json`);
    expect(calls.runZones).toEqual(['inner']);
    expect(svc.report.peek()).toEqual(['Wrote x.json', '14 zones']);
});

test('a failed DEM or outer run surfaces the server message like the other runs', async () => {
    const { svc } = await openService({ failRun: 'GSPro outer DEM fetch failed: No DEM items found' });
    expect(await svc.runDem('outer')).toBe(false);
    expect(svc.error.peek()).toMatch(/No DEM items/);
    expect(await svc.runOuterOrtho()).toBe(false);
    expect(svc.lastPath.peek()).toBeNull();
    expect(svc.busy.peek()).toBe(false);
});

// --- Jobs ---

function runningJob(courseId: string, label = 'outer orthophoto'): GsproExportJob {
    return { id: 'job-1', courseId, kind: 'outer-ortho', label, status: 'running',
        startedAt: new Date(Date.now() - 75_000).toISOString(), finishedAt: null, result: null, error: null };
}

/** A job API whose `start` returns a running job that `job` finishes after `polls` polls. */
function slowApi(polls: number, outcome: 'succeeded' | 'failed' = 'succeeded') {
    const base = fakeApi().api;
    let asked = 0;
    let started: GsproExportJob | null = null;
    const finish = (job: GsproExportJob): GsproExportJob => ({
        ...job, status: outcome, finishedAt: new Date().toISOString(),
        result: outcome === 'succeeded' ? { path: '/x/vreta-outer-orto-l2-2025-8192.jpg', report: ['fetched 9 tiles', 'wrote x.jpg'] } : null,
        error: outcome === 'failed' ? 'GSPro outer orthophoto fetch failed: HTTP 403' : null,
    });
    const api: GsproExportApi = {
        ...base,
        async start({ courseId }) { started = runningJob(courseId); return started; },
        async job({ jobId }) {
            if (!started || started.id !== jobId) throw new Error('no such job');
            asked++;
            return asked >= polls ? finish(started) : started;
        },
        async current({ courseId }) { return started ?? null; },
    };
    return { api, polls: () => asked };
}

test('a slow export is followed by polling until it finishes, then its result is shown', async () => {
    const { api, polls } = slowApi(3);
    const svc = new GsproExportService(api, 1);
    await svc.openFor('course-1', 'Vreta');
    const done = svc.runOuterOrtho();
    await new Promise(r => setTimeout(r, 2));
    expect(svc.busy.peek()).toBe(true);
    expect(svc.job.peek()?.status).toBe('running');
    expect(await done).toBe(true);
    expect(polls()).toBe(3);
    expect(svc.job.peek()?.status).toBe('succeeded');
    expect(svc.lastPath.peek()).toBe('/x/vreta-outer-orto-l2-2025-8192.jpg');
    expect(svc.report.peek()).toEqual(['fetched 9 tiles', 'wrote x.jpg']);
    expect(svc.busy.peek()).toBe(false);
});

test('a job that fails on the server surfaces its reason', async () => {
    const svc = new GsproExportService(slowApi(2, 'failed').api, 1);
    await svc.openFor('course-1', 'Vreta');
    expect(await svc.runOuterOrtho()).toBe(false);
    expect(svc.error.peek()).toMatch(/HTTP 403/);
    expect(svc.lastPath.peek()).toBeNull();
    expect(svc.busy.peek()).toBe(false);
});

test('opening the panel resumes a job already running for the course', async () => {
    const { api, polls } = slowApi(2);
    // Make `current` report the running job before any start.
    let started = runningJob('course-1');
    const resuming: GsproExportApi = { ...api, async current() { return started; }, async job() { return polls() >= 0 && ++resumed >= 2 ? { ...started, status: 'succeeded', finishedAt: 'x', result: { path: '/x/a.jpg', report: [] } } : started; } };
    let resumed = 0;
    const svc = new GsproExportService(resuming, 1);
    await svc.openFor('course-1', 'Vreta');
    expect(svc.busy.peek()).toBe(true);
    expect(svc.job.peek()?.label).toBe('outer orthophoto');
    await new Promise(r => setTimeout(r, 20));
    expect(svc.busy.peek()).toBe(false);
    expect(svc.lastPath.peek()).toBe('/x/a.jpg');
});

test('opening the panel shows the last finished job\'s outcome', async () => {
    const finished: GsproExportJob = { ...runningJob('course-1', 'inner heightmap'), status: 'succeeded', finishedAt: new Date().toISOString(),
        result: { path: '/x/vreta-inner-dem-2010m.tif', report: ['Wrote x.tif'] } };
    const api: GsproExportApi = { ...fakeApi().api, async current() { return finished; } };
    const svc = new GsproExportService(api, 1);
    await svc.openFor('course-1', 'Vreta');
    expect(svc.busy.peek()).toBe(false);
    expect(svc.lastPath.peek()).toBe('/x/vreta-inner-dem-2010m.tif');
    expect(jobLabel(svc.job.peek())).toMatch(/^Last export: inner heightmap, done in/);
});

test('opening the panel on a server with no job yet shows no outcome', async () => {
    // The server's null reaches the client as the framework's bare `{ ok: true }`.
    const api: GsproExportApi = { ...fakeApi().api, async current() { return { ok: true } as never; } };
    const svc = new GsproExportService(api, 1);
    await svc.openFor('course-1', 'Vreta');
    expect(svc.job.peek()).toBeNull();
    expect(svc.error.peek()).toBe('');
});

test('a start refused because an export is already running re-attaches to that job', async () => {
    const running = runningJob('course-1', 'outer trees');
    let polled = 0;
    const api: GsproExportApi = {
        ...fakeApi().api,
        async start() { throw new Error('An export is already running for this course: outer trees (job job-1) — wait for it to finish'); },
        async current() { return running; },
        async job() { return ++polled >= 2 ? { ...running, status: 'succeeded', finishedAt: 'x', result: { path: '/x/t.json', report: [] } } : running; },
    };
    const svc = new GsproExportService(api, 1);
    await svc.openFor('course-1', 'Vreta');
    // `current` is consulted on open too; reset so the run's own re-attach is what we measure.
    await new Promise(r => setTimeout(r, 20));
    polled = 0;
    expect(await svc.run()).toBe(true);
    expect(svc.error.peek()).toBe('');
    expect(svc.lastPath.peek()).toBe('/x/t.json');
});

test('jobLabel reads elapsed time for running and finished jobs', () => {
    const t0 = Date.parse('2026-09-12T10:00:00Z');
    const running = { ...runningJob('c'), startedAt: '2026-09-12T10:00:00Z' };
    expect(jobLabel(running, t0 + 72_000)).toBe('Running: outer orthophoto — 1 min 12 s. The server keeps going if you close this panel.');
    expect(jobLabel({ ...running, status: 'succeeded', finishedAt: '2026-09-12T10:00:08Z' })).toBe('Last export: outer orthophoto, done in 8 s');
    expect(jobLabel({ ...running, status: 'failed', finishedAt: '2026-09-12T10:02:00Z', error: 'x' })).toBe('Last export: outer orthophoto failed after 2 min 0 s');
    expect(jobLabel(null)).toBe('');
});

test('terrainLabel reads as side × side and a thin-spaced centre', () => {
    expect(terrainLabel(TERRAIN.inner)).toBe('2010 m × 2010 m, centre 530\u2009035 E 6\u2009487\u2009675 N (EPSG:3006)');
});

// --- SVG test variants (features left out for the Blender build) ---

/** A Map-backed stand-in for localStorage, so tests never share state. */
function memoryStorage() {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
        removeItem: (k: string) => { data.delete(k); },
    };
}

test('a plain SVG export sends no exclusions and no variant', async () => {
    const { api, calls } = fakeApi();
    const svc = new GsproExportService(api, 1, memoryStorage());
    await svc.openFor('course-1', 'Vreta');
    await svc.run();
    expect(calls.svg).toEqual([{ excludeFeatureIds: undefined, variant: undefined }]);
});

test('excluded features and the variant name travel with the SVG export', async () => {
    const { api, calls } = fakeApi();
    const svc = new GsproExportService(api, 1, memoryStorage());
    await svc.openFor('course-1', 'Vreta');
    svc.excludeFromSvg(['road-1', 'road-2', 'bunker-7']);
    svc.includeInSvg(['bunker-7']);
    svc.toggleSvgExcluded('green-3');
    svc.setSvgVariant('  no roads ');
    expect(await svc.run()).toBe(true);
    expect(calls.svg).toEqual([{ excludeFeatureIds: ['road-1', 'road-2', 'green-3'], variant: 'no roads' }]);
});

test('exclusions are kept per course and come back when the panel reopens', async () => {
    const { api } = fakeApi();
    const storage = memoryStorage();
    const svc = new GsproExportService(api, 1, storage);
    await svc.openFor('course-1', 'Vreta');
    svc.excludeFromSvg(['road-1']);
    svc.setSvgVariant('no-roads');

    await svc.openFor('course-2', 'Landeryd');
    expect(svc.svgExcluded.peek().size).toBe(0);
    expect(svc.svgVariant.peek()).toBe('');

    await svc.openFor('course-1', 'Vreta');
    expect([...svc.svgExcluded.peek()]).toEqual(['road-1']);
    expect(svc.svgVariant.peek()).toBe('no-roads');

    svc.clearSvgExclusions();
    svc.setSvgVariant('');
    expect(storage.data.size).toBe(0);  // nothing left behind for a clean course
});

test('without storage (private mode) exclusions still hold for the session', async () => {
    const { api, calls } = fakeApi();
    const svc = new GsproExportService(api, 1, null);
    await svc.openFor('course-1', 'Vreta');
    svc.excludeFromSvg(['road-1']);
    await svc.run();
    expect(calls.svg[0].excludeFeatureIds).toEqual(['road-1']);
});

test('a bisect exports each step as its own variant, narrowing on every answer', async () => {
    const { api, calls } = fakeApi();
    const storage = memoryStorage();
    const svc = new GsproExportService(api, 1, storage);
    await svc.openFor('course-1', 'Vreta');
    svc.excludeFromSvg(['tree-1']);

    svc.startSvgBisect(['p1', 'p2', 'p3', 'p4']);
    expect(await svc.answerSvgBisect(true)).toBe(false);  // nothing to answer before the step is exported
    await svc.run();
    expect(calls.svg.at(-1)).toEqual({ excludeFeatureIds: ['tree-1', 'p1', 'p2'], variant: 'bisect-1' });

    await svc.answerSvgBisect(false);  // still failed: the culprit is in p3, p4
    expect(calls.svg.at(-1)).toEqual({ excludeFeatureIds: ['tree-1', 'p3'], variant: 'bisect-2' });

    // A reload mid-bisect picks it up where it was.
    const again = new GsproExportService(api, 1, storage);
    await again.openFor('course-1', 'Vreta');
    expect(again.svgBisect.peek()?.candidates).toEqual(['p3', 'p4']);
    expect(again.svgBisect.peek()?.exported).toBe(true);

    await again.answerSvgBisect(true);  // built without p3: it is p3
    expect(calls.svg.at(-1)).toEqual({ excludeFeatureIds: ['tree-1', 'p3'], variant: 'bisect-3' });
    await again.answerSvgBisect(true);  // confirmed, and nothing more to export
    expect(again.svgBisect.peek()?.result).toBe('confirmed');
    expect(calls.svg).toHaveLength(3);

    again.stopSvgBisect();
    expect(again.svgBisect.peek()).toBeNull();
    expect(again.svgVariant.peek()).toBe('');
    expect([...again.svgExcluded.peek()]).toEqual(['tree-1', 'p3']);  // the culprit stays out
});
