import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { FetchLike } from '../src/sam/sam-client';
import { SamClient, SAM_CROP_SIZE } from '../src/sam/sam-client';
import { planCrop, cropPixelToSweref } from '../src/sam/sam-crop';
import { lngLatToSweref99tm } from '../src/geo/transform';
import { deriveTileVersion } from '../src/map/tileset.service';
import { CleanClient } from '../src/clean/clean-client';
import { maskArea, planBounds3857 } from '../src/clean/clean-mask';
import {
    CleanToolService,
    CLEAN_TOOL_ID,
    CLEAN_PREVIEW_OVERLAY_ID,
    CLEAN_SOURCE_OVERLAY_ID,
    type CleanImaging,
} from '../src/clean/clean-tool.service';
import type { OrthoPatchesApi } from '../../shared/api/ortho-patches.gen';

// Clean-photo tool — mask modes (T55) + clone stamp + pending queue + batch
// baking into the dual-state sim photo. The pointer/canvas wiring needs a
// live map + sidecar, so these tests drive the mask/stroke state machine and
// the clickAt/finishEllipse/pickSource/beginStroke/accept/bakeAll seams with
// canned sidecar responses, a fake imaging seam (no OffscreenCanvas in
// happy-dom), and a fake patches API (sam-tool.service.test.ts pattern).

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const CLICK = { lng: 15.5658, lat: 58.4015 };
const ZOOM = 20;

/** Ellipse polygon in crop pixels (integer vertices, cv2-contour style). */
function contour(cx: number, cy: number, rx: number, ry: number, n = 90): number[][] {
    return Array.from({ length: n }, (_, i) => {
        const t = (i / n) * 2 * Math.PI;
        return [Math.round(cx + rx * Math.cos(t)), Math.round(cy + ry * Math.sin(t))];
    });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface SidecarOpts {
    inpaintAvailable?: boolean;
    online?: boolean;
    polygons?: number[][][];
    inpaintStatus?: number;
}

type ApplyEditsInput = Parameters<OrthoPatchesApi['applyOrthoEdits']>[0];

interface Harness {
    svc: CleanToolService;
    interactionMode: Signal<string>;
    clickHandlers: Array<(e: { lngLat: { lng: number; lat: number } }) => void>;
    requests: Array<{ url: string; body: unknown }>;
    cropCalls: Array<{ urls: string[]; size: number }>;
    pixelCropCalls: Array<{ urls: string[]; size: number }>;
    maskCalls: Array<{ area: number; size: number; mask: Uint8Array }>;
    applyCalls: ApplyEditsInput[];
    revertCalls: number[];
    /** courseIds passed to the tileset.refreshTiles resync. */
    refreshes: string[];
    /** tile versions pushed to the live map's in-place ortho refresh. */
    orthoRefreshes: string[];
    /** dual-photo-state switches on the live map. */
    photoStates: Array<{ layer: string; version: string }>;
    /** courseIds passed to the full tileset.reload (must stay empty here). */
    reloads: string[];
    imageOverlays: Array<{ id: string; url: string; coords: number[][]; beforeId?: string }>;
    removedOverlays: string[];
    confirms: string[];
    sidecar: SidecarOpts;
    mapReady: Signal<boolean>;
}

async function harness(opts: SidecarOpts & {
    patchCount?: number;
    bakeable?: boolean;
    stampBakeable?: boolean;
    patchesGeneratedAt?: string | null;
    mapReady?: boolean;
    confirmAnswer?: boolean;
    failApply?: boolean;
} = {}): Promise<Harness> {
    const sidecar: SidecarOpts = {
        online: opts.online ?? true,
        inpaintAvailable: opts.inpaintAvailable ?? true,
        polygons: opts.polygons ?? [contour(256, 256, 40, 25)],
        inpaintStatus: opts.inpaintStatus ?? 200,
    };
    const requests: Harness['requests'] = [];
    const fetchFn: FetchLike = async (url, init) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
        if (!sidecar.online) throw new Error('ECONNREFUSED');
        if (url.endsWith('/health')) {
            return json({
                status: 'healthy',
                point_model: 'mock',
                inpaint: sidecar.inpaintAvailable
                    ? { available: true, weights: 'present' }
                    : { available: false, weights: 'missing', detail: 'no LaMa weights' },
            });
        }
        if (url.endsWith('/segment')) return json({ polygons: sidecar.polygons, confidence: 0.9 });
        if (url.endsWith('/inpaint')) {
            if (sidecar.inpaintStatus !== 200) return json({ detail: 'inpaint broke' }, sidecar.inpaintStatus);
            return json({ image: 'RESULTPNG', masked_pixels: 123, elapsed_ms: 5 });
        }
        return json({}, 404);
    };

    const cropCalls: Harness['cropCalls'] = [];
    const pixelCropCalls: Harness['pixelCropCalls'] = [];
    const maskCalls: Harness['maskCalls'] = [];
    const imaging: CleanImaging = {
        composeCropPng: async (tiles, size) => {
            cropCalls.push({ urls: tiles.map(t => t.url), size });
            return 'CROPPNG';
        },
        encodeMaskPng: async (mask, size) => {
            maskCalls.push({ area: maskArea(mask), size, mask });
            return 'MASKPNG';
        },
        composeCropPixels: async (tiles, size) => {
            pixelCropCalls.push({ urls: tiles.map(t => t.url), size });
            const px = new Uint8ClampedArray(size * size * 4);
            px.fill(128);
            return px;
        },
        pixelsToPngDataUrl: async () => 'data:image/png;base64,SURFACE',
    };

    const applyCalls: Harness['applyCalls'] = [];
    const revertCalls: number[] = [];
    let count = opts.patchCount ?? 0;
    const patchesApi: OrthoPatchesApi = {
        applyOrthoEdits: async input => {
            if (opts.failApply) throw new Error('server exploded');
            applyCalls.push(input);
            count += input.edits.length;
            return { count, patchesGeneratedAt: `2026-07-18T12:00:0${count}.000Z` };
        },
        revertLastOrthoPatch: async () => {
            revertCalls.push(count);
            count = Math.max(0, count - 1);
            return { count, patchesGeneratedAt: '2026-07-18T12:59:59.000Z' };
        },
        orthoPatchesInfo: async () => ({
            count, lastCreatedAt: null, lastTool: null,
            bakeable: opts.bakeable ?? true,
            stampBakeable: opts.stampBakeable ?? opts.bakeable ?? true,
            reason: (opts.bakeable ?? true) ? undefined : 'rebuild the map first',
            patchesGeneratedAt: opts.patchesGeneratedAt ?? null,
        }),
    };

    const confirms: string[] = [];
    const svc = new CleanToolService(
        new CleanClient('http://sam.test', fetchFn),
        new SamClient('http://sam.test', fetchFn),
        imaging,
        patchesApi,
        message => {
            confirms.push(message);
            return opts.confirmAnswer ?? true;
        },
    );

    const interactionMode = new Signal<string>(CLEAN_TOOL_ID);
    const clickHandlers: Harness['clickHandlers'] = [];
    const imageOverlays: Harness['imageOverlays'] = [];
    const removedOverlays: string[] = [];
    const refreshes: string[] = [];
    const orthoRefreshes: string[] = [];
    const photoStates: Harness['photoStates'] = [];
    const reloads: string[] = [];
    const mapReady = new Signal(opts.mapReady ?? false);
    const manifest = {
        bounds: { west: 15.5, south: 58.3, east: 15.7, north: 58.5 },
        layers: { ortho: { minzoom: 14, maxzoom: ZOOM }, terrain: { minzoom: 12, maxzoom: 16 } },
        elevation: { min: 0, max: 100 },
        generatedAt: '2026-07-14T10:25:11.864Z',
    };
    const ctx: ToolContext = {
        map: {
            interactionMode,
            ready: mapReady,
            map: new Signal(null),
            onClick: (h: Harness['clickHandlers'][number]) => {
                clickHandlers.push(h);
                return () => {};
            },
            onMouseMove: () => () => {},
            addImageOverlay: (id: string, url: string, coords: number[][], overlayOpts?: { beforeId?: string }) => {
                imageOverlays.push({ id, url, coords, beforeId: overlayOpts?.beforeId });
            },
            addOverlayLayer: () => {},
            updateOverlayData: () => {},
            removeOverlayLayer: (id: string) => {
                removedOverlays.push(id);
            },
            refreshOrthoTiles: (version: string) => {
                orthoRefreshes.push(version);
            },
            setOrthoPhotoState: (layer: string, version: string) => {
                photoStates.push({ layer, version });
            },
        } as never,
        elevation: null as never,
        tileset: {
            manifest: new Signal(manifest),
            mapKey: new Signal('site-1'),
            tileVersion: new Signal('20260714T102511864Z'),
            reload: async (courseId: string) => {
                reloads.push(courseId);
            },
            refreshTiles: async (courseId: string) => {
                refreshes.push(courseId);
            },
        } as never,
        courseDetail: null as never,
        features: null as never,
        courseId: 'course-1',
        track: d => { cleanups.push(d); },
    };
    svc.activate(ctx);
    await tick(); // settle the activation health + info probes
    return {
        svc, interactionMode, clickHandlers, requests, cropCalls, pixelCropCalls, maskCalls,
        applyCalls, revertCalls, refreshes, orthoRefreshes, photoStates, reloads,
        imageOverlays, removedOverlays, confirms, sidecar, mapReady,
    };
}

// ─── health gating ──────────────────────────────────────────────────────────

describe('health gating', () => {
    test('activation probes /health per capability', async () => {
        const h = await harness();
        expect(h.svc.health.get()).toBe('online');
        expect(h.svc.inpaintReady.get()).toBe(true);
    });

    test('offline sidecar: clicks refuse with a notice, no crop is composed', async () => {
        const h = await harness({ online: false });
        expect(h.svc.health.get()).toBe('offline');
        expect(await h.svc.clickAt(CLICK)).toBe(false);
        expect(h.cropCalls).toHaveLength(0);
        expect(h.svc.notice.get()).toContain('offline');
    });

    test('online but inpaint unavailable (no weights): refused with the sidecar detail', async () => {
        const h = await harness({ inpaintAvailable: false });
        expect(h.svc.health.get()).toBe('online');
        expect(h.svc.inpaintReady.get()).toBe(false);
        expect(await h.svc.clickAt(CLICK)).toBe(false);
        expect(h.svc.notice.get()).toContain('no LaMa weights');
        expect(h.cropCalls).toHaveLength(0);
    });

    test('the STAMP mode never needs the sidecar: strokes work while offline', async () => {
        const h = await harness({ online: false });
        h.svc.mode.set('stamp');
        h.svc.pickSource({ lng: CLICK.lng + 0.0002, lat: CLICK.lat });
        expect(await h.svc.beginStroke(CLICK)).toBe(true);
        expect(await h.svc.endStroke()).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(1);
    });

    test('retry flips the gate once the sidecar comes up', async () => {
        const h = await harness({ online: false });
        h.sidecar.online = true;
        await h.svc.checkHealth();
        expect(h.svc.health.get()).toBe('online');
        expect(h.svc.inpaintReady.get()).toBe(true);
    });
});

// ─── click mode (SAM mask) ──────────────────────────────────────────────────

describe('click mode', () => {
    test('click → tile crop → /segment → dilated mask → /inpaint → preview overlay', async () => {
        const h = await harness();
        expect(await h.svc.clickAt(CLICK)).toBe(true);
        expect(h.svc.phase.get()).toBe('preview');

        // Crop composed from SIM-layer tile URLs at maxzoom (cleaning is
        // cumulative on the cleaned photo; the route falls back per-tile).
        expect(h.cropCalls).toHaveLength(1);
        expect(h.cropCalls[0].size).toBe(SAM_CROP_SIZE);
        for (const url of h.cropCalls[0].urls) {
            expect(url).toMatch(/^\/tiles\/site-1\/ortho-sim\/20\/\d+\/\d+\.jpg\?v=20260714T102511864Z$/);
        }

        // /inpaint contract: PNG crop + encoded mask, JSON body pinned.
        const inpaint = h.requests.find(r => r.url.endsWith('/inpaint'))!;
        expect(inpaint.body).toEqual({ image: 'CROPPNG', mask: 'MASKPNG' });

        // The SAM contour (rx 40, ry 25) was filled AND dilated ~0.5 m
        // (≈ 6 px at z20/lat 58): area clearly beyond the raw ellipse.
        const raw = Math.PI * 40 * 25;
        expect(h.maskCalls).toHaveLength(1);
        expect(h.maskCalls[0].area).toBeGreaterThan(raw * 1.15);
        expect(h.maskCalls[0].area).toBeLessThan(raw * 2);

        // Preview overlay: whole-result data URL at the crop's 4 corners.
        expect(h.imageOverlays).toHaveLength(1);
        const overlay = h.imageOverlays[0];
        expect(overlay.id).toBe(CLEAN_PREVIEW_OVERLAY_ID);
        expect(overlay.url).toBe('data:image/png;base64,RESULTPNG');
        // Below the vector feature fills — the preview replaces photo pixels
        // only; water/bunker tints must stay visible across it.
        expect(overlay.beforeId).toBe('features-fill');
        expect(overlay.coords).toHaveLength(4);
        const [tl, tr, br, bl] = overlay.coords;
        expect(tl[0]).toBeLessThan(tr[0]); // west of
        expect(tl[1]).toBeGreaterThan(bl[1]); // north of
        expect(br[0]).toBeCloseTo(tr[0], 12);
        expect(br[1]).toBeCloseTo(bl[1], 12);
    });

    test('the sim crop template uses the sim version once known', async () => {
        const h = await harness({ patchesGeneratedAt: '2026-07-18T09:00:00.000Z' });
        await h.svc.clickAt(CLICK);
        for (const url of h.cropCalls[0].urls) {
            expect(url).toContain(`?v=${deriveTileVersion('2026-07-18T09:00:00.000Z')}`);
        }
    });

    test('SAM finding nothing sets a notice and never calls /inpaint', async () => {
        const h = await harness({ polygons: [] });
        expect(await h.svc.clickAt(CLICK)).toBe(false);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.notice.get()).toContain('no object');
        expect(h.requests.some(r => r.url.endsWith('/inpaint'))).toBe(false);
    });

    test('a failed /inpaint recovers to idle with a notice and re-probes health', async () => {
        const h = await harness({ inpaintStatus: 503 });
        expect(await h.svc.clickAt(CLICK)).toBe(false);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.notice.get()).toContain('failed');
    });

    test('the map click handler gates on the interaction claim and mode', async () => {
        const h = await harness();
        expect(h.clickHandlers).toHaveLength(1);

        h.interactionMode.set('draw');
        h.clickHandlers[0]({ lngLat: CLICK });
        await tick();
        expect(h.cropCalls).toHaveLength(0);

        h.interactionMode.set(CLEAN_TOOL_ID);
        h.svc.mode.set('ellipse'); // clicks are inert in ellipse mode
        h.clickHandlers[0]({ lngLat: CLICK });
        await tick();
        expect(h.cropCalls).toHaveLength(0);

        h.svc.mode.set('click');
        h.clickHandlers[0]({ lngLat: CLICK });
        await tick();
        await tick();
        expect(h.cropCalls).toHaveLength(1);
    });

    test('out-of-domain clicks are rejected before any network work', async () => {
        const h = await harness();
        expect(await h.svc.clickAt({ lng: 15.5658, lat: 553.9 })).toBe(false);
        expect(h.cropCalls).toHaveLength(0);
        expect(h.svc.notice.get()).toContain('outside');
    });
});

// ─── ellipse mode (SAM-free) ────────────────────────────────────────────────

describe('ellipse mode', () => {
    test('a drag builds the mask directly — /segment is never called', async () => {
        const h = await harness();
        h.svc.mode.set('ellipse');
        // ~8 m x ~5 m drag around the click.
        const a = { lng: CLICK.lng - 0.00007, lat: CLICK.lat - 0.000022 };
        const b = { lng: CLICK.lng + 0.00007, lat: CLICK.lat + 0.000022 };
        expect(await h.svc.finishEllipse(a, b)).toBe(true);
        expect(h.svc.phase.get()).toBe('preview');

        expect(h.requests.some(r => r.url.endsWith('/segment'))).toBe(false);
        expect(h.requests.some(r => r.url.endsWith('/inpaint'))).toBe(true);
        expect(h.maskCalls).toHaveLength(1);
        // Mask area ≈ π·rx·ry in crop pixels (mercator meters → px).
        expect(h.maskCalls[0].area).toBeGreaterThan(100);
    });

    test('a micro-drag decays silently (no calls, no notice)', async () => {
        const h = await harness();
        h.svc.mode.set('ellipse');
        const b = { lng: CLICK.lng + 0.0000002, lat: CLICK.lat + 0.0000001 };
        expect(await h.svc.finishEllipse(CLICK, b)).toBe(false);
        expect(h.cropCalls).toHaveLength(0);
        expect(h.svc.notice.get()).toBeNull();
    });
});

// ─── candidate preview → pending queue ──────────────────────────────────────

describe('accept queues (no server call)', () => {
    test('accept moves the candidate into the pending queue with its overlay kept', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        expect(h.svc.phase.get()).toBe('preview');

        expect(h.svc.accept()).toBe(true);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.pendingCount.get()).toBe(1);
        expect(h.svc.patchCount.get()).toBe(0); // nothing baked yet
        expect(h.applyCalls).toHaveLength(0); // NO server call on accept

        // The preview re-anchors under a per-edit id (still below the fills)
        // and the candidate slot frees up.
        const pendingOverlay = h.imageOverlays[h.imageOverlays.length - 1];
        expect(pendingOverlay.id).toMatch(/^clean-pending-/);
        expect(pendingOverlay.url).toBe('data:image/png;base64,RESULTPNG');
        expect(pendingOverlay.beforeId).toBe('features-fill');
        expect(h.removedOverlays).toContain(CLEAN_PREVIEW_OVERLAY_ID);

        // A second candidate can start right away and queue behind it.
        expect(await h.svc.clickAt(CLICK)).toBe(true);
        expect(h.svc.accept()).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(2);
    });

    test('discard drops the candidate and stores nothing', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        h.svc.discard();
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.pendingCount.get()).toBe(0);
        expect(h.removedOverlays).toContain(CLEAN_PREVIEW_OVERLAY_ID);
        expect(h.applyCalls).toHaveLength(0);
        expect(h.refreshes).toHaveLength(0);
    });

    test('a second click while previewing is refused until accept/discard', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        expect(await h.svc.clickAt(CLICK)).toBe(false);
        expect(h.svc.notice.get()).toContain('Accept or discard');
        expect(h.cropCalls).toHaveLength(1);
    });

    test('esc discards the candidate preview first, then prompts for the queue', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        h.svc.accept();
        await h.svc.clickAt(CLICK);
        expect(h.svc.onEscape()).toBe(true); // candidate discarded
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.pendingCount.get()).toBe(1);
        expect(h.svc.onEscape()).toBe(true); // queue prompt (confirm=true → discard all)
        expect(h.confirms).toHaveLength(1);
        expect(h.svc.pendingCount.get()).toBe(0);
        expect(h.svc.onEscape()).toBe(false); // nothing left to consume
    });

    test('discardLastPending removes the newest pending mask edit and its overlay', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        h.svc.accept();
        const overlayId = h.imageOverlays[h.imageOverlays.length - 1].id;
        expect(h.svc.discardLastPending()).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(0);
        expect(h.removedOverlays).toContain(overlayId);
    });
});

// ─── batch bake ─────────────────────────────────────────────────────────────

describe('bakeAll', () => {
    test('sends the whole ordered queue in ONE call with exact frames, then refreshes ONLY the sim photo', async () => {
        const h = await harness({ mapReady: true });
        h.photoStates.length = 0; // drop the activation-time switch
        await h.svc.clickAt(CLICK);
        h.svc.accept();
        h.svc.mode.set('ellipse');
        const a = { lng: CLICK.lng - 0.00005, lat: CLICK.lat - 0.00002 };
        const b = { lng: CLICK.lng + 0.00005, lat: CLICK.lat + 0.00002 };
        await h.svc.finishEllipse(a, b);
        h.svc.accept();
        expect(h.svc.pendingCount.get()).toBe(2);

        expect(await h.svc.bakeAll()).toBe(true);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.pendingCount.get()).toBe(0);
        expect(h.svc.patchCount.get()).toBe(2);

        expect(h.applyCalls).toHaveLength(1);
        const call = h.applyCalls[0];
        expect(call.courseId).toBe('course-1');
        expect(call.edits).toHaveLength(2);
        expect(call.edits.map(e => e.kind)).toEqual(['mask', 'mask']);
        expect(call.edits.map(e => (e as { tool?: string }).tool)).toEqual(['sam', 'ellipse']);

        // The bake payload is the encoded mask — the sidecar's inpainted
        // preview ('RESULTPNG') must never be uploaded (its tile-provenance
        // pixels are what caused the visible patch seam).
        const first = call.edits[0] as { maskPngBase64: string; bounds3857: unknown; boundsSweref: { west: number; east: number; south: number; north: number } };
        expect(first.maskPngBase64).toBe('MASKPNG');
        expect(JSON.stringify(call)).not.toContain('RESULTPNG');

        // bounds3857 must be EXACTLY the planned crop's frame.
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        expect(first.bounds3857).toEqual(planBounds3857(plan));
        const corners = [
            cropPixelToSweref(plan, 0, 0),
            cropPixelToSweref(plan, plan.size, 0),
            cropPixelToSweref(plan, plan.size, plan.size),
            cropPixelToSweref(plan, 0, plan.size),
        ];
        expect(first.boundsSweref.west).toBeCloseTo(Math.min(...corners.map(p => p.x)), 6);
        expect(first.boundsSweref.east).toBeCloseTo(Math.max(...corners.map(p => p.x)), 6);

        // Dual photo state: the SIM source refetches at the response's
        // patchesGeneratedAt; the pristine version is never touched (no
        // refreshOrthoTiles, no full reload), then the manifest resyncs.
        const last = h.photoStates[h.photoStates.length - 1];
        expect(last.layer).toBe('ortho-sim');
        expect(last.version).toBe(deriveTileVersion('2026-07-18T12:00:02.000Z'));
        expect(h.orthoRefreshes).toHaveLength(0);
        expect(h.reloads).toHaveLength(0);
        expect(h.refreshes).toEqual(['course-1']);
    });

    test('a failed bake keeps the whole queue (and previews) for retry', async () => {
        const h = await harness({ failApply: true });
        await h.svc.clickAt(CLICK);
        h.svc.accept();
        expect(await h.svc.bakeAll()).toBe(false);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.pendingCount.get()).toBe(1); // still queued
        expect(h.svc.notice.get()).toContain('server exploded');
        expect(h.refreshes).toHaveLength(0);
    });

    test('bakeAll with an empty queue is a no-op', async () => {
        const h = await harness();
        expect(await h.svc.bakeAll()).toBe(false);
        expect(h.applyCalls).toHaveLength(0);
    });
});

// ─── clone stamp ────────────────────────────────────────────────────────────

describe('stamp mode', () => {
    // ~11 m east of CLICK at this latitude.
    const SOURCE = { lng: CLICK.lng + 0.0002, lat: CLICK.lat };

    async function stampHarness(opts: Parameters<typeof harness>[0] = {}) {
        const h = await harness(opts);
        h.svc.mode.set('stamp');
        return h;
    }

    test('alt-click picks the source (ring overlay); strokes without a source refuse', async () => {
        const h = await stampHarness();
        expect(await h.svc.beginStroke(CLICK)).toBe(false);
        expect(h.svc.notice.get()).toContain('pick a clone source');

        h.svc.pickSource(SOURCE);
        expect(h.svc.hasStampSource.get()).toBe(true);
        expect(h.svc.notice.get()).toBeNull();
        expect(await h.svc.beginStroke(CLICK)).toBe(true);
        expect(await h.svc.endStroke()).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(1);
    });

    test('a stroke composes ONE surface from sim tiles and paints it below the feature fills', async () => {
        const h = await stampHarness();
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        h.svc.extendStroke({ lng: CLICK.lng + 0.00004, lat: CLICK.lat });
        await h.svc.endStroke();

        expect(h.pixelCropCalls).toHaveLength(1);
        expect(h.pixelCropCalls[0].size).toBe(SAM_CROP_SIZE);
        for (const url of h.pixelCropCalls[0].urls) {
            expect(url).toMatch(/^\/tiles\/site-1\/ortho-sim\/20\//);
        }
        const surface = h.imageOverlays.find(o => o.id.startsWith('clean-stamp-'))!;
        expect(surface.url).toBe('data:image/png;base64,SURFACE');
        expect(surface.beforeId).toBe('features-fill');

        // A second stroke in the same area re-uses the surface (one compose).
        await h.svc.beginStroke({ lng: CLICK.lng + 0.00002, lat: CLICK.lat });
        await h.svc.endStroke();
        expect(h.pixelCropCalls).toHaveLength(1);
        expect(h.svc.pendingCount.get()).toBe(2);
    });

    test('ALIGNED: the source offset persists across strokes', async () => {
        const h = await stampHarness();
        h.svc.stampAligned.set(true);
        h.svc.pickSource(SOURCE);
        const d1 = CLICK;
        const d2 = { lng: CLICK.lng - 0.0001, lat: CLICK.lat + 0.00003 };
        await h.svc.beginStroke(d1);
        await h.svc.endStroke();
        await h.svc.beginStroke(d2);
        await h.svc.endStroke();
        await h.svc.bakeAll();

        const edits = h.applyCalls[0].edits as Array<{ kind: string; offsetM: { dx: number; dy: number }; path: Array<{ x: number; y: number }>; aligned: boolean }>;
        expect(edits.map(e => e.kind)).toEqual(['stamp', 'stamp']);
        const s = lngLatToSweref99tm(SOURCE);
        const p1 = lngLatToSweref99tm(d1);
        // Stroke 1 establishes offset = source − firstDest…
        expect(edits[0].offsetM.dx).toBeCloseTo(s.x - p1.x, 6);
        expect(edits[0].offsetM.dy).toBeCloseTo(s.y - p1.y, 6);
        // …and stroke 2 KEEPS that offset (its source follows the brush).
        expect(edits[1].offsetM.dx).toBeCloseTo(edits[0].offsetM.dx, 9);
        expect(edits[1].offsetM.dy).toBeCloseTo(edits[0].offsetM.dy, 9);
        expect(edits[0].aligned).toBe(true);
        // Paths are dest geo coords (EPSG:3006) starting at each stroke's start.
        expect(edits[0].path[0].x).toBeCloseTo(p1.x, 6);
        expect(edits[0].path[0].y).toBeCloseTo(p1.y, 6);
    });

    test('NON-aligned: every stroke restarts from the picked source', async () => {
        const h = await stampHarness();
        h.svc.stampAligned.set(false);
        h.svc.pickSource(SOURCE);
        const d1 = CLICK;
        const d2 = { lng: CLICK.lng - 0.0001, lat: CLICK.lat + 0.00003 };
        await h.svc.beginStroke(d1);
        await h.svc.endStroke();
        await h.svc.beginStroke(d2);
        await h.svc.endStroke();
        await h.svc.bakeAll();

        const edits = h.applyCalls[0].edits as Array<{ offsetM: { dx: number; dy: number }; aligned: boolean }>;
        const s = lngLatToSweref99tm(SOURCE);
        const p1 = lngLatToSweref99tm(d1);
        const p2 = lngLatToSweref99tm(d2);
        expect(edits[0].offsetM.dx).toBeCloseTo(s.x - p1.x, 6);
        expect(edits[1].offsetM.dx).toBeCloseTo(s.x - p2.x, 6);
        expect(edits[1].offsetM.dx).not.toBeCloseTo(edits[0].offsetM.dx, 4);
        expect(edits[0].aligned).toBe(false);
    });

    test('the stamp payload carries brush params, tone-match state, and a radius-padded 3857 frame', async () => {
        const h = await stampHarness();
        h.svc.stampSizeM.set(4);
        h.svc.stampOpacity.set(0.8);
        h.svc.stampFlow.set(0.5);
        h.svc.stampHardness.set(0.6);
        h.svc.stampToneMatch.set(false);
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        h.svc.extendStroke({ lng: CLICK.lng + 0.00008, lat: CLICK.lat });
        await h.svc.endStroke();
        await h.svc.bakeAll();

        const edit = h.applyCalls[0].edits[0] as {
            kind: string;
            brush: { sizeM: number; opacity: number; flow: number; hardness: number };
            toneMatch: boolean;
            path: Array<{ x: number; y: number }>;
            bounds3857: { west: number; east: number; south: number; north: number };
            boundsSweref: { west: number; east: number };
        };
        expect(edit.kind).toBe('stamp');
        expect(edit.brush).toEqual({ sizeM: 4, opacity: 0.8, flow: 0.5, hardness: 0.6 });
        expect(edit.toneMatch).toBe(false);
        expect(edit.path.length).toBeGreaterThan(1);
        // The 3857 frame pads the path bbox by the brush radius (in mercator
        // metres — ground metres / cos(lat)).
        const rMerc = 2 / Math.cos((CLICK.lat * Math.PI) / 180);
        expect(edit.bounds3857.east - edit.bounds3857.west).toBeGreaterThan(2 * rMerc);
        expect(edit.bounds3857.north - edit.bounds3857.south).toBeCloseTo(2 * rMerc, 3);
        // The sweref frame pads by the plain ground radius.
        const sw = lngLatToSweref99tm(CLICK);
        expect(edit.boundsSweref.west).toBeCloseTo(sw.x - 2, 1);
    });

    test('discardLastPending peels the newest stroke; the surface re-renders or disappears', async () => {
        const h = await stampHarness();
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        await h.svc.endStroke();
        await h.svc.beginStroke({ lng: CLICK.lng + 0.00003, lat: CLICK.lat });
        await h.svc.endStroke();
        expect(h.svc.pendingCount.get()).toBe(2);

        expect(h.svc.discardLastPending()).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(1);
        const surfaceId = h.imageOverlays.find(o => o.id.startsWith('clean-stamp-'))!.id;
        expect(h.removedOverlays.filter(id => id === surfaceId).length).toBeGreaterThan(0); // re-render path

        // Dropping the last stroke removes the surface overlay entirely.
        expect(h.svc.discardLastPending()).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(0);
        expect(h.removedOverlays[h.removedOverlays.length - 1]).toBe(surfaceId);
    });

    test('escape cancels a live stroke without queueing it', async () => {
        const h = await stampHarness();
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        expect(h.svc.onEscape()).toBe(true);
        expect(await h.svc.endStroke()).toBe(false);
        expect(h.svc.pendingCount.get()).toBe(0);
    });

    test('shift-click strokes a straight line from the last dab', async () => {
        const h = await stampHarness();
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        await h.svc.endStroke();
        const to = { lng: CLICK.lng + 0.0001, lat: CLICK.lat + 0.00002 };
        expect(await h.svc.strokeLine(CLICK, to)).toBe(true);
        expect(h.svc.pendingCount.get()).toBe(2);
        await h.svc.bakeAll();
        const line = h.applyCalls[0].edits[1] as { path: Array<{ x: number; y: number }> };
        expect(line.path.length).toBeGreaterThan(2); // sampled along the segment
        const first = line.path[0];
        const last = line.path[line.path.length - 1];
        const a = lngLatToSweref99tm(CLICK);
        const b = lngLatToSweref99tm(to);
        expect(first.x).toBeCloseTo(a.x, 4);
        expect(last.x).toBeCloseTo(b.x, 0);
    });

    test('a stamp-only queue bakes even when MASK baking is blocked (no LaMa deps)', async () => {
        const h = await stampHarness({ bakeable: false, stampBakeable: true });
        expect(h.svc.stampBakeable.get()).toBe(true);
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        await h.svc.endStroke();
        expect(await h.svc.bakeAll()).toBe(true);
        expect(h.applyCalls).toHaveLength(1);
    });

    test('a queue WITH masks refuses to bake while mask baking is blocked', async () => {
        const h = await harness({ bakeable: false, stampBakeable: true });
        await h.svc.clickAt(CLICK);
        h.svc.accept();
        expect(await h.svc.bakeAll()).toBe(false);
        expect(h.applyCalls).toHaveLength(0);
        expect(h.svc.pendingCount.get()).toBe(1);
        expect(h.svc.notice.get()).toContain('rebuild the map');
    });

    test('pickSource resets the aligned offset (a new source re-anchors)', async () => {
        const h = await stampHarness();
        h.svc.stampAligned.set(true);
        h.svc.pickSource(SOURCE);
        await h.svc.beginStroke(CLICK);
        await h.svc.endStroke();
        const source2 = { lng: CLICK.lng - 0.0003, lat: CLICK.lat };
        h.svc.pickSource(source2);
        await h.svc.beginStroke(CLICK);
        await h.svc.endStroke();
        await h.svc.bakeAll();
        const edits = h.applyCalls[0].edits as Array<{ offsetM: { dx: number } }>;
        const s2 = lngLatToSweref99tm(source2);
        const p = lngLatToSweref99tm(CLICK);
        expect(edits[1].offsetM.dx).toBeCloseTo(s2.x - p.x, 6);
        expect(edits[1].offsetM.dx).not.toBeCloseTo(edits[0].offsetM.dx, 4);
    });
});

// ─── dual photo state ───────────────────────────────────────────────────────

describe('photo state (sim vs pristine)', () => {
    test('activation switches the ready map to the sim layer; toggle flips back; deactivate restores pristine', async () => {
        const h = await harness({ mapReady: true, patchesGeneratedAt: '2026-07-18T09:00:00.000Z' });
        // Activation (map ready) pointed the flat source at ortho-sim.
        expect(h.photoStates.length).toBeGreaterThan(0);
        expect(h.photoStates[h.photoStates.length - 1]).toEqual({
            layer: 'ortho-sim',
            version: deriveTileVersion('2026-07-18T09:00:00.000Z'),
        });

        h.svc.setShowCleaned(false);
        expect(h.photoStates[h.photoStates.length - 1]).toEqual({
            layer: 'ortho',
            version: '20260714T102511864Z',
        });
        h.svc.setShowCleaned(true);
        expect(h.photoStates[h.photoStates.length - 1].layer).toBe('ortho-sim');

        h.svc.deactivate();
        expect(h.photoStates[h.photoStates.length - 1]).toEqual({
            layer: 'ortho',
            version: '20260714T102511864Z',
        });
    });

    test('before any bake the sim ?v= falls back to the pristine version', async () => {
        const h = await harness({ mapReady: true, patchesGeneratedAt: null });
        const first = h.photoStates.find(p => p.layer === 'ortho-sim')!;
        expect(first.version).toBe('20260714T102511864Z');
    });

    test('deactivate with pending edits prompts: confirm bakes, cancel discards', async () => {
        const h = await harness({ confirmAnswer: false });
        await h.svc.clickAt(CLICK);
        h.svc.accept();
        h.svc.deactivate();
        expect(h.confirms).toHaveLength(1);
        expect(h.confirms[0]).toContain('pending');
        expect(h.applyCalls).toHaveLength(0); // declined → discarded
        expect(h.svc.pendingCount.get()).toBe(0);

        const h2 = await harness({ confirmAnswer: true });
        await h2.svc.clickAt(CLICK);
        h2.svc.accept();
        h2.svc.deactivate();
        await tick();
        expect(h2.applyCalls).toHaveLength(1); // confirmed → baked
    });
});

// ─── revert ─────────────────────────────────────────────────────────────────

describe('revert last patch', () => {
    test('reverts, updates the count, and refreshes the sim photo only', async () => {
        const h = await harness({ patchCount: 2, mapReady: true });
        h.photoStates.length = 0;
        expect(h.svc.patchCount.get()).toBe(2);
        expect(await h.svc.revertLast()).toBe(true);
        expect(h.revertCalls).toEqual([2]);
        expect(h.svc.patchCount.get()).toBe(1);
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.reloads).toHaveLength(0);
        expect(h.orthoRefreshes).toHaveLength(0); // pristine version untouched
        expect(h.photoStates[h.photoStates.length - 1].layer).toBe('ortho-sim');
        expect(h.svc.phase.get()).toBe('idle');
    });

    test('no-op with zero patches or while not idle', async () => {
        const h = await harness();
        expect(await h.svc.revertLast()).toBe(false);
        await h.svc.clickAt(CLICK); // → preview
        expect(await h.svc.revertLast()).toBe(false);
        expect(h.revertCalls).toHaveLength(0);
    });
});

// ─── /inpaint + /health client contracts (canned fetch) ────────────────────

describe('CleanClient contract', () => {
    test('inpaint POSTs {image, mask} and returns the result image', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const client = new CleanClient('http://sam.test', async (url, init) => {
            calls.push({ url, init });
            return json({ image: 'OUT', masked_pixels: 9, elapsed_ms: 1 });
        });
        expect(await client.inpaint('IMG', 'MSK')).toBe('OUT');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://sam.test/inpaint');
        expect(calls[0].init?.method).toBe('POST');
        expect(JSON.parse(calls[0].init?.body as string)).toEqual({ image: 'IMG', mask: 'MSK' });
    });

    test('inpaint surfaces the sidecar detail on HTTP errors and rejects empty results', async () => {
        const failing = new CleanClient('http://sam.test', async () => json({ detail: 'no weights' }, 503));
        await expect(failing.inpaint('I', 'M')).rejects.toThrow(/503.*no weights/);
        const empty = new CleanClient('http://sam.test', async () => json({}));
        await expect(empty.inpaint('I', 'M')).rejects.toThrow(/no image/);
    });

    test('health parses per-capability readiness and degrades on garbage', async () => {
        const ok = new CleanClient('http://sam.test', async () =>
            json({ status: 'healthy', inpaint: { available: false, detail: 'torch missing' } }));
        expect(await ok.health()).toEqual({ online: true, inpaintAvailable: false, detail: 'torch missing' });

        const legacy = new CleanClient('http://sam.test', async () =>
            json({ status: 'healthy', point_model: 'mock' })); // pre-T55 sidecar: no inpaint field
        expect((await legacy.health()).inpaintAvailable).toBe(false);

        const dead = new CleanClient('http://sam.test', async () => { throw new Error('down'); });
        expect((await dead.health()).online).toBe(false);
    });

    test('the source ring overlay id is stable (regression pin)', () => {
        expect(CLEAN_SOURCE_OVERLAY_ID).toBe('clean-stamp-source');
    });
});
