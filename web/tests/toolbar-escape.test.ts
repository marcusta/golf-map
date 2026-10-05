import { test, expect, afterEach } from 'bun:test';
import { Router, Signal, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { EditorToolbarComponent } from '../src/editor/toolbar.component';
import { EditorModeService } from '../src/editor/editor-mode.service';
import { MapService } from '../src/map/map.service';
import { FeaturesService } from '../src/draw/features.service';
import { ServerModeService } from '../src/app/server-mode.service';
import { measureTool } from '../src/measure/measure-tool';
import { MEASURE_TOOL_ID } from '../src/measure/measure-tool.service';
import { DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Esc on the builder canvas (review item 20). Draw is the default tool: an
// Esc it does not consume must leave it armed (deactivating it left no tool,
// so keys and clicks went dead), and an unconsumed Esc in any other tool
// returns to Draw instead of to "no tool".

const mounted: Array<{ destroy(): void }> = [];

afterEach(() => {
    for (const component of mounted.splice(0)) component.destroy();
    document.body.textContent = '';
    _reset();
    di.reset();
});

function mountBuilder(): EditorModeService {
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
    di.set(FeaturesService, new FeaturesService(api));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const toolbar = new EditorToolbarComponent();
    toolbar.mount(host);
    mounted.push(toolbar);
    return di.get(EditorModeService);
}

const escape = (): void => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
};

test('Esc with nothing to cancel keeps Draw armed', () => {
    const mode = mountBuilder();
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);

    escape();
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
    escape();
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});

test('Esc in Measure returns to Draw', () => {
    const mode = mountBuilder();
    mode.activate(measureTool);
    expect(mode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);

    escape();
    expect(mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});
