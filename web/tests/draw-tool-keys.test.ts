import { afterEach, describe, expect, mock, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Track cleanups so the window keydown listener each activate() registers is
// torn down between tests (the mock ctx.track below feeds this array).
let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

function context(features: FeaturesService): ToolContext {
    const map = {
        ready: new Signal(false),
        map: new Signal(null),
        interactionMode: new Signal(DRAW_TOOL_ID), // makes isMyClaim() true
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
        track: (d: () => void) => { cleanups.push(d); },
    };
}

function armedTool(): { tool: DrawToolService; features: FeaturesService } {
    di.set(ConfirmService, new ConfirmService());
    const features = new FeaturesService({} as CourseFeaturesApi);
    const tool = new DrawToolService();
    tool.activate(context(features));
    return { tool, features };
}

function pressDigit(key: string, init: KeyboardEventInit = {}): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

describe('DrawToolService digit type switching (T39)', () => {
    test('a bare digit arms the mapped draw type', () => {
        const { tool } = armedTool();
        expect(tool.drawType.peek()).toBe('bunker'); // default

        pressDigit('3'); // green
        expect(tool.drawType.peek()).toBe('green');

        pressDigit('0'); // water_creek
        expect(tool.drawType.peek()).toBe('water_creek');
    });

    test('with a selection, a digit retypes instead of setting the draw type', () => {
        const { tool, features } = armedTool();
        features.selectedIds.set(new Set(['feat-1']));
        const retype = mock((_t: string) => {});
        tool.retypeSelection = retype as never;
        const before = tool.drawType.peek();

        pressDigit('4'); // bunker

        expect(retype).toHaveBeenCalledTimes(1);
        expect(retype.mock.calls[0][0]).toBe('bunker');
        expect(tool.drawType.peek()).toBe(before); // draw type untouched while retyping
    });

    test('armed with a selection (chain-draw), a digit sets the NEXT shape type and never retypes', () => {
        // create() selects each new shape, so mid-chain the previous shape is
        // always selected; the pick must go to the shape being drawn.
        const { tool, features } = armedTool();
        features.selectedIds.set(new Set(['feat-1']));
        const retype = mock((_t: string) => {});
        tool.retypeSelection = retype as never;
        tool.armDraw();

        pressDigit('3'); // green

        expect(retype).not.toHaveBeenCalled();
        expect(tool.drawType.peek()).toBe('green');
    });

    test('⌘/Ctrl/Alt + digit is ignored (reserved for browser tab switching)', () => {
        const { tool } = armedTool();
        pressDigit('2', { metaKey: true });
        pressDigit('2', { ctrlKey: true });
        pressDigit('2', { altKey: true });
        expect(tool.drawType.peek()).toBe('bunker'); // unchanged
    });

    test('digits typed into an input/textarea are ignored', () => {
        const { tool } = armedTool();
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
        expect(tool.drawType.peek()).toBe('bunker'); // unchanged
        input.remove();
    });

    test('an unmapped digit-adjacent key does nothing', () => {
        const { tool } = armedTool();
        pressDigit('!'); // shift+1 on many layouts — not a bare digit
        expect(tool.drawType.peek()).toBe('bunker');
    });
});
