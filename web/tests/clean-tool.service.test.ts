import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { FetchLike } from '../src/sam/sam-client';
import { SamClient, SAM_CROP_SIZE } from '../src/sam/sam-client';
import { planCrop, cropPixelToSweref } from '../src/sam/sam-crop';
import { CleanClient } from '../src/clean/clean-client';
import { maskArea, planBounds3857 } from '../src/clean/clean-mask';
import {
    CleanToolService,
    CLEAN_TOOL_ID,
    CLEAN_PREVIEW_OVERLAY_ID,
    type CleanImaging,
} from '../src/clean/clean-tool.service';
import type { OrthoPatchesApi } from '../../shared/api/ortho-patches.gen';

// T55 — Clean-photo tool. The pointer/canvas wiring needs a live map +
// sidecar, so these tests drive the mask-mode state machine and the
// clickAt/finishEllipse/accept/discard/revert seams with canned sidecar
// responses, a fake imaging seam (no OffscreenCanvas in happy-dom), and a
// fake patches API (sam-tool.service.test.ts pattern).

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

interface Harness {
    svc: CleanToolService;
    interactionMode: Signal<string>;
    clickHandlers: Array<(e: { lngLat: { lng: number; lat: number } }) => void>;
    requests: Array<{ url: string; body: unknown }>;
    cropCalls: Array<{ urls: string[]; size: number }>;
    maskCalls: Array<{ area: number; size: number; mask: Uint8Array }>;
    applyCalls: Array<Parameters<OrthoPatchesApi['applyOrthoPatch']>[0]>;
    revertCalls: number[];
    reloads: string[];
    imageOverlays: Array<{ id: string; url: string; coords: number[][] }>;
    removedOverlays: string[];
    sidecar: SidecarOpts;
}

async function harness(opts: SidecarOpts & { patchCount?: number; bakeable?: boolean } = {}): Promise<Harness> {
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
    };

    const applyCalls: Harness['applyCalls'] = [];
    const revertCalls: number[] = [];
    let count = opts.patchCount ?? 0;
    const patchesApi: OrthoPatchesApi = {
        applyOrthoPatch: async input => {
            applyCalls.push(input);
            count += 1;
            return { count, generatedAt: `2026-07-18T12:00:0${count}.000Z` };
        },
        revertLastOrthoPatch: async () => {
            revertCalls.push(count);
            count = Math.max(0, count - 1);
            return { count, generatedAt: '2026-07-18T12:59:59.000Z' };
        },
        orthoPatchesInfo: async () => ({
            count, lastCreatedAt: null, lastTool: null,
            bakeable: opts.bakeable ?? true,
            reason: (opts.bakeable ?? true) ? undefined : 'rebuild the map first',
        }),
    };

    const svc = new CleanToolService(
        new CleanClient('http://sam.test', fetchFn),
        new SamClient('http://sam.test', fetchFn),
        imaging,
        patchesApi,
    );

    const interactionMode = new Signal<string>(CLEAN_TOOL_ID);
    const clickHandlers: Harness['clickHandlers'] = [];
    const imageOverlays: Harness['imageOverlays'] = [];
    const removedOverlays: string[] = [];
    const reloads: string[] = [];
    const manifest = {
        bounds: { west: 15.5, south: 58.3, east: 15.7, north: 58.5 },
        layers: { ortho: { minzoom: 14, maxzoom: ZOOM }, terrain: { minzoom: 12, maxzoom: 16 } },
        elevation: { min: 0, max: 100 },
        generatedAt: '2026-07-14T10:25:11.864Z',
    };
    const ctx: ToolContext = {
        map: {
            interactionMode,
            ready: new Signal(false),
            map: new Signal(null),
            onClick: (h: Harness['clickHandlers'][number]) => {
                clickHandlers.push(h);
                return () => {};
            },
            onMouseMove: () => () => {},
            addImageOverlay: (id: string, url: string, coords: number[][]) => {
                imageOverlays.push({ id, url, coords });
            },
            addOverlayLayer: () => {},
            updateOverlayData: () => {},
            removeOverlayLayer: (id: string) => {
                removedOverlays.push(id);
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
        } as never,
        courseDetail: null as never,
        features: null as never,
        courseId: 'course-1',
        track: d => { cleanups.push(d); },
    };
    svc.activate(ctx);
    await tick(); // settle the activation health + info probes
    return {
        svc, interactionMode, clickHandlers, requests, cropCalls, maskCalls,
        applyCalls, revertCalls, reloads, imageOverlays, removedOverlays, sidecar,
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

        // Crop composed from direct ortho tile URLs at maxzoom.
        expect(h.cropCalls).toHaveLength(1);
        expect(h.cropCalls[0].size).toBe(SAM_CROP_SIZE);
        for (const url of h.cropCalls[0].urls) {
            expect(url).toMatch(/^\/tiles\/site-1\/ortho\/20\/\d+\/\d+\.jpg\?v=20260714T102511864Z$/);
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
        expect(overlay.coords).toHaveLength(4);
        const [tl, tr, br, bl] = overlay.coords;
        expect(tl[0]).toBeLessThan(tr[0]); // west of
        expect(tl[1]).toBeGreaterThan(bl[1]); // north of
        expect(br[0]).toBeCloseTo(tr[0], 12);
        expect(br[1]).toBeCloseTo(bl[1], 12);
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

// ─── preview → accept / discard ─────────────────────────────────────────────

describe('preview accept/discard', () => {
    test('accept sends the MASK png (never fill pixels) with the crop\'s exact 3857 frame, then reloads tiles', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        expect(h.svc.phase.get()).toBe('preview');

        expect(await h.svc.accept()).toBe(true);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.patchCount.get()).toBe(1);

        expect(h.applyCalls).toHaveLength(1);
        const call = h.applyCalls[0];
        expect(call.courseId).toBe('course-1');
        // The bake payload is the encoded mask — the sidecar's inpainted
        // preview ('RESULTPNG') must never be uploaded (its tile-provenance
        // pixels are what caused the visible patch seam).
        expect(call.maskPngBase64).toBe('MASKPNG');
        expect(JSON.stringify(call)).not.toContain('RESULTPNG');
        expect(call.tool).toBe('sam');

        // bounds3857 must be EXACTLY the planned crop's frame.
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        expect(call.bounds3857).toEqual(planBounds3857(plan));

        // boundsSweref is the EPSG:3006 bbox of the crop corners.
        const corners = [
            cropPixelToSweref(plan, 0, 0),
            cropPixelToSweref(plan, plan.size, 0),
            cropPixelToSweref(plan, plan.size, plan.size),
            cropPixelToSweref(plan, 0, plan.size),
        ];
        expect(call.boundsSweref.west).toBeCloseTo(Math.min(...corners.map(p => p.x)), 6);
        expect(call.boundsSweref.east).toBeCloseTo(Math.max(...corners.map(p => p.x)), 6);
        expect(call.boundsSweref.south).toBeCloseTo(Math.min(...corners.map(p => p.y)), 6);
        expect(call.boundsSweref.north).toBeCloseTo(Math.max(...corners.map(p => p.y)), 6);
        expect(call.boundsSweref.west).toBeLessThan(call.boundsSweref.east);

        // Overlay removed; tiles reloaded so the new ?v= takes effect.
        expect(h.removedOverlays).toContain(CLEAN_PREVIEW_OVERLAY_ID);
        expect(h.reloads).toEqual(['course-1']);
    });

    test('an ellipse-mode accept is logged with tool "ellipse"', async () => {
        const h = await harness();
        h.svc.mode.set('ellipse');
        const a = { lng: CLICK.lng - 0.00005, lat: CLICK.lat - 0.00002 };
        const b = { lng: CLICK.lng + 0.00005, lat: CLICK.lat + 0.00002 };
        await h.svc.finishEllipse(a, b);
        await h.svc.accept();
        expect(h.applyCalls[0].tool).toBe('ellipse');
    });

    test('discard drops the overlay and stores nothing', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        h.svc.discard();
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.removedOverlays).toContain(CLEAN_PREVIEW_OVERLAY_ID);
        expect(h.applyCalls).toHaveLength(0);
        expect(h.reloads).toHaveLength(0);
    });

    test('a second click while previewing is refused until accept/discard', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        expect(await h.svc.clickAt(CLICK)).toBe(false);
        expect(h.svc.notice.get()).toContain('Accept or discard');
        expect(h.cropCalls).toHaveLength(1);
    });

    test('esc discards the preview', async () => {
        const h = await harness();
        await h.svc.clickAt(CLICK);
        expect(h.svc.onEscape()).toBe(true);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.onEscape()).toBe(false); // nothing left to consume
    });
});

test('a failed bake keeps the preview and reports the error', async () => {
    const h = await harness();
    await h.svc.clickAt(CLICK);
    // Swap the injected patches API for a throwing one mid-test.
    const svcAny = h.svc as unknown as { patchesApi: OrthoPatchesApi };
    svcAny.patchesApi = {
        applyOrthoPatch: async () => { throw new Error('server exploded'); },
        revertLastOrthoPatch: async () => ({ count: 0, generatedAt: '' }),
        orthoPatchesInfo: async () => ({ count: 0, lastCreatedAt: null, lastTool: null, bakeable: true }),
    };
    expect(await h.svc.accept()).toBe(false);
    expect(h.svc.phase.get()).toBe('preview'); // still previewable
    expect(h.svc.notice.get()).toContain('server exploded');
    expect(h.reloads).toHaveLength(0);
});

// ─── bake pre-flight (legacy courses) ───────────────────────────────────────

describe('bake pre-flight', () => {
    test('bakeable course: info flips the gate on, accept is allowed', async () => {
        const h = await harness();
        expect(h.svc.bakeable.get()).toBe(true);
        expect(h.svc.bakeReason.get()).toBeNull();
    });

    test('non-bakeable course: preview still works, but accept refuses without touching the server', async () => {
        const h = await harness({ bakeable: false });
        // info() on activation surfaced the reason up front.
        expect(h.svc.bakeable.get()).toBe(false);
        expect(h.svc.bakeReason.get()).toContain('rebuild the map');

        // Previewing is genuinely useful — the click pipeline still runs.
        expect(await h.svc.clickAt(CLICK)).toBe(true);
        expect(h.svc.phase.get()).toBe('preview');

        // But baking is blocked before any patch is sent; preview is kept.
        expect(await h.svc.accept()).toBe(false);
        expect(h.applyCalls).toHaveLength(0);
        expect(h.svc.phase.get()).toBe('preview');
        expect(h.svc.notice.get()).toContain('rebuilt');
        expect(h.reloads).toHaveLength(0);
    });
});

// ─── revert ─────────────────────────────────────────────────────────────────

describe('revert last patch', () => {
    test('reverts, updates the count, and reloads tiles', async () => {
        const h = await harness({ patchCount: 2 });
        expect(h.svc.patchCount.get()).toBe(2);
        expect(await h.svc.revertLast()).toBe(true);
        expect(h.revertCalls).toEqual([2]);
        expect(h.svc.patchCount.get()).toBe(1);
        expect(h.reloads).toEqual(['course-1']);
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
});
