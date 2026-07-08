// T24 — the D23 stack model as ONE rule across render, hit-testing and lie
// classification. Acceptance scenario 1 (the "rough island") is deliberately
// a SINGLE test: the same fixture drives the render sort key
// (FeaturesService), the editor hit walk (containingTopDown, what hitFeature/
// hitStack call) and the optimiser lie map (buildLieMap) — so they cannot
// silently disagree again (the bug D23 fixes). Plus the Alt+click cycle (D27).

import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { FeaturesService } from '../src/draw/features.service';
import { containingTopDown, advanceAltCycle } from '../src/draw/draw-tool.service';
import { buildLieMap } from '../src/planner/lie-map';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { Hole } from '../../shared/api/holes.gen';

afterEach(() => { _reset(); di.reset(); });

const base = wgs84ToSweref99tm(58.4015, 15.5658);

function square(half: number, cx = base.x, cy = base.y): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: cx - half, y: cy - half },
                { x: cx + half, y: cy - half },
                { x: cx + half, y: cy + half },
                { x: cx - half, y: cy + half },
            ],
        }],
    };
}

function feature(id: string, type: string, geometry: FeatureGeometry, sortOrder: number, holeId: string | null = null): CourseFeature {
    return { id, courseId: 'c1', holeId, type, geometry, geojson: null, sortOrder, version: 1 };
}

/** Register CourseDetailService (FeaturesService reads hole numbers for stackKey). */
function withHoles(holes: Array<{ id: string; number: number }>): void {
    const svc = new CourseDetailService();
    svc.holeStore.set(holes.map(h => ({
        ...h, courseId: 'c1', par: 4, strokeIndex: null, notes: null, savedRegionJson: null,
        version: 1, createdAt: '', updatedAt: '',
    } satisfies Hole)));
    di.set(CourseDetailService, svc);
}

function stackKeyOf(svc: FeaturesService, id: string): number {
    const f = svc.geojson.get().features.find(feat => feat.id === id);
    return (f?.properties?.stackKey as number) ?? NaN;
}

describe('D23 stack model — render / hit / lie agree (acceptance scenario 1)', () => {
    const NO_HIDDEN = new Set<string>();
    const islandCenter = { x: base.x, y: base.y };       // inside both shapes
    const fairwayOnly = { x: base.x + 30, y: base.y };    // inside fairway, outside island

    test('rough island above the fairway: renders on top, hits, and classifies as rough — then flips together when lowered', () => {
        withHoles([]);
        const svc = new FeaturesService();

        // Fairway (large) with a smaller rough polygon inside it, rough ABOVE
        // the fairway in the stack (higher sortOrder).
        const fairway = feature('fair', 'fairway', square(50), 0);
        const rough = feature('isle', 'rough', square(10), 1);
        svc.store.set([fairway, rough]);

        // 1. RENDER: the rough sorts on top (larger fill-sort-key), and
        //    stackTopDown lists it first.
        expect(stackKeyOf(svc, 'isle')).toBeGreaterThan(stackKeyOf(svc, 'fair'));
        expect(svc.stackTopDown.get().map(f => f.id)).toEqual(['isle', 'fair']);

        // 2. HIT: a plain click at the island centre resolves to the rough
        //    (this is exactly what hitFeature returns — first of the stack).
        const hit = containingTopDown(svc.stackTopDown.get(), NO_HIDDEN, islandCenter);
        expect(hit.map(f => f.id)).toEqual(['isle', 'fair']); // both contain it, topmost first
        expect(hit[0].id).toBe('isle');

        // 3. LIE: the optimiser classifies the same point as rough.
        const lie = buildLieMap(svc.store.items.get());
        expect(lie.classifyLie(islandCenter)).toBe('rough');

        // Fairway-only point stays fairway across all three (the island isn't
        // just swallowing everything).
        expect(containingTopDown(svc.stackTopDown.get(), NO_HIDDEN, fairwayOnly)[0].id).toBe('fair');
        expect(lie.classifyLie(fairwayOnly)).toBe('fairway');

        // Lower the rough BELOW the fairway — all three flip to fairway.
        svc.store.set([feature('fair', 'fairway', square(50), 1), feature('isle', 'rough', square(10), 0)]);
        expect(stackKeyOf(svc, 'fair')).toBeGreaterThan(stackKeyOf(svc, 'isle'));
        expect(svc.stackTopDown.get().map(f => f.id)).toEqual(['fair', 'isle']);
        expect(containingTopDown(svc.stackTopDown.get(), NO_HIDDEN, islandCenter)[0].id).toBe('fair');
        expect(buildLieMap(svc.store.items.get()).classifyLie(islandCenter)).toBe('fairway');
    });

    test('hidden types drop out of the hit stack', () => {
        withHoles([]);
        const svc = new FeaturesService();
        svc.store.set([feature('fair', 'fairway', square(50), 0), feature('isle', 'rough', square(10), 1)]);
        // Rough hidden → the click falls through to the fairway underneath.
        const hit = containingTopDown(svc.stackTopDown.get(), new Set(['rough']), islandCenter);
        expect(hit.map(f => f.id)).toEqual(['fair']);
    });
});

describe('advanceAltCycle (D27 Alt+click)', () => {
    test('first click selects topmost; repeats step down and wrap', () => {
        const ids = ['top', 'mid', 'bot'];
        let cycle = advanceAltCycle(null, ids);
        expect(cycle.index).toBe(0);        // topmost
        cycle = advanceAltCycle(cycle, ids);
        expect(cycle.index).toBe(1);        // one deeper
        cycle = advanceAltCycle(cycle, ids);
        expect(cycle.index).toBe(2);        // bottom
        cycle = advanceAltCycle(cycle, ids);
        expect(cycle.index).toBe(0);        // wraps to topmost
    });

    test('a different stack resets to the topmost', () => {
        const first = advanceAltCycle(advanceAltCycle(null, ['a', 'b']), ['a', 'b']);
        expect(first.index).toBe(1);
        const moved = advanceAltCycle(first, ['x', 'y', 'z']); // stack changed
        expect(moved).toEqual({ ids: ['x', 'y', 'z'], index: 0 });
    });
});
