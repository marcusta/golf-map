import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';

afterEach(() => { _reset(); di.reset(); });

function context(features: FeaturesService): ToolContext {
    const map = {
        ready: new Signal(false),
        map: new Signal(null),
        interactionMode: new Signal(DRAW_TOOL_ID),
        onClick: () => () => {},
        onMouseMove: () => () => {},
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
    };
    return {
        map: map as never,
        elevation: null as never,
        tileset: null as never,
        courseDetail: null as never,
        features,
        courseId: 'course-1',
        track: () => {},
    };
}

describe('DrawToolService rendering mode', () => {
    test('uses high-contrast rendering for the whole active Draw-tool span', () => {
        di.set(ConfirmService, new ConfirmService());
        const features = new FeaturesService({} as CourseFeaturesApi);
        const tool = new DrawToolService();
        const ctx = context(features);

        expect(features.niceRendering.get()).toBe(true);
        tool.activate(ctx); // No polygon has been armed or clicked yet.
        expect(features.niceRendering.get()).toBe(false);

        tool.deactivate();
        expect(features.niceRendering.get()).toBe(true);
    });
});
