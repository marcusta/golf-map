import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { lngLatToSweref99tm, sweref99tmToLngLat } from '../src/geo/transform';
import { deriveTileVersion } from '../src/map/tileset.service';
import {
    CleanToolService,
    CLEAN_TOOL_ID,
    CLEAN_BLOCK_PX,
    CLEAN_BRUSH_OVERLAY_ID,
    CLEAN_SOURCE_OVERLAY_ID,
    CLEAN_STROKE_OVERLAY_ID,
    cleanedPhotoPixelsUrl,
    type PixelSaver,
} from '../src/clean/clean-tool.service';
import type { Changed, CommandResult, PhotoRect, RetouchEngine } from '../src/clean/retouch-engine';
import type { CleanedPhotoApi } from '../../shared/api/cleaned-photo.gen';
import type { CleanedImportResult } from '../../shared/cleaned-photo';
import { PhotoImportClient } from '../src/clean/clean-external';

// The Clean tool on the cleaned photo's pixels: strokes go to the pixel
// engine, what they changed goes onto the map and to the server. The engine,
// the save, the map views and the frame clock are stand-ins; the service and
// its state machine are real.

/** The photo on the ground: 8192 px over a 2048 m square, 0.25 m per pixel. */
const BOUNDS = { west: 529000, south: 6486000, east: 531048, north: 6488048 };
const RES = 0.25;
/** A spot in the photo, by pixel. */
const at = (x: number, y: number) => sweref99tmToLngLat(BOUNDS.west + x * RES, BOUNDS.north - y * RES);
const C = at(3000, 4000);
const SOURCE = at(3200, 4000);

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Manual animation-frame clock: frames run only when the test ticks. */
function manualFrames() {
    let next = 1;
    const queue = new Map<number, () => void>();
    return {
        request(cb: () => void): number {
            const id = next++;
            queue.set(id, cb);
            return id;
        },
        cancel(id: number): void {
            queue.delete(id);
        },
        tick(): number {
            const cbs = [...queue.values()];
            queue.clear();
            for (const cb of cbs) cb();
            return cbs.length;
        },
    };
}

interface EngineCall {
    op: string;
    cmd?: string;
    params?: Record<string, any>;
    points?: number[][];
    rect?: PhotoRect;
}

/** A pixel engine that paints nothing real: every operation "changes" a
 * square around its points and remembers what it was asked. */
function fakeEngine(log: EngineCall[], opts: { holdLoad?: Array<() => void>; failLoad?: string } = {}) {
    let stroke: { cmd: string; params: Record<string, any>; points: number[][] } | null = null;
    const history: PhotoRect[] = [];
    const undone: PhotoRect[] = [];
    let disposed = false;
    const changed = (rect: PhotoRect, value = 200): Changed => ({ rect, rgba: new Uint8ClampedArray(rect.w * rect.h * 4).fill(value) });
    const around = (points: number[][], size: number): PhotoRect => {
        const r = Math.ceil(size / 2);
        const xs = points.map(p => p[0]);
        const ys = points.map(p => p[1]);
        const x = Math.floor(Math.min(...xs)) - r;
        const y = Math.floor(Math.min(...ys)) - r;
        return { x, y, w: Math.ceil(Math.max(...xs)) + r - x, h: Math.ceil(Math.max(...ys)) + r - y };
    };
    const engine: RetouchEngine = {
        async load(url, onProgress) {
            log.push({ op: 'load', cmd: url });
            if (opts.holdLoad) await new Promise<void>(resolve => opts.holdLoad!.push(resolve));
            if (opts.failLoad) throw new Error(opts.failLoad);
            onProgress(1);
            return { size: 8192 };
        },
        async begin(cmd, params) {
            log.push({ op: 'begin', cmd, params: params as Record<string, any> });
            stroke = { cmd, params: params as Record<string, any>, points: [...(params.points as number[][])] };
            return changed(around(stroke.points, stroke.params.size));
        },
        async push(points) {
            log.push({ op: 'push', points });
            stroke!.points.push(...points);
            return changed(around(points, stroke!.params.size));
        },
        async end(): Promise<CommandResult> {
            log.push({ op: 'end' });
            const s = stroke!;
            stroke = null;
            const rect = around(s.points, s.params.size);
            history.push(rect);
            undone.length = 0;
            const first = s.points[0];
            const offset: [number, number] = s.params.offset ?? [s.params.source[0] - first[0], s.params.source[1] - first[1]];
            return { changed: changed(rect), offset };
        },
        async cancel() {
            log.push({ op: 'cancel' });
            const s = stroke;
            stroke = null;
            // Back to the photo: nothing differs any more.
            return s ? changed(around(s.points, s.params.size), 0) : null;
        },
        async run(cmd, params) {
            log.push({ op: 'run', cmd, params: params as Record<string, any> });
            const p = params as Record<string, any>;
            if (p.points.length === 1 && p.size === 2) throw new Error("the stroke doesn't cover anything that can change");
            const rect = around(p.points, p.size);
            history.push(rect);
            undone.length = 0;
            return { changed: changed(rect) };
        },
        async undo() {
            log.push({ op: 'undo' });
            const rect = history.pop();
            if (!rect) return null;
            undone.push(rect);
            return changed(rect, 0);
        },
        async redo() {
            log.push({ op: 'redo' });
            const rect = undone.pop();
            if (!rect) return null;
            history.push(rect);
            return changed(rect);
        },
        async read(rect) {
            log.push({ op: 'read', rect });
            return changed(rect).rgba;
        },
        dispose() {
            disposed = true;
            log.push({ op: 'dispose' });
        },
    };
    return Object.defineProperty(engine, 'disposed', { get: () => disposed }) as RetouchEngine & { readonly disposed: boolean };
}

interface Harness {
    svc: CleanToolService;
    frames: ReturnType<typeof manualFrames>;
    /** Calls of every engine made, in order. */
    log: EngineCall[];
    engines: Array<ReturnType<typeof fakeEngine>>;
    saves: Array<{ courseId: string; rect: PhotoRect; bytes: number; snapshot: boolean }>;
    /** Block views on the map: id -> the patches put into it. */
    views: Map<string, Array<{ x: number; y: number; w: number; h: number; opaque: boolean }>>;
    removedViews: string[];
    overlays: Map<string, unknown>;
    photoStates: Array<{ layer: string; version: string }>;
    refreshes: string[];
    readonly undoCalls: number;
    move: (p: { lng: number; lat: number }) => void;
    featuresView: { modeHiddenTypes: Signal<ReadonlySet<string>> };
    holdSave: Array<() => void>;
    releaseLoad: () => void;
}

async function harness(opts: {
    bounds?: typeof BOUNDS | null;
    patchesGeneratedAt?: string | null;
    undoDepth?: number;
    failSaves?: () => boolean;
    holdSaves?: boolean;
    holdLoad?: boolean;
    failLoad?: string;
    importResult?: Partial<CleanedImportResult>;
} = {}): Promise<Harness> {
    const log: EngineCall[] = [];
    const engines: Harness['engines'] = [];
    const held: Array<() => void> = [];
    const holdSave: Array<() => void> = [];
    const saves: Harness['saves'] = [];
    let undoDepth = opts.undoDepth ?? 0;
    let undoCalls = 0;
    let version = 0;
    const stamp = () => `2026-10-10T12:00:0${++version}.000Z`;

    const photoApi: CleanedPhotoApi = {
        undoPhotoChange: async () => {
            undoCalls++;
            undoDepth = Math.max(0, undoDepth - 1);
            return { undoDepth, patchesGeneratedAt: stamp() };
        },
        cleanedPhotoInfo: async () => ({
            exists: undoDepth > 0, undoDepth, size: 8192,
            bounds3006: opts.bounds === undefined ? BOUNDS : opts.bounds,
            reason: opts.bounds === null ? 'Course course-1 has no map (no site): build the map first' : undefined,
            patchesGeneratedAt: opts.patchesGeneratedAt ?? null,
        }),
    };
    const savePixels: PixelSaver = async (courseId, changed, snapshot) => {
        if (opts.holdSaves) await new Promise<void>(resolve => holdSave.push(resolve));
        if (opts.failSaves?.()) throw new Error('disk full');
        saves.push({ courseId, rect: changed.rect, bytes: changed.rgba.length, snapshot });
        if (snapshot) undoDepth += 1;
        return { undoDepth, patchesGeneratedAt: stamp() };
    };
    const views: Harness['views'] = new Map();
    const removedViews: string[] = [];
    const frames = manualFrames();
    const importClient = {
        importPhoto: async () => ({
            changed: true, changedPixels: 10, bounds3006: null, size: 8192, undoDepth: ++undoDepth, patchesGeneratedAt: stamp(),
            ...opts.importResult,
        }),
    } as unknown as PhotoImportClient;
    const svc = new CleanToolService(
        () => {
            const e = fakeEngine(log, { holdLoad: opts.holdLoad ? held : undefined, failLoad: opts.failLoad });
            engines.push(e);
            return e;
        },
        photoApi,
        savePixels,
        {
            frames,
            views: (_map, id) => {
                const puts: Array<{ x: number; y: number; w: number; h: number; opaque: boolean }> = [];
                views.set(id, puts);
                return {
                    put: (patch, x, y, w, h) => {
                        let opaque = false;
                        for (let i = 3; i < patch.length; i += 4) if (patch[i]) { opaque = true; break; }
                        puts.push({ x, y, w, h, opaque });
                    },
                    remove: () => { removedViews.push(id); views.delete(id); },
                };
            },
        },
        importClient,
    );

    const canvas = document.createElement('canvas');
    const overlays: Harness['overlays'] = new Map();
    const photoStates: Harness['photoStates'] = [];
    const refreshes: string[] = [];
    let moveHandler: ((e: { lngLat: { lng: number; lat: number } }) => void) | null = null;
    const featuresView = {
        modeHiddenTypes: new Signal<ReadonlySet<string>>(new Set(['vegetation_zone'])),
        resetModeView() { this.modeHiddenTypes.set(new Set(['vegetation_zone'])); },
    };
    const ctx = {
        map: {
            interactionMode: new Signal<string>(CLEAN_TOOL_ID),
            ready: new Signal(true),
            map: new Signal({ on: () => {}, off: () => {}, dragPan: { enable: () => {}, disable: () => {} }, getZoom: () => 18, getCanvas: () => canvas }),
            onClick: () => () => {},
            onMouseMove: (h: typeof moveHandler) => { moveHandler = h; return () => {}; },
            addOverlayLayer: (id: string, data: unknown) => { overlays.set(id, data); },
            updateOverlayData: (id: string, data: unknown) => { overlays.set(id, data); },
            removeOverlayLayer: (id: string) => { overlays.delete(id); },
            setOrthoPhotoState: (layer: string, v: string) => { photoStates.push({ layer, version: v }); },
        },
        tileset: {
            manifest: new Signal({ layers: { ortho: { minzoom: 14, maxzoom: 20 } } }),
            mapKey: new Signal('site-1'),
            tileVersion: new Signal('20260714T102511864Z'),
            refreshTiles: async (courseId: string) => { refreshes.push(courseId); },
        },
        features: featuresView,
        courseId: 'course-1',
        track: (d: () => void) => { cleanups.push(d); },
    } as unknown as ToolContext;
    svc.activate(ctx);
    await tick();
    await tick();
    return {
        svc, frames, log, engines, saves, views, removedViews, overlays, photoStates, refreshes, featuresView, holdSave,
        get undoCalls() { return undoCalls; },
        move: p => moveHandler!({ lngLat: p }),
        releaseLoad: () => { while (held.length) held.shift()!(); },
    };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const ops = (h: Harness, from = 0) => h.log.slice(from).map(c => c.op);

describe('opening the photo', () => {
    test('activation loads the pixels, shows the cleaned layer and hides the features; deactivation hands the map back', async () => {
        const h = await harness({ patchesGeneratedAt: '2026-10-09T08:00:00.000Z' });
        expect(h.log).toEqual([{ op: 'load', cmd: cleanedPhotoPixelsUrl('course-1') }]);
        expect(h.svc.photo.get()).toBe('ready');
        expect(h.svc.photoExists.get()).toBe(true);
        expect(h.photoStates.at(-1)).toEqual({ layer: 'ortho-sim', version: deriveTileVersion('2026-10-09T08:00:00.000Z') });
        expect(h.featuresView.modeHiddenTypes.get().size).toBeGreaterThan(5);

        h.svc.deactivate();
        expect(h.engines[0].disposed).toBe(true);
        expect(h.photoStates.at(-1)).toEqual({ layer: 'ortho', version: '20260714T102511864Z' });
        expect([...h.featuresView.modeHiddenTypes.get()]).toEqual(['vegetation_zone']);
        expect(h.svc.photo.get()).toBe('none');
    });

    test('before anything was ever cleaned the cleaned layer shows under the pristine version', async () => {
        const h = await harness();
        expect(h.photoStates.at(-1)).toEqual({ layer: 'ortho-sim', version: '20260714T102511864Z' });
    });

    test('a course without a built map says why and takes no stroke', async () => {
        const h = await harness({ bounds: null });
        expect(h.svc.photo.get()).toBe('error');
        expect(h.svc.loadError.get()).toMatch(/has no map/);
        expect(h.engines).toHaveLength(0);
        h.svc.setMode('spot');
        expect(h.svc.beginStroke(C)).toBe(false);
    });

    test('a failed load says why; strokes wait while the photo is still loading', async () => {
        const failed = await harness({ failLoad: 'HTTP 500' });
        expect(failed.svc.photo.get()).toBe('error');
        expect(failed.svc.loadError.get()).toBe('The photo could not be loaded: HTTP 500');
        expect(failed.engines[0].disposed).toBe(true);

        const loading = await harness({ holdLoad: true });
        expect(loading.svc.photo.get()).toBe('loading');
        loading.svc.setMode('spot');
        expect(loading.svc.beginStroke(C)).toBe(false);
        expect(loading.svc.notice.get()).toBe('The photo is still loading.');
        loading.releaseLoad();
        await tick();
        expect(loading.svc.photo.get()).toBe('ready');
        expect(loading.svc.beginStroke(C)).toBe(true);
    });
});

describe('clone stamp and healing brush', () => {
    test('a stroke needs a source; with one it runs PhotoCraft\'s command live in photo pixels', async () => {
        const h = await harness();
        expect(h.svc.beginStroke(C)).toBe(false);
        expect(h.svc.notice.get()).toContain('pick a source');

        h.svc.brushSizeM.set(4);
        h.svc.brushHardness.set(0.6);
        h.svc.brushOpacity.set(0.8);
        h.svc.brushFlow.set(0.5);
        h.svc.pickSource(SOURCE);
        expect(h.svc.hasSource.get()).toBe(true);
        expect(h.overlays.has(CLEAN_SOURCE_OVERLAY_ID)).toBe(true);
        expect(h.svc.beginStroke(C)).toBe(true);
        await tick();

        const begin = h.log[1];
        expect(begin.op).toBe('begin');
        expect(begin.cmd).toBe('paint.cloneStamp');
        expect(begin.params!.size).toBe(16); // 4 m at 0.25 m per pixel
        expect([begin.params!.hardness, begin.params!.opacity, begin.params!.flow, begin.params!.aligned]).toEqual([60, 80, 50, true]);
        expect(begin.params!.points[0][0]).toBeCloseTo(3000, 2);
        expect(begin.params!.points[0][1]).toBeCloseTo(4000, 2);
        expect(begin.params!.source[0]).toBeCloseTo(3200, 2);
        expect(begin.params!.offset).toBeUndefined();
        // The first dab is on the map at once, in the block it falls in.
        const block = `clean-photo-${Math.floor(3000 / CLEAN_BLOCK_PX)}-${Math.floor(4000 / CLEAN_BLOCK_PX)}`;
        expect([...h.views.keys()]).toEqual([block]);
        expect(h.views.get(block)![0].opaque).toBe(true);

        // Moves reach the engine once per frame, in one batch.
        for (let i = 1; i <= 9; i++) h.move(at(3000 + i * 4, 4000));
        expect(ops(h, 2)).toEqual([]);
        h.frames.tick();
        await tick();
        expect(ops(h, 2)).toEqual(['push']);
        expect(h.log[2].points).toHaveLength(9);

        // Points after the last frame go with the release.
        h.move(at(3050, 4010));
        expect(await h.svc.endStroke()).toBe(true);
        expect(ops(h, 3)).toEqual(['push', 'end']);
        expect(h.svc.undoSteps.get()).toBe(1);
    });

    test('the healing brush is the same flow under its own command', async () => {
        const h = await harness();
        h.svc.setMode('heal');
        h.svc.pickSource(SOURCE);
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        expect(h.log[1].cmd).toBe('paint.healingBrush');
        expect(ops(h, 1)).toEqual(['begin', 'end']);
    });

    test('ALIGNED keeps the first stroke\'s offset; NON-aligned starts from the source every time; a new source re-anchors', async () => {
        const h = await harness();
        h.svc.pickSource(SOURCE);
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        h.svc.beginStroke(at(2900, 4100));
        await h.svc.endStroke();
        const second = h.log.filter(c => c.op === 'begin')[1].params!;
        expect(second.source).toBeUndefined();
        expect(second.offset[0]).toBeCloseTo(200, 2);
        expect(second.offset[1]).toBeCloseTo(0, 2);

        h.svc.pickSource(at(2500, 4000));
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        const third = h.log.filter(c => c.op === 'begin')[2].params!;
        expect(third.offset).toBeUndefined();
        expect(third.source[0]).toBeCloseTo(2500, 2);

        h.svc.cloneAligned.set(false);
        h.svc.beginStroke(at(2900, 4100));
        await h.svc.endStroke();
        const fourth = h.log.filter(c => c.op === 'begin')[3].params!;
        expect([fourth.aligned, fourth.offset]).toEqual([false, undefined]);
        expect(fourth.source[0]).toBeCloseTo(2500, 2);
    });

    test('escape cancels the stroke: the preview goes, nothing is saved or counted', async () => {
        const h = await harness();
        h.svc.pickSource(SOURCE);
        h.svc.beginStroke(C);
        await tick();
        expect(h.svc.onEscape()).toBe(true);
        await h.svc.settled();
        expect(ops(h, 1)).toEqual(['begin', 'cancel']);
        const puts = [...h.views.values()][0];
        expect(puts.at(-1)!.opaque).toBe(false);
        expect(await h.svc.endStroke()).toBe(false);
        expect(h.saves).toHaveLength(0);
        expect(h.svc.undoSteps.get()).toBe(0);
        expect(h.svc.onEscape()).toBe(false);
    });

    test('shift-click draws a straight stroke from the last one', async () => {
        const h = await harness();
        h.svc.pickSource(SOURCE);
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        const from = h.log.length;
        expect(await h.svc.strokeLine(C, at(3100, 4050))).toBe(true);
        expect(ops(h, from)).toEqual(['begin', 'push', 'end']);
        expect(h.log[from + 1].points!.length).toBeGreaterThan(30);
        expect(h.svc.undoSteps.get()).toBe(2);
    });

    test('a stroke across block borders paints every block it crosses', async () => {
        const h = await harness();
        h.svc.pickSource(SOURCE);
        h.svc.beginStroke(at(1000, 1000));
        for (let i = 1; i <= 40; i++) h.move(at(1000 + i * 30, 1000 + i * 10));
        await h.svc.endStroke();
        // 1000..2200 px east, 1000..1400 px south: blocks 1..4 x 1..2.
        expect(h.views.size).toBeGreaterThanOrEqual(6);
        for (const puts of h.views.values()) {
            for (const p of puts) {
                expect(p.x >= 0 && p.y >= 0 && p.x + p.w <= CLEAN_BLOCK_PX && p.y + p.h <= CLEAN_BLOCK_PX).toBe(true);
            }
        }
    });
});

describe('spot healing and remove', () => {
    test('the stroke shows as a band, runs on release with every point, and needs no source', async () => {
        for (const [mode, cmd] of [['spot', 'paint.spotHealing'], ['remove', 'paint.remove']] as const) {
            const h = await harness();
            h.svc.setMode(mode);
            h.svc.brushSizeM.set(2);
            expect(h.svc.beginStroke(C)).toBe(true);
            expect(h.overlays.has(CLEAN_STROKE_OVERLAY_ID)).toBe(true);
            expect(h.overlays.has(CLEAN_SOURCE_OVERLAY_ID)).toBe(false);
            for (let i = 1; i <= 5; i++) h.move(at(3000 + i * 3, 4000));
            h.frames.tick();
            expect(ops(h, 1)).toEqual([]);

            const ending = h.svc.endStroke();
            expect(h.svc.working.get()).toBe(true);
            expect(await ending).toBe(true);
            expect(h.svc.working.get()).toBe(false);
            expect(h.overlays.has(CLEAN_STROKE_OVERLAY_ID)).toBe(false);
            const run = h.log[1];
            expect([run.op, run.cmd]).toEqual(['run', cmd]);
            expect(run.params!.points).toHaveLength(6);
            expect(run.params!.size).toBe(8);
            expect(run.params!.source).toBeUndefined();
            expect(h.saves).toHaveLength(1);
        }
    });

    test('a stroke the engine refuses says why and changes nothing', async () => {
        const h = await harness();
        h.svc.setMode('remove');
        h.svc.brushSizeM.set(0.5); // 2 px: the stand-in refuses a lone 2 px dab
        h.svc.beginStroke(C);
        expect(await h.svc.endStroke()).toBe(false);
        expect(h.svc.notice.get()).toContain("doesn't cover anything");
        expect(h.svc.working.get()).toBe(false);
        expect(h.saves).toHaveLength(0);
        expect(h.svc.undoSteps.get()).toBe(0);
    });
});

describe('saving', () => {
    test('every stroke is written to the photo at once; only the first of a session keeps the photo from before', async () => {
        const h = await harness();
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        h.svc.beginStroke(at(3100, 4000));
        await h.svc.endStroke();
        await h.svc.settled();

        expect(h.saves.map(s => [s.courseId, s.snapshot])).toEqual([['course-1', true], ['course-1', false]]);
        const { rect, bytes } = h.saves[0];
        expect(bytes).toBe(rect.w * rect.h * 4);
        expect(rect.x).toBeLessThanOrEqual(3000);
        expect(h.svc.saveState.get()).toBe('saved');
        expect(h.svc.undoDepth.get()).toBe(1);
    });

    test('saves run one at a time, in the order painted', async () => {
        const h = await harness({ holdSaves: true });
        h.svc.setMode('spot');
        for (const x of [3000, 3100, 3200]) {
            h.svc.beginStroke(at(x, 4000));
            await h.svc.endStroke();
        }
        expect(h.svc.saveState.get()).toBe('saving');
        expect(h.holdSave).toHaveLength(1);
        for (let i = 0; i < 3; i++) {
            await tick();
            h.holdSave.shift()!();
            await tick();
        }
        await h.svc.settled();
        expect(h.saves.map(s => Math.round((s.rect.x + s.rect.w / 2) / 100) * 100)).toEqual([3000, 3100, 3200]);
        expect(h.svc.saveState.get()).toBe('saved');
    });

    test('a failed save keeps the pixels and sends them again on retry', async () => {
        let failing = true;
        const h = await harness({ failSaves: () => failing });
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        await h.svc.settled();
        expect(h.svc.saveState.get()).toBe('error');
        expect(h.svc.saveError.get()).toBe('Saving failed: disk full');
        expect(h.saves).toHaveLength(0);

        failing = false;
        h.svc.retrySave();
        await h.svc.settled();
        expect(h.saves.map(s => s.snapshot)).toEqual([true]);
        expect(h.svc.saveState.get()).toBe('saved');
    });

    test('a save still in flight when the tool closes carries on', async () => {
        const h = await harness({ holdSaves: true });
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        await tick();
        h.svc.deactivate();
        h.holdSave.shift()!();
        await tick();
        expect(h.saves).toHaveLength(1);
    });
});

describe('undo and redo of strokes', () => {
    test('Ctrl+Z steps back and Ctrl+Shift+Z forward; the restored pixels are saved like a stroke', async () => {
        const h = await harness();
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        expect([h.svc.undoSteps.get(), h.svc.redoSteps.get()]).toEqual([1, 0]);

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        await h.svc.settled();
        expect(ops(h, 2)).toEqual(['undo']);
        expect([h.svc.undoSteps.get(), h.svc.redoSteps.get()]).toEqual([0, 1]);
        // The block shows the photo again there.
        expect([...h.views.values()][0].at(-1)!.opaque).toBe(false);
        expect(h.saves).toHaveLength(2);
        expect(h.saves[1].rect).toEqual(h.saves[0].rect);

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true }));
        await h.svc.settled();
        expect(ops(h, 3)).toEqual(['redo']);
        expect([h.svc.undoSteps.get(), h.svc.redoSteps.get()]).toEqual([1, 0]);
        expect(h.saves).toHaveLength(3);

        // Nothing more to redo: no engine call.
        await h.svc.redoStroke();
        expect(ops(h, 4)).toEqual([]);
    });

    test('a new stroke drops the redo steps', async () => {
        const h = await harness();
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        await h.svc.undoStroke();
        h.svc.beginStroke(at(3100, 4000));
        await h.svc.endStroke();
        expect([h.svc.undoSteps.get(), h.svc.redoSteps.get()]).toEqual([1, 0]);
    });
});

describe('brush and rings', () => {
    test('[ and ] resize the brush; the white ring follows the pointer and the blue one rides at the aligned offset', async () => {
        const h = await harness();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
        expect(h.svc.brushSizeM.get()).toBeCloseTo(3.75, 5);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }));
        expect(h.svc.brushSizeM.get()).toBeCloseTo(3, 5);

        h.move(C);
        h.frames.tick();
        const ring = h.overlays.get(CLEAN_BRUSH_OVERLAY_ID) as { geometry: { coordinates: number[][][] } };
        const east = lngLatToSweref99tm({ lng: ring.geometry.coordinates[0][0][0], lat: ring.geometry.coordinates[0][0][1] });
        // Radius 1.5 m east of the pointer.
        expect(east.x - (BOUNDS.west + 3000 * RES)).toBeCloseTo(1.5, 2);

        h.svc.pickSource(SOURCE);
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        h.move(at(2000, 2000));
        h.frames.tick();
        const src = h.overlays.get(CLEAN_SOURCE_OVERLAY_ID) as { geometry: { coordinates: number[][][] } };
        const p = lngLatToSweref99tm({ lng: src.geometry.coordinates[0][12][0], lat: src.geometry.coordinates[0][12][1] });
        // A quarter turn round the ring: straight below its centre, 200 px east of the pointer.
        expect((p.x - BOUNDS.west) / RES).toBeCloseTo(2200, 0);

        // The tools without a source show no source ring.
        h.svc.setMode('remove');
        expect(h.overlays.has(CLEAN_SOURCE_OVERLAY_ID)).toBe(false);
        expect(h.overlays.has(CLEAN_BRUSH_OVERLAY_ID)).toBe(true);
    });
});

describe('cleaned versus original', () => {
    test('the toggle takes the changed pixels off the map and puts them back from the engine', async () => {
        const h = await harness();
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        const block = [...h.views.keys()][0];

        h.svc.setShowCleaned(false);
        expect(h.photoStates.at(-1)!.layer).toBe('ortho');
        expect(h.removedViews).toEqual([block]);
        expect(h.views.size).toBe(0);

        const from = h.log.length;
        h.svc.setShowCleaned(true);
        await h.svc.settled();
        expect(h.photoStates.at(-1)!.layer).toBe('ortho-sim');
        expect(ops(h, from)).toEqual(['read']);
        expect(h.log[from].rect).toEqual({ x: 2560, y: 3584, w: 512, h: 512 });
        expect([...h.views.keys()]).toEqual([block]);
    });
});

describe('the photo file changing under the tool', () => {
    test('"Undo last session" waits for the saves, steps the server back and loads the pixels again', async () => {
        const h = await harness();
        h.svc.setMode('spot');
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        await h.svc.settled();
        expect(h.svc.undoDepth.get()).toBe(1);

        expect(await h.svc.undoLast()).toBe(true);
        expect(h.undoCalls).toBe(1);
        expect(h.svc.undoDepth.get()).toBe(0);
        // A fresh engine with the photo as the server now has it; the map refetched its tiles.
        expect(h.engines).toHaveLength(2);
        expect(h.engines[0].disposed).toBe(true);
        expect(h.svc.photo.get()).toBe('ready');
        expect(h.views.size).toBe(0);
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.photoStates.at(-1)!.layer).toBe('ortho-sim');
        expect(h.svc.undoSteps.get()).toBe(0);
        expect(h.svc.phase.get()).toBe('idle');

        // The next stroke starts a new session: its save keeps the photo from before again.
        h.svc.beginStroke(C);
        await h.svc.endStroke();
        await h.svc.settled();
        expect(h.saves.at(-1)!.snapshot).toBe(true);

        // Nothing kept: no call.
        const empty = await harness();
        expect(await empty.svc.undoLast()).toBe(false);
        expect(empty.undoCalls).toBe(0);
    });

    test('an import that changed the photo loads the pixels again; one that changed nothing does not', async () => {
        const h = await harness();
        expect(await h.svc.importPhoto(new File([new Uint8Array(8)], 'edit.png'))).toBe(true);
        expect(h.engines).toHaveLength(2);
        expect(h.svc.photo.get()).toBe('ready');
        expect(h.svc.importSummary.get()).toBeTruthy();

        const same = await harness({ importResult: { changed: false, changedPixels: 0 } });
        expect(await same.svc.importPhoto(new File([new Uint8Array(8)], 'edit.png'))).toBe(true);
        expect(same.engines).toHaveLength(1);

        expect(await same.svc.importPhoto(new File([], 'empty.png'))).toBe(false);
        expect(same.svc.externalMessage.get()).toEqual({ kind: 'error', text: 'The file is empty.' });
    });

    test('Refresh loads the photo and its tiles again', async () => {
        const h = await harness();
        await h.svc.refreshInfo({ resync: true });
        expect(h.engines).toHaveLength(2);
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.svc.photo.get()).toBe('ready');
    });
});

describe('overlay ids', () => {
    test('the ring overlay ids are stable (regression pin)', () => {
        expect(CLEAN_SOURCE_OVERLAY_ID).toBe('clean-stamp-source');
        expect(CLEAN_BRUSH_OVERLAY_ID).toBe('clean-stamp-brush');
    });
});
