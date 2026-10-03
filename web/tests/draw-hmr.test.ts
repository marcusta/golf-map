import { test, expect, afterEach } from 'bun:test';
import { Router, Signal, di, effect } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { EditorToolbarComponent } from '../src/editor/toolbar.component';
import { EditorModeService } from '../src/editor/editor-mode.service';
import { MapService } from '../src/map/map.service';
import { FeaturesService } from '../src/draw/features.service';
import { ServerModeService } from '../src/app/server-mode.service';
import { DrawToolService, DRAW_TOOL_ID, hotSwapDrawTool } from '../src/draw/draw-tool.service';
import { measureTool } from '../src/measure/measure-tool';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Review item 32: an edit to draw-tool.service.ts swaps the live service's
// code in place instead of remounting the app. These tests drive the swap
// routine the module's import.meta.hot.accept handler calls, against the
// real toolbar + EditorModeService.

const mounted: Array<{ destroy(): void }> = [];
let log: string[] = [];

afterEach(() => {
    for (const component of mounted.splice(0)) component.destroy();
    document.body.textContent = '';
    log = [];
    _reset();
    di.reset();
});

// The "old module" class: only method overrides, so the field set matches.
class OldDrawTool extends DrawToolService {
    override activate(ctx: Parameters<DrawToolService['activate']>[0]): void {
        log.push('old-activate');
        super.activate(ctx);
    }
    override deactivate(): void {
        log.push('old-deactivate');
        super.deactivate();
    }
}

// The "re-executed module" class.
class NextDrawTool extends DrawToolService {
    override activate(ctx: Parameters<DrawToolService['activate']>[0]): void {
        log.push('next-activate');
        super.activate(ctx);
    }
    override deactivate(): void {
        log.push('next-deactivate');
        super.deactivate();
    }
}

function mountBuilder(): { mode: EditorModeService; live: DrawToolService; claims: Array<string | null>; features: FeaturesService } {
    const serverMode = new ServerModeService();
    serverMode.mode.set('builder');
    di.set(ServerModeService, serverMode);

    const map = {
        ready: new Signal(false),
        map: new Signal(null),
        zoom: new Signal(18),
        interactionMode: new Signal<string | null>(null),
        claimInteraction(mode: string) {
            map.interactionMode.set(mode);
            return () => { if (map.interactionMode.peek() === mode) map.interactionMode.set(null); };
        },
        onClick: () => () => {},
        onMouseMove: () => () => {},
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
    };
    di.set(MapService, map as never);
    const router = new Router();
    router.navigate('/course/course-1');
    di.set(Router, router);
    const api = { async listByCourse() { return []; } } as unknown as CourseFeaturesApi;
    const features = new FeaturesService(api);
    di.set(FeaturesService, features);

    // The registry entry resolves the service with di.get(DrawToolService).
    const live = new OldDrawTool();
    di.set(DrawToolService, live);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const toolbar = new EditorToolbarComponent();
    toolbar.mount(host);
    mounted.push(toolbar);

    const claims: Array<string | null> = [];
    mounted.push({ destroy: effect(() => { claims.push(map.interactionMode.get()); }) });
    return { mode: di.get(EditorModeService), live, claims, features };
}

test('swap with Draw active: old code deactivates, new code activates under a fresh claim', () => {
    const { mode, live, claims } = mountBuilder();
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
    log = [];
    claims.length = 0;
    live.state.arm();

    expect(hotSwapDrawTool(live, NextDrawTool)).toBe(true);

    expect(log).toEqual(['old-deactivate', 'next-activate']);
    expect(claims).toEqual([null, DRAW_TOOL_ID]); // released, then re-taken
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
    // Same instance, new code, registered under both class keys.
    expect(live).toBeInstanceOf(NextDrawTool);
    expect(di.get(DrawToolService)).toBe(live);
    expect(di.get(NextDrawTool)).toBe(live);
    // The open draft is dropped by deactivate.
    expect(live.state.isDrawing.peek()).toBe(false);
    // Later lifecycle calls run the new code.
    log = [];
    mode.deactivate();
    expect(log).toEqual(['next-deactivate']);
});

test('swap keeps the feature selection, undo history and draw type', () => {
    const { live, features } = mountBuilder();
    features.setSelection(['f-1', 'f-2']);
    live.drawType.set('green');
    live.history.push([{ id: 'f-1', before: null, after: null }] as never);
    expect(live.history.canUndo.peek()).toBe(true);

    hotSwapDrawTool(live, NextDrawTool);

    expect([...features.selectedIds.peek()]).toEqual(['f-1', 'f-2']);
    expect(live.drawType.peek()).toBe('green');
    expect(live.history.canUndo.peek()).toBe(true);
});

test('swap with another tool active only swaps the code', () => {
    const { mode, live, claims } = mountBuilder();
    mode.activate(measureTool);
    log = [];
    claims.length = 0;

    expect(hotSwapDrawTool(live, NextDrawTool)).toBe(true);

    expect(log).toEqual([]);
    expect(claims).toEqual([]);
    expect(live).toBeInstanceOf(NextDrawTool);
    expect(mode.activeToolId.peek()).toBe(measureTool.id);
});

test('a new instance field refuses the swap and changes nothing', () => {
    const { mode, live, claims } = mountBuilder();
    class Widened extends DrawToolService {
        readonly extra = new Signal(0);
    }
    log = [];
    claims.length = 0;

    expect(hotSwapDrawTool(live, Widened)).toBe(false);

    expect(log).toEqual([]);
    expect(claims).toEqual([]);
    expect(live).toBeInstanceOf(OldDrawTool);
    expect(live).not.toBeInstanceOf(Widened);
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});
