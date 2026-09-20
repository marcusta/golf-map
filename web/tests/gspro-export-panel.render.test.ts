import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { GsproExportPanelComponent } from '../src/export/gspro-export-panel.component';
import { GsproExportService } from '../src/export/gspro-export.service';
import type { GsproExportApi, GsproExportSettings, GsproOrthoSource, CourseTerrain, GsproExportJob } from '../../shared/api/gspro-export.gen';

// Render smoke for the GSPro export panel (there are no per-component specs by
// design — TESTING.md — but the folder field, the default hint and the report
// list are worth one throw-check through happy-dom).

afterEach(() => {
    _reset();
    di.reset();
});

const DEFAULT_DIR = 'C:\\Users\\marcus\\Downloads';

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

function fakeApi(dir: string | null, run?: () => never, sources: GsproOrthoSource[] = SOURCES, terrain: CourseTerrain | null = TERRAIN) {
    const settings = (): GsproExportSettings =>
        ({ dir: dir ?? DEFAULT_DIR, isDefault: dir === null, defaultDir: DEFAULT_DIR });
    const orthoCalls: string[] = [];
    const outerCalls: string[] = [];
    const demCalls: string[] = [];
    const hillshadeCalls: string[] = [];
    const treesCalls: string[] = [];
    const handlers: Record<string, (input: any) => Promise<any>> = {
        async settings() { return settings(); },
        async setDir() { return settings(); },
        async run() {
            if (run) run();
            return { path: `${dir ?? DEFAULT_DIR}\\vreta.svg`, report: ['Wrote vreta.svg', '200 features in 19 layer(s)', 'warning: 5 outside'] };
        },
        async orthoSources() { return sources; },
        async runOrtho({ source }) {
            if (run) run();
            orthoCalls.push(source);
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
    };
    const api = jobApi(handlers);
    return { api, orthoCalls, outerCalls, demCalls, hillshadeCalls, treesCalls };
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
            const result = kind === 'svg' ? await h.run({ courseId })
                : kind === 'ortho' ? await h.runOrtho({ courseId, source: input.source, darken: input.darken, tint: input.tint, tintOpacity: input.tintOpacity })
                : kind === 'outer-ortho' ? await h.runOuterOrtho({ courseId, collection: input.collection, darken: input.darken, tint: input.tint, tintOpacity: input.tintOpacity })
                : kind === 'dem' ? await h.runDem({ courseId, terrain: input.terrain })
                : kind === 'hillshade' ? await h.runHillshade({ courseId, terrain: input.terrain })
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
    const { api, orthoCalls, outerCalls, demCalls, hillshadeCalls, treesCalls } = fakeApi(dir, run, sources, terrain);
    const svc = new GsproExportService(api, 1);
    di.set(GsproExportService, svc);
    const host = document.createElement('div');
    new GsproExportPanelComponent({}).mount(host);
    return { host, svc, orthoCalls, outerCalls, demCalls, hillshadeCalls, treesCalls };
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

    const button = host.querySelector('.gspro-export__run') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Export SVG');
});

// --- Orthophoto ---

test('the vintage picker lists the persisted orthophotos and preselects the one on the map', async () => {
    const { host, svc } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.parentElement?.className).not.toContain('hidden');
    expect([...select.options].map(o => o.textContent)).toEqual([
        'orto-l2-2025 (shown on map)', 'orto-l2-2025 (patched)', 'orto-l2-2023',
    ]);
    expect(svc.orthoSource.peek()).toBe('ortho-orto-l2-2025.tif');
    expect(select.value).toBe('ortho-orto-l2-2025.tif');
    expect(host.textContent).toContain('8192 × 8192');

    const button = host.querySelector('.gspro-export__run-ortho') as HTMLButtonElement;
    expect(button.textContent).toBe('Export inner orthophoto JPEG');
    expect(button.disabled).toBe(false);
});

test('picking another vintage exports that one', async () => {
    const { host, svc, orthoCalls } = await mount();
    await svc.openFor('course-1', 'Vreta');

    const select = host.querySelector('select') as HTMLSelectElement;
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

    const select = host.querySelector('select') as HTMLSelectElement;
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
    expect(button.textContent).toBe('Export outer orthophoto JPEG');
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain('5000 m outer square');

    const select = host.querySelector('select') as HTMLSelectElement;
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
    expect(inner.textContent).toBe('Export inner heightmap (RAW + GeoTIFF)');
    expect(outer.textContent).toBe('Export outer heightmap (RAW + GeoTIFF)');
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
    expect(inner.textContent).toBe('Export inner hillshade JPEG');
    expect(outer.textContent).toBe('Export outer hillshade JPEG');
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
    expect(inner.textContent).toBe('Export inner trees');
    expect(outer.textContent).toBe('Export outer trees');
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
    expect((host.querySelector('.gspro-export__run') as HTMLButtonElement).disabled).toBe(false);
    expect(await svc.runDem('inner')).toBe(true);  // the server is the judge; the button just guards
    expect(demCalls).toEqual(['inner']);
    expect(outerCalls).toEqual([]);
});
