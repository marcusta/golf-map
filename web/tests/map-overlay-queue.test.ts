import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import type { FeatureCollection } from 'geojson';
import { MapService } from '../src/map/map.service';

// The overlay data queue in MapService (updateOverlayData / pumpOverlayData,
// plus the first-load hold in addOverlayLayer) serializes GeoJSON setData per
// source with a latest-wins queue, to dodge the maplibre 5.x worker race
// (maplibre-gl-js#7734). MapLibre cannot run under happy-dom, so these drive
// the queue off a fake maplibregl.Map whose GeoJSONSource.setData returns a
// promise the test resolves on demand.

afterEach(() => { di.reset(); });

/** Distinct, tagged collections so assertions can say which one was sent. */
function fc(tag: string): FeatureCollection {
    return { type: 'FeatureCollection', features: [], tag } as FeatureCollection;
}
const tagOf = (data: unknown): string => (data as { tag: string }).tag;

interface SetDataCall { source: string; tag: string; resolve: () => void; reject: (e: Error) => void }

/**
 * Fake maplibregl.Map covering what addOverlayLayer / updateOverlayData /
 * removeOverlayLayer / destroy touch. Each geojson source records its
 * setData calls with a manual resolver.
 */
function fakeOverlayMap() {
    const calls: SetDataCall[] = [];
    const sources = new Map<string, { type: 'geojson'; setData: (data: unknown, wait?: boolean) => Promise<void> }>();
    const layers = new Map<string, unknown>();
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const map = {
        addSource(id: string) {
            sources.set(id, {
                type: 'geojson',
                setData: (data: unknown) => new Promise<void>((resolve, reject) => {
                    calls.push({ source: id, tag: tagOf(data), resolve, reject });
                }),
            });
        },
        getSource: (id: string) => sources.get(id),
        removeSource: (id: string) => { sources.delete(id); },
        addLayer: (layer: { id: string }) => { layers.set(layer.id, layer); },
        getLayer: (id: string) => layers.get(id),
        getLayersOrder: () => [...layers.keys()],
        removeLayer: (id: string) => { layers.delete(id); },
        moveLayer: () => {},
        on(type: string, fn: (e: unknown) => void) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(fn);
        },
        off(type: string, fn: (e: unknown) => void) { listeners.get(type)?.delete(fn); },
        remove: () => {},
    };
    const emit = (type: string, e: unknown): void => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
    };
    return { map, calls, emit, listenerCount: (type: string) => listeners.get(type)?.size ?? 0 };
}

/** Let awaited promise chains in the pump settle. */
const flush = () => Bun.sleep(0);

/**
 * Capture setTimeout callbacks scheduled with `delay` (the hard-coded 3 s
 * first-load fallback) so a test can fire them on demand. Other timers pass
 * through to the real implementation.
 */
function captureTimeouts(delay: number) {
    const real = globalThis.setTimeout;
    const captured: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (ms === delay) {
            captured.push(fn);
            return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return real(fn, ms, ...rest);
    }) as typeof setTimeout;
    return { captured, restore: () => { globalThis.setTimeout = real; } };
}

/** A ready MapService on the fake map, with overlay `ids` added and their first-load hold released. */
async function readyService(ids: string[]) {
    const fake = fakeOverlayMap();
    const svc = new MapService();
    svc.map.set(fake.map as never);
    svc.ready.set(true);
    const timers = captureTimeouts(3000); // keep the real 3 s fallback timers out of the run
    try {
        for (const id of ids) {
            svc.addOverlayLayer(id, fc(`${id}-initial`), [{ id: `${id}-fill`, type: 'fill' } as never]);
            fake.emit('sourcedata', { sourceId: id, isSourceLoaded: true });
        }
    } finally {
        timers.restore();
    }
    await flush();
    return { svc, ...fake };
}

describe('updateOverlayData latest-wins queue', () => {
    test('3 rapid updates to one source send exactly 2 setData calls: the first, then the latest', async () => {
        const { svc, calls } = await readyService(['a']);

        svc.updateOverlayData('a', fc('a1'));
        svc.updateOverlayData('a', fc('a2'));
        svc.updateOverlayData('a', fc('a3'));
        await flush();
        expect(calls.map(c => c.tag)).toEqual(['a1']); // a2/a3 wait for a1's worker round-trip

        calls[0]!.resolve();
        await flush();
        expect(calls.map(c => c.tag)).toEqual(['a1', 'a3']); // a2 dropped

        calls[1]!.resolve();
        await flush();
        expect(calls).toHaveLength(2);
    });

    test('an update after the queue drains starts a fresh send', async () => {
        const { svc, calls } = await readyService(['a']);
        svc.updateOverlayData('a', fc('a1'));
        await flush();
        calls[0]!.resolve();
        await flush();

        svc.updateOverlayData('a', fc('a2'));
        await flush();
        expect(calls.map(c => c.tag)).toEqual(['a1', 'a2']);
    });

    test('two sources queue independently', async () => {
        const { svc, calls } = await readyService(['a', 'b']);

        svc.updateOverlayData('a', fc('a1'));
        svc.updateOverlayData('b', fc('b1'));
        svc.updateOverlayData('a', fc('a2'));
        await flush();
        // b is not blocked behind a's in-flight send.
        expect(calls.map(c => c.tag)).toEqual(['a1', 'b1']);

        calls.find(c => c.tag === 'b1')!.resolve();
        await flush();
        expect(calls.map(c => c.tag)).toEqual(['a1', 'b1']); // a2 still waits on a1

        calls.find(c => c.tag === 'a1')!.resolve();
        await flush();
        expect(calls.map(c => c.tag)).toEqual(['a1', 'b1', 'a2']);
    });

    test('a rejected setData ends that pump; the next update sends again', async () => {
        const { svc, calls } = await readyService(['a']);
        svc.updateOverlayData('a', fc('a1'));
        await flush();
        calls[0]!.reject(new Error('worker gone'));
        await flush();

        svc.updateOverlayData('a', fc('a2'));
        await flush();
        expect(calls.map(c => c.tag)).toEqual(['a1', 'a2']);
    });

    test('after destroy() a queued update is never sent', async () => {
        const { svc, calls } = await readyService(['a']);
        svc.updateOverlayData('a', fc('a1'));
        svc.updateOverlayData('a', fc('a2')); // queued behind a1
        await flush();

        svc.destroy();
        calls[0]!.resolve();
        await flush();

        expect(calls.map(c => c.tag)).toEqual(['a1']);
    });

    test('removeOverlayLayer drops a queued update for that source', async () => {
        const { svc, calls } = await readyService(['a']);
        svc.updateOverlayData('a', fc('a1'));
        svc.updateOverlayData('a', fc('a2'));
        await flush();

        svc.removeOverlayLayer('a');
        calls[0]!.resolve();
        await flush();

        expect(calls.map(c => c.tag)).toEqual(['a1']);
    });
});

describe('addOverlayLayer first-load hold', () => {
    test('updates wait for the source\'s loaded sourcedata event, then only the latest is sent', async () => {
        const fake = fakeOverlayMap();
        const svc = new MapService();
        svc.map.set(fake.map as never);
        svc.ready.set(true);
        const timers = captureTimeouts(3000);
        try {
            svc.addOverlayLayer('a', fc('a0'), [{ id: 'a-fill', type: 'fill' } as never]);
        } finally {
            timers.restore();
        }

        svc.updateOverlayData('a', fc('a1'));
        svc.updateOverlayData('a', fc('a2'));
        await flush();
        expect(fake.calls).toHaveLength(0);

        // Unrelated events do not release the hold.
        fake.emit('sourcedata', { sourceId: 'other', isSourceLoaded: true });
        fake.emit('sourcedata', { sourceId: 'a', isSourceLoaded: false });
        await flush();
        expect(fake.calls).toHaveLength(0);

        fake.emit('sourcedata', { sourceId: 'a', isSourceLoaded: true });
        await flush();
        expect(fake.calls.map(c => c.tag)).toEqual(['a2']);
        expect(fake.listenerCount('sourcedata')).toBe(0); // hold listener detached

        // The later fallback firing is a no-op (already released).
        timers.captured[0]!();
        await flush();
        expect(fake.calls.map(c => c.tag)).toEqual(['a2']);
    });

    test('the 3 s fallback releases the hold when no loaded event arrives', async () => {
        const fake = fakeOverlayMap();
        const svc = new MapService();
        svc.map.set(fake.map as never);
        svc.ready.set(true);
        const timers = captureTimeouts(3000);
        try {
            svc.addOverlayLayer('a', fc('a0'), [{ id: 'a-fill', type: 'fill' } as never]);
        } finally {
            timers.restore();
        }
        expect(timers.captured).toHaveLength(1);

        svc.updateOverlayData('a', fc('a1'));
        await flush();
        expect(fake.calls).toHaveLength(0);

        timers.captured[0]!();
        await flush();
        expect(fake.calls.map(c => c.tag)).toEqual(['a1']);
        expect(fake.listenerCount('sourcedata')).toBe(0);
    });

    test('a hold released with nothing queued sends nothing', async () => {
        const { calls } = await readyService(['a']);
        expect(calls).toHaveLength(0);
    });
});
