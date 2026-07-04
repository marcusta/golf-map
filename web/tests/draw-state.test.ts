import { test, expect, describe } from 'bun:test';
import {
    DrawState,
    MIN_RING_POINTS,
    moveAnchor,
    moveHandle,
    setSymmetricHandles,
    clearHandles,
    hasHandles,
    deleteAnchor,
    insertAnchor,
} from '../src/draw/draw-state';
import type { FeatureGeometry } from '../src/geo/bezier';

// ── DrawState machine ─────────────────────────────────────────────────────

describe('DrawState', () => {
    test('starts in select mode with an empty draft', () => {
        const state = new DrawState();
        expect(state.mode.get()).toBe('select');
        expect(state.draft.get()).toEqual([]);
        expect(state.isDrawing.get()).toBe(false);
    });

    test('arm → addPoint accumulates anchors; canClose at 3 points', () => {
        const state = new DrawState();
        state.arm();
        expect(state.isDrawing.get()).toBe(true);

        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        expect(state.canClose.get()).toBe(false);
        state.addPoint({ x: 10, y: 10 });
        expect(state.canClose.get()).toBe(true);
        expect(state.draft.get()).toHaveLength(3);
    });

    test('addPoint is ignored in select mode', () => {
        const state = new DrawState();
        state.addPoint({ x: 1, y: 1 });
        expect(state.draft.get()).toEqual([]);
    });

    test('closeDraft below the minimum returns null and stays drawing', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        expect(state.closeDraft()).toBeNull();
        expect(state.mode.get()).toBe('draw');
    });

    test('closeDraft returns the ring and resets to select mode', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.addPoint({ x: 10, y: 10 });

        const ring = state.closeDraft();
        expect(ring!.points).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
        expect(ring!.points.length).toBeGreaterThanOrEqual(MIN_RING_POINTS);
        expect(state.mode.get()).toBe('select');
        expect(state.draft.get()).toEqual([]);
    });

    test('popPoint drops the last anchor (dblclick duplicate handling)', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.popPoint();
        expect(state.draft.get()).toEqual([{ x: 0, y: 0 }]);
    });

    test('rearming clears a stale draft', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.disarm();
        state.arm();
        expect(state.draft.get()).toEqual([]);
    });

    test('handleEscape consumes while drawing, not in select mode', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        expect(state.handleEscape()).toBe(true);
        expect(state.mode.get()).toBe('select');
        expect(state.draft.get()).toEqual([]);
        expect(state.handleEscape()).toBe(false);
    });
});

// ── Geometry edit operations ──────────────────────────────────────────────

function square(withHandles = false): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                withHandles
                    ? { x: 0, y: 0, hIn: { x: -3, y: 0 }, hOut: { x: 3, y: 0 } }
                    : { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        }],
    };
}

describe('moveAnchor', () => {
    test('moves the anchor and translates its handles; input untouched', () => {
        const geometry = square(true);
        const next = moveAnchor(geometry, 0, 0, { x: 5, y: 5 });

        expect(next.rings[0].points[0].x).toBe(5);
        expect(next.rings[0].points[0].y).toBe(5);
        expect(next.rings[0].points[0].hIn).toEqual({ x: 2, y: 5 });
        expect(next.rings[0].points[0].hOut).toEqual({ x: 8, y: 5 });

        // pure: original unchanged, new identity
        expect(geometry.rings[0].points[0].x).toBe(0);
        expect(next).not.toBe(geometry);
    });
});

describe('moveHandle', () => {
    test('symmetric move mirrors the opposite handle through the anchor', () => {
        const next = moveHandle(square(true), 0, 0, 'hOut', { x: 4, y: 6 });
        expect(next.rings[0].points[0].hOut).toEqual({ x: 4, y: 6 });
        expect(next.rings[0].points[0].hIn).toEqual({ x: -4, y: -6 });
    });

    test('asymmetric move leaves the opposite handle alone', () => {
        const next = moveHandle(square(true), 0, 0, 'hOut', { x: 4, y: 6 }, false);
        expect(next.rings[0].points[0].hOut).toEqual({ x: 4, y: 6 });
        expect(next.rings[0].points[0].hIn).toEqual({ x: -3, y: 0 });
    });
});

describe('setSymmetricHandles / clearHandles / hasHandles', () => {
    test('alt-drag pulls symmetric handles around the anchor', () => {
        const next = setSymmetricHandles(square(), 0, 1, { x: 14, y: 3 });
        const p = next.rings[0].points[1]; // anchor at (10, 0)
        expect(p.hOut).toEqual({ x: 14, y: 3 });
        expect(p.hIn).toEqual({ x: 6, y: -3 });
        expect(hasHandles(p)).toBe(true);
    });

    test('clearHandles straightens the vertex', () => {
        const geometry = square(true);
        expect(hasHandles(geometry.rings[0].points[0])).toBe(true);
        const next = clearHandles(geometry, 0, 0);
        expect(next.rings[0].points[0].hIn).toBeUndefined();
        expect(next.rings[0].points[0].hOut).toBeUndefined();
        expect(hasHandles(next.rings[0].points[0])).toBe(false);
    });
});

describe('deleteAnchor', () => {
    test('removes the anchor', () => {
        const next = deleteAnchor(square(), 0, 1)!;
        expect(next.rings[0].points.map(p => [p.x, p.y])).toEqual([
            [0, 0],
            [10, 10],
            [0, 10],
        ]);
    });

    test('refuses to shrink a ring below 3 anchors', () => {
        const triangle: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] }],
        };
        expect(deleteAnchor(triangle, 0, 0)).toBeNull();
    });
});

describe('insertAnchor', () => {
    test('inserts a plain on-line anchor on a straight segment', () => {
        const next = insertAnchor(square(), 0, 1, 0.5);
        expect(next.rings[0].points).toHaveLength(5);
        expect(next.rings[0].points[2]).toEqual({ x: 10, y: 5 });
    });

    test('only touches the targeted ring', () => {
        const geometry = square();
        geometry.rings.push({
            points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }],
        });
        const next = insertAnchor(geometry, 1, 0, 0.5);
        expect(next.rings[0].points).toHaveLength(4);
        expect(next.rings[1].points).toHaveLength(5);
        expect(next.rings[1].points[1]).toEqual({ x: 3, y: 2 });
    });
});
