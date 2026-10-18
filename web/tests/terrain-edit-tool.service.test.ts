import type { PondEdgeApi, PondEdgeProposal } from '../../shared/api/pond-edge.gen';
import type { WaterStepsApi, WaterStepsProposal } from '../../shared/api/water-steps.gen';
import { EditHistory } from '../src/draw/history';
import { afterEach, describe, expect, test } from 'bun:test';
import { di, Signal, Computed } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { MapService } from '../src/map/map.service';
import type { TerrainEdit, TerrainEditsApi } from '../../shared/api/terrain-edits.gen';
import type { MapBuildApi, MapBuildJob } from '../../shared/api/map-build.gen';
import type { TerrainGeneratorsApi, TerrainGenerateResult } from '../../shared/api/terrain-generators.gen';
import type { Course } from '../../shared/api/courses.gen';
import { deriveTileVersion, type TileManifest } from '../src/map/tileset.service';
import type { FeatureCollection } from 'geojson';
import { lngLatToSweref99tm, sweref99tmToWgs84 } from '../src/geo/transform';
import {
    TerrainEditToolService,
    TERRAIN_EDIT_TOOL_ID,
    DEFAULT_FEATHER_M,
    DEFAULT_RADIUS_M,
    paramsSummary,
    RECIPE_COLORS,
    RECIPE_COLOR_OTHER,
    type TerrainEditRenderer,
    type TerrainEditView,
    type TerrainGeneratorKind,
} from '../src/terrain-edit/terrain-edit-tool.service';
import { ShapingService } from '../src/terrain-edit/shaping.service';
import { doneJob, fakeShapingApi, shapingJob, type FakeShapingApi, type LibraryEntry } from './shaping-fakes';
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
        import: () => Promise.reject(new Error('not under test')),
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
                params: { featherM: 0, ...input.params },
                rings: input.rings ?? [],
                enabled: input.enabled ?? true,
            });
        },
        async update(input) {
            api.calls.update.push(input);
            if (api.failUpdate) throw new Error('version conflict');
            const current = api.listResult.find(e => e.id === input.id) ?? makeEdit({ id: input.id });
            return {
                ...current,
                ...('enabled' in input ? { enabled: input.enabled! } : {}),
                ...(input.op ? { op: input.op } : {}),
                ...(input.params ? { params: { featherM: 0, ...input.params } } : {}),
                version: input.version + 1,
            };
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

interface FakeGenerators extends TerrainGeneratorsApi {
    calls: Array<{ courseId: string; kind: TerrainGeneratorKind }>;
    result: TerrainGenerateResult | Error;
}

function fakeGenerators(): FakeGenerators {
    const g: FakeGenerators = {
        calls: [],
        result: { kind: 'building-pads', imported: 3, skipped: [], report: [] },
        startRoadsFetch: () => Promise.reject(new Error('not under test')),
        roadsFetchJob: () => Promise.reject(new Error('not under test')),
        currentRoadsFetch: () => Promise.reject(new Error('not under test')),
        async generate(input) {
            g.calls.push(input);
            if (g.result instanceof Error) throw g.result;
            return { ...g.result, kind: input.kind };
        },
    };
    return g;
}

interface FakeFeature {
    id: string;
    type: string;
    holeId?: string | null;
    attributes: Record<string, string | number | boolean> | null;
    no?: number | null;
    geometry?: { crs: string; curveType?: string; rings: Array<{ points: Array<{ x: number; y: number }> }> };
    version?: number;
}

interface FakeFeatures {
    store: { items: Signal<FakeFeature[]> };
    /** FeaturesService's hit-test inputs (draw mode's rule): the stack, top first, and nothing hidden. */
    stackTopDown: Computed<FakeFeature[]>;
    effectiveHiddenTypes: Signal<ReadonlySet<string>>;
    effectiveHiddenIds: Signal<ReadonlySet<string>>;
    hiddenSources: Signal<ReadonlySet<string>>;
    updates: Array<{ id: string; patch: { attributes?: Record<string, string | number | boolean> | null; geometry?: unknown; type?: string } }>;
    update(id: string, patch: { attributes?: Record<string, string | number | boolean> | null; geometry?: unknown }): Promise<unknown>;
    /** The batch funnels Find falls and its undo use: each call recorded as it came. */
    creates: Array<Array<Record<string, unknown>>>;
    removes: string[][];
    updateMany(items: Array<{ id: string; patch: Record<string, unknown> }>, opts?: { local?: boolean }): Promise<unknown[] | undefined>;
    createMany(inputs: Array<Record<string, unknown>>, opts?: { select?: boolean }): Promise<unknown[] | undefined>;
    removeMany(ids: string[]): Promise<boolean>;
    stackFor(): FakeFeature[];
}

function fakeFeatures(items: FakeFeature[] = []): FakeFeatures {
    const store = { items: new Signal(items) };
    const f: FakeFeatures = {
        store,
        stackTopDown: new Computed(() => store.items.get()),
        effectiveHiddenTypes: new Signal<ReadonlySet<string>>(new Set()),
        effectiveHiddenIds: new Signal<ReadonlySet<string>>(new Set()),
        hiddenSources: new Signal<ReadonlySet<string>>(new Set()),
        updates: [],
        async update(id, patch) {
            f.updates.push({ id, patch });
            const next = f.store.items.peek().map(x => (x.id !== id ? x : {
                ...x,
                ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
                ...(patch.geometry !== undefined ? { geometry: patch.geometry as FakeFeature['geometry'] } : {}),
                version: (x.version ?? 1) + 1,
            }));
            f.store.items.set(next);
            return next.find(x => x.id === id);
        },
        creates: [],
        removes: [],
        async updateMany(items) {
            const out: unknown[] = [];
            for (const { id, patch } of items) {
                f.updates.push({ id, patch: patch as FakeFeatures['updates'][number]['patch'] });
                const next = f.store.items.peek().map(x => (x.id !== id ? x : { ...x, ...patch, version: (x.version ?? 1) + 1 } as FakeFeature));
                f.store.items.set(next);
                out.push(next.find(x => x.id === id));
            }
            return out;
        },
        async createMany(inputs) {
            f.creates.push(inputs);
            const made = inputs.map((input, i) => ({ id: `new-${f.creates.length}-${i}`, version: 1, holeId: null, ...input }) as unknown as FakeFeature);
            f.store.items.set([...f.store.items.peek(), ...made]);
            return made;
        },
        async removeMany(ids) {
            f.removes.push(ids);
            f.store.items.set(f.store.items.peek().filter(x => !ids.includes(x.id)));
            return true;
        },
        stackFor: () => [],
    };
    return f;
}

interface MoveEvent {
    lngLat: { lng: number; lat: number };
    point: { x: number; y: number };
    originalEvent: { buttons: number };
}

interface Harness {
    svc: TerrainEditToolService;
    shaping: FakeShapingApi;
    features: FakeFeatures;
    /** Bounds passed to map.fitBounds ([w, s, e, n], WGS84). */
    fits: Array<[number, number, number, number]>;
    api: FakeApi;
    mapBuild: FakeMapBuild;
    generators: FakeGenerators;
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
    features?: FakeFeatures;
    holes?: Array<{ id: string; number: number }>;
    siteId?: string | null;
    mapKey?: string | null;
    recipes?: LibraryEntry[];
    /** Live tile manifest (TilesetService.manifest). */
    manifest?: TileManifest | null;
    /** Non-null stands in for a live MaplibreMap. */
    rawMap?: object | null;
    renderer?: TerrainEditRenderer;
    /** "Fit edge to water" stand-in (PondEdgeService). */
    pondEdge?: PondEdgeApi;
    /** "Find falls" stand-in (WaterStepsService) and the undo history it joins. */
    waterSteps?: WaterStepsApi;
    history?: EditHistory;
} = {}): Promise<Harness> {
    const api = fakeApi(opts.listResult ?? []);
    const mapBuild = fakeMapBuild();
    const renderer = fakeRenderer();
    const generators = fakeGenerators();
    const features = opts.features ?? fakeFeatures();
    const shaping = fakeShapingApi(opts.recipes ?? []);
    const course: Harness['course'] = { tileManifestJson: null, siteId: 'site-1' };
    const courseGets: string[] = [];
    const coursesApi = {
        async get(input: { id: string }) {
            courseGets.push(input.id);
            return { id: input.id, ...course } as unknown as Course;
        },
    };
    const svc = new TerrainEditToolService(api, mapBuild, 0 /* pollMs: no real waits */, generators, new ShapingService(shaping, 0), coursesApi,
        opts.pondEdge ?? { propose: async () => { throw new Error('unused'); }, proposeAll: async () => { throw new Error('unused'); } },
        opts.waterSteps ?? { propose: async () => { throw new Error('unused'); } },
        () => opts.history ?? new EditHistory());

    const ready = new Signal(true);
    const interactionMode = new Signal<string>(TERRAIN_EDIT_TOOL_ID);
    const reloads: string[] = [];
    const fits: Array<[number, number, number, number]> = [];
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
            fitBounds: (bounds: [number, number, number, number]) => { fits.push(bounds); },
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
            holes: new Signal(opts.holes ?? []),
        } as never,
        features: features as never,
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
        shaping,
        features,
        fits,
        api,
        mapBuild,
        generators,
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
function click(h: Harness, lng: number, lat: number, shiftKey = false, ctrlKey = false): void {
    h.clickHandlers[0]({ lngLat: { lng, lat }, point: { x: 0, y: 0 }, originalEvent: { shiftKey, ctrlKey } } as never);
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

test('paramsSummary gives a lake shore its water level, floor and islands, no feather', () => {
    const ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(paramsSummary(makeEdit({ op: 'shore', params: { featherM: 0, levelM: 88.5, depthM: 12 }, rings: [ring, ring, ring] })))
        .toBe('water at 88.5 m · floor 12 m below · 2 islands');
    expect(paramsSummary(makeEdit({ op: 'shore', params: { featherM: 0, levelM: 88.5 } }))).toBe('water at 88.5 m');
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

describe('generators (building pads / road grades)', () => {
    test('generate calls the server for the course, reloads the list and reports the count', async () => {
        const h = await harness();
        h.api.listResult = [makeEdit({ id: 'g1', origin: 'building-pads', originRef: 'osm:way/1' })];
        const listsBefore = h.api.calls.list.length;

        const ok = await h.svc.generate('building-pads');
        expect(ok).toBe(true);
        expect(h.generators.calls).toEqual([{ courseId: 'course-1', kind: 'building-pads' }]);
        expect(h.api.calls.list.length).toBe(listsBefore + 1);
        expect(h.svc.edits.get().map(e => e.id)).toEqual(['g1']);
        expect(h.svc.notice.get()).toBe('Building pads: 3 edit(s) generated. Apply to terrain to bake them.');
        expect(h.svc.generating.get()).toBeNull();
        expect(h.svc.editName(h.svc.edits.get()[0])).toBe('Building pad');
    });

    test('a failed generation surfaces in the notice and one runs at a time', async () => {
        const h = await harness();
        h.generators.result = new Error('No lidar is persisted for this course');
        expect(await h.svc.generate('road-grades')).toBe(false);
        expect(h.svc.notice.get()).toBe('Road grades failed: No lidar is persisted for this course');

        let release!: () => void;
        h.generators.generate = () => new Promise(resolve => {
            release = () => resolve({ kind: 'road-grades', imported: 1, skipped: ['feature 3: bad'], report: [] });
        });
        const first = h.svc.generate('road-grades');
        expect(h.svc.generating.get()).toBe('road-grades');
        expect(await h.svc.generate('building-pads')).toBe(false); // busy
        release();
        expect(await first).toBe(true);
        expect(h.svc.notice.get()).toBe('Road grades: 1 edit(s) generated (1 feature(s) skipped). Apply to terrain to bake them.');
    });
});

describe('changing an edit', () => {
    const creekDig = makeEdit({
        id: 'g1', op: 'dig', origin: 'creek-digs', originRef: 'feature:f1',
        params: { featherM: 0, reference: 'stream', depthM: 0.28, bankSlopeDeg: 10 },
    });
    const creek = () => fakeFeatures([{ id: 'f1', type: 'water_creek', attributes: { digPreset: 'meadow_brook', note: 'kept' } }]);

    test('only hand-drawn plane/smooth edits and generated digs open a form', async () => {
        const h = await harness({ features: creek() });
        expect(h.svc.formKind(makeEdit())).toBe('params');
        expect(h.svc.formKind(makeEdit({ op: 'smooth', params: { featherM: 2, radiusM: 2 } }))).toBe('params');
        expect(h.svc.formKind(creekDig)).toBe('dig');
        expect(h.svc.formKind(makeEdit({ op: 'plane', origin: 'building-pads', originRef: 'osm:way/1' }))).toBeNull();
        expect(h.svc.formKind(makeEdit({ op: 'corridor', origin: 'road-grades', originRef: 'osm:way/2' }))).toBeNull();
        expect(h.svc.formKind(makeEdit({ op: 'delta', origin: 'unity-sculpt-inner', originRef: null }))).toBeNull();
        expect(h.svc.formKind(makeEdit({ op: 'shore', origin: 'lake-shore', originRef: 'lake:vattern', params: { featherM: 0, levelM: 88.5 } }))).toBeNull();
    });

    test("a generated dig's settings come from its feature, and saving them writes the feature and re-digs", async () => {
        const h = await harness({ listResult: [creekDig], features: creek() });
        expect(h.svc.digSettings(creekDig)).toEqual({ preset: 'meadow_brook' });

        expect(await h.svc.saveDigSettings('g1', { preset: 'eroded_gully', depthM: 0.5 })).toBe(true);
        // The feature keeps its other attributes; the generator re-runs for that kind.
        expect(h.features.updates).toEqual([{ id: 'f1', patch: { attributes: { note: 'kept', digPreset: 'eroded_gully', digDepthM: 0.5 } } }]);
        expect(h.generators.calls).toEqual([{ courseId: 'course-1', kind: 'creek-digs' }]);
        expect(h.svc.notice.get()).toContain('Apply to terrain');

        // Back to the defaults: the dig keys go, the rest stays.
        await h.svc.saveDigSettings('g1', {});
        expect(h.features.updates[1]).toEqual({ id: 'f1', patch: { attributes: { note: 'kept' } } });
    });

    test('deleting a generated dig marks its feature dig: false, so the next run leaves it out too', async () => {
        const h = await harness({ listResult: [creekDig], features: creek() });
        await h.svc.remove('g1');
        expect(h.api.calls.remove).toEqual([]);
        expect(h.features.updates).toEqual([{ id: 'f1', patch: { attributes: { digPreset: 'meadow_brook', note: 'kept', dig: false } } }]);
        expect(h.generators.calls).toEqual([{ courseId: 'course-1', kind: 'creek-digs' }]);
    });

    test("a hand-drawn edit's op and params save in place, with its version", async () => {
        const h = await harness({ listResult: [makeEdit({ id: 'e1', version: 4, params: { featherM: 2, flat: true } })] });
        expect(await h.svc.saveParams('e1', { op: 'smooth', featherM: 3, radiusM: 4, flat: true })).toBe(true);
        expect(h.api.calls.update).toEqual([{ id: 'e1', version: 4, op: 'smooth', params: { featherM: 3, radiusM: 4 } }]);
        expect(h.svc.edits.get()[0]).toMatchObject({ op: 'smooth', params: { featherM: 3, radiusM: 4 }, version: 5 });

        await h.svc.saveParams('e1', { op: 'plane', featherM: 1, radiusM: 4, flat: true });
        expect(h.api.calls.update[1]).toEqual({ id: 'e1', version: 5, op: 'plane', params: { featherM: 1, flat: true } });
    });
});

describe('finding an edit', () => {
    const dig = (id: string, origin: string, featureId: string, params: TerrainEdit['params'] = { featherM: 0, depthM: 1, bankSlopeDeg: 11 }) =>
        makeEdit({ id, op: 'dig', origin, originRef: `feature:${featureId}`, params });
    const features = () => fakeFeatures([
        { id: 'b3', type: 'bunker', holeId: 'h3', attributes: null },
        { id: 'b1', type: 'bunker', holeId: 'h1', attributes: null },
        { id: 'p5', type: 'water', holeId: 'h5', attributes: { digPreset: 'deep_water' } },
        { id: 'c', type: 'water_creek', holeId: null, attributes: { digPreset: 'eroded_gully' } },
    ]);
    const holes = [{ id: 'h1', number: 1 }, { id: 'h3', number: 3 }, { id: 'h5', number: 5 }];
    const edits = [
        dig('d-b3', 'bunker-digs', 'b3'),
        makeEdit({ id: 'pad', op: 'plane', origin: 'building-pads', originRef: 'osm:way/1', params: { featherM: 4, flat: true } }),
        dig('d-p5', 'water-digs', 'p5'),
        makeEdit({ id: 'road', op: 'corridor', origin: 'road-grades', originRef: 'osm:way/2', params: { featherM: 2, widthM: 6 } }),
        dig('d-b1', 'bunker-digs', 'b1'),
        dig('d-c', 'creek-digs', 'c'),
        dig('d-gone', 'water-digs', 'elsewhere'),
        makeEdit({ id: 'mine', op: 'smooth', params: { featherM: 2, radiusM: 3 } }),
        makeEdit({ id: 'lake', op: 'shore', origin: 'lake-shore', originRef: 'lake:vattern', params: { featherM: 0, levelM: 88.5, depthM: 12 } }),
    ];

    test('each edit is named after what it is: its feature and hole, or its kind', async () => {
        const h = await harness({ listResult: edits, features: features(), holes });
        const byId = (id: string) => h.svc.editName(edits.find(e => e.id === id)!);
        expect(byId('d-b3')).toBe('Bunker · hole 3');
        expect(byId('d-p5')).toBe('Pond · hole 5 · Deep Water');
        expect(byId('d-c')).toBe('Creek · Eroded Gully');
        expect(byId('pad')).toBe('Building pad');
        expect(byId('road')).toBe('Road grade · 6 m wide');
        expect(byId('mine')).toBe('Smooth (drawn)');
        expect(byId('lake')).toBe('Lake shore');
        expect(byId('d-gone')).toBe('Pond · not on this course');
    });

    test('the list is grouped by kind, sorted by hole, with digs from other courses apart', async () => {
        const h = await harness({ listResult: edits, features: features(), holes });
        const groups = h.svc.groups.get().map(g => [g.label, g.edits.map(e => e.id)]);
        expect(groups).toEqual([
            ['Your edits', ['mine']],
            ['Lake shore', ['lake']],
            ['Ponds', ['d-p5']],
            ['Bunkers', ['d-b1', 'd-b3']],
            ['Creeks', ['d-c']],
            ['Building pads', ['pad']],
            ['Road grades', ['road']],
            ['Not on this course', ['d-gone']],
        ]);
    });

    test('hovering a row highlights its outline; clicking it zooms the map there', async () => {
        const h = await harness({ listResult: [makeEdit({ id: 'e1', rings: [[{ x: 533000, y: 6475000 }, { x: 533100, y: 6475000 }, { x: 533100, y: 6475050 }]] })] });
        h.svc.hoveredId.set('e1');
        await tick();
        expect(h.renderer.renders[h.renderer.renders.length - 1].highlightId).toBe('e1');
        h.svc.hoveredId.set(null);
        h.svc.editingId.set('e1'); // an open form keeps its edit highlighted
        await tick();
        expect(h.renderer.renders[h.renderer.renders.length - 1].highlightId).toBe('e1');

        h.svc.zoomTo('e1');
        expect(h.fits).toHaveLength(1);
        const [w, s, e, n] = h.fits[0];
        expect(w).toBeLessThan(e);
        expect(s).toBeLessThan(n);
        expect(e - w).toBeGreaterThan(0.001); // ~100 m of longitude
    });
});

// ─── Shape in Blender (SHAPING-PLAN.md "Terrain editor → Blender") ──────────

describe('shape in Blender', () => {
    /** A square feature of `half` m round a click point (EPSG:3006). */
    const square = (at: { lng: number; lat: number }, half: number) => {
        const c = lngLatToSweref99tm(at);
        return {
            crs: 'EPSG:3006',
            rings: [{ points: [
                { x: c.x - half, y: c.y - half }, { x: c.x + half, y: c.y - half },
                { x: c.x + half, y: c.y + half }, { x: c.x - half, y: c.y + half },
            ] }],
        };
    };
    const library: LibraryEntry[] = [
        { id: 'conway', name: 'Conway Standard', author: 'cesimgolf', surfaces: ['bunker'], defaultFor: ['bunker'], notes: 'Grass lip, steep face' },
        { id: 'pot', name: 'Pot bunker', author: 'golfmap', surfaces: ['bunker'] },
        { id: 'pond', name: 'Natural pond', author: 'afrod', surfaces: ['lake'], defaultFor: ['lake'] },
    ];
    // A bunker on top of a fairway at P1 (stack order: top first), a pond at P3.
    const course = () => fakeFeatures([
        { id: 'b1', type: 'bunker', holeId: 'h3', no: 28, attributes: null, geometry: square(P1, 5) },
        { id: 'fw', type: 'fairway', holeId: 'h3', no: 2, attributes: null, geometry: square(P1, 40) },
        { id: 'p1', type: 'water', holeId: null, no: 9, attributes: null, geometry: square(P3, 5) },
    ]);
    const holes = [{ id: 'h3', number: 3 }];

    test('a click on a bunker selects it instead of starting an outline; open ground clears it and outlines', async () => {
        const h = await harness({ features: course(), holes, recipes: library });
        click(h, P1.lng, P1.lat);
        expect(h.svc.selectedFeatureId.get()).toBe('b1');
        expect(h.svc.state.draft.get()).toHaveLength(0);
        expect(h.svc.describeFeature(h.svc.selectedFeature.get()!)).toBe('Bunker · hole 3 · hole_3_1c');
        await tick();
        expect(h.renderer.renders.at(-1)!.selection).toHaveLength(1); // its outline is drawn

        // Beside the bunker, still on the fairway (not shaped per feature): an outline starts.
        const off = { lng: P1.lng + 0.0002, lat: P1.lat };
        click(h, off.lng, off.lat);
        expect(h.svc.selectedFeatureId.get()).toBeNull();
        expect(h.svc.state.draft.get()).toHaveLength(1);

        // While outlining, a click on the pond is just the next point.
        click(h, P3.lng, P3.lat);
        expect(h.svc.selectedFeatureId.get()).toBeNull();
        expect(h.svc.state.draft.get()).toHaveLength(2);
    });

    test('Shift+click on a bunker starts an outline there; Esc clears the selection', async () => {
        const h = await harness({ features: course(), holes });
        click(h, P1.lng, P1.lat, true);
        expect(h.svc.selectedFeatureId.get()).toBeNull();
        expect(h.svc.state.draft.get()).toHaveLength(1);
        h.svc.onEscape();

        click(h, P3.lng, P3.lat);
        expect(h.svc.selectedFeatureId.get()).toBe('p1');
        expect(h.svc.describeFeature(h.svc.selectedFeature.get()!)).toBe('Water · others_9');
        expect(h.svc.onEscape()).toBe(true);
        expect(h.svc.selectedFeatureId.get()).toBeNull();
        expect(h.svc.onEscape()).toBe(false);
    });

    test("saving a recipe creates the feature's recipe edit, then updates it keeping its overrides; the default deletes it", async () => {
        const h = await harness({ features: course(), holes, recipes: library });
        expect(await h.svc.saveRecipe('b1', 'pot')).toBe(true);
        // No rings (the feature is the shape): the server files it under origin feature, originRef feature:b1.
        expect(h.api.calls.create).toEqual([{ siteId: 'site-1', op: 'recipe', params: { recipe: 'pot' }, featureId: 'b1' }]);

        // The server's row: a recipe edit with overrides set elsewhere.
        const row = makeEdit({ id: 'r1', op: 'recipe', params: { featherM: 0, recipe: 'pot', overrides: { rings: 3 } }, origin: 'feature', originRef: 'feature:b1', version: 2 });
        h.api.listResult = [row];
        await h.svc.reload();
        expect(h.svc.recipeEditOf('b1')?.id).toBe('r1');

        expect(await h.svc.saveRecipe('b1', 'conway')).toBe(true);
        expect(h.api.calls.update).toEqual([{ id: 'r1', version: 2, params: { recipe: 'conway', overrides: { rings: 3 } } }]);

        expect(await h.svc.saveRecipe('b1', null)).toBe(true);
        expect(h.api.calls.remove).toEqual([{ id: 'r1', version: 3 }]);
        expect(h.svc.recipeEditOf('b1')).toBeNull();
        expect(h.svc.notice.get()).toContain('course default');
    });

    test('Cmd/Ctrl+click adds bunkers to the selection and takes them out; a pond starts a new one', async () => {
        const features = fakeFeatures([
            { id: 'b1', type: 'bunker', holeId: 'h3', no: 28, attributes: null, geometry: square(P1, 5) },
            { id: 'b2', type: 'bunker', holeId: 'h3', no: 29, attributes: null, geometry: square(P2, 5) },
            { id: 'p1', type: 'water', holeId: null, no: 9, attributes: null, geometry: square(P3, 5) },
        ]);
        const h = await harness({ features, holes, recipes: library });
        click(h, P1.lng, P1.lat);
        click(h, P2.lng, P2.lat, false, true);
        expect(h.svc.selectedFeatureIds.get()).toEqual(['b1', 'b2']);
        expect(h.svc.state.draft.get()).toHaveLength(0);
        expect(h.svc.describeSelection(h.svc.selectedFeatures.get())).toBe('Bunker × 2 · hole_3_1c, hole_3_1d');
        await tick();
        expect(h.renderer.renders.at(-1)!.selection).toHaveLength(2); // both outlines are drawn

        click(h, P1.lng, P1.lat, false, true); // again: out
        expect(h.svc.selectedFeatureIds.get()).toEqual(['b2']);
        click(h, P3.lng, P3.lat, false, true); // a pond among bunkers: a new selection
        expect(h.svc.selectedFeatureIds.get()).toEqual(['p1']);
        click(h, P1.lng + 0.0002, P1.lat, false, true); // open ground: nothing, and no outline
        expect(h.svc.selectedFeatureIds.get()).toEqual(['p1']);
        expect(h.svc.state.draft.get()).toHaveLength(0);
        expect(h.svc.onEscape()).toBe(true);
        expect(h.svc.selectedFeatureIds.get()).toEqual([]);
    });

    test('one recipe saves on several features, each keeping its own seed', async () => {
        const saved = makeEdit({ id: 'r1', op: 'recipe', params: { featherM: 0, recipe: 'conway', overrides: { depth: 0.9, seed: 7 } },
            origin: 'feature', originRef: 'feature:b1', rings: [], version: 2 });
        const h = await harness({ features: course(), holes, recipes: library, listResult: [saved] });
        expect(await h.svc.saveRecipes(['b1', 'p1'], 'pot', { depth: 1.2, seed: 99 }, { keepSeeds: true })).toBe(true);
        expect(h.api.calls.update).toEqual([{ id: 'r1', version: 2, params: { recipe: 'pot', overrides: { depth: 1.2, seed: 7 } } }]);
        expect(h.api.calls.create).toEqual([{ siteId: 'site-1', op: 'recipe', params: { recipe: 'pot', overrides: { depth: 1.2 } }, featureId: 'p1' }]);
        expect(h.svc.notice.get()).toBe('Recipe saved on 2 features. Update meshes in the command bar to shape them.');
    });

    test('recipe edits are listed under Blender recipes by feature, hole and recipe name; clicking one selects its feature', async () => {
        const recipeEdit = (id: string, featureId: string, recipe: string) => makeEdit({
            id, op: 'recipe', params: { featherM: 0, recipe }, origin: 'feature', originRef: `feature:${featureId}`, rings: [],
        });
        const h = await harness({
            features: course(), holes, recipes: library,
            listResult: [recipeEdit('r-b', 'b1', 'pot'), recipeEdit('r-p', 'p1', 'pond'), recipeEdit('r-x', 'gone', 'pot'), recipeEdit('r-n', 'fw', 'none'), makeEdit({ id: 'mine' })],
        });
        await tick();
        const groups = h.svc.groups.get().map(g => [g.label, g.edits.map(e => h.svc.editName(e))]);
        expect(groups).toEqual([
            ['Your edits', ['Plane (drawn)']],
            ['Blender recipes', ['Bunker · hole 3 · Pot bunker', 'Fairway · hole 3 · no recipe', 'Water · Natural pond']],
            ['Not on this course', ['Recipe · not on this course · Pot bunker']],
        ]);
        expect(paramsSummary(h.svc.edits.get()[0])).toBe('Blender recipe pot');

        // On the map: each loaded feature with a recipe, in its recipe's colour, labelled by the recipe.
        const { recipes, labels } = h.svc.view.get();
        expect(Object.fromEntries(Object.entries(recipes).map(([id, mark]) => [id, mark.color]))).toEqual({
            'r-b': RECIPE_COLORS[1], 'r-p': RECIPE_COLORS[2], 'r-n': RECIPE_COLOR_OTHER,
        });
        expect(recipes['r-b'].rings[0].length).toBeGreaterThanOrEqual(4);
        expect(labels).toMatchObject({ 'r-b': 'Pot bunker', 'r-p': 'Natural pond', 'r-n': 'no recipe', mine: 'Plane (drawn)' });

        h.svc.showEdit('r-b');
        expect(h.svc.selectedFeatureId.get()).toBe('b1');
        expect(h.fits).toHaveLength(1); // the bunker's outline
        const [w, , e] = h.fits[0];
        expect(e - w).toBeGreaterThan(0.0001);
        expect(e - w).toBeLessThan(0.001); // about 10 m, not the 80 m fairway
    });

    test("applyToMeshes runs the course's shaping job for the selection's scope or the whole course, and follows it to the end", async () => {
        const h = await harness({ features: course(), holes, recipes: library });
        h.shaping.polls = [shapingJob(), doneJob(['Spline_hole_3_1c_Bunker_-_Mesh'])];
        expect(await h.svc.applyToMeshes('b1')).toBe(true);
        // The server runs the course (only changed ops re-run); the outcome shows in the feature's section.
        expect(h.shaping.calls.apply).toEqual([{ courseId: 'course-1', featureIds: ['b1'] }]);
        expect(h.svc.shaping.jobScope.get()).toBe('b1');
        expect(h.svc.shaping.job.get()?.result?.changedObjects).toEqual(['Spline_hole_3_1c_Bunker_-_Mesh']);

        expect(await h.svc.applyToMeshes()).toBe(true);
        expect(h.shaping.calls.apply[1]).toEqual({ courseId: 'course-1' });
        expect(h.svc.shaping.jobScope.get()).toBeNull();
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

describe('fit edge to water', () => {
    const square = (x0: number, y0: number, side: number, step = 0.25) => {
        const pts: Array<{ x: number; y: number }> = [];
        for (let t = 0; t < 4 * side; t += step) {
            const k = Math.floor(t / side), u = t - k * side;
            pts.push(k === 0 ? { x: x0 + u, y: y0 } : k === 1 ? { x: x0 + side, y: y0 + u } : k === 2 ? { x: x0 + side - u, y: y0 + side } : { x: x0, y: y0 + side - u });
        }
        return pts;
    };
    const drawn = { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points: [{ x: 0, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 22 }, { x: 0, y: 22 }] }] };
    const proposal = (featureId: string, shape: string, moved: number, version = 1): PondEdgeProposal => ({
        featureId, shape, version, ring: square(1, 1, 20), lidarRing: square(2, 2, 18), level: 103.43,
        areaM2: { drawn: 484, lidar: 324, new: 400 }, outsideLidarM: { p50: 2, p90: 2, max: 3 },
        movedM: { p50: 1, p90: 1, max: moved }, kept: [{ fromM: 0, toM: 4, why: 'no clear water edge on the photo (reeds, shade?)' }],
        photos: [{ separation: 4 }], toward: null, image: null,
    });
    const ponds = () => fakeFeatures([
        { id: 'p1', type: 'water', attributes: null, geometry: drawn, version: 1 },
        { id: 'p2', type: 'water', attributes: null, geometry: drawn, version: 1 },
    ]);

    test('a proposal shows on the map; Accept stores it as a B-spline, Undo puts the old outline back', async () => {
        const calls: unknown[] = [];
        const pondEdge: PondEdgeApi = {
            propose: async (input) => { calls.push(input); return proposal('p1', 'hole_14_53', 1.2); },
            proposeAll: async () => { throw new Error('unused'); },
        };
        const h = await harness({ features: ponds(), pondEdge });
        expect(await h.svc.proposeEdge('p1')).toBe(true);
        expect(calls).toEqual([{ courseId: 'course-1', featureId: 'p1' }]);
        const review = h.svc.pondEdge.get()!;
        expect(review.proposal.shape).toBe('hole_14_53');
        expect(review.controls.length).toBeGreaterThanOrEqual(8);
        expect(review.deviation).toBeLessThan(0.2);
        expect(h.svc.view.get().pondEdge?.proposed).toBe(review.proposal.ring);
        expect(h.features.updates).toEqual([]);                       // nothing stored yet

        expect(await h.svc.acceptEdge()).toBe(true);
        const stored = h.features.updates[0]!;
        expect(stored.id).toBe('p1');
        const geometry = stored.patch.geometry as typeof drawn;
        expect(geometry.curveType).toBe('bspline');
        expect(geometry.rings[0]!.points).toEqual(review.controls);
        expect(stored.patch.attributes).toMatchObject({ waterEdge: 'photo' });
        expect(h.svc.pondProgress.get()).toMatchObject({ total: 2, fitted: 1 });
        expect(h.svc.pondEdge.get()).toBeNull();
        expect(h.svc.view.get().pondEdge).toBeNull();
        expect(h.svc.notice.get()).toContain('Dig ponds again');

        expect(await h.svc.undoEdge()).toBe(true);
        expect(h.features.updates[1]).toEqual({ id: 'p1', patch: { geometry: drawn, attributes: null } });
        expect(h.svc.pondProgress.get()).toMatchObject({ total: 2, fitted: 0 });
        expect(h.svc.edgeUndo.get()).toBeNull();
    });

    test('all ponds: biggest change first, Skip moves on, failures are told; a pond changed since is not stored', async () => {
        const pondEdge: PondEdgeApi = {
            propose: async () => { throw new Error('unused'); },
            proposeAll: async () => ({
                proposals: [proposal('p1', 'hole_1_4d', 0.4), proposal('p2', 'others_12', 3.1, 7)],
                failed: [{ featureId: 'v', shape: 'others_15', error: 'no orthophoto tells this pond' }],
            }),
        };
        const h = await harness({ features: ponds(), pondEdge });
        expect(await h.svc.proposeAllEdges()).toBe(true);
        expect(h.svc.pondEdge.get()!.proposal.shape).toBe('others_12');
        expect(h.svc.pondEdge.get()!.queue.map((p) => p.shape)).toEqual(['hole_1_4d']);
        expect(h.svc.pondEdge.get()!.failed).toEqual([{ shape: 'others_15', error: 'no orthophoto tells this pond' }]);

        // others_12 was proposed from version 7 but the store holds version 1: not stored, on to the next.
        expect(await h.svc.acceptEdge()).toBe(false);
        expect(h.svc.notice.get()).toContain('changed since the proposal');
        expect(h.svc.pondEdge.get()!.proposal.shape).toBe('hole_1_4d');
        h.svc.discardEdge();
        expect(h.svc.pondEdge.get()).toBeNull();
        expect(h.features.updates).toEqual([]);
    });

    test('the Ponds checklist: steep banks on all ponds in one go (one re-dig), lakes marked dig: false left out', async () => {
        const features = fakeFeatures([
            { id: 'p1', type: 'water', attributes: null, geometry: drawn, version: 1 },
            { id: 'p2', type: 'water', attributes: { digBankAboveDeg: 40 }, geometry: drawn, version: 1 },
            { id: 'lake', type: 'water', attributes: { dig: false }, geometry: drawn, version: 1 },
        ]);
        const h = await harness({ features });
        expect(h.svc.pondProgress.get()).toEqual({ total: 2, fitted: 0, steep: 1, dug: 0, stale: 0 });
        expect(await h.svc.steepAllPonds(45)).toBe(true);
        expect(h.features.updates).toEqual([{ id: 'p1', patch: { attributes: { digBankAboveDeg: 45 } } }]);
        expect(h.generators.calls).toEqual([{ courseId: 'course-1', kind: 'water-digs' }]);
        expect(h.svc.pondProgress.get().steep).toBe(2);
    });

    test("a dig older than the pond's edge fit counts as stale", async () => {
        const dig = makeEdit({ id: 'd1', op: 'dig', origin: 'water-digs', originRef: 'feature:p1', updatedAt: '2026-10-16 10:00:00',
            params: { featherM: 0, reference: 'level', depthM: 1 } });
        const h = await harness({ listResult: [dig], features: fakeFeatures([
            { id: 'p1', type: 'water', attributes: { waterEdge: 'photo', waterEdgeAt: '2026-10-16T12:00:00.000Z' }, geometry: drawn, version: 2 },
        ]) });
        expect(h.svc.pondProgress.get()).toEqual({ total: 1, fitted: 1, steep: 0, dug: 1, stale: 1 });
    });

    test('after a water import the tool proposes the edges as soon as it is up', async () => {
        let asked = 0;
        const pondEdge: PondEdgeApi = {
            propose: async () => { throw new Error('unused'); },
            proposeAll: async () => { asked++; return { proposals: [proposal('p1', 'others_4d', 1)], failed: [] }; },
        };
        const h = await harness({ features: ponds(), pondEdge });
        h.svc.requestPondFit();   // the tool is already active in the harness: proposes at once
        await new Promise((r) => setTimeout(r, 0));
        expect(asked).toBe(1);
        expect(h.svc.pondsOpen.get()).toBe(true);
        expect(h.svc.pondEdge.get()?.proposal.shape).toBe('others_4d');
    });

    test("a pond dig's form carries the bank above the water: read from and saved on the feature", async () => {
        const pondDig = makeEdit({ id: 'd1', op: 'dig', origin: 'water-digs', originRef: 'feature:p1', params: { featherM: 0, reference: 'level', depthM: 1, bankSlopeDeg: 32 } });
        const h = await harness({ listResult: [pondDig], features: fakeFeatures([{ id: 'p1', type: 'water', attributes: { digPreset: 'deep_water', digBankAboveDeg: 45 } }]) });
        expect(h.svc.digSettings(pondDig)).toEqual({ preset: 'deep_water', bankAboveDeg: 45 });
        expect(h.svc.pondOf(pondDig)).toBe('p1');
        await h.svc.saveDigSettings('d1', { preset: 'deep_water', bankAboveDeg: 40 });
        expect(h.features.updates[0]).toEqual({ id: 'p1', patch: { attributes: { digPreset: 'deep_water', digBankAboveDeg: 40 } } });
    });
});

// ─── Find falls ─────────────────────────────────────────────────────────────

describe('Find falls', () => {
    // A creek 60 m long running east, and a pond past its end; clicks are WGS84 like the map's.
    const o = lngLatToSweref99tm(P1);
    const at = (dx: number, dy = 0) => ({ x: o.x + dx, y: o.y + dy });
    const lngLat = (dx: number, dy = 0) => { const w = sweref99tmToWgs84(o.x + dx, o.y + dy); return { lng: w.lon, lat: w.lat }; };
    const box = (x0: number, x1: number, half: number) => [at(x0, -half), at(x1, -half), at(x1, half), at(x0, half)];
    const water = () => fakeFeatures([
        { id: 'c1', type: 'water_creek', holeId: 'h3', attributes: { bankVegPalette: 'reeds' }, geometry: { crs: 'EPSG:3006', rings: [{ points: box(0, 60, 3) }] }, version: 3 },
        { id: 'p1', type: 'water', holeId: null, attributes: null, geometry: { crs: 'EPSG:3006', rings: [{ points: box(70, 90, 8) }] }, version: 1 },
        { id: 'b1', type: 'bunker', attributes: null, geometry: { crs: 'EPSG:3006', rings: [{ points: box(-30, -20, 3) }] }, version: 1 },
    ]);
    const answer = (): WaterStepsProposal => ({
        courseId: 'course-1',
        bodies: [
            { featureId: 'c1', shape: 'hole_3_23e', type: 'water_creek', version: 3, line: [at(0), at(60)], profile: null, steps: 1 },
            { featureId: 'p1', shape: 'others_23c', type: 'water', version: 1, line: null, profile: null, steps: 0 },
        ],
        pieces: [
            { bodyId: 'c1', shape: 'hole_3_23e', index: 0, kind: 'pond', ring: box(0, 29.5, 3), levelM: 109.61, topM: 109.61, bottomM: 109.61, areaM2: 177, digLevelOffsetM: -0.02 },
            { bodyId: 'c1', shape: 'hole_3_23e', index: 1, kind: 'pond', ring: box(30.5, 60, 3), levelM: 109.12, topM: 109.12, bottomM: 109.12, areaM2: 180, digLevelOffsetM: -0.07 },
            { bodyId: 'p1', shape: 'others_23c', index: 0, kind: 'pond', ring: box(70, 90, 8), levelM: 107.5, topM: 107.5, bottomM: 107.5, areaM2: 320, digLevelOffsetM: 0 },
        ],
        falls: [
            { style: 'sill', fromBodyId: 'c1', toBodyId: 'c1', fromPiece: 0, toPiece: 1, line: [at(30.5, -3), at(30.5, 3)], at: at(30.5), flow: { x: 1, y: 0 }, topM: 109.61, bottomM: 109.12, dropM: 0.49, widthM: 6, sillM: 1, forced: false, gapM: null },
            { style: 'outlet', fromBodyId: 'c1', toBodyId: 'p1', fromPiece: 1, toPiece: 0, line: [at(70, -0.75), at(70, 0.75)], at: at(70), flow: { x: 1, y: 0 }, topM: 109.12, bottomM: 107.5, dropM: 1.62, widthM: 1.5, sillM: null, forced: false, gapM: 10 },
        ],
        cuts: [], skips: [], image: null,
    });

    test('ponds and creeks select together; Find shows the pieces and falls; a click on the water cuts, on a sill skips', async () => {
        const calls: Array<Parameters<WaterStepsApi['propose']>[0]> = [];
        const waterSteps: WaterStepsApi = { propose: async (input) => { calls.push(input); return answer(); } };
        const h = await harness({ features: water(), waterSteps });
        h.svc.selectFeature('c1');
        h.svc.toggleFeature('p1');
        expect(h.svc.selectedFeatureIds.get()).toEqual(['c1', 'p1']);
        expect(h.svc.selectionMixed.get()).toBe(true);
        expect(h.svc.waterSelection.get().map(f => f.id)).toEqual(['c1', 'p1']);
        h.svc.toggleFeature('b1');                                       // a bunker starts a selection of its own
        expect(h.svc.waterSelection.get()).toEqual([]);
        h.svc.selectFeature('c1');
        h.svc.toggleFeature('p1');

        expect(await h.svc.proposeSteps()).toBe(true);
        expect(calls).toEqual([{ courseId: 'course-1', featureIds: ['c1', 'p1'] }]);
        const mark = h.svc.view.get().waterSteps!;
        expect(mark.pieces.map(p => [p.kind, p.label])).toEqual([['pond', '109.61'], ['pond', '109.12'], ['pond', '107.50']]);
        expect(mark.falls.map(f => f.label)).toEqual(['0.49 m', '1.62 m outlet']);
        expect(h.features.updates).toEqual([]);                          // nothing stored yet

        click(h, lngLat(12).lng, lngLat(12).lat);                        // on the water: a cut there
        await tick();
        expect(calls).toHaveLength(2);
        expect(calls[1]!.cuts!).toHaveLength(1);
        expect(Math.hypot(calls[1]!.cuts![0]!.x - at(12).x, calls[1]!.cuts![0]!.y - at(12).y)).toBeLessThan(0.05);
        expect(h.svc.selectedFeatureIds.get()).toEqual(['c1', 'p1']);   // the click did not select

        click(h, lngLat(31, 1).lng, lngLat(31, 1).lat);                  // on the sill: skipped, the cut kept
        await tick();
        expect(calls).toHaveLength(3);
        expect(calls[2]!.cuts!).toHaveLength(1);
        expect(calls[2]!.skips).toEqual([at(30.5)]);

        click(h, lngLat(70.5).lng, lngLat(70.5).lat);                    // on the outlet: left out here, no new proposal
        await tick();
        expect(calls).toHaveLength(3);
        expect(h.svc.view.get().waterSteps!.falls.map(f => f.label)).toEqual(['0.49 m']);

        h.svc.discardSteps();
        expect(h.svc.view.get().waterSteps).toBeNull();
    });

    test('Accept without Split into ponds adds only the waterfalls; the creeks keep their shapes', async () => {
        const waterSteps: WaterStepsApi = { propose: async () => answer() };
        const h = await harness({ features: water(), waterSteps, history: new EditHistory() });
        h.svc.selectFeature('c1');
        h.svc.toggleFeature('p1');
        await h.svc.proposeSteps();
        expect(await h.svc.acceptSteps()).toBe(true);
        expect(h.features.updates).toEqual([]);
        expect(h.features.creates.length).toBeGreaterThan(0);
        expect(h.features.creates.flat().every(c => c.type === 'waterfall')).toBe(true);
    });

    test('Accept stores the plan as one undo step; Undo takes it back', async () => {
        const waterSteps: WaterStepsApi = { propose: async () => answer() };
        const history = new EditHistory();
        const h = await harness({ features: water(), waterSteps, history });
        h.svc.selectFeature('c1');
        h.svc.toggleFeature('p1');
        h.svc.stepsSplit.set(true);
        await h.svc.proposeSteps();
        expect(await h.svc.acceptSteps()).toBe(true);

        // hole_3_23e's bigger piece keeps c1; p1 (one piece) keeps its outline and becomes a dug pond.
        expect(h.features.updates.map(u => [u.id, u.patch.type])).toEqual([['c1', 'water'], ['p1', 'water']]);
        expect(h.features.updates[0]!.patch.attributes).toEqual({ bankVegPalette: 'reeds', digPreset: 'natural_pond', digBankAboveDeg: 45, digLevelOffsetM: -0.07 });
        expect((h.features.updates[0]!.patch.geometry as { curveType: string }).curveType).toBe('bspline');
        const created = h.features.creates[0]!;
        expect(created.map(c => c.type)).toEqual(['water', 'waterfall', 'waterfall']);
        expect(created[0]!.holeId).toBe('h3');
        expect(created[1]!.attributes).toEqual({ style: 'sill', flowBearingDeg: 90, topM: 109.61, bottomM: 109.12, sillM: 1 });
        expect(history.lastEntry()!.map(d => [d.featureId, d.before === null])).toEqual([
            ['c1', false], ['p1', false], ['new-1-0', true], ['new-1-1', true], ['new-1-2', true],
        ]);
        expect(h.svc.waterSteps.get()).toBeNull();
        expect(h.svc.stepsUndo.get()!.summary).toBe('3 pieces, 2 falls');
        expect(h.svc.notice.get()).toContain('Dig ponds and creeks');

        expect(await h.svc.undoSteps()).toBe(true);
        expect(h.features.removes).toEqual([['new-1-2', 'new-1-1', 'new-1-0']]);
        const back = h.features.store.items.get().find(f => f.id === 'c1')!;
        expect(back.type).toBe('water_creek');
        expect(back.attributes).toEqual({ bankVegPalette: 'reeds' });
        expect(h.svc.stepsUndo.get()).toBeNull();
    });

    test('a feature changed since the proposal is not stored', async () => {
        const h = await harness({ features: water(), waterSteps: { propose: async () => answer() } });
        h.svc.selectFeature('c1');
        await h.svc.proposeSteps();
        await h.features.update('c1', { attributes: { bankVegPalette: 'sedge' } });   // version 3 -> 4
        expect(await h.svc.acceptSteps()).toBe(false);
        expect(h.svc.notice.get()).toContain('changed since the proposal');
        expect(h.features.creates).toEqual([]);
    });
});
