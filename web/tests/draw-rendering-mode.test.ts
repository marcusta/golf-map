import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID, scopeOwnsType, scopeSelectsType, vegetationHitOrder } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

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

    test('Draw hides the rules lines; the rules scope (Furniture) edits only those, in nice rendering', () => {
        di.set(ConfirmService, new ConfirmService());
        const features = new FeaturesService({} as CourseFeaturesApi);
        const tool = new DrawToolService();

        tool.activate(context(features));
        expect([...features.modeHiddenTypes.get()].sort()).toEqual(['oob', 'penalty_red', 'penalty_yellow', 'tree_area', 'vegetation_zone']);
        tool.chooseType('oob');
        expect(tool.drawType.get()).toBe('bunker'); // Draw never picks a rules type
        tool.chooseType('vegetation_zone');
        expect(tool.drawType.get()).toBe('bunker'); // nor a zone
        tool.chooseType('green');
        tool.chooseTreeArea();
        expect(tool.drawType.get()).toBe('green'); // nor a tree species area
        tool.deactivate();
        expect([...features.modeHiddenTypes.get()]).toEqual(['vegetation_zone', 'tree_area']); // zones and tree areas stay hidden outside Vegetation

        const ctx = context(features);
        (ctx.map.interactionMode as Signal<string>).set('furniture');
        tool.activate(ctx, { scope: 'rules', toolId: 'furniture' });
        expect(tool.scope.get()).toBe('rules');
        expect(features.niceRendering.get()).toBe(true);
        expect(features.rulesOutlines.get()).toBe(true);
        expect([...features.modeHiddenTypes.get()]).toEqual(['vegetation_zone', 'tree_area']);
        expect(tool.drawType.get()).toBe('penalty_yellow');
        tool.chooseType('fairway');
        expect(tool.drawType.get()).toBe('penalty_yellow'); // only rules types here
        tool.armRules('oob');
        expect(tool.drawType.get()).toBe('oob');
        expect(tool.state.isDrawing.get()).toBe(true);
        expect(tool.isEngaged()).toBe(true);
        tool.cancelDrawing();
        expect(tool.isEngaged()).toBe(false);

        tool.deactivate();
        expect(tool.scope.get()).toBe('surfaces');
        expect(features.rulesOutlines.get()).toBe(false);
        expect(tool.drawType.get()).toBe('green'); // Draw's own type comes back
    });

    test('the vegetation scope edits only the zones, over the course as a backdrop', () => {
        di.set(ConfirmService, new ConfirmService());
        const features = new FeaturesService({} as CourseFeaturesApi);
        const tool = new DrawToolService();
        tool.chooseType('fairway');

        const ctx = context(features);
        (ctx.map.interactionMode as Signal<string>).set('vegetation');
        tool.activate(ctx, { scope: 'vegetation', toolId: 'vegetation' });
        expect(tool.scope.get()).toBe('vegetation');
        expect(features.niceRendering.get()).toBe(false);
        expect([...features.modeHiddenTypes.get()].sort()).toEqual(['oob', 'penalty_red', 'penalty_yellow']);
        const backdrop = features.modeBackdropTypes.get();
        expect(backdrop.has('fairway') && backdrop.has('green') && backdrop.has('trees')).toBe(true);
        expect(backdrop.has('vegetation_zone') || backdrop.has('tree_area') || backdrop.has('oob')).toBe(false);
        expect(tool.drawType.get()).toBe('vegetation_zone');
        tool.chooseType('bunker');
        expect(tool.drawType.get()).toBe('vegetation_zone'); // only zones and tree areas here
        tool.chooseTreeArea(); // the picker's "Tree species area"
        expect(tool.drawType.get()).toBe('tree_area');
        tool.chooseZoneType('fern'); // nothing selected: the next zone's type, and back to drawing zones
        expect(tool.drawZoneType.get()).toBe('fern');
        expect(tool.drawType.get()).toBe('vegetation_zone');

        tool.deactivate();
        expect(tool.scope.get()).toBe('surfaces');
        expect(features.modeBackdropTypes.get().size).toBe(0);
        expect([...features.modeHiddenTypes.get()]).toEqual(['vegetation_zone', 'tree_area']);
        expect(tool.drawType.get()).toBe('fairway'); // Draw's own type comes back
    });

    test('scopes own disjoint types', () => {
        for (const type of ['green', 'trees', 'path', 'water_creek']) {
            expect([scopeOwnsType('surfaces', type), scopeOwnsType('rules', type), scopeOwnsType('vegetation', type)]).toEqual([true, false, false]);
        }
        expect([scopeOwnsType('surfaces', 'oob'), scopeOwnsType('rules', 'oob'), scopeOwnsType('vegetation', 'oob')]).toEqual([false, true, false]);
        expect([scopeOwnsType('surfaces', 'vegetation_zone'), scopeOwnsType('rules', 'vegetation_zone'), scopeOwnsType('vegetation', 'vegetation_zone')])
            .toEqual([false, false, true]);
    });

    test('Vegetation also selects the creeks and water (for their bank vegetation), nothing else of the course', () => {
        for (const type of ['water_creek', 'water']) {
            expect([scopeSelectsType('surfaces', type), scopeSelectsType('rules', type), scopeSelectsType('vegetation', type)]).toEqual([true, false, true]);
        }
        for (const type of ['green', 'fairway', 'bunker', 'oob']) expect(scopeSelectsType('vegetation', type)).toBe(false);
        expect(scopeSelectsType('vegetation', 'vegetation_zone')).toBe(true);
    });

    test('a Vegetation click takes a hand-drawn zone, then the water, then the generated zones planted on it', () => {
        const f = (id: string, type: string, generated = false) => ({ id, type, generated }) as CourseFeature;
        const topDown = [f('gen-bank', 'vegetation_zone', true), f('creek', 'water_creek'), f('gen-rough', 'vegetation_zone', true), f('section', 'vegetation_zone'), f('pond', 'water')];
        expect(vegetationHitOrder(topDown).map(x => x.id)).toEqual(['section', 'creek', 'pond', 'gen-bank', 'gen-rough']);
    });
});
