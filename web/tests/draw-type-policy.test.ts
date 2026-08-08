import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di } from '@basics/core/client/core';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';

// New-shape type policy: `typeFollowsLast` (default on = chain-draw feel) vs
// resetting `drawType` to a persisted `defaultDrawType` on every arm.

const FOLLOWS_KEY = 'golfmap.draw.typeFollowsLast';
const DEFAULT_KEY = 'golfmap.draw.defaultType';

function makeTool(): DrawToolService {
    di.set(ConfirmService, new ConfirmService());
    return new DrawToolService();
}

afterEach(() => {
    localStorage.removeItem(FOLLOWS_KEY);
    localStorage.removeItem(DEFAULT_KEY);
    _reset();
    di.reset();
});

describe('new-shape type policy', () => {
    test('defaults: follows last-used, default type bunker', () => {
        const tool = makeTool();
        expect(tool.typeFollowsLast.peek()).toBe(true);
        expect(tool.defaultDrawType.peek()).toBe('bunker');
    });

    test('follows-last (default): armDraw keeps the current draw type', () => {
        const tool = makeTool();
        tool.drawType.set('green');
        tool.armDraw();
        expect(tool.drawType.peek()).toBe('green');
        expect(tool.state.mode.peek()).toBe('draw');
    });

    test('policy off: armDraw resets the draw type to the default', () => {
        const tool = makeTool();
        tool.setDefaultDrawType('fairway');
        tool.setTypeFollowsLast(false);
        tool.drawType.set('green'); // e.g. a mid-chain digit pick
        tool.armDraw();
        expect(tool.drawType.peek()).toBe('fairway');
    });

    test('turning the policy off applies the default immediately', () => {
        const tool = makeTool();
        tool.drawType.set('green');
        tool.setDefaultDrawType('rough');
        tool.setTypeFollowsLast(false);
        expect(tool.drawType.peek()).toBe('rough');
    });

    test('changing the default while the policy is off re-arms the new default', () => {
        const tool = makeTool();
        tool.setTypeFollowsLast(false);
        tool.setDefaultDrawType('water');
        expect(tool.drawType.peek()).toBe('water');
    });

    test('both settings persist to localStorage and are read back on construction', () => {
        const tool = makeTool();
        tool.setTypeFollowsLast(false);
        tool.setDefaultDrawType('fairway');
        expect(localStorage.getItem(FOLLOWS_KEY)).toBe('0');
        expect(localStorage.getItem(DEFAULT_KEY)).toBe('fairway');

        const fresh = new DrawToolService();
        expect(fresh.typeFollowsLast.peek()).toBe(false);
        expect(fresh.defaultDrawType.peek()).toBe('fairway');
    });

    test('a garbage persisted default type falls back to bunker', () => {
        localStorage.setItem(DEFAULT_KEY, 'lava');
        const tool = makeTool();
        expect(tool.defaultDrawType.peek()).toBe('bunker');
    });

    test('policy off: closing a ring (chain-draw) resets the next shape to the default', () => {
        const cleanups: Array<() => void> = [];
        const tool = makeTool();
        tool.activate({
            map: {
                ready: { get: () => false, peek: () => false },
                map: { get: () => null, peek: () => null },
                interactionMode: { peek: () => 'draw' },
                onClick: () => () => {},
                onMouseMove: () => () => {},
            } as never,
            elevation: null as never,
            tileset: null as never,
            courseDetail: null as never,
            features: new FeaturesService({} as CourseFeaturesApi),
            courseId: 'course-1',
            track: (d: () => void) => { cleanups.push(d); },
        });
        try {
            tool.setDefaultDrawType('fairway');
            tool.setTypeFollowsLast(false);
            tool.armDraw();
            tool.drawType.set('green'); // mid-chain pick for THIS shape
            tool.state.addPoint({ x: 0, y: 0 });
            tool.state.addPoint({ x: 10, y: 0 });
            tool.state.addPoint({ x: 10, y: 10 });
            tool.closeDraft();
            expect(tool.state.mode.peek()).toBe('draw'); // chain-draw stays armed
            expect(tool.drawType.peek()).toBe('fairway'); // next shape = default
        } finally {
            for (const c of cleanups) c();
        }
    });
});
