import { afterEach, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Draw preview cost per mousemove (review item 6): an armed tool with an
// empty draft pushes nothing to the overlay worker, and with a draft the
// cursor updates of one animation frame collapse into one push.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

function setup() {
    const moveHandlers: Array<(e: MapPointerEvent) => void> = [];
    let pushes = 0;
    const map = {
        ready: new Signal(true),
        map: new Signal(null),
        zoom: new Signal(18),
        interactionMode: new Signal(DRAW_TOOL_ID),
        onClick: () => () => {},
        onMouseMove: (h: (e: MapPointerEvent) => void) => { moveHandlers.push(h); return () => {}; },
        addOverlayLayer: () => { pushes++; },
        updateOverlayData: () => { pushes++; },
        removeOverlayLayer: () => {},
    };
    const ctx: ToolContext = {
        map: map as never,
        elevation: null as never,
        tileset: null as never,
        courseDetail: null as never,
        features: new FeaturesService({} as CourseFeaturesApi),
        courseId: 'course-1',
        track: (d: () => void) => { cleanups.push(d); },
    };
    di.set(ConfirmService, new ConfirmService());
    const tool = new DrawToolService();
    // Manual frames: callbacks queue until the test runs a frame.
    let queued: Array<() => void> = [];
    tool.frameScheduler = cb => { queued.push(cb); };
    const frame = (): void => {
        const run = queued;
        queued = [];
        for (const cb of run) cb();
    };
    tool.activate(ctx);
    const move = (i: number): void => {
        const e: MapPointerEvent = {
            lngLat: { lng: 15.5 + i * 1e-5, lat: 58.4 + i * 1e-5 },
            point: { x: 100 + i, y: 100 + i },
            originalEvent: new MouseEvent('mousemove'),
        };
        for (const h of moveHandlers) h(e);
    };
    return { tool, move, frame, pushes: () => pushes, queued: () => queued.length };
}

test('armed with an empty draft: mousemoves push no preview', () => {
    const t = setup();
    t.tool.state.arm();
    const before = t.pushes();

    for (let i = 0; i < 50; i++) t.move(i);
    t.frame();

    expect(t.pushes() - before).toBe(0);
    expect(t.queued()).toBe(0);
});

test('with a draft: N mousemoves in one frame make one preview push', () => {
    const t = setup();
    t.tool.state.arm();
    const p = wgs84ToSweref99tm(58.4, 15.5);
    t.tool.state.addPoint(p);
    const before = t.pushes();

    for (let i = 1; i <= 20; i++) t.move(i);
    expect(t.pushes() - before).toBe(0); // nothing before the frame
    t.frame();
    expect(t.pushes() - before).toBe(1);

    // The same position again is not a change: no frame is even requested.
    t.move(20);
    expect(t.queued()).toBe(0);

    // Next frame, next push.
    t.move(21);
    t.move(22);
    t.frame();
    expect(t.pushes() - before).toBe(2);
});

test('a direct clear beats a pending frame write', () => {
    const t = setup();
    t.tool.state.arm();
    t.tool.state.addPoint(wgs84ToSweref99tm(58.4, 15.5));
    t.move(1);
    t.tool.deactivate(); // clears the cursor now
    const before = t.pushes();
    t.frame(); // the pending cursor must not come back
    expect(t.pushes() - before).toBe(0);
});
