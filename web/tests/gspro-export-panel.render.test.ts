import { emptyCourseMeta, type GsproCourseMeta } from '../../shared/gspro-course-meta';
import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { GsproExportPanelComponent } from '../src/export/gspro-export-panel.component';
import { GsproExportService } from '../src/export/gspro-export.service';
import type { GsproExportApi, GsproExportSettings, GsproOrthoSource, CourseTerrain, GsproExportJob } from '../../shared/api/gspro-export.gen';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Render smoke for the GSPro export panel (there are no per-component specs by
// design — TESTING.md — but the folder field, the default hint and the report
// list are worth one throw-check through happy-dom).

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
    return { api, svgCalls, orthoCalls, outerCalls, demCalls, hillshadeCalls, treesCalls, zonesCalls, floorCalls, gkdCalls, metaCalls, gkd };
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

async function mount(dir: string | null = null, run?: () => never, sources?: GsproOrthoSource[], terrain?: CourseTerrain | null) {
    const { api, orthoCalls, outerCalls, demCalls, hillshadeCalls, treesCalls, zonesCalls, floorCalls, gkdCalls, metaCalls, gkd } = fakeApi(dir, run, sources, terrain);
    const svc = new GsproExportService(api, 1);
    di.set(GsproExportService, svc);
    const host = document.createElement('div');
    new GsproExportPanelComponent({}).mount(host);
    return { host, svc, orthoCalls, outerCalls, demCalls, hillshadeCalls, treesCalls, zonesCalls, floorCalls, gkdCalls, metaCalls, gkd };
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

test('the panel shows what is running and what last ran', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');
    expect(host.querySelector('.gspro-export__job')!.closest('.gspro-export__section')!.className).toContain('hidden');
    await svc.runDem('inner');
    expect(host.querySelector('.gspro-export__job')!.textContent).toMatch(/^Last export: dem, done in \d+ s$/);
    expect(host.querySelector('.gspro-export__job')!.closest('.gspro-export__section')!.className).not.toContain('hidden');
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
