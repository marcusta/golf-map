import { afterEach, describe, expect, test } from 'bun:test';
import { Signal } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { ToolContext } from '../src/editor/tool';
import { bindDrag, isPanEscape, type DragBinding } from '../src/editor/drag-binding';

// editor/drag-binding.ts against a fake gl map that records handlers and
// dragPan state. The sequence tests drive the binding the way MapLibre
// does: mousedown, then mouseup, then the synthesized click on a later
// macrotask.

const TOOL = 'tool-under-test';

interface FakeGl {
    gl: MaplibreMap;
    fire(type: string, e: unknown): void;
    count(type: string): number;
    dragPanEnabled(): boolean;
}

function fakeGl(): FakeGl {
    const handlers = new Map<string, Set<(e: unknown) => void>>();
    let panEnabled = true;
    const gl = {
        on(type: string, fn: (e: unknown) => void) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type)!.add(fn);
        },
        off(type: string, fn: (e: unknown) => void) {
            handlers.get(type)?.delete(fn);
        },
        dragPan: {
            enable() { panEnabled = true; },
            disable() { panEnabled = false; },
        },
    } as unknown as MaplibreMap;
    return {
        gl,
        fire(type, e) { for (const fn of [...(handlers.get(type) ?? [])]) fn(e); },
        count(type) { return handlers.get(type)?.size ?? 0; },
        dragPanEnabled: () => panEnabled,
    };
}

function fakeCtx(gl: MaplibreMap) {
    const disposers: Array<() => void> = [];
    const map = {
        ready: new Signal(true),
        map: new Signal<MaplibreMap | null>(gl),
        interactionMode: new Signal<string | null>(TOOL),
    };
    const ctx = {
        map,
        track: (d: () => void) => { disposers.push(d); },
    } as unknown as Pick<ToolContext, 'map' | 'track'>;
    return { ctx, map, dispose: () => { for (const d of disposers.splice(0)) d(); } };
}

interface FakeEvent { defaultPrevented: boolean }

function mouse(type: string, init: MouseEventInit = {}): MapMouseEvent & FakeEvent {
    const e = {
        defaultPrevented: false,
        point: { x: 10, y: 10 },
        lngLat: { lng: 15, lat: 58 },
        originalEvent: new MouseEvent(type, { button: 0, ...init }),
        preventDefault() { e.defaultPrevented = true; },
    };
    return e as unknown as MapMouseEvent & FakeEvent;
}

const nextMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));

let cleanups: Array<() => void> = [];
afterEach(() => {
    for (const c of cleanups.splice(0)) c();
});

/**
 * A minimal dragging tool: a press claims, a release hands the gesture
 * back and, if the pointer moved, swallows the synthesized click.
 */
function setup() {
    const fake = fakeGl();
    const { ctx, map, dispose } = fakeCtx(fake.gl);
    cleanups.push(dispose);
    const log: string[] = [];
    let dragging = false;
    let moved = false;
    const binding: DragBinding = bindDrag(ctx, {
        toolId: TOOL,
        onDown(e, gl) {
            log.push('down');
            binding.claim(e, gl);
            dragging = true;
            moved = false;
        },
        onUp(_e, gl) {
            log.push('up');
            if (!dragging) return;
            dragging = false;
            binding.release(gl);
            if (moved) binding.suppressNextClick();
        },
    });
    const click = () => { log.push(binding.clickSuppressed ? 'click-suppressed' : 'click'); };
    return { fake, map, dispose, binding, log, click, move: () => { moved = true; } };
}

describe('drag binding', () => {
    test('mousedown claims, mouseup releases, dragPan follows', () => {
        const { fake, log, binding } = setup();
        const down = mouse('mousedown');
        fake.fire('mousedown', down);
        expect(log).toEqual(['down']);
        expect(down.defaultPrevented).toBe(true);
        expect(fake.dragPanEnabled()).toBe(false);
        fake.fire('mouseup', mouse('mouseup'));
        expect(log).toEqual(['down', 'up']);
        expect(fake.dragPanEnabled()).toBe(true);
        expect(binding.clickSuppressed).toBe(false);
    });

    test('a moved drag suppresses the synthesized click for one macrotask', async () => {
        const { fake, log, click, move } = setup();
        fake.fire('mousedown', mouse('mousedown'));
        move();
        fake.fire('mouseup', mouse('mouseup'));
        click();
        await nextMacrotask();
        click();
        expect(log).toEqual(['down', 'up', 'click-suppressed', 'click']);
    });

    test('a stationary press-release leaves the click alone', () => {
        const { fake, log, click } = setup();
        fake.fire('mousedown', mouse('mousedown'));
        fake.fire('mouseup', mouse('mouseup'));
        click();
        expect(log).toEqual(['down', 'up', 'click']);
    });

    test('Cmd or Ctrl press is the pan escape: no onDown, no preventDefault', () => {
        const { fake, log } = setup();
        for (const init of [{ metaKey: true }, { ctrlKey: true }]) {
            const down = mouse('mousedown', init);
            expect(isPanEscape(down)).toBe(true);
            fake.fire('mousedown', down);
            expect(down.defaultPrevented).toBe(false);
            expect(fake.dragPanEnabled()).toBe(true);
        }
        expect(log).toEqual([]);
        expect(isPanEscape(mouse('mousedown', { shiftKey: true, altKey: true }))).toBe(false);
    });

    test('non-left buttons and a foreign claim never reach onDown', () => {
        const { fake, map, log } = setup();
        fake.fire('mousedown', mouse('mousedown', { button: 1 }));
        fake.fire('mousedown', mouse('mousedown', { button: 2 }));
        map.interactionMode.set('other-tool');
        fake.fire('mousedown', mouse('mousedown'));
        expect(log).toEqual([]);
    });

    test('mouseup is ungated: a drag ends even after the claim moved', () => {
        const { fake, map, log } = setup();
        fake.fire('mousedown', mouse('mousedown'));
        map.interactionMode.set('other-tool');
        fake.fire('mouseup', mouse('mouseup'));
        expect(log).toEqual(['down', 'up']);
        expect(fake.dragPanEnabled()).toBe(true);
    });

    test('dispose mid-drag restores dragPan, unbinds and clears suppression', () => {
        const { fake, dispose, binding } = setup();
        fake.fire('mousedown', mouse('mousedown'));
        binding.suppressNextClick();
        expect(fake.dragPanEnabled()).toBe(false);
        dispose();
        expect(fake.dragPanEnabled()).toBe(true);
        expect(binding.clickSuppressed).toBe(false);
        expect(fake.count('mousedown')).toBe(0);
        expect(fake.count('mouseup')).toBe(0);
    });

    test('a ready flip rebinds once, without doubling handlers', () => {
        const { fake, map, log } = setup();
        expect(fake.count('mousedown')).toBe(1);
        map.ready.set(false);
        map.ready.set(true);
        expect(fake.count('mousedown')).toBe(1);
        expect(fake.count('mouseup')).toBe(1);
        fake.fire('mousedown', mouse('mousedown'));
        expect(log).toEqual(['down']);
    });

    test('a recreated map moves the handlers to the new instance', () => {
        const { fake, map } = setup();
        const next = fakeGl();
        map.map.set(next.gl);
        expect(fake.count('mousedown')).toBe(0);
        expect(next.count('mousedown')).toBe(1);
    });

    test('bindExtra shares the lifecycle', () => {
        const fake = fakeGl();
        const { ctx, dispose } = fakeCtx(fake.gl);
        let bound = 0;
        bindDrag(ctx, {
            toolId: TOOL,
            onDown() {},
            onUp() {},
            bindExtra(gl) {
                const fn = () => {};
                gl.on('dblclick', fn);
                bound++;
                return () => gl.off('dblclick', fn);
            },
        });
        expect(bound).toBe(1);
        expect(fake.count('dblclick')).toBe(1);
        dispose();
        expect(fake.count('dblclick')).toBe(0);
    });
});
