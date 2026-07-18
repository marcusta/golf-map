import { afterEach, describe, expect, test } from 'bun:test';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { MapService } from '../src/map/map.service';
import type { TerrainEdit, TerrainEditsApi } from '../../shared/api/terrain-edits.gen';
import type { MapBuildApi, MapBuildJob } from '../../shared/api/map-build.gen';
import { lngLatToSweref99tm } from '../src/geo/transform';
import {
    TerrainEditToolService,
    TERRAIN_EDIT_TOOL_ID,
    DEFAULT_FEATHER_M,
    DEFAULT_RADIUS_M,
    paramsSummary,
    type TerrainEditRenderer,
    type TerrainEditView,
} from '../src/terrain-edit/terrain-edit-tool.service';

// T55b — terrain-edit tool. The pointer/overlay wiring needs a live
// MaplibreMap, so these tests drive the service's seams (closeDraft, the
// click handler, setEnabled/remove) over a recording fake API and a fake
// renderer (sam-tool.service.test.ts harness pattern; renderer seam per the
// analysis tool).

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    di.reset();
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// ─── Fakes ──────────────────────────────────────────────────────────────────

function makeEdit(overrides: Partial<TerrainEdit> = {}): TerrainEdit {
    return {
        id: 'e1',
        siteId: 'site-1',
        op: 'plane',
        params: { featherM: 2 },
        rings: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]],
        enabled: true,
        version: 1,
        createdAt: '2026-07-18T10:00:00Z',
        updatedAt: '2026-07-18T10:00:00Z',
        ...overrides,
    };
}

interface FakeApi extends TerrainEditsApi {
    calls: { list: Array<{ siteId: string }>; create: unknown[]; update: unknown[]; remove: unknown[] };
    listResult: TerrainEdit[];
    failUpdate: boolean;
    failRemove: boolean;
}

function fakeApi(listResult: TerrainEdit[] = []): FakeApi {
    let n = 0;
    const api: FakeApi = {
        calls: { list: [], create: [], update: [], remove: [] },
        listResult,
        failUpdate: false,
        failRemove: false,
        async list(input) {
            api.calls.list.push(input);
            return api.listResult;
        },
        async create(input) {
            api.calls.create.push(input);
            n += 1;
            return makeEdit({
                id: `created-${n}`,
                siteId: input.siteId,
                op: input.op,
                params: input.params,
                rings: input.rings,
                enabled: input.enabled ?? true,
            });
        },
        async update(input) {
            api.calls.update.push(input);
            if (api.failUpdate) throw new Error('version conflict');
            const current = api.listResult.find(e => e.id === input.id) ?? makeEdit({ id: input.id });
            return { ...current, ...('enabled' in input ? { enabled: input.enabled! } : {}), version: input.version + 1 };
        },
        async remove(input) {
            api.calls.remove.push(input);
            if (api.failRemove) throw new Error('version conflict');
            return { ok: true };
        },
    };
    return api;
}

function makeJob(overrides: Partial<MapBuildJob> = {}): MapBuildJob {
    return {
        id: 'job-1',
        courseId: 'course-1',
        siteId: 'site-1',
        kind: 're-terrain',
        status: 'succeeded',
        step: 'register',
        bbox: { west: 0, south: 0, east: 0, north: 0 },
        log: '',
        error: null,
        createdAt: '2026-07-18T10:00:00Z',
        updatedAt: '2026-07-18T10:00:00Z',
        ...overrides,
    };
}

interface FakeMapBuild extends MapBuildApi {
    calls: { reTerrain: Array<{ courseId: string }>; status: Array<{ jobId: string }> };
    /** Job returned by reTerrain; then statusQueue is consumed per poll. */
    reTerrainResult: MapBuildJob;
    statusQueue: MapBuildJob[];
}

function fakeMapBuild(): FakeMapBuild {
    const mb: FakeMapBuild = {
        calls: { reTerrain: [], status: [] },
        reTerrainResult: makeJob(),
        statusQueue: [],
        async reTerrain(input) {
            mb.calls.reTerrain.push(input);
            return mb.reTerrainResult;
        },
        async status(input) {
            mb.calls.status.push(input);
            return mb.statusQueue.shift() ?? makeJob();
        },
        async start() { throw new Error('unused'); },
        async latest() { return null; },
        async ensureOrtho() { throw new Error('unused'); },
        async lidarInfo() { return { files: [], totalBytes: 0 }; },
        async deleteLidar() { return { freedBytes: 0 }; },
    };
    return mb;
}

interface FakeRenderer extends TerrainEditRenderer {
    renders: TerrainEditView[];
    resets: number;
    clears: number;
}

function fakeRenderer(): FakeRenderer {
    const r: FakeRenderer = {
        renders: [],
        resets: 0,
        clears: 0,
        render(_map, view) { r.renders.push(view); },
        reset() { r.resets += 1; },
        clear() { r.clears += 1; },
    };
    return r;
}

interface Harness {
    svc: TerrainEditToolService;
    api: FakeApi;
    mapBuild: FakeMapBuild;
    renderer: FakeRenderer;
    ready: Signal<boolean>;
    interactionMode: Signal<string>;
    /** courseIds passed to tileset.reload (post-apply cache-bust). */
    reloads: string[];
    clickHandlers: Array<(e: { lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => void>;
    disposers: Array<() => void>;
    /** Run the activation-span disposers + deactivate (EditorModeService order). */
    deactivate(): void;
}

async function harness(opts: {
    listResult?: TerrainEdit[];
    siteId?: string | null;
    mapKey?: string | null;
} = {}): Promise<Harness> {
    const api = fakeApi(opts.listResult ?? []);
    const mapBuild = fakeMapBuild();
    const renderer = fakeRenderer();
    const svc = new TerrainEditToolService(api, mapBuild, 0 /* pollMs: no real waits */);

    const ready = new Signal(true);
    const interactionMode = new Signal<string>(TERRAIN_EDIT_TOOL_ID);
    const reloads: string[] = [];
    const clickHandlers: Harness['clickHandlers'] = [];
    const disposers: Array<() => void> = [];

    const siteId = opts.siteId === undefined ? 'site-1' : opts.siteId;
    const ctx: ToolContext = {
        map: {
            interactionMode,
            ready,
            map: new Signal(null),
            onClick: (h: Harness['clickHandlers'][number]) => {
                clickHandlers.push(h);
                return () => {};
            },
        } as unknown as MapService,
        elevation: null as never,
        tileset: {
            mapKey: new Signal(opts.mapKey === undefined ? null : opts.mapKey),
            reload: async (id: string) => { reloads.push(id); },
        } as never,
        courseDetail: {
            course: new Signal(siteId === null ? null : { id: 'course-1', siteId }),
        } as never,
        features: null as never,
        courseId: 'course-1',
        track: d => {
            disposers.push(d);
            cleanups.push(d);
        },
    };
    svc.activate(ctx, renderer);
    await tick(); // settle the initial list load + render flush

    return {
        svc,
        api,
        mapBuild,
        renderer,
        ready,
        interactionMode,
        reloads,
        clickHandlers,
        disposers,
        deactivate() {
            for (const d of disposers) d();
            disposers.length = 0;
            svc.deactivate();
        },
    };
}

/** Place a draft point directly (screenDist is Infinity without a live map). */
function click(h: Harness, lng: number, lat: number): void {
    h.clickHandlers[0]({ lngLat: { lng, lat }, point: { x: 0, y: 0 } });
}

// Landeryd-ish clicks (must be inside the SWEREF99 TM domain).
const P1 = { lng: 15.5658, lat: 58.4015 };
const P2 = { lng: 15.5668, lat: 58.4015 };
const P3 = { lng: 15.5668, lat: 58.4020 };

// ─── Draft → create payload mapping ─────────────────────────────────────────

describe('closeDraft payload', () => {
    test('plane: armed params map to the create input; rings are the plain draft points', async () => {
        const h = await harness();
        h.svc.op.set('plane');
        h.svc.featherM.set(3.5);
        h.svc.flat.set(true);

        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        const created = await h.svc.closeDraft();

        expect(created).toBeDefined();
        expect(h.api.calls.create).toHaveLength(1);
        const input = h.api.calls.create[0] as {
            siteId: string; op: string; params: Record<string, unknown>; rings: { x: number; y: number }[][];
        };
        expect(input.siteId).toBe('site-1');
        expect(input.op).toBe('plane');
        expect(input.params).toEqual({ featherM: 3.5, flat: true });
        // Rings: EPSG:3006 straight-segment points, exactly the clicks.
        expect(input.rings).toHaveLength(1);
        expect(input.rings[0]).toHaveLength(3);
        const expected = lngLatToSweref99tm(P1);
        expect(input.rings[0][0].x).toBeCloseTo(expected.x, 6);
        expect(input.rings[0][0].y).toBeCloseTo(expected.y, 6);
        // Plain {x, y} only — no corner/handle keys leak into storage.
        expect(Object.keys(input.rings[0][0]).sort()).toEqual(['x', 'y']);

        // The created edit joins the list; chain-draw keeps drawing armed.
        expect(h.svc.edits.get().map(e => e.id)).toEqual(['created-1']);
        expect(h.svc.state.isDrawing.get()).toBe(true);
        expect(h.svc.state.draft.get()).toHaveLength(0);
    });

    test('plane without flat omits the flag; smooth carries radiusM and never flat', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        await h.svc.closeDraft();
        expect((h.api.calls.create[0] as { params: unknown }).params).toEqual({ featherM: DEFAULT_FEATHER_M });

        h.svc.op.set('smooth');
        h.svc.radiusM.set(4);
        h.svc.flat.set(true); // a leftover plane setting must not leak into smooth
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        await h.svc.closeDraft();
        expect((h.api.calls.create[1] as { op: string }).op).toBe('smooth');
        expect((h.api.calls.create[1] as { params: unknown }).params)
            .toEqual({ featherM: DEFAULT_FEATHER_M, radiusM: 4 });
    });

    test('below the 3-point minimum nothing is posted', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        const created = await h.svc.closeDraft();
        expect(created).toBeUndefined();
        expect(h.api.calls.create).toHaveLength(0);
    });

    test('no site anywhere → notice, no create', async () => {
        const h = await harness({ siteId: null, mapKey: null });
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        const created = await h.svc.closeDraft();
        expect(created).toBeUndefined();
        expect(h.api.calls.create).toHaveLength(0);
        expect(h.svc.notice.get()).toContain('site');
    });

    test('falls back to the tileset mapKey (== site id) before the course record lands', async () => {
        const h = await harness({ siteId: null, mapKey: 'site-9' });
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        await h.svc.closeDraft();
        expect((h.api.calls.create[0] as { siteId: string }).siteId).toBe('site-9');
    });

    test('a failed create keeps the notice and does not grow the list', async () => {
        const h = await harness();
        h.api.create = async () => { throw new Error('boom'); };
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        const created = await h.svc.closeDraft();
        expect(created).toBeUndefined();
        expect(h.svc.edits.get()).toHaveLength(0);
        expect(h.svc.notice.get()).toContain('failed');
        expect(h.svc.saving.get()).toBe(false);
    });
});

// ─── Click handling ─────────────────────────────────────────────────────────

describe('map clicks', () => {
    test('activation loads the site list and arms drawing; clicks place EPSG:3006 points', async () => {
        const h = await harness();
        expect(h.api.calls.list).toEqual([{ siteId: 'site-1' }]);
        expect(h.svc.state.isDrawing.get()).toBe(true);

        click(h, P1.lng, P1.lat);
        expect(h.svc.state.draft.get()).toHaveLength(1);
        const p = lngLatToSweref99tm(P1);
        expect(h.svc.state.draft.get()[0].x).toBeCloseTo(p.x, 6);
        expect(h.svc.state.draft.get()[0].y).toBeCloseTo(p.y, 6);
    });

    test('the click handler gates on the interaction claim', async () => {
        const h = await harness();
        h.interactionMode.set('draw'); // displaced
        click(h, P1.lng, P1.lat);
        expect(h.svc.state.draft.get()).toHaveLength(0);

        h.interactionMode.set(TERRAIN_EDIT_TOOL_ID);
        click(h, P1.lng, P1.lat);
        expect(h.svc.state.draft.get()).toHaveLength(1);
    });

    test('ESC discards the draft but keeps the tool drawing; empty → unconsumed', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        expect(h.svc.onEscape()).toBe(true);
        expect(h.svc.state.draft.get()).toHaveLength(0);
        expect(h.svc.state.isDrawing.get()).toBe(true);
        expect(h.svc.onEscape()).toBe(false); // toolbar deactivates
    });
});

// ─── Enabled toggle / delete flows ──────────────────────────────────────────

describe('setEnabled / remove', () => {
    test('setEnabled sends the row version and swaps in the server row', async () => {
        const edit = makeEdit({ id: 'e1', version: 3, enabled: true });
        const h = await harness({ listResult: [edit] });
        await h.svc.setEnabled('e1', false);
        expect(h.api.calls.update).toEqual([{ id: 'e1', version: 3, enabled: false }]);
        expect(h.svc.edits.get()[0].enabled).toBe(false);
        expect(h.svc.edits.get()[0].version).toBe(4);
    });

    test('a version conflict on update sets a notice and resyncs from the server', async () => {
        const edit = makeEdit({ id: 'e1', version: 3 });
        const h = await harness({ listResult: [edit] });
        h.api.failUpdate = true;
        h.api.listResult = [makeEdit({ id: 'e1', version: 5, enabled: false })];
        await h.svc.setEnabled('e1', false);
        expect(h.svc.notice.get()).toContain('failed');
        expect(h.api.calls.list).toHaveLength(2); // activation + resync
        expect(h.svc.edits.get()[0].version).toBe(5);
    });

    test('remove deletes with the row version and drops the row', async () => {
        const h = await harness({ listResult: [makeEdit({ id: 'e1', version: 2 }), makeEdit({ id: 'e2' })] });
        await h.svc.remove('e1');
        expect(h.api.calls.remove).toEqual([{ id: 'e1', version: 2 }]);
        expect(h.svc.edits.get().map(e => e.id)).toEqual(['e2']);
    });

    test('a failed remove resyncs instead of dropping the row locally', async () => {
        const edit = makeEdit({ id: 'e1' });
        const h = await harness({ listResult: [edit] });
        h.api.failRemove = true;
        await h.svc.remove('e1');
        expect(h.svc.edits.get().map(e => e.id)).toEqual(['e1']);
        expect(h.svc.notice.get()).toContain('failed');
    });
});

// ─── Overlay visibility gating ──────────────────────────────────────────────

describe('overlay gating', () => {
    test('renders after activation, coalesces a burst of writes into one flush', async () => {
        const h = await harness({ listResult: [makeEdit()] });
        expect(h.renderer.renders.length).toBeGreaterThanOrEqual(1);
        const last = h.renderer.renders[h.renderer.renders.length - 1];
        expect(last.edits.map(e => e.id)).toEqual(['e1']);

        // Three synchronous draft writes → exactly ONE further render
        // (microtask coalescing per the reactive-cascade gotcha).
        const before = h.renderer.renders.length;
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        expect(h.renderer.renders.length).toBe(before); // nothing until the flush
        await tick();
        expect(h.renderer.renders.length).toBe(before + 1);
        expect(h.renderer.renders[before].draft).toHaveLength(3);
    });

    test('map death resets the renderer; recovery renders again', async () => {
        const h = await harness();
        h.ready.set(false);
        expect(h.renderer.resets).toBeGreaterThanOrEqual(1);

        const before = h.renderer.renders.length;
        h.ready.set(true);
        await tick();
        expect(h.renderer.renders.length).toBe(before + 1);
    });

    test('deactivation clears the overlay from a live map (hidden outside the tool)', async () => {
        const h = await harness();
        expect(h.renderer.clears).toBe(0);
        h.deactivate();
        expect(h.renderer.clears).toBe(1);
    });

    test('a flush scheduled before deactivation is dropped, not rendered', async () => {
        const h = await harness();
        const before = h.renderer.renders.length;
        click(h, P1.lng, P1.lat); // schedules a microtask flush
        h.deactivate();
        await tick();
        expect(h.renderer.renders.length).toBe(before);
    });
});

// ─── Panel helpers / T56 seam ───────────────────────────────────────────────

test('paramsSummary names flat planes and smooth radii', () => {
    expect(paramsSummary(makeEdit({ op: 'plane', params: { featherM: 2, flat: true } }))).toBe('flat · feather 2 m');
    expect(paramsSummary(makeEdit({ op: 'plane', params: { featherM: 0 } }))).toBe('feather 0 m');
    expect(paramsSummary(makeEdit({ op: 'smooth', params: { featherM: 2, radiusM: 3 } }))).toBe('r 3 m · feather 2 m');
    expect(paramsSummary(makeEdit({ op: 'smooth', params: { featherM: 2 } })))
        .toBe(`r ${DEFAULT_RADIUS_M} m · feather 2 m`);
});

// ─── Apply to terrain (the T56 fast re-terrain job) ─────────────────────────

describe('applyToTerrain', () => {
    test('starts the job, polls to success, then reloads the tileset (new ?v=)', async () => {
        const h = await harness();
        h.mapBuild.reTerrainResult = makeJob({ status: 'running', step: 'apply-dem-edits' });
        h.mapBuild.statusQueue = [
            makeJob({ status: 'running', step: 'tile-terrain' }),
            makeJob({ status: 'succeeded', step: 'register' }),
        ];

        const ok = await h.svc.applyToTerrain();

        expect(ok).toBe(true);
        expect(h.mapBuild.calls.reTerrain).toEqual([{ courseId: 'course-1' }]);
        expect(h.mapBuild.calls.status).toEqual([{ jobId: 'job-1' }, { jobId: 'job-1' }]);
        expect(h.reloads).toEqual(['course-1']); // manifest reload busts the tile cache
        expect(h.svc.notice.get()).toContain('re-tiled');
        expect(h.svc.applying.get()).toBe(false);
        expect(h.svc.applyStep.get()).toBeNull();
        expect(h.svc.canApply.get()).toBe(true);
    });

    test('a failed job surfaces its error and does NOT reload the tileset', async () => {
        const h = await harness();
        h.mapBuild.reTerrainResult = makeJob({ status: 'failed', step: 'tile-terrain', error: 'boom at tile-terrain' });

        const ok = await h.svc.applyToTerrain();

        expect(ok).toBe(false);
        expect(h.reloads).toEqual([]);
        expect(h.svc.notice.get()).toContain('boom at tile-terrain');
        expect(h.svc.applying.get()).toBe(false);
    });

    test('a rejected start (e.g. no persisted DEM) surfaces the message', async () => {
        const h = await harness();
        h.mapBuild.reTerrain = async () => { throw new Error('No persisted DEM — run a full map build first'); };

        const ok = await h.svc.applyToTerrain();

        expect(ok).toBe(false);
        expect(h.svc.notice.get()).toContain('full map build');
        expect(h.svc.applying.get()).toBe(false);
    });

    test('canApply gates re-entry while a job is in flight', async () => {
        const h = await harness();
        let resolveJob!: (j: MapBuildJob) => void;
        h.mapBuild.reTerrain = () => new Promise<MapBuildJob>(resolve => { resolveJob = resolve; });

        const first = h.svc.applyToTerrain();
        expect(h.svc.applying.get()).toBe(true);
        expect(h.svc.canApply.get()).toBe(false);

        // A second apply while in flight is refused without a second POST.
        expect(await h.svc.applyToTerrain()).toBe(false);

        resolveJob(makeJob({ status: 'succeeded' }));
        expect(await first).toBe(true);
        expect(h.svc.canApply.get()).toBe(true);
    });

    test('the running step is exposed as a human progress label', async () => {
        const h = await harness();
        const seen: Array<string | null> = [];
        let resolveStatus!: (j: MapBuildJob) => void;
        h.mapBuild.reTerrainResult = makeJob({ status: 'running', step: 'apply-dem-edits' });
        h.mapBuild.status = () => new Promise<MapBuildJob>(resolve => {
            seen.push(h.svc.applyStep.get());
            resolveStatus = resolve;
            queueMicrotask(() => resolveStatus(makeJob({ status: 'succeeded' })));
        });

        await h.svc.applyToTerrain();
        expect(seen).toEqual(['Apply terrain edits']); // STEP_LABELS mapping
        expect(h.svc.applyStep.get()).toBeNull(); // cleared once terminal
    });
});
