import { afterEach, describe, expect, test } from 'bun:test';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { MapService } from '../src/map/map.service';
import type { TerrainEdit, TerrainEditsApi } from '../../shared/api/terrain-edits.gen';
import type { MapBuildApi, MapBuildJob } from '../../shared/api/map-build.gen';
import type { Course } from '../../shared/api/courses.gen';
import { deriveTileVersion, type TileManifest } from '../src/map/tileset.service';
import type { FeatureCollection } from 'geojson';
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
import {
    TerrainEditOverlayRenderer,
    TERRAIN_EDIT_DRAFT_OVERLAY_ID,
    terrainEditProjectionCount,
} from '../src/terrain-edit/terrain-edit-render';

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

interface MoveEvent {
    lngLat: { lng: number; lat: number };
    point: { x: number; y: number };
    originalEvent: { buttons: number };
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
    moveHandlers: Array<(e: MoveEvent) => void>;
    disposers: Array<() => void>;
    /** Course rows returned by the fake coursesApi.get (post-apply manifest). */
    course: { tileManifestJson: string | null; siteId: string | null };
    courseGets: string[];
    /** setRasterTileUrl calls on the fake MapService. */
    tileUrls: Array<{ sourceId: string; template: string }>;
    displayedVersion: Signal<string | null>;
    elevationConfigs: unknown[];
    jumps: number;
    /** Overlay data by id, as the real renderer pushes it. */
    overlays: Map<string, FeatureCollection>;
    /** Run the activation-span disposers + deactivate (EditorModeService order). */
    deactivate(): void;
}

async function harness(opts: {
    listResult?: TerrainEdit[];
    siteId?: string | null;
    mapKey?: string | null;
    /** Live tile manifest (TilesetService.manifest). */
    manifest?: TileManifest | null;
    /** Non-null stands in for a live MaplibreMap. */
    rawMap?: object | null;
    renderer?: TerrainEditRenderer;
} = {}): Promise<Harness> {
    const api = fakeApi(opts.listResult ?? []);
    const mapBuild = fakeMapBuild();
    const renderer = fakeRenderer();
    const course: Harness['course'] = { tileManifestJson: null, siteId: 'site-1' };
    const courseGets: string[] = [];
    const coursesApi = {
        async get(input: { id: string }) {
            courseGets.push(input.id);
            return { id: input.id, ...course } as unknown as Course;
        },
    };
    const svc = new TerrainEditToolService(api, mapBuild, 0 /* pollMs: no real waits */, coursesApi);

    const ready = new Signal(true);
    const interactionMode = new Signal<string>(TERRAIN_EDIT_TOOL_ID);
    const reloads: string[] = [];
    const clickHandlers: Harness['clickHandlers'] = [];
    const moveHandlers: Harness['moveHandlers'] = [];
    const disposers: Array<() => void> = [];
    const tileUrls: Harness['tileUrls'] = [];
    const displayedVersion = new Signal<string | null>(null);
    const elevationConfigs: unknown[] = [];
    let jumps = 0;
    const overlays = new Map<string, FeatureCollection>();
    const rawMap = opts.rawMap === undefined
        ? null
        : opts.rawMap && { ...opts.rawMap, getCanvas: () => ({ style: {} }), project: () => ({ x: 1e4, y: 1e4 }), jumpTo: () => { jumps++; }, getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 17, getBearing: () => 0, getPitch: () => 0 };

    const siteId = opts.siteId === undefined ? 'site-1' : opts.siteId;
    const ctx: ToolContext = {
        map: {
            interactionMode,
            ready,
            map: new Signal(rawMap),
            displayedVersion,
            onClick: (h: Harness['clickHandlers'][number]) => {
                clickHandlers.push(h);
                return () => {};
            },
            onMouseMove: (h: Harness['moveHandlers'][number]) => {
                moveHandlers.push(h);
                return () => {
                    const i = moveHandlers.indexOf(h);
                    if (i >= 0) moveHandlers.splice(i, 1);
                };
            },
            setRasterTileUrl: (sourceId: string, template: string) => { tileUrls.push({ sourceId, template }); },
            addOverlayLayer: (id: string, data: FeatureCollection) => { overlays.set(id, data); },
            updateOverlayData: (id: string, data: FeatureCollection) => { overlays.set(id, data); },
            removeOverlayLayer: (id: string) => { overlays.delete(id); },
        } as unknown as MapService,
        elevation: { configure: (c: unknown) => { elevationConfigs.push(c); } } as never,
        tileset: {
            mapKey: new Signal(opts.mapKey === undefined ? null : opts.mapKey),
            manifest: new Signal(opts.manifest ?? null),
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
    svc.activate(ctx, opts.renderer ?? renderer);
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
        moveHandlers,
        disposers,
        course,
        courseGets,
        tileUrls,
        displayedVersion,
        elevationConfigs,
        get jumps() { return jumps; },
        overlays,
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

// ─── Item 17: abortable poll, in-place terrain refresh ──────────────────────

function makeManifest(overrides: Partial<TileManifest> = {}): TileManifest {
    return {
        bounds: { west: 15.55, south: 58.39, east: 15.58, north: 58.41 },
        layers: {
            ortho: { minzoom: 14, maxzoom: 20 },
            terrain: { minzoom: 12, maxzoom: 17 },
            hillshade: { minzoom: 12, maxzoom: 18 },
        },
        elevation: { min: 150, max: 190 },
        generatedAt: '2026-10-01T10:00:00.000Z',
        ...overrides,
    };
}

describe('applyToTerrain abort', () => {
    test('deactivate stops the poll: no further status calls, no refresh, no notice', async () => {
        const h = await harness();
        h.mapBuild.reTerrainResult = makeJob({ status: 'running', step: 'tile-terrain' });
        h.mapBuild.status = async input => {
            h.mapBuild.calls.status.push(input);
            return makeJob({ status: 'running', step: 'tile-terrain' });
        };

        const result = h.svc.applyToTerrain();
        for (let i = 0; i < 5; i++) await tick();
        const polled = h.mapBuild.calls.status.length;
        expect(polled).toBeGreaterThan(0);

        h.deactivate();
        expect(await result).toBe(false);
        for (let i = 0; i < 5; i++) await tick();

        console.log(`[terrain-edit] status calls before deactivate ${polled}, after ${h.mapBuild.calls.status.length - polled}`);
        expect(h.mapBuild.calls.status).toHaveLength(polled);
        expect(h.courseGets).toEqual([]);
        expect(h.reloads).toEqual([]);
        expect(h.svc.notice.get()).toBeNull();
        expect(h.svc.applying.get()).toBe(false);
    });

    test('an in-flight status request is abandoned at once', async () => {
        const h = await harness();
        h.mapBuild.reTerrainResult = makeJob({ status: 'running' });
        h.mapBuild.status = input => {
            h.mapBuild.calls.status.push(input);
            return new Promise<MapBuildJob>(() => {}); // never settles
        };

        const result = h.svc.applyToTerrain();
        for (let i = 0; i < 3; i++) await tick();
        expect(h.mapBuild.calls.status).toHaveLength(1);

        h.svc.abortApply(); // the canvas-unmount path (descriptor attach disposer)
        expect(await result).toBe(false);
        expect(h.svc.applying.get()).toBe(false);
        expect(h.svc.canApply.get()).toBe(true);
    });

    test('a pending sleep between polls is cancelled too', async () => {
        const h = await harness();
        // Real interval: the abort must not wait it out.
        const svc = new TerrainEditToolService(h.api, h.mapBuild, 60_000, { get: async () => { throw new Error('unused'); } });
        h.mapBuild.reTerrainResult = makeJob({ status: 'running' });
        svc.activate({
            map: { interactionMode: h.interactionMode, ready: h.ready, map: new Signal(null), onClick: () => () => {}, onMouseMove: () => () => {} },
            tileset: { mapKey: new Signal(null), manifest: new Signal(null), reload: async () => {} },
            courseDetail: { course: new Signal({ id: 'course-1', siteId: 'site-1' }) },
            courseId: 'course-1',
            track: (d: () => void) => { cleanups.push(d); },
        } as never, fakeRenderer());

        const t0 = performance.now();
        const result = svc.applyToTerrain();
        await tick();
        svc.deactivate();
        expect(await result).toBe(false);
        expect(performance.now() - t0).toBeLessThan(1000);
        expect(h.mapBuild.calls.status).toHaveLength(0);
    });
});

describe('applyToTerrain refresh', () => {
    test('same layout: terrain + hillshade sources get the new ?v= in place, no map re-init', async () => {
        const prev = makeManifest();
        const h = await harness({ manifest: prev, mapKey: 'site-1', rawMap: {} });
        const next = makeManifest({ generatedAt: '2026-10-03T08:30:00.000Z' });
        h.course.tileManifestJson = JSON.stringify(next);

        expect(await h.svc.applyToTerrain()).toBe(true);

        const version = deriveTileVersion(next.generatedAt);
        expect(h.tileUrls.map(u => u.sourceId).sort()).toEqual(['course-hillshade-dem', 'course-terrain']);
        for (const u of h.tileUrls) expect(u.template).toContain(`v=${version}`);
        expect(h.tileUrls.find(u => u.sourceId === 'course-hillshade-dem')!.template).toContain('hillshade');
        // displayedVersion matches the reloaded manifest, so the canvas skips its re-init.
        expect(h.displayedVersion.get()).toBe(version);
        expect(h.elevationConfigs).toEqual([{ mapKey: 'site-1', zoom: 17, version }]);
        expect(h.reloads).toEqual(['course-1']);
        expect(h.jumps).toBe(0); // camera untouched
    });

    test('changed zoom range falls back to the full reload with the camera restored', async () => {
        const h = await harness({ manifest: makeManifest(), mapKey: 'site-1', rawMap: {} });
        h.course.tileManifestJson = JSON.stringify(makeManifest({
            generatedAt: '2026-10-03T08:30:00.000Z',
            layers: { ortho: { minzoom: 14, maxzoom: 20 }, terrain: { minzoom: 12, maxzoom: 18 } },
        }));

        expect(await h.svc.applyToTerrain()).toBe(true);
        expect(h.tileUrls).toEqual([]);
        expect(h.displayedVersion.get()).toBeNull();
        expect(h.reloads).toEqual(['course-1']);
        expect(h.jumps).toBe(1);
    });

    test('no live map falls back to the full reload', async () => {
        const h = await harness({ manifest: makeManifest(), mapKey: 'site-1', rawMap: null });
        h.course.tileManifestJson = JSON.stringify(makeManifest({ generatedAt: '2026-10-03T08:30:00.000Z' }));
        expect(await h.svc.applyToTerrain()).toBe(true);
        expect(h.tileUrls).toEqual([]);
        expect(h.reloads).toEqual(['course-1']);
    });
});

// ─── Item 19: draft keys, busy flag, rubber band ────────────────────────────

function key(k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}, target?: EventTarget): KeyboardEvent {
    const e = new KeyboardEvent('keydown', {
        key: k,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        bubbles: true,
        cancelable: true,
    });
    (target ?? window).dispatchEvent(e);
    return e;
}

function move(h: Harness, lng: number, lat: number, buttons = 0): void {
    for (const m of h.moveHandlers) m({ lngLat: { lng, lat }, point: { x: 0, y: 0 }, originalEvent: { buttons } });
}

describe('draft keys', () => {
    test('Backspace and Cmd/Ctrl+Z remove the last point; Cmd+Shift+Z and Ctrl+Y put it back', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);

        expect(key('Backspace').defaultPrevented).toBe(true);
        expect(h.svc.state.draft.get()).toHaveLength(2);
        expect(key('z', { meta: true }).defaultPrevented).toBe(true);
        expect(h.svc.state.draft.get()).toHaveLength(1);
        key('z', { meta: true, shift: true });
        expect(h.svc.state.draft.get()).toHaveLength(2);
        key('y', { ctrl: true });
        expect(h.svc.state.draft.get()).toHaveLength(3);
        key('z', { ctrl: true });
        expect(h.svc.state.draft.get()).toHaveLength(2);
    });

    test('removing the only point leaves the tool armed with an empty draft', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        key('Backspace');
        expect(h.svc.state.draft.get()).toHaveLength(0);
        expect(h.svc.state.isDrawing.get()).toBe(true);
        click(h, P2.lng, P2.lat);
        expect(h.svc.state.draft.get()).toHaveLength(1);
    });

    test('Enter closes and saves a ring of 3+ points; with fewer it is not consumed', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        expect(key('Enter').defaultPrevented).toBe(false);
        expect(h.api.calls.create).toHaveLength(0);

        click(h, P3.lng, P3.lat);
        expect(key('Enter').defaultPrevented).toBe(true);
        await tick();
        expect(h.api.calls.create).toHaveLength(1);
        expect(h.svc.state.draft.get()).toHaveLength(0);
    });

    test('nothing is consumed with an empty draft, in a text field, or without the claim', async () => {
        const h = await harness();
        expect(key('Backspace').defaultPrevented).toBe(false);
        expect(key('z', { meta: true }).defaultPrevented).toBe(false);

        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        const input = document.createElement('input');
        document.body.appendChild(input);
        cleanups.push(() => input.remove());
        expect(key('Backspace', {}, input).defaultPrevented).toBe(false);
        expect(h.svc.state.draft.get()).toHaveLength(2);

        h.interactionMode.set('draw');
        expect(key('Backspace').defaultPrevented).toBe(false);
        expect(h.svc.state.draft.get()).toHaveLength(2);
    });

    test('editor-wide letters are left alone while drafting', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        for (const k of ['d', 'm', 'f', 'a', 't', ',', '.', 'h', '?']) {
            expect(key(k).defaultPrevented).toBe(false);
        }
        expect(key('F', { shift: true }).defaultPrevented).toBe(false);
        expect(key('\\', { meta: true }).defaultPrevented).toBe(false);
        expect(h.svc.state.draft.get()).toHaveLength(1);
    });

    test('the key listener goes away with the activation', async () => {
        const h = await harness();
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        h.deactivate();
        expect(key('Backspace').defaultPrevented).toBe(false);
    });
});

describe('isBusy', () => {
    test('true only while a draft ring has points', async () => {
        const h = await harness();
        expect(h.svc.isBusy()).toBe(false);
        click(h, P1.lng, P1.lat);
        expect(h.svc.isBusy()).toBe(true);
        h.svc.onEscape();
        expect(h.svc.isBusy()).toBe(false);
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        await h.svc.closeDraft();
        expect(h.svc.isBusy()).toBe(false);
    });
});

describe('rubber band', () => {
    test('tracks the pointer while drafting; off with a button held, after Esc and after close', async () => {
        const h = await harness();
        move(h, P2.lng, P2.lat);
        expect(h.svc.cursor.get()).toBeNull(); // no draft yet

        click(h, P1.lng, P1.lat);
        move(h, P2.lng, P2.lat);
        const p2 = lngLatToSweref99tm(P2);
        expect(h.svc.cursor.get()!.x).toBeCloseTo(p2.x, 6);

        move(h, P3.lng, P3.lat, 1); // pan drag
        expect(h.svc.cursor.get()).toBeNull();
        move(h, P3.lng, P3.lat);
        expect(h.svc.cursor.get()).not.toBeNull();

        h.svc.onEscape();
        expect(h.svc.cursor.get()).toBeNull();

        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        move(h, P2.lng, P2.lat);
        expect(h.svc.cursor.get()).not.toBeNull();
        await h.svc.closeDraft();
        expect(h.svc.cursor.get()).toBeNull();
    });

    test('with the real renderer the draft-cursor segment is drawn while drafting and gone after finish', async () => {
        const created: number[] = [];
        const renderer = new TerrainEditOverlayRenderer(() => {
            created.push(1);
            return { setLngLat() { return this; }, remove() { return this; } };
        });
        const h = await harness({ rawMap: {}, renderer });
        const roles = () => (h.overlays.get(TERRAIN_EDIT_DRAFT_OVERLAY_ID)?.features ?? [])
            .map(f => (f.properties as { role: string }).role);

        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat);
        click(h, P3.lng, P3.lat);
        move(h, P2.lng, P2.lat);
        await tick();
        expect(roles()).toContain('draft-cursor');

        key('Enter');
        await tick();
        await tick();
        expect(roles()).toEqual([]);
        expect(h.svc.edits.get()).toHaveLength(1);
        expect(created).toHaveLength(1);
    });

    test('projection count per click through the service is one', async () => {
        const renderer = new TerrainEditOverlayRenderer(() => ({ setLngLat() { return this; }, remove() { return this; } }));
        const edits = Array.from({ length: 10 }, (_, i) => makeEdit({ id: `e${i}` }));
        const h = await harness({ rawMap: {}, renderer, listResult: edits });
        const clicks = [P1, P2, P3, P1, P2, P3];
        const perClick: number[] = [];
        for (const p of clicks) {
            const before = terrainEditProjectionCount();
            click(h, p.lng + perClick.length * 1e-5, p.lat);
            await tick();
            perClick.push(terrainEditProjectionCount() - before);
        }
        expect(perClick).toEqual([1, 1, 1, 1, 1, 1]);
    });
});
