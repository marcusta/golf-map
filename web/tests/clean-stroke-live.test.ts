import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { FetchLike } from '../src/sam/sam-client';
import { SamClient } from '../src/sam/sam-client';
import { lngLatToSweref99tm } from '../src/geo/transform';
import type { OrthoPatchesApi } from '../../shared/api/ortho-patches.gen';
import { CleanClient } from '../src/clean/clean-client';
import { CleanToolService, CLEAN_TOOL_ID, type CleanImaging } from '../src/clean/clean-tool.service';
import { IncrementalStampStroke, renderStampStroke, type PxPoint, type StampStrokePx } from '../src/clean/clean-stamp';

// Live clone-stamp stroke: incremental painting must land on the same bytes
// as the one-shot renderer the commit and replay paths use.

function texture(size: number, seed: number): Uint8ClampedArray {
    const px = new Uint8ClampedArray(size * size * 4);
    let s = seed;
    for (let i = 0; i < px.length; i += 4) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const p = i / 4;
        const x = p % size, y = Math.floor(p / size);
        px[i] = (x * 3 + (s & 31)) & 255;
        px[i + 1] = (y * 2 + ((s >> 5) & 31)) & 255;
        px[i + 2] = ((x ^ y) + ((s >> 10) & 15)) & 255;
        px[i + 3] = 255;
    }
    return px;
}

function wiggle(n: number, seed: number, size: number, spill = 0): PxPoint[] {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pts: PxPoint[] = [{ x: size * (0.2 + rnd() * 0.6), y: size * (0.2 + rnd() * 0.6) }];
    for (let i = 1; i < n; i++) {
        const p = pts[i - 1];
        // Mostly short steps, some zero-length repeats, some jumps.
        const step = rnd() < 0.1 ? 0 : rnd() < 0.1 ? 15 : 2 + rnd() * 4;
        const t = rnd() * Math.PI * 2;
        pts.push({
            x: Math.min(size + spill, Math.max(-spill, p.x + Math.cos(t) * step)),
            y: Math.min(size + spill, Math.max(-spill, p.y + Math.sin(t) * step)),
        });
    }
    return pts;
}

describe('IncrementalStampStroke', () => {
    const SIZE = 128;
    const cases: Array<{ name: string; params: Omit<StampStrokePx, 'path'>; seed: number; spill?: number }> = [
        { name: 'tone-match on', params: { offsetPx: { dx: 23.4, dy: -11.6 }, radiusPx: 9.3, opacity: 1, flow: 0.7, hardness: 0.7, toneMatch: true }, seed: 1 },
        { name: 'tone-match off, partial opacity', params: { offsetPx: { dx: -30, dy: 4 }, radiusPx: 6, opacity: 0.6, flow: 0.3, hardness: 0.2, toneMatch: false }, seed: 2 },
        { name: 'hard brush, flow 1', params: { offsetPx: { dx: 12, dy: 40 }, radiusPx: 4.5, opacity: 0.9, flow: 1, hardness: 1, toneMatch: true }, seed: 3 },
        { name: 'path leaving the surface', params: { offsetPx: { dx: 50, dy: 0 }, radiusPx: 12, opacity: 1, flow: 0.5, hardness: 0.5, toneMatch: true }, seed: 4, spill: 30 },
    ];

    for (const c of cases) {
        test(`flushes at any cadence equal the one-shot render byte for byte: ${c.name}`, () => {
            const base = texture(SIZE, c.seed);
            const path = wiggle(120, c.seed * 7, SIZE, c.spill ?? 0);
            for (const cadence of [1, 3, 17, 1000]) {
                const out = base.slice();
                const live = new IncrementalStampStroke(base, out, SIZE, c.params);
                for (let i = 0; i < path.length; i++) {
                    live.add(path[i]);
                    if ((i + 1) % cadence === 0 || i === path.length - 1) {
                        live.flush();
                        const expected = base.slice();
                        renderStampStroke(expected, SIZE, { ...c.params, path: path.slice(0, i + 1) });
                        expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
                    }
                }
            }
        });
    }

    test('a single dab with no movement matches; zero opacity paints nothing', () => {
        const base = texture(SIZE, 9);
        const params = { offsetPx: { dx: 20, dy: 20 }, radiusPx: 8, opacity: 1, flow: 0.7, hardness: 0.7, toneMatch: true };
        const out = base.slice();
        const live = new IncrementalStampStroke(base, out, SIZE, params);
        live.add({ x: 50, y: 50 });
        expect(live.flush()).not.toBeNull();
        const expected = base.slice();
        renderStampStroke(expected, SIZE, { ...params, path: [{ x: 50, y: 50 }] });
        expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);

        const off = base.slice();
        const none = new IncrementalStampStroke(base, off, SIZE, { ...params, opacity: 0 });
        none.add({ x: 50, y: 50 });
        expect(none.flush()).toBeNull();
        expect(Buffer.from(off).equals(Buffer.from(base))).toBe(true);
    });
});

// ─── service: live stroke through the canvas view ───────────────────────────

/** Manual animation-frame clock: frames run only when the test ticks. */
function manualFrames() {
    let next = 1;
    const queue = new Map<number, () => void>();
    return {
        requested: 0,
        request(cb: () => void): number {
            this.requested++;
            const id = next++;
            queue.set(id, cb);
            return id;
        },
        cancel(id: number): void {
            queue.delete(id);
        },
        /** Run every queued callback; returns how many ran. */
        tick(): number {
            const cbs = [...queue.values()];
            queue.clear();
            for (const cb of cbs) cb();
            return cbs.length;
        },
        get pending(): number {
            return queue.size;
        },
    };
}

/** Raw MapLibre stand-in: records source adds/removes and texture uploads. */
function fakeRawMap() {
    const sources = new Map<string, { spec: { type: string }; _playing: boolean; play(): void; pause(): void }>();
    const raw = {
        sources,
        adds: 0, removes: 0, uploads: 0, repaints: 0,
        on: () => {}, off: () => {},
        dragPan: { enable: () => {}, disable: () => {} },
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => (id === 'features-fill' || sources.has(id) ? { id } : undefined),
        addSource: (id: string, spec: { type: string }) => {
            raw.adds++;
            sources.set(id, {
                spec, _playing: false,
                play() { this._playing = true; },
                pause() { if (this._playing) raw.uploads++; this._playing = false; },
            });
        },
        addLayer: () => {},
        removeLayer: () => {},
        removeSource: (id: string) => { raw.removes++; sources.delete(id); },
        triggerRepaint: () => { raw.repaints++; },
    };
    return raw;
}

const C = { lng: 15.5658, lat: 58.4015 };
const SOURCE = { lng: C.lng + 0.0002, lat: C.lat };

interface LiveHarness {
    svc: CleanToolService;
    frames: ReturnType<typeof manualFrames>;
    raw: ReturnType<typeof fakeRawMap>;
    move: (p: { lng: number; lat: number }) => void;
    /** Resolvers for crop composes the test holds back (when `holdCompose`). */
    held: Array<() => void>;
    applied: Array<{ edits: unknown[] }>;
}

async function liveHarness(opts: { holdCompose?: boolean } = {}): Promise<LiveHarness> {
    const held: Array<() => void> = [];
    const imaging: CleanImaging = {
        composeCropPng: async () => 'CROP',
        encodeMaskPng: async () => 'MASK',
        composeCropPixels: async (_tiles, size) => {
            const px = texture(size, 5);
            if (opts.holdCompose) await new Promise<void>(resolve => held.push(resolve));
            return px;
        },
    };
    const fetchFn: FetchLike = async () => new Response(JSON.stringify({ status: 'healthy', inpaint: { available: true } }));
    const applied: LiveHarness['applied'] = [];
    const patchesApi = {
        orthoPatchesInfo: async () => ({ count: 0, lastCreatedAt: null, lastTool: null, bakeable: true, stampBakeable: true, patchesGeneratedAt: null }),
        applyOrthoEdits: async (input: { edits: unknown[] }) => {
            applied.push(input);
            return { count: input.edits.length, patchesGeneratedAt: '2026-10-03T00:00:00.000Z' };
        },
        revertLastOrthoPatch: async () => ({ count: 0, patchesGeneratedAt: '' }),
    } as unknown as OrthoPatchesApi;
    const frames = manualFrames();
    const svc = new CleanToolService(
        new CleanClient('http://sam.test', fetchFn),
        new SamClient('http://sam.test', fetchFn),
        imaging,
        patchesApi,
        () => false,
        { frames },
    );
    const raw = fakeRawMap();
    let moveHandler: ((e: { lngLat: { lng: number; lat: number } }) => void) | null = null;
    const ctx = {
        map: {
            interactionMode: new Signal<string>(CLEAN_TOOL_ID),
            ready: new Signal(true),
            map: new Signal(raw),
            onClick: () => () => {},
            onMouseMove: (h: typeof moveHandler) => { moveHandler = h; return () => {}; },
            addImageOverlay: () => {},
            addOverlayLayer: () => {},
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
            setOrthoPhotoState: () => {},
        },
        tileset: {
            manifest: new Signal({ layers: { ortho: { minzoom: 14, maxzoom: 20 } } }),
            mapKey: new Signal('site-1'),
            tileVersion: new Signal('v1'),
            refreshTiles: async () => {},
        },
        courseId: 'course-1',
        track: (d: () => void) => { cleanups.push(d); },
    } as unknown as ToolContext;
    svc.activate(ctx);
    await new Promise(resolve => setTimeout(resolve, 0));
    svc.mode.set('stamp');
    svc.pickSource(SOURCE);
    return { svc, frames, raw, move: p => moveHandler!({ lngLat: p }), held, applied };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

/** A scribble that stays on the surface (about 120 x 90 px), roughly
 * 3 px per mousemove. */
const dragPoint = (i: number) => ({
    lng: C.lng + 0.00008 * Math.sin(i / 20),
    lat: C.lat + 0.00003 * Math.sin(i / 13),
});

type Internals = {
    surfaces: Array<{ base: Uint8ClampedArray; work: Uint8ClampedArray; plan: { size: number } }>;
    pending: Array<{ kind: string; pathPx: PxPoint[]; offsetPx: { dx: number; dy: number }; radiusPx: number; brush: { opacity: number; flow: number; hardness: number }; toneMatch: boolean }>;
};

describe('live stroke rendering', () => {
    test('bench: N mousemoves paint at most once per frame, one source add, no removes', async () => {
        const h = await liveHarness();
        expect(await h.svc.beginStroke(C)).toBe(true);
        const addsAtBegin = h.raw.adds;
        const uploadsAtBegin = h.raw.uploads;
        expect(addsAtBegin).toBe(1);

        const N = 600;
        const MOVES_PER_FRAME = 3; // a 180 Hz mouse on a 60 Hz display
        let framesRun = 0;
        const t0 = performance.now();
        for (let i = 1; i <= N; i++) {
            h.move(dragPoint(i));
            if (i % MOVES_PER_FRAME === 0) framesRun += h.frames.tick();
        }
        framesRun += h.frames.tick();
        const ms = performance.now() - t0;
        const uploads = h.raw.uploads - uploadsAtBegin;
        console.log(`AFTER  N=${N} ms/move=${(ms / N).toFixed(3)} frames=${framesRun} uploads=${uploads} sourceAdds=${h.raw.adds - addsAtBegin} sourceRemoves=${h.raw.removes} encodes=0`);

        expect(uploads).toBeLessThanOrEqual(framesRun);
        expect(framesRun).toBeLessThanOrEqual(Math.ceil(N / MOVES_PER_FRAME) + 1);
        expect(h.raw.adds).toBe(1);
        expect(h.raw.removes).toBe(0);

        expect(await h.svc.endStroke()).toBe(true);
        expect(h.raw.adds).toBe(1);
        expect(h.raw.removes).toBe(0);
        expect(h.frames.pending).toBe(0);
    });

    test('mouseup flushes the pending frame; the committed surface equals the one-shot render', async () => {
        const h = await liveHarness();
        await h.svc.beginStroke(C);
        const before = (h.svc as unknown as Internals).surfaces[0].base.slice();
        for (let i = 1; i <= 50; i++) h.move(dragPoint(i));
        // No frame ran: endStroke must paint the rest itself.
        expect(await h.svc.endStroke()).toBe(true);
        expect(h.frames.pending).toBe(0);

        const internals = h.svc as unknown as Internals;
        const surface = internals.surfaces[0];
        const edit = internals.pending[0];
        expect(edit.pathPx.length).toBeGreaterThan(10);
        const expected = before.slice();
        renderStampStroke(expected, surface.plan.size, {
            path: edit.pathPx, offsetPx: edit.offsetPx, radiusPx: edit.radiusPx,
            opacity: edit.brush.opacity, flow: edit.brush.flow, hardness: edit.brush.hardness, toneMatch: edit.toneMatch,
        });
        expect(Buffer.from(surface.work).equals(Buffer.from(expected))).toBe(true);
    });

    test('shift-click line: 64 sampled points, one paint, committed like a drag', async () => {
        const h = await liveHarness();
        await h.svc.beginStroke(C);
        await h.svc.endStroke();
        const uploads = h.raw.uploads;
        const to = { lng: C.lng + 0.0001, lat: C.lat + 0.00002 };
        expect(await h.svc.strokeLine(C, to)).toBe(true);
        // begin paints the first dab, endStroke paints the remaining 63.
        expect(h.raw.uploads - uploads).toBe(2);
        expect(h.raw.adds).toBe(1);
        expect(h.svc.pendingCount.get()).toBe(2);
    });

    test('escape restores the pre-stroke surface in place', async () => {
        const h = await liveHarness();
        await h.svc.beginStroke(C);
        await h.svc.endStroke();
        const internals = h.svc as unknown as Internals;
        const committed = internals.surfaces[0].work.slice();
        await h.svc.beginStroke(dragPoint(40));
        for (let i = 41; i <= 60; i++) h.move(dragPoint(i));
        h.frames.tick();
        expect(h.svc.onEscape()).toBe(true);
        expect(h.frames.pending).toBe(0);
        expect(Buffer.from(internals.surfaces[0].work).equals(Buffer.from(committed))).toBe(true);
        expect(h.raw.removes).toBe(0);
        expect(h.svc.pendingCount.get()).toBe(1);
    });
});

describe('stroke token', () => {
    test('a stroke cancelled while its crop composes never comes back', async () => {
        const h = await liveHarness({ holdCompose: true });
        const begin = h.svc.beginStroke(C);
        await Promise.resolve();
        expect(h.svc.onEscape()).toBe(false); // nothing live yet to cancel
        // ESC with an init in flight goes through the mouse path:
        const ending = h.svc.endStroke(); // mouseup awaits the init…
        (h.svc as unknown as { cancelStroke(): void }).cancelStroke(); // …and teardown cancels
        h.held.shift()!();
        expect(await begin).toBe(false);
        expect(await ending).toBe(false);
        // A late mousemove + mouseup find no zombie stroke to extend or queue.
        h.move(dragPoint(5));
        expect(await h.svc.endStroke()).toBe(false);
        expect(h.svc.pendingCount.get()).toBe(0);
        expect(h.frames.pending).toBe(0);
    });

    test('a slower earlier begin cannot overwrite a later stroke', async () => {
        const h = await liveHarness({ holdCompose: true });
        const far = { lng: C.lng - 0.002, lat: C.lat }; // a different crop
        const first = h.svc.beginStroke(far);
        const second = h.svc.beginStroke(C);
        await Promise.resolve();
        expect(h.held).toHaveLength(2);
        h.held[1](); // the later compose lands first…
        expect(await second).toBe(true);
        h.held[0](); // …the earlier one lands last and is dropped.
        expect(await first).toBe(false);
        expect(await h.svc.endStroke()).toBe(true);
        expect(await h.svc.bakeAll()).toBe(true);
        const edits = h.applied[0].edits as Array<{ path: Array<{ x: number; y: number }> }>;
        expect(edits).toHaveLength(1);
        const start = lngLatToSweref99tm(C);
        expect(edits[0].path[0].x).toBeCloseTo(start.x, 6);
        expect(edits[0].path[0].y).toBeCloseTo(start.y, 6);
    });
});
