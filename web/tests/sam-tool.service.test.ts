import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { FeaturesService } from '../src/draw/features.service';
import { EditHistory } from '../src/draw/history';
import { rdpSimplifyClosed } from '../src/draw/draw-state';
import { flattenRing, signedArea, type Point } from '../src/geo/bezier';
import { fitClosedBspline } from '../src/geo/spline-fit';
import { fractionalTile } from '../src/geo/webmercator-tiles';
import { sweref99tmToWgs84 } from '../src/geo/transform';
import { SamClient, SAM_CROP_SIZE, type FetchLike } from '../src/sam/sam-client';
import {
    planCrop,
    cropPixelToSweref,
    cropPolygonToSweref,
    fillTileUrl,
} from '../src/sam/sam-crop';
import {
    SamToolService,
    SAM_TOOL_ID,
    SAM_SIMPLIFY_EPS_M,
    SAM_FIT_TOLERANCE_M,
    SAM_MAX_CONTROLS,
    SAM_CURVATURE_SHARE,
    SAM_METERS_PER_CONTROL,
    samMinControls,
    ringPerimeter,
    SAM_SCOPE_COURSE,
    type SamCropSource,
} from '../src/sam/sam-tool.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// T45 — SAM click-to-feature assist. The pointer/canvas wiring needs a live
// map + sidecar, so these tests drive the pure crop/georef math and the
// service's `segmentAt` seam with a canned sidecar (draw-trace.test.ts
// pattern: real FeaturesService over a create-echoing fake API).

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// Landeryd-ish click + a plausible ortho maxzoom.
const CLICK = { lng: 15.5658, lat: 58.4015 };
const ZOOM = 19;

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeApi() {
    let n = 0;
    const reject = () => Promise.reject(new Error('not under test'));
    const api: CourseFeaturesApi = {
        listByCourse: async () => [],
        listByHole: reject,
        geojsonByCourse: reject,
        create: async input => {
            n += 1;
            return { id: `f${n}`, version: 1, geojson: null, ...input } as CourseFeature;
        },
        update: reject,
        remove: async () => ({}) as never,
        reorder: reject,
    };
    return api;
}

interface Harness {
    svc: SamToolService;
    features: FeaturesService;
    history: EditHistory;
    interactionMode: Signal<string>;
    clickHandlers: Array<(e: { lngLat: { lng: number; lat: number } }) => void>;
    cropCalls: Array<{ urls: string[]; size: number }>;
    drawHoleId: Signal<string | null>;
    setSidecar(handler: (url: string) => Response | Promise<Response>): void;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Ellipse polygon in crop pixels (integer vertices, cv2-contour style). */
function ellipseMask(cx: number, cy: number, rx: number, ry: number, n = 90): number[][] {
    return Array.from({ length: n }, (_, i) => {
        const t = (i / n) * 2 * Math.PI;
        return [Math.round(cx + rx * Math.cos(t)), Math.round(cy + ry * Math.sin(t))];
    });
}

async function harness(sidecar?: (url: string) => Response | Promise<Response>): Promise<Harness> {
    let handler = sidecar ?? ((url: string) =>
        url.endsWith('/health') ? json({ status: 'healthy', point_model: 'mock' }) : json({ polygons: [], confidence: 0 }));
    const fetchFn: FetchLike = async url => handler(url);
    const cropCalls: Array<{ urls: string[]; size: number }> = [];
    const cropSource: SamCropSource = async (tiles, size) => {
        cropCalls.push({ urls: tiles.map(t => t.url), size });
        return 'FAKEJPEGBASE64';
    };
    const history = new EditHistory();
    const drawHoleId = new Signal<string | null>(null);
    const svc = new SamToolService(
        new SamClient('http://sam.test', fetchFn), cropSource, () => history, () => drawHoleId.peek());

    const features = new FeaturesService(fakeApi());
    await features.load('course-1');

    const interactionMode = new Signal<string>(SAM_TOOL_ID);
    const clickHandlers: Harness['clickHandlers'] = [];
    const manifest = {
        bounds: { west: 15.5, south: 58.3, east: 15.7, north: 58.5 },
        layers: { ortho: { minzoom: 12, maxzoom: ZOOM }, terrain: { minzoom: 12, maxzoom: 16 } },
        elevation: { min: 0, max: 100 },
        generatedAt: '2026-07-04T08:28:59Z',
    };
    const ctx: ToolContext = {
        map: {
            interactionMode,
            onClick: (h: Harness['clickHandlers'][number]) => {
                clickHandlers.push(h);
                return () => {};
            },
        } as never,
        elevation: null as never,
        tileset: {
            manifest: new Signal(manifest),
            mapKey: new Signal('site-1'),
            tileVersion: new Signal('20260704T082859Z'),
        } as never,
        courseDetail: null as never,
        features,
        courseId: 'course-1',
        track: d => { cleanups.push(d); },
    };
    svc.activate(ctx);
    await tick(); // settle the activation health probe
    return { svc, features, history, interactionMode, clickHandlers, cropCalls, drawHoleId, setSidecar: h => { handler = h; } };
}

/** Sidecar that answers healthy and returns the given polygons. */
const sidecarWith = (polygons: number[][][]) => (url: string) =>
    url.endsWith('/health')
        ? json({ status: 'healthy', point_model: 'mock' })
        : json({ polygons, confidence: 0.9 });

// ─── planCrop / georeferencing (pure) ───────────────────────────────────────

describe('planCrop', () => {
    test('centers a 512 px crop on the click (within the 1 px snap)', () => {
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        expect(plan.size).toBe(SAM_CROP_SIZE);
        const f = fractionalTile(CLICK.lng, CLICK.lat, ZOOM);
        expect(Math.abs(f.x * 256 - plan.originX - 256)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(f.y * 256 - plan.originY - 256)).toBeLessThanOrEqual(0.5);
        expect(Number.isInteger(plan.originX)).toBe(true);
        expect(Number.isInteger(plan.originY)).toBe(true);
    });

    test('tiles exactly cover the crop at integer offsets', () => {
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        // Every crop pixel must be covered by exactly one tile placement.
        for (const [px, py] of [[0, 0], [511, 0], [0, 511], [511, 511], [256, 256]] as const) {
            const covering = plan.tiles.filter(t =>
                px >= t.dx && px < t.dx + 256 && py >= t.dy && py < t.dy + 256);
            expect(covering).toHaveLength(1);
            const t = covering[0];
            // The placement really is that tile's slippy address.
            expect(t.dx).toBe(t.x * 256 - plan.originX);
            expect(t.dy).toBe(t.y * 256 - plan.originY);
        }
        expect([4, 6, 9]).toContain(plan.tiles.length);
    });

    test('out-of-domain latitude (the iOS crash value) yields null, not NaN addresses', () => {
        expect(planCrop(15.5658, 553.9, ZOOM)).toBeNull();
        expect(planCrop(0, 90, ZOOM)).toBeNull();
    });
});

describe('crop pixel → EPSG:3006', () => {
    test('round trips through the independent forward path to < 0.01 px', () => {
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        for (const [px, py] of [[0.5, 0.5], [256, 256], [100.5, 400.5], [511.5, 3.5]] as const) {
            const p = cropPixelToSweref(plan, px, py);
            const g = sweref99tmToWgs84(p.x, p.y);
            const f = fractionalTile(g.lon, g.lat, ZOOM);
            // The tile math is exact; the residual (≈ 0.004 px ≈ 0.6 mm) is
            // the SWEREF↔WGS84 truncated-series round-trip error.
            expect(Math.abs(f.x * 256 - plan.originX - px)).toBeLessThan(0.01);
            expect(Math.abs(f.y * 256 - plan.originY - py)).toBeLessThan(0.01);
        }
    });

    test('cropPolygonToSweref addresses pixel centers (+0.5)', () => {
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        const viaPolygon = cropPolygonToSweref(plan, [[100, 200]])[0];
        const viaPixel = cropPixelToSweref(plan, 100.5, 200.5);
        expect(viaPolygon.x).toBe(viaPixel.x);
        expect(viaPolygon.y).toBe(viaPixel.y);
    });
});

test('fillTileUrl substitutes the XYZ placeholders', () => {
    expect(fillTileUrl('/tiles/site-1/ortho/{z}/{x}/{y}.jpg?v=V', 19, 285000, 156000))
        .toBe('/tiles/site-1/ortho/19/285000/156000.jpg?v=V');
});

describe('samMinControls', () => {
    test('one control per SAM_METERS_PER_CONTROL of perimeter, clamped to the cap', () => {
        expect(samMinControls(10 * SAM_METERS_PER_CONTROL)).toBe(10);
        expect(samMinControls(1e6)).toBe(SAM_MAX_CONTROLS);
        expect(samMinControls(0)).toBe(0); // the fitter's own 8 floor applies
    });
    test('ringPerimeter closes the ring', () => {
        expect(ringPerimeter([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }])).toBeCloseTo(12, 9);
    });
});

// ─── contour → simplify → fit round trip (synthetic ellipse mask) ───────────

describe('mask contour → simplify → fit', () => {
    test('a synthetic ellipse mask survives the pipeline with area and deviation bounds', () => {
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        const mask = ellipseMask(256, 256, 150, 90);
        const ring = cropPolygonToSweref(plan, mask);

        const simplified = rdpSimplifyClosed(ring, SAM_SIMPLIFY_EPS_M);
        expect(simplified.length).toBeGreaterThanOrEqual(3);
        expect(simplified.length).toBeLessThan(mask.length);

        const minControls = samMinControls(ringPerimeter(simplified));
        const fit = fitClosedBspline(simplified, SAM_FIT_TOLERANCE_M, SAM_MAX_CONTROLS, {
            minControls,
            curvatureShare: SAM_CURVATURE_SHARE,
        });
        expect(fit.controls.length).toBeGreaterThanOrEqual(minControls);
        expect(fit.controls.length).toBeLessThanOrEqual(SAM_MAX_CONTROLS);
        // Pixel quantization (±0.5 px ≈ ±8 cm here) + RDP at 0.2 m + fit
        // tolerance: the fitted curve stays within tolerance of ITS input…
        expect(fit.maxDeviation).toBeLessThanOrEqual(SAM_FIT_TOLERANCE_M);

        // …and the fitted AREA matches the projected mask's area within 3%.
        const flat = flattenRing({ points: fit.controls }, 0.05, 'bspline');
        const fitArea = Math.abs(signedArea(flat));
        const maskArea = Math.abs(signedArea(ring.map(p => [p.x, p.y] as [number, number])));
        expect(maskArea).toBeGreaterThan(100); // sanity: a real, meters-scale shape
        expect(Math.abs(fitArea - maskArea) / maskArea).toBeLessThan(0.03);

        // The fitted curve sits ON the mask contour, not just near it: every
        // control-window midpoint stays within tolerance of the input ring.
        const worst = Math.max(...simplified.map((p: Point) => {
            let best = Infinity;
            for (let i = 0; i < flat.length; i++) {
                const d = Math.hypot(p.x - flat[i][0], p.y - flat[i][1]);
                if (d < best) best = d;
            }
            return best;
        }));
        expect(worst).toBeLessThanOrEqual(SAM_FIT_TOLERANCE_M + 0.05);
    });
});

// ─── health gate ────────────────────────────────────────────────────────────

describe('health gate', () => {
    test('activation probes /health → online', async () => {
        const h = await harness();
        expect(h.svc.health.get()).toBe('online');
    });

    test('a dead sidecar → offline; retry after it comes up → online', async () => {
        let up = false;
        const h = await harness(url => {
            if (!up) throw new Error('ECONNREFUSED');
            return url.endsWith('/health') ? json({ status: 'healthy' }) : json({ polygons: [] });
        });
        expect(h.svc.health.get()).toBe('offline');

        up = true;
        await h.svc.checkHealth();
        expect(h.svc.health.get()).toBe('online');
    });

    test('clicks while offline create nothing and explain themselves', async () => {
        const h = await harness(() => json({}, 503));
        expect(h.svc.health.get()).toBe('offline');
        const created = await h.svc.segmentAt(CLICK);
        expect(created).toBeUndefined();
        expect(h.features.store.items.get()).toHaveLength(0);
        expect(h.svc.notice.get()).toContain('offline');
    });
});

// ─── segmentAt orchestration ────────────────────────────────────────────────

describe('segmentAt', () => {
    test('click → composed ortho crop → sidecar mask → armed-type b-spline feature, ONE history entry', async () => {
        const h = await harness(sidecarWith([ellipseMask(256, 256, 150, 90)]));
        h.svc.armedType.set('green');

        const created = await h.svc.segmentAt(CLICK);

        expect(created).toBeDefined();
        expect(created!.type).toBe('green');
        expect(created!.holeId).toBeNull(); // follow scope, no draw target hole
        expect(created!.geometry.crs).toBe('EPSG:3006');
        expect(created!.geometry.curveType).toBe('bspline');
        expect(created!.geometry.rings).toHaveLength(1);
        expect(created!.geometry.rings[0].points.length).toBeGreaterThanOrEqual(8);
        expect(created!.geometry.rings[0].points.length).toBeLessThanOrEqual(SAM_MAX_CONTROLS);

        // The crop was composed from direct ortho-tile URLs at maxzoom —
        // never the MapLibre canvas.
        expect(h.cropCalls).toHaveLength(1);
        expect(h.cropCalls[0].size).toBe(SAM_CROP_SIZE);
        for (const url of h.cropCalls[0].urls) {
            expect(url).toMatch(/^\/tiles\/site-1\/ortho\/19\/\d+\/\d+\.jpg\?v=20260704T082859Z$/);
        }

        // Store has it, it's selected, and ONE entry undoes it.
        expect(h.features.store.items.get()).toHaveLength(1);
        expect([...h.features.selectedIds.get()]).toEqual([created!.id]);
        expect(h.history.canUndo.get()).toBe(true);
        await h.history.undo(h.features);
        expect(h.features.store.items.get()).toHaveLength(0);
        expect(h.history.canUndo.get()).toBe(false);
    });

    test('the map click handler gates on the interaction claim', async () => {
        const h = await harness(sidecarWith([ellipseMask(256, 256, 120, 120)]));
        expect(h.clickHandlers).toHaveLength(1);

        h.interactionMode.set('draw'); // displaced — someone else holds the claim
        h.clickHandlers[0]({ lngLat: CLICK });
        await tick();
        expect(h.features.store.items.get()).toHaveLength(0);

        h.interactionMode.set(SAM_TOOL_ID);
        h.clickHandlers[0]({ lngLat: CLICK });
        await tick();
        await tick();
        expect(h.features.store.items.get()).toHaveLength(1);
    });

    test('default follow scope tracks the draw target hole', async () => {
        const h = await harness(sidecarWith([ellipseMask(256, 256, 150, 90)]));
        h.drawHoleId.set('hole-7');
        const created = await h.svc.segmentAt(CLICK);
        expect(created!.holeId).toBe('hole-7');
    });

    test('course scope forces holeId null even with a draw target hole', async () => {
        const h = await harness(sidecarWith([ellipseMask(256, 256, 150, 90)]));
        h.drawHoleId.set('hole-7');
        h.svc.holeScope.set(SAM_SCOPE_COURSE);
        const created = await h.svc.segmentAt(CLICK);
        expect(created!.holeId).toBeNull();
    });

    test('an explicit hole id scope wins over the draw target', async () => {
        const h = await harness(sidecarWith([ellipseMask(256, 256, 150, 90)]));
        h.drawHoleId.set('hole-7');
        h.svc.holeScope.set('hole-3');
        const created = await h.svc.segmentAt(CLICK);
        expect(created!.holeId).toBe('hole-3');
    });

    test('an empty mask sets a notice and creates nothing', async () => {
        const h = await harness(sidecarWith([]));
        const created = await h.svc.segmentAt(CLICK);
        expect(created).toBeUndefined();
        expect(h.svc.notice.get()).toContain('no shape');
        expect(h.features.store.items.get()).toHaveLength(0);
    });

    test('a sidecar failure mid-flight sets a notice and re-probes health', async () => {
        let healthy = true;
        const h = await harness(url => {
            if (url.endsWith('/health')) {
                return healthy ? json({ status: 'healthy' }) : json({}, 503);
            }
            healthy = false; // dies on the segment call
            throw new Error('socket hang up');
        });
        expect(h.svc.health.get()).toBe('online');

        const created = await h.svc.segmentAt(CLICK);
        expect(created).toBeUndefined();
        expect(h.svc.notice.get()).toContain('failed');
        await tick();
        expect(h.svc.health.get()).toBe('offline');
        expect(h.svc.busy.get()).toBe(false);
    });

    test('out-of-domain clicks are rejected before any network work', async () => {
        const h = await harness(sidecarWith([ellipseMask(256, 256, 100, 100)]));
        const created = await h.svc.segmentAt({ lng: 15.5658, lat: 553.9 });
        expect(created).toBeUndefined();
        expect(h.cropCalls).toHaveLength(0);
        expect(h.svc.notice.get()).toContain('outside');
    });
});
