import { test, expect } from 'bun:test';
import type { AnalysisApi, SampleGrid } from '../../shared/api/analysis.gen';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import { AnalysisToolService, BUFFER_MIN, BUFFER_MAX, ANALYSIS_RESOLUTION_M } from '../src/analysis/analysis-tool.service';

// ─── Fakes ────────────────────────────────────────────────────────────────

function makeGrid(width = 4, height = 3): SampleGrid {
    const heights: (number | null)[] = [];
    const insideMask: number[] = [];
    for (let i = 0; i < width * height; i++) {
        heights.push(50 + (i % width) * 0.1);
        insideMask.push(i % 2);
    }
    return { origin: { e: 500000, n: 6468000 }, resolution: 0.5, width, height, heights, insideMask };
}

function makeFeature(id = 'green-1'): CourseFeature {
    return {
        id,
        courseId: 'course-1',
        holeId: 'hole-1',
        type: 'green',
        geometry: {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: 500000, y: 6468000 },
                    { x: 500020, y: 6468000 },
                    { x: 500020, y: 6468020 },
                    { x: 500000, y: 6468020 },
                ],
            }],
        },
        geojson: null,
        version: 1,
    };
}

interface FakeApi extends AnalysisApi {
    calls: Array<Parameters<AnalysisApi['sampleGrid']>[0]>;
}

function fakeApi(result: () => Promise<SampleGrid>): FakeApi {
    const api: FakeApi = {
        calls: [],
        async sampleGrid(input) {
            api.calls.push(input);
            return result();
        },
        async sampleElevations() {
            return { elevations: [] };
        },
    };
    return api;
}

// ─── State flow ───────────────────────────────────────────────────────────

test('analyze fetches the grid for the clicked green with current buffer + resolution', async () => {
    const grid = makeGrid();
    const api = fakeApi(() => Promise.resolve(grid));
    const svc = new AnalysisToolService(api);

    await svc.analyze(makeFeature());

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toEqual({
        courseId: 'course-1',
        featureId: 'green-1',
        bufferM: 20, // default
        resolutionM: ANALYSIS_RESOLUTION_M,
    });
    expect(svc.grid.get()).toBe(grid);
    expect(svc.loading.get()).toBe(false);
    expect(svc.error.get()).toBeNull();

    // Derived view: stats + slope computed, mode included.
    const view = svc.view.get();
    expect(view).not.toBeNull();
    expect(view!.mode).toBe('slope');
    expect(view!.grid).toBe(grid);
    expect(svc.stats.get()).not.toBeNull();
});

test('setBuffer clamps to 10–30 and re-fetches when a green is analyzed', async () => {
    const api = fakeApi(() => Promise.resolve(makeGrid()));
    const svc = new AnalysisToolService(api);
    await svc.analyze(makeFeature());

    await svc.setBuffer(30);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1].bufferM).toBe(30);

    await svc.setBuffer(999);
    expect(svc.bufferM.get()).toBe(BUFFER_MAX);
    await svc.setBuffer(-5);
    expect(svc.bufferM.get()).toBe(BUFFER_MIN);

    // Unchanged buffer → no extra fetch.
    const before = api.calls.length;
    await svc.setBuffer(BUFFER_MIN);
    expect(api.calls.length).toBe(before);
});

test('setBuffer does not fetch when nothing is analyzed', async () => {
    const api = fakeApi(() => Promise.resolve(makeGrid()));
    const svc = new AnalysisToolService(api);
    await svc.setBuffer(25);
    expect(api.calls).toHaveLength(0);
    expect(svc.bufferM.get()).toBe(25);
});

test('setMode changes the view mode without re-fetching', async () => {
    const api = fakeApi(() => Promise.resolve(makeGrid()));
    const svc = new AnalysisToolService(api);
    await svc.analyze(makeFeature());

    svc.setMode('relative');
    expect(svc.view.get()!.mode).toBe('relative');
    svc.setMode('height');
    expect(svc.view.get()!.mode).toBe('height');
    expect(api.calls).toHaveLength(1);
});

test('clear resets grid, feature, error and view', async () => {
    const api = fakeApi(() => Promise.resolve(makeGrid()));
    const svc = new AnalysisToolService(api);
    await svc.analyze(makeFeature());
    expect(svc.view.get()).not.toBeNull();

    svc.clear();
    expect(svc.grid.get()).toBeNull();
    expect(svc.analyzedFeature.get()).toBeNull();
    expect(svc.view.get()).toBeNull();
    expect(svc.stats.get()).toBeNull();
});

test('onEscape consumes ESC while an analysis is shown, then lets the toolbar deactivate', async () => {
    const api = fakeApi(() => Promise.resolve(makeGrid()));
    const svc = new AnalysisToolService(api);
    expect(svc.onEscape()).toBe(false); // nothing shown → deactivate

    await svc.analyze(makeFeature());
    expect(svc.onEscape()).toBe(true); // consumed: cleared the overlay
    expect(svc.grid.get()).toBeNull();
    expect(svc.onEscape()).toBe(false);
});

test('fetch failure sets the error signal and keeps the grid null', async () => {
    const api = fakeApi(() => Promise.reject(new Error('DEM file not available')));
    const svc = new AnalysisToolService(api);
    await svc.analyze(makeFeature());

    expect(svc.grid.get()).toBeNull();
    expect(svc.error.get()).not.toBeNull();
    expect(svc.loading.get()).toBe(false);
    expect(svc.view.get()).toBeNull();
});

test('a stale in-flight fetch cannot overwrite a newer analysis', async () => {
    const slowGrid = makeGrid(2, 2);
    const fastGrid = makeGrid(6, 6);
    let call = 0;
    const resolvers: Array<(g: SampleGrid) => void> = [];
    const api: AnalysisApi = {
        sampleGrid: () => new Promise<SampleGrid>(resolve => {
            resolvers.push(resolve);
            call++;
        }),
        sampleElevations: async () => ({ elevations: [] }),
    };
    const svc = new AnalysisToolService(api);

    const first = svc.analyze(makeFeature('green-1'));
    const second = svc.analyze(makeFeature('green-2'));
    expect(call).toBe(2);

    resolvers[1](fastGrid); // newer request lands first
    await second;
    expect(svc.grid.get()).toBe(fastGrid);

    resolvers[0](slowGrid); // stale response arrives late — must be ignored
    await first;
    expect(svc.grid.get()).toBe(fastGrid);
});

test('clear invalidates an in-flight fetch', async () => {
    let resolveFetch: (g: SampleGrid) => void = () => {};
    const api: AnalysisApi = {
        sampleGrid: () => new Promise<SampleGrid>(resolve => { resolveFetch = resolve; }),
        sampleElevations: async () => ({ elevations: [] }),
    };
    const svc = new AnalysisToolService(api);
    const pending = svc.analyze(makeFeature());

    svc.clear();
    resolveFetch(makeGrid());
    await pending;
    expect(svc.grid.get()).toBeNull();
});

test('derived slope/stats are cached per grid object across mode switches', async () => {
    const api = fakeApi(() => Promise.resolve(makeGrid()));
    const svc = new AnalysisToolService(api);
    await svc.analyze(makeFeature());

    const view1 = svc.view.get()!;
    svc.setMode('height');
    const view2 = svc.view.get()!;
    expect(view2.slope).toBe(view1.slope); // same derived arrays, not recomputed
    expect(view2.stats).toBe(view1.stats);
});
