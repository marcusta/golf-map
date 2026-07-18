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
    insertControlPoint,
    toggleVertexCorner,
    isCornerVertex,
    bakeBsplineToBezier,
    translateGeometry,
    deleteVertices,
    insertBetweenVertices,
    rdpSimplify,
    simplifyGeometry,
    offsetGeometry,
    canOffsetGeometry,
    featuresInRect,
    verticesInRect,
    rectFromCorners,
    vertexKey,
    parseVertexKey,
} from '../src/draw/draw-state';
import { flattenRing, type FeatureGeometry } from '../src/geo/bezier';

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

    test('closeDraft returns the ring and stays armed (sticky chain-draw)', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.addPoint({ x: 10, y: 10 });
        state.addPoint({ x: 0, y: 10 });
        state.undoPoint(); // parks a point on the ephemeral redo stack

        const ring = state.closeDraft();
        expect(ring!.points).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
        expect(ring!.points.length).toBeGreaterThanOrEqual(MIN_RING_POINTS);
        // Sticky: stay in draw mode with a cleared draft + redo stack so the
        // next click begins the next shape of the same type.
        expect(state.mode.get()).toBe('draw');
        expect(state.isDrawing.get()).toBe(true);
        expect(state.draft.get()).toEqual([]);
        expect(state.redoPoint()).toBe(false); // redo stack cleared on close
    });

    test('close then addPoint starts ring 2 (chain-draw)', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.addPoint({ x: 10, y: 10 });
        state.closeDraft();

        // Still armed: the next point begins a fresh draft.
        state.addPoint({ x: 100, y: 100 });
        expect(state.mode.get()).toBe('draw');
        expect(state.draft.get()).toEqual([{ x: 100, y: 100 }]);
    });

    test('Esc after a sticky close exits draw mode', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.addPoint({ x: 10, y: 10 });
        state.closeDraft();
        expect(state.isDrawing.get()).toBe(true);

        expect(state.handleEscape()).toBe(true);
        expect(state.mode.get()).toBe('select');
        expect(state.draft.get()).toEqual([]);
    });

    test('starts with box-select off', () => {
        const state = new DrawState();
        expect(state.boxSelect.get()).toBe(false);
    });

    test('toggleBoxSelect flips the sticky flag', () => {
        const state = new DrawState();
        state.toggleBoxSelect();
        expect(state.boxSelect.get()).toBe(true);
        state.toggleBoxSelect();
        expect(state.boxSelect.get()).toBe(false);
    });

    test('toggleBoxSelect while drawing leaves draw mode, then arms box-select', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.toggleBoxSelect();
        expect(state.isDrawing.get()).toBe(false);
        expect(state.mode.get()).toBe('select');
        expect(state.boxSelect.get()).toBe(true);
    });

    test('arm clears box-select (drawing and box-select are exclusive)', () => {
        const state = new DrawState();
        state.toggleBoxSelect();
        expect(state.boxSelect.get()).toBe(true);
        state.arm();
        expect(state.boxSelect.get()).toBe(false);
        expect(state.mode.get()).toBe('draw');
    });

    test('popPoint drops the last anchor', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.popPoint();
        expect(state.draft.get()).toEqual([{ x: 0, y: 0 }]);
    });

    test('discardDoubleClickDuplicate removes duplicate point and keeps draft open', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.addPoint({ x: 10, y: 10 });
        state.addPoint({ x: 10, y: 10 });

        expect(state.discardDoubleClickDuplicate()).toBe(true);

        expect(state.mode.get()).toBe('draw');
        expect(state.draft.get()).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
        expect(state.canClose.get()).toBe(true);
    });

    test('discardDoubleClickDuplicate is ignored outside drawing', () => {
        const state = new DrawState();
        expect(state.discardDoubleClickDuplicate()).toBe(false);
        expect(state.mode.get()).toBe('select');
        expect(state.draft.get()).toEqual([]);
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

// ── B-spline additions ────────────────────────────────────────────────────

function splineSquare(): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        curveType: 'bspline',
        rings: [{
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0, corner: true },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        }],
    };
}

describe('DrawState corner points', () => {
    test('addPoint with corner=true marks the control point', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 }, true); // Shift+click
        state.addPoint({ x: 10, y: 10 }, false);
        expect(state.draft.get()).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0, corner: true },
            { x: 10, y: 10 },
        ]);
        const ring = state.closeDraft()!;
        expect(ring.points[1].corner).toBe(true);
        expect(ring.points[0].corner).toBeUndefined();
    });
});

describe('toggleVertexCorner / isCornerVertex', () => {
    test('bspline: flips the corner flag both ways; input untouched', () => {
        const geometry = splineSquare();
        expect(isCornerVertex(geometry, 0, 0)).toBe(false);
        expect(isCornerVertex(geometry, 0, 1)).toBe(true);

        const on = toggleVertexCorner(geometry, 0, 0);
        expect(on.rings[0].points[0].corner).toBe(true);
        expect(on.curveType).toBe('bspline'); // clone preserves curveType
        expect(isCornerVertex(on, 0, 0)).toBe(true);

        const off = toggleVertexCorner(geometry, 0, 1);
        expect(off.rings[0].points[1].corner).toBeUndefined();

        expect(geometry.rings[0].points[0].corner).toBeUndefined(); // pure
    });

    test('bezier: corner drops handles; smooth computes Catmull-Rom handles', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: 0, y: 0, hIn: { x: -3, y: 0 }, hOut: { x: 3, y: 0 } },
                    { x: 10, y: 0 },
                    { x: 10, y: 10 },
                    { x: 0, y: 10 },
                ],
            }],
        };
        // Curved vertex → corner: handles dropped.
        const cornered = toggleVertexCorner(geometry, 0, 0);
        expect(cornered.rings[0].points[0].hIn).toBeUndefined();
        expect(cornered.rings[0].points[0].hOut).toBeUndefined();
        expect(isCornerVertex(cornered, 0, 0)).toBe(true);

        // Straight vertex → smooth: ±(P[i+1] − P[i−1])/6 around the anchor.
        // Vertex 1 at (10,0): prev (0,0), next (10,10) → d = (10/6, 10/6).
        const smoothed = toggleVertexCorner(geometry, 0, 1);
        const p = smoothed.rings[0].points[1];
        expect(p.hOut).toEqual({ x: 10 + 10 / 6, y: 10 / 6 });
        expect(p.hIn).toEqual({ x: 10 - 10 / 6, y: -10 / 6 });
        expect(isCornerVertex(smoothed, 0, 1)).toBe(false);
    });
});

describe('insertControlPoint', () => {
    test('splices a smooth control after the given index', () => {
        const geometry = splineSquare();
        const next = insertControlPoint(geometry, 0, 1, { x: 12, y: 5 });
        expect(next.rings[0].points).toHaveLength(5);
        expect(next.rings[0].points[2]).toEqual({ x: 12, y: 5 });
        expect(next.rings[0].points[1].corner).toBe(true); // neighbors kept
        expect(next.curveType).toBe('bspline');
        expect(geometry.rings[0].points).toHaveLength(4); // pure
    });
});

describe('bakeBsplineToBezier', () => {
    test('bakes to curveType bezier with identical flattened outline', () => {
        const geometry = splineSquare();
        const baked = bakeBsplineToBezier(geometry);
        expect(baked.curveType).toBe('bezier');
        // 4 controls, one corner → 6 expanded controls → 6 bezier anchors.
        expect(baked.rings[0].points).toHaveLength(6);
        expect(baked.rings[0].points.every(p => !p.corner)).toBe(true);

        const before = flattenRing(geometry.rings[0], 0.1, 'bspline');
        const after = flattenRing(baked.rings[0], 0.1, baked.curveType);
        // The bake IS the conversion the flattener uses — outputs match
        // exactly point-for-point.
        expect(after).toEqual(before);
    });

    test('bezier input is returned unchanged', () => {
        const geometry = square();
        expect(bakeBsplineToBezier(geometry)).toBe(geometry);
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

// ── Round-2 editing operations ────────────────────────────────────────────

describe('mid-draw point undo/redo (ephemeral stack)', () => {
    test('undoPoint removes the last placed point; redoPoint restores it', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.addPoint({ x: 10, y: 10 });

        expect(state.undoPoint()).toBe('point');
        expect(state.draft.get()).toHaveLength(2);
        expect(state.redoPoint()).toBe(true);
        expect(state.draft.get()).toHaveLength(3);
        expect(state.draft.get()[2]).toEqual({ x: 10, y: 10 });
    });

    test('undoing the first point cancels the draw', () => {
        const state = new DrawState();
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        expect(state.undoPoint()).toBe('cancelled');
        expect(state.mode.get()).toBe('select');
    });

    test('placing a new point clears the redo stack; select mode is a no-op', () => {
        const state = new DrawState();
        expect(state.undoPoint()).toBeNull();
        expect(state.redoPoint()).toBe(false);
        state.arm();
        state.addPoint({ x: 0, y: 0 });
        state.addPoint({ x: 10, y: 0 });
        state.undoPoint();
        state.addPoint({ x: 5, y: 5 }); // forks — redo gone
        expect(state.redoPoint()).toBe(false);
    });
});

describe('translateGeometry', () => {
    test('moves all anchors and handles by the delta (duplicate offset math)', () => {
        const next = translateGeometry(square(true), 10, 10);
        expect(next.rings[0].points[0].x).toBe(10);
        expect(next.rings[0].points[0].y).toBe(10);
        expect(next.rings[0].points[0].hIn).toEqual({ x: 7, y: 10 });
        expect(next.rings[0].points[0].hOut).toEqual({ x: 13, y: 10 });
        expect(next.rings[0].points[2]).toEqual({ x: 20, y: 20 });
    });

    test('input is not mutated', () => {
        const geometry = square();
        translateGeometry(geometry, 5, 5);
        expect(geometry.rings[0].points[0]).toEqual({ x: 0, y: 0 });
    });
});

describe('deleteVertices', () => {
    test('removes the keyed vertices', () => {
        const geometry = square();
        geometry.rings[0].points.push({ x: -5, y: 5 });
        const next = deleteVertices(geometry, new Set(['0:1', '0:3']));
        expect(next!.rings[0].points).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 10 },
            { x: -5, y: 5 },
        ]);
    });

    test('all-or-nothing guard: any ring below 3 points rejects the whole delete', () => {
        expect(deleteVertices(square(), new Set(['0:0', '0:1']))).toBeNull();
        // Multi-ring: ring 1 would fall below 3 → whole op rejected.
        const geometry = square();
        geometry.rings.push({ points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 3, y: 4 }] });
        expect(deleteVertices(geometry, new Set(['0:0', '1:0']))).toBeNull();
        // Deleting only from the big ring is fine.
        expect(deleteVertices(geometry, new Set(['0:0']))!.rings[0].points).toHaveLength(3);
    });
});

describe('insertBetweenVertices', () => {
    test('redistributes in-between vertices evenly along the chord', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: 0, y: 0 },
                    { x: 3, y: 4 },   // off-chord — will be redistributed
                    { x: 6, y: -2 },  // off-chord — will be redistributed
                    { x: 9, y: 0 },
                    { x: 5, y: 10 },
                ],
            }],
        };
        const result = insertBetweenVertices(geometry, 0, 0, 3)!;
        const points = result.geometry.rings[0].points;
        expect(points).toHaveLength(6);
        // 3 evenly spaced points along the straight chord (0,0) → (9,0).
        expect(points[1]).toEqual({ x: 2.25, y: 0 });
        expect(points[2]).toEqual({ x: 4.5, y: 0 });
        expect(points[3]).toEqual({ x: 6.75, y: 0 });
        expect(points[4]).toEqual({ x: 9, y: 0 });
        // Selection follows: second endpoint shifted by the insertion.
        expect(result.selection).toEqual(['0:0', '0:4']);
    });

    test('adjacent vertices get a plain midpoint', () => {
        const result = insertBetweenVertices(square(), 0, 1, 2)!;
        const points = result.geometry.rings[0].points;
        expect(points).toHaveLength(5);
        expect(points[2]).toEqual({ x: 10, y: 5 });
        expect(result.selection).toEqual(['0:1', '0:3']);
    });

    test('wrap-around (first + last selected) appends the closing midpoint', () => {
        const result = insertBetweenVertices(square(), 0, 0, 3)!;
        const points = result.geometry.rings[0].points;
        expect(points).toHaveLength(5);
        expect(points[4]).toEqual({ x: 0, y: 5 });
        expect(result.selection).toEqual(['0:0', '0:3']);
    });
});

describe('rdpSimplify', () => {
    test('drops near-collinear points within epsilon', () => {
        const line = [
            { x: 0, y: 0 },
            { x: 2, y: 0.1 },
            { x: 4, y: -0.2 },
            { x: 6, y: 0.05 },
            { x: 10, y: 0 },
        ];
        expect(rdpSimplify(line, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    });

    test('keeps significant detours', () => {
        const line = [
            { x: 0, y: 0 },
            { x: 5, y: 4 }, // 4 m off the base line — kept
            { x: 10, y: 0 },
        ];
        expect(rdpSimplify(line, 0.5)).toEqual(line);
        expect(rdpSimplify(line, 5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    });

    test('surviving anchor points keep their handles', () => {
        const line = [
            { x: 0, y: 0, hOut: { x: 1, y: 1 } },
            { x: 5, y: 0.01 },
            { x: 10, y: 0, hIn: { x: 9, y: 1 } },
        ];
        const out = rdpSimplify(line, 0.5);
        expect(out).toHaveLength(2);
        expect(out[0].hOut).toEqual({ x: 1, y: 1 });
        expect(out[1].hIn).toEqual({ x: 9, y: 1 });
    });
});

describe('simplifyGeometry', () => {
    test('reduces a dense noisy ring; never below 3 points', () => {
        // A 40-point circle-ish ring with tiny jitter.
        const points = Array.from({ length: 40 }, (_, i) => {
            const a = (i / 40) * 2 * Math.PI;
            const r = 20 + (i % 2 === 0 ? 0.05 : -0.05);
            return { x: r * Math.cos(a), y: r * Math.sin(a) };
        });
        const geometry: FeatureGeometry = { crs: 'EPSG:3006', rings: [{ points }] };

        const simplified = simplifyGeometry(geometry, 0.5);
        const n = simplified.rings[0].points.length;
        expect(n).toBeLessThan(40);
        expect(n).toBeGreaterThanOrEqual(3);

        // Tiny epsilon keeps everything.
        expect(simplifyGeometry(geometry, 0.001).rings[0].points.length).toBe(40);
    });

    test('a minimal 3-point ring is untouched', () => {
        const tri: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0.01 }] }],
        };
        expect(simplifyGeometry(tri, 5).rings[0].points).toHaveLength(3);
    });
});

describe('offsetGeometry (expand / contract)', () => {
    test('square expands to a bigger square (winding-aware, both orders)', () => {
        for (const reverse of [false, true]) {
            const geometry = square();
            if (reverse) geometry.rings[0].points.reverse();
            const next = offsetGeometry(geometry, 1)!;
            const xs = next.rings[0].points.map(p => p.x);
            const ys = next.rings[0].points.map(p => p.y);
            // Corner normals are diagonal with miter √2 → exactly ±1 in x/y.
            expect(Math.min(...xs)).toBeCloseTo(-1, 6);
            expect(Math.max(...xs)).toBeCloseTo(11, 6);
            expect(Math.min(...ys)).toBeCloseTo(-1, 6);
            expect(Math.max(...ys)).toBeCloseTo(11, 6);
        }
    });

    test('contract shrinks the square', () => {
        const next = offsetGeometry(square(), -2)!;
        const xs = next.rings[0].points.map(p => p.x);
        expect(Math.min(...xs)).toBeCloseTo(2, 6);
        expect(Math.max(...xs)).toBeCloseTo(8, 6);
    });

    test('miter clamp: a sharp spike moves at most 4× the distance', () => {
        const spike: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: 0, y: 0 },
                    { x: 20, y: 0 },
                    { x: 10, y: 30 }, // sharp-ish apex
                    { x: 10.5, y: 31 }, // very sharp pair
                ],
            }],
        };
        const next = offsetGeometry(spike, 1)!;
        spike.rings[0].points.forEach((p, i) => {
            const q = next.rings[0].points[i];
            const moved = Math.hypot(q.x - p.x, q.y - p.y);
            expect(moved).toBeLessThanOrEqual(4 + 1e-9);
        });
    });

    test('collapse guard: contraction ≥ half the min dimension is rejected', () => {
        expect(offsetGeometry(square(), -5)).toBeNull();   // 10 m square, 2·5 = 10 — rejected
        expect(offsetGeometry(square(), -4.9)).not.toBeNull();
        expect(canOffsetGeometry(square(), -5)).toBe(false);
        expect(canOffsetGeometry(square(), 100)).toBe(true); // expansion never guarded
    });

    test('hole rings offset the OPPOSITE direction', () => {
        const geometry = square();
        geometry.rings[0].points = geometry.rings[0].points.map(p => ({ x: p.x * 3, y: p.y * 3 })); // 30 m outer
        geometry.rings.push({
            points: [
                { x: 10, y: 10 },
                { x: 20, y: 10 },
                { x: 20, y: 20 },
                { x: 10, y: 20 },
            ],
        });
        const next = offsetGeometry(geometry, 1)!;
        // Outer grows...
        expect(Math.min(...next.rings[0].points.map(p => p.x))).toBeCloseTo(-1, 6);
        // ...the hole SHRINKS (material grows into the cutout).
        expect(Math.min(...next.rings[1].points.map(p => p.x))).toBeCloseTo(11, 6);
        expect(Math.max(...next.rings[1].points.map(p => p.x))).toBeCloseTo(19, 6);
    });
});

describe('marquee hit math', () => {
    const items = [
        { id: 'a', geometry: square() },                                  // 0..10
        { id: 'b', geometry: translateGeometry(square(), 20, 0) },        // 20..30
        { id: 'c', geometry: translateGeometry(square(), 8, 8) },         // 8..18 (straddles)
    ];

    test('contain: only features fully inside the rect', () => {
        const rect = rectFromCorners({ x: -1, y: -1 }, { x: 15, y: 15 });
        expect(featuresInRect(items, rect, 'contain')).toEqual(['a']);
    });

    test('intersect (Alt): any bbox overlap counts', () => {
        const rect = rectFromCorners({ x: -1, y: -1 }, { x: 15, y: 15 });
        expect(featuresInRect(items, rect, 'intersect')).toEqual(['a', 'c']);
    });

    test('rectFromCorners normalizes any drag direction', () => {
        expect(rectFromCorners({ x: 15, y: 15 }, { x: -1, y: -1 }))
            .toEqual({ minX: -1, minY: -1, maxX: 15, maxY: 15 });
    });

    test('verticesInRect returns vertex keys of points inside (all rings)', () => {
        const geometry = square();
        geometry.rings.push({ points: [{ x: 2, y: 2 }, { x: 40, y: 2 }, { x: 3, y: 4 }] });
        const rect = rectFromCorners({ x: -1, y: -1 }, { x: 5, y: 5 });
        expect(verticesInRect(geometry, rect)).toEqual(['0:0', '1:0', '1:2']);
    });
});

describe('vertexKey / parseVertexKey', () => {
    test('round-trips', () => {
        expect(vertexKey(2, 17)).toBe('2:17');
        expect(parseVertexKey('2:17')).toEqual({ ringIdx: 2, idx: 17 });
    });
});
