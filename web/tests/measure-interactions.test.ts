import { test, expect } from 'bun:test';
import { Signal } from '@basics/core/client/core';
import type { FeatureCollection } from 'geojson';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import {
    MeasureToolService,
    MEASURE_TOOL_ID,
    PROFILE_SAMPLES_PER_SEGMENT,
    type MeasureElevationSampler,
} from '../src/measure/measure-tool.service';

type LngLat = { lng: number; lat: number };

interface Deferred { resolve(): void }

/** Sampler whose sampleLine calls are recorded and can be held until released. */
function sampler(hold: (a: LngLat, b: LngLat, call: number) => boolean = () => false) {
    const calls: Array<{ a: LngLat; b: LngLat }> = [];
    const pending: Deferred[] = [];
    const s: MeasureElevationSampler & { calls: typeof calls; pending: Deferred[] } = {
        calls,
        pending,
        async elevationAt() { return 10; },
        sampleLine(a, b, n) {
            const call = calls.length;
            calls.push({ a, b });
            const out = Array.from({ length: n }, (_, i) => ({
                lng: a.lng + (b.lng - a.lng) * (i / (n - 1)),
                lat: a.lat + (b.lat - a.lat) * (i / (n - 1)),
                // Elevation encodes the segment start lng so tests can tell results apart.
                elevation: a.lng * 1000,
            }));
            if (!hold(a, b, call)) return Promise.resolve(out);
            return new Promise(resolve => pending.push({ resolve: () => resolve(out) }));
        },
    };
    return s;
}

/** Minimal MapService stand-in: events, claim mode, overlay recording. */
function fakeCtx(elevation: MeasureElevationSampler) {
    const clicks = new Set<(e: MapPointerEvent) => void>();
    const moves = new Set<(e: MapPointerEvent) => void>();
    const overlay: { data: FeatureCollection | null; removed: boolean } = { data: null, removed: false };
    const disposers: Array<() => void> = [];
    const canvas = { style: { cursor: '' } };
    const rawMap = { on() {}, off() {}, getCanvas: () => canvas, project: ([lng, lat]: number[]) => ({ x: lng * 1e4, y: lat * 1e4 }) };
    const map = {
        ready: new Signal(true),
        map: new Signal(rawMap as never),
        interactionMode: new Signal<string | null>(MEASURE_TOOL_ID),
        onClick: (h: (e: MapPointerEvent) => void) => { clicks.add(h); return () => clicks.delete(h); },
        onMouseMove: (h: (e: MapPointerEvent) => void) => { moves.add(h); return () => moves.delete(h); },
        addOverlayLayer: (_id: string, data: FeatureCollection) => { overlay.data = data; overlay.removed = false; },
        updateOverlayData: (_id: string, data: FeatureCollection) => { overlay.data = data; },
        removeOverlayLayer: () => { overlay.removed = true; },
    };
    const ctx = { map, elevation, track: (d: () => void) => disposers.push(d) } as unknown as ToolContext;
    const ev = (lng: number, lat: number, buttons = 0): MapPointerEvent => ({
        lngLat: { lng, lat },
        point: { x: lng * 1e4, y: lat * 1e4 },
        originalEvent: { buttons } as MouseEvent,
    });
    return {
        ctx,
        overlay,
        click: (lng: number, lat: number) => clicks.forEach(h => h(ev(lng, lat))),
        move: (lng: number, lat: number, buttons = 0) => moves.forEach(h => h(ev(lng, lat, buttons))),
        dispose: () => disposers.splice(0).reverse().forEach(d => d()),
    };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const key = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
const roles = (fc: FeatureCollection | null) => (fc?.features ?? []).map(f => f.properties?.role as string);

const P = [
    [18.0, 59.0],
    [18.001, 59.0],
    [18.002, 59.0],
    [18.003, 59.0],
] as const;

test('adding a 4th point to a 3-point line samples 1 segment, not 3', async () => {
    const s = sampler();
    const t = fakeCtx(s);
    const svc = new MeasureToolService();
    svc.activate(t.ctx);

    for (const [lng, lat] of P.slice(0, 3)) t.click(lng, lat);
    await flush();
    const before = s.calls.length;
    t.click(...P[3]);
    await flush();
    const added = s.calls.length - before;
    console.log(`profile sample requests: 3-point line = ${before}, adding 4th point = ${added} (previously 3)`);
    expect(before).toBe(2);
    expect(added).toBe(1);
    expect(s.calls[before].a).toEqual({ lng: P[2][0], lat: P[2][1] });
    expect(svc.profile.get()).toHaveLength(PROFILE_SAMPLES_PER_SEGMENT * 3 - 2);
    t.dispose();
});

test('a slow earlier sample resolving after a later one does not overwrite it', async () => {
    // The first request for segment B->C is held; the path then grows to D.
    const s = sampler((a, b) => a.lng === P[1][0] && b.lng === P[2][0] && s.pending.length === 0);
    const t = fakeCtx(s);
    const svc = new MeasureToolService();
    svc.activate(t.ctx);

    t.click(...P[0]);
    t.click(...P[1]);
    await flush();
    t.click(...P[2]); // held: B->C unresolved
    await flush();
    expect(s.pending).toHaveLength(1);
    expect(svc.profileLoading.get()).toBe(true);

    // A later undo shortens the path to 2 points and publishes the 1-segment profile.
    svc.undoPoint();
    await flush();
    const shortProfile = svc.profile.get();
    expect(shortProfile).toHaveLength(PROFILE_SAMPLES_PER_SEGMENT);
    expect(svc.profileLoading.get()).toBe(false);

    s.pending[0].resolve(); // stale 3-point request lands late
    await flush();
    expect(svc.profile.get()).toBe(shortProfile);
    t.dispose();
});

test('Backspace and Cmd/Ctrl+Z remove the last point; Enter finishes', async () => {
    const t = fakeCtx(sampler());
    const svc = new MeasureToolService();
    svc.activate(t.ctx);
    for (const [lng, lat] of P) t.click(lng, lat);
    expect(svc.state.count.get()).toBe(4);

    key({ key: 'Backspace' });
    expect(svc.state.count.get()).toBe(3);
    key({ key: 'z', metaKey: true });
    expect(svc.state.count.get()).toBe(2);
    key({ key: 'z', ctrlKey: true });
    expect(svc.state.count.get()).toBe(1);
    key({ key: 'Enter' }); // one point: nothing to finish
    expect(svc.state.ended.get()).toBe(false);

    t.click(...P[1]);
    key({ key: 'Enter' });
    expect(svc.state.ended.get()).toBe(true);
    expect(svc.isBusy()).toBe(false);

    // Finished path: undo keys leave it alone.
    key({ key: 'Backspace' });
    expect(svc.state.count.get()).toBe(2);
    t.dispose();
});

test('undo keys are ignored in text inputs and when another tool holds the claim', () => {
    const t = fakeCtx(sampler());
    const svc = new MeasureToolService();
    svc.activate(t.ctx);
    t.click(...P[0]);
    t.click(...P[1]);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(svc.state.count.get()).toBe(2);
    input.remove();

    (t.ctx.map.interactionMode as Signal<string | null>).set('draw');
    key({ key: 'Backspace' });
    expect(svc.state.count.get()).toBe(2);
    t.dispose();
});

test('isBusy is true only while a path is open, and Escape behaviour is unchanged', () => {
    const t = fakeCtx(sampler());
    const svc = new MeasureToolService();
    svc.activate(t.ctx);
    expect(svc.isBusy()).toBe(false);
    t.click(...P[0]);
    expect(svc.isBusy()).toBe(true);
    t.click(...P[1]);
    svc.finish();
    expect(svc.isBusy()).toBe(false);
    expect(svc.onEscape()).toBe(true);
    expect(svc.onEscape()).toBe(false);
    t.dispose();
});

test('rubber band is present while measuring, gated by held buttons, absent after finish', async () => {
    const t = fakeCtx(sampler());
    const svc = new MeasureToolService();
    svc.activate(t.ctx);

    t.move(18.0005, 59.0);
    expect(roles(t.overlay.data)).not.toContain('cursor'); // nothing placed yet

    t.click(...P[0]);
    t.move(18.0005, 59.0005);
    const band = t.overlay.data!.features.find(f => f.properties?.role === 'cursor');
    expect(band).toBeDefined();
    expect((band!.geometry as { coordinates: number[][] }).coordinates).toEqual([[P[0][0], P[0][1]], [18.0005, 59.0005]]);

    t.move(18.0006, 59.0006, 1); // button held: pan or drag
    expect(roles(t.overlay.data)).not.toContain('cursor');
    t.move(18.0007, 59.0007, 0);
    expect(roles(t.overlay.data)).toContain('cursor');

    t.click(...P[1]);
    t.move(18.0015, 59.0);
    key({ key: 'Enter' });
    expect(roles(t.overlay.data)).not.toContain('cursor');
    t.move(18.002, 59.0); // ended path: pointer does not bring it back
    expect(roles(t.overlay.data)).not.toContain('cursor');
    t.dispose();
});

test('Backspace to an empty path removes the rubber band', () => {
    const t = fakeCtx(sampler());
    const svc = new MeasureToolService();
    svc.activate(t.ctx);
    t.click(...P[0]);
    t.move(18.0005, 59.0);
    expect(roles(t.overlay.data)).toContain('cursor');
    key({ key: 'Backspace' });
    expect(svc.state.count.get()).toBe(0);
    expect(roles(t.overlay.data)).not.toContain('cursor');
    t.dispose();
});
