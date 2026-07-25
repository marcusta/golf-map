import { test, expect, afterEach } from 'bun:test';
import { Router, Signal, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { EditorToolbarComponent } from '../src/editor/toolbar.component';
import { ContextDockComponent } from '../src/draw/feature-dock.component';
import { EditorModeService } from '../src/editor/editor-mode.service';
import { MapService } from '../src/map/map.service';
import { FeaturesService } from '../src/draw/features.service';
import { ServerModeService, type ServerMode } from '../src/app/server-mode.service';
import { AnalysisToolService } from '../src/analysis/analysis-tool.service';
import { analysisTool } from '../src/analysis/analysis-tool';
import { MEASURE_TOOL_ID } from '../src/measure/measure-tool.service';
import { DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { MapPointerEvent } from '../src/map/map.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { AnalysisApi, SampleGrid } from '../../shared/api/analysis.gen';

// The /course editor under a serve-mode server (T63). The builder tools are
// gone there, so anything the page NEEDS in both modes must not hang off one
// of them — this pins the two places where it did: the feature load/overlay
// (was draw's `attach`) and the dock's "nothing armed" fallback.

const COURSE_ID = 'course-1';
const GREEN_CENTER = { lat: 58.4015, lng: 15.5658 };

afterEach(() => {
    for (const component of mounted.splice(0)) component.destroy();
    document.body.textContent = '';
    _reset();
    di.reset();
});

const mounted: Array<{ destroy(): void }> = [];

function greenFeature(): CourseFeature {
    const c = wgs84ToSweref99tm(GREEN_CENTER.lat, GREEN_CENTER.lng);
    const half = 15;
    return {
        id: 'green-1',
        courseId: COURSE_ID,
        holeId: null,
        type: 'green',
        geometry: {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: c.x - half, y: c.y - half },
                    { x: c.x + half, y: c.y - half },
                    { x: c.x + half, y: c.y + half },
                    { x: c.x - half, y: c.y + half },
                ],
            }],
        },
        geojson: null,
        sortOrder: 0,
        source: null,
        sourceRef: null,
        license: null,
        version: 1,
    };
}

function featuresApi(rows: CourseFeature[]): { api: CourseFeaturesApi; listCalls: () => number } {
    let listCalls = 0;
    const api = {
        async listByCourse({ courseId }: { courseId: string }) {
            listCalls++;
            return rows.filter(r => r.courseId === courseId).map(r => structuredClone(r));
        },
    } as unknown as CourseFeaturesApi;
    return { api, listCalls: () => listCalls };
}

function analysisApi(): { api: AnalysisApi; calls: Array<{ featureId: string }> } {
    const calls: Array<{ featureId: string }> = [];
    const grid: SampleGrid = {
        origin: { e: 500000, n: 6468000 }, resolution: 0.5,
        width: 2, height: 2, heights: [50, 50.1, 50.2, 50.3], insideMask: [1, 1, 1, 1],
    };
    const api = {
        async sampleGrid(input: { featureId: string }) {
            calls.push({ featureId: input.featureId });
            return grid;
        },
        async sampleElevations() { return { elevations: [] }; },
    } as unknown as AnalysisApi;
    return { api, calls };
}

/** Minimal MapService stand-in: real interaction claims, capturable click handler. */
function fakeMap() {
    const clickHandlers = new Set<(e: MapPointerEvent) => void>();
    const overlays: string[] = [];
    const map = {
        ready: new Signal(false),
        map: new Signal(null),
        interactionMode: new Signal<string | null>(null),
        claimInteraction(mode: string) {
            map.interactionMode.set(mode);
            return () => { if (map.interactionMode.peek() === mode) map.interactionMode.set(null); };
        },
        onClick(handler: (e: MapPointerEvent) => void) {
            clickHandlers.add(handler);
            return () => clickHandlers.delete(handler);
        },
        onMouseMove: () => () => {},
        addOverlayLayer: (id: string) => { overlays.push(id); },
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
    };
    const click = (lngLat: { lng: number; lat: number }): void => {
        for (const handler of [...clickHandlers]) {
            handler({ lngLat, point: { x: 0, y: 0 }, originalEvent: new MouseEvent('click') });
        }
    };
    return { map, click, overlays };
}

/** Wires DI the way the /course page does, then mounts the editor toolbar. */
function mountEditor(mode: ServerMode) {
    const serverMode = new ServerModeService();
    serverMode.mode.set(mode);
    di.set(ServerModeService, serverMode);

    const { map, click, overlays } = fakeMap();
    di.set(MapService, map as never);
    // A real Router on the editor's own URL — the tools read params AND query
    // off it, and the courseId is what the feature load keys on.
    const router = new Router();
    router.navigate(`/course/${COURSE_ID}`);
    di.set(Router, router);

    const { api, listCalls } = featuresApi([greenFeature()]);
    const features = new FeaturesService(api);
    di.set(FeaturesService, features);

    const analysis = analysisApi();
    di.set(AnalysisToolService, new AnalysisToolService(analysis.api));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const toolbar = new EditorToolbarComponent();
    toolbar.mount(host);
    mounted.push(toolbar);

    return { features, listCalls, map, click, overlays, analysis, editorMode: di.get(EditorModeService) };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('serve mode: the /course editor still loads its features and overlays them', async () => {
    const editor = mountEditor('serve');
    await tick();

    // The load is the page's, not the (absent) draw tool's.
    expect(editor.listCalls()).toBe(1);
    expect(editor.features.stackTopDown.peek().map(f => f.id)).toEqual(['green-1']);

    // And the overlay is bound: it appears as soon as the map is ready.
    expect(editor.overlays).toHaveLength(0);
    editor.map.ready.set(true);
    expect(editor.overlays).toContain('features');

    // Draw is not offered, so the first offered tool is armed instead.
    expect(editor.editorMode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);
});

test('serve mode: the green-analysis tool resolves a green from the loaded stack', async () => {
    const editor = mountEditor('serve');
    await tick();

    editor.editorMode.activate(analysisTool);
    editor.click(GREEN_CENTER);
    await tick();

    expect(editor.analysis.calls.map(c => c.featureId)).toEqual(['green-1']);

    // A click off the green resolves nothing (no second request).
    editor.click({ lng: GREEN_CENTER.lng + 0.01, lat: GREEN_CENTER.lat + 0.01 });
    await tick();
    expect(editor.analysis.calls).toHaveLength(1);
});

test('builder mode is unchanged: features load once and draw is armed', async () => {
    const editor = mountEditor('builder');
    await tick();

    expect(editor.listCalls()).toBe(1); // exactly once — no double load with draw attached
    expect(editor.features.stackTopDown.peek()).toHaveLength(1);
    expect(editor.editorMode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});

/** Mounts the right dock the way /course does (Create variant, no `content` prop). */
function mountDock(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const dock = new ContextDockComponent({});
    dock.mount(host);
    mounted.push(dock);
    return host;
}

test('serve mode: Escape (nothing armed) does not fall back to the draw dock', async () => {
    const editor = mountEditor('serve');
    await tick();
    const host = mountDock();

    // Escape deactivates the armed tool — the dock then has nothing to follow.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(editor.editorMode.activeToolId.peek()).toBeNull();

    expect(host.querySelector('[data-testid="feature-stack-panel"]')).toBeNull();
    expect(host.textContent).not.toContain('Feature stack');
});

test('builder mode: Escape still falls back to the draw dock', async () => {
    const editor = mountEditor('builder');
    await tick();
    const host = mountDock();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(editor.editorMode.activeToolId.peek()).toBeNull();

    expect(host.textContent).toContain('Feature stack');
});
