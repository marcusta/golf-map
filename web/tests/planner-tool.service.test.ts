// T9/D10 seam — PlannerToolService wires the green-slope DEM adapter
// (green-slope.ts) into the live caddy so `greenSlopeHalfRule` can actually
// fire from the Plan UI. Exercises the REAL service (di-registered fakes for
// the data services it reads, a stub AnalysisApi standing in for the network
// — house rule: no mocking library, hand-built fakes only) end to end: select
// a hole with a tee + a mapped green that tilts back-to-front → a fetched
// slope grid → `greenSlopeSummary` set → `runCaddy` surfaces the rule's
// advice on the approach leg. Then proves a hole change clears it.

import { test, expect, describe, afterEach } from 'bun:test';
import { di, Router } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { PlannerToolService } from '../src/planner/planner-tool.service';
import { PlanService } from '../src/planner/plan.service';
import type { PlanShot } from '../../shared/api/game-plans.gen';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FeaturesService } from '../src/draw/features.service';
import { FurnitureService } from '../src/furniture/furniture.service';
import { wgs84ToSweref99tm, sweref99tmToWgs84 } from '../src/geo/transform';
import type { Hole } from '../../shared/api/holes.gen';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import type { Tee } from '../../shared/api/tees.gen';
import type { Green } from '../../shared/api/greens.gen';
import type { AnalysisApi, SampleGrid } from '../../shared/api/analysis.gen';
import type { FeatureGeometry } from '../src/geo/bezier';

afterEach(() => { _reset(); di.reset(); });

/** Flush the effect's queueMicrotask + the fake fetch's microtask + the
 *  refreshStrategy coalescing microtask it triggers on resolve. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const TEE_LATLON = sweref99tmToWgs84(500000, 6468000); // planar origin
const GREEN_CENTER_XY = { x: 500000, y: 6468100 }; // 100 m due north of the tee
const GREEN_CENTER_LATLON = sweref99tmToWgs84(GREEN_CENTER_XY.x, GREEN_CENTER_XY.y);

function square(half: number, cx: number, cy: number): FeatureGeometry {
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

function hole(id: string, number: number): Hole {
    return {
        id, courseId: 'c1', number, par: 4, strokeIndex: null, notes: null,
        savedRegionJson: null, version: 1, createdAt: '', updatedAt: '',
    };
}

function greenFeature(id: string, holeId: string): CourseFeature {
    return {
        id, courseId: 'c1', holeId, type: 'green',
        geometry: square(15, GREEN_CENTER_XY.x, GREEN_CENTER_XY.y),
        geojson: null, sortOrder: 0, source: null, sourceRef: null, license: null, version: 1,
    };
}

function tee(id: string, holeId: string): Tee {
    return {
        id, holeId, name: 'White', color: 'white',
        lat: TEE_LATLON.lat, lon: TEE_LATLON.lon, elevation: 0, sortOrder: 0, version: 1,
    };
}

function greenRow(id: string, holeId: string): Green {
    return {
        id, holeId, boundaryJson: null,
        centerLat: GREEN_CENTER_LATLON.lat, centerLon: GREEN_CENTER_LATLON.lon,
        frontLat: null, frontLon: null, backLat: null, backLon: null,
        elevation: 0, version: 1,
    };
}

/**
 * A 30x30 m grid over the green (NW corner origin, row 0 = north) that rises
 * to the north and falls toward the tee (south) — the same "back-to-front for
 * a north-playing shot" geometry as the rule's own unit tests
 * (green-slope-half.test.ts) and the pure summarizeGreenSlope tests
 * (green-slope.test.ts): ~10% fall line, bearing ≈ 180°.
 */
function tiltedGreenGrid(): SampleGrid {
    const resolution = 5;
    const width = 6;
    const height = 6;
    const origin = { e: GREEN_CENTER_XY.x - 15, n: GREEN_CENTER_XY.y + 15 };
    const heights: number[] = [];
    const insideMask: number[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            heights.push((height - 1 - row) * 0.5); // higher to the north (row 0)
            insideMask.push(1);
        }
    }
    return { heights, insideMask, origin, resolution, width, height };
}

/** Stub AnalysisApi — no mocking library, a hand-built fake matching the
 *  interface (simpler than routing global fetch since the service takes the
 *  client directly). */
function stubAnalysisApi(grid: SampleGrid | (() => SampleGrid)): {
    api: AnalysisApi;
    calls: Array<{ featureId?: string; courseId: string }>;
} {
    const calls: Array<{ featureId?: string; courseId: string }> = [];
    return {
        calls,
        api: {
            async sampleGrid(input) {
                calls.push(input);
                return typeof grid === 'function' ? grid() : grid;
            },
            async sampleElevations() {
                return { elevations: [] };
            },
        },
    };
}

/** Register the DI fakes a hole/green selection needs, WITHOUT a plan
 *  (tee + green alone already yields one approach leg — see buildHolePlan). */
function seedHoleWithGreen(h: Hole, opts: { withGreenRow?: boolean } = {}): void {
    const courseDetail = new CourseDetailService();
    courseDetail.holeStore.set([h]);
    di.set(CourseDetailService, courseDetail);

    const features = new FeaturesService();
    features.store.set([greenFeature('green-feat-1', h.id)]);
    di.set(FeaturesService, features);

    const furniture = new FurnitureService();
    furniture.tees.set([tee('tee-1', h.id)]);
    if (opts.withGreenRow !== false) furniture.greens.set([greenRow('green-row-1', h.id)]);
    di.set(FurnitureService, furniture);
}

function selectHole(number: number): void {
    di.get(Router).navigate('/planner', { query: { hole: String(number) } });
}

describe('PlannerToolService — option score chips (T30, enrich cadence)', () => {
    /** Two root options for hole 1 (a tee decision point), no clubs — the
     *  chain scorer's point-estimate branch prices them regardless. */
    function seedOptionPlan(): { plan: PlanService; a: PlanShot; b: PlanShot } {
        const mk = (id: string, sortOrder: number, eastM: number): PlanShot => {
            const p = sweref99tmToWgs84(GREEN_CENTER_XY.x + eastM, GREEN_CENTER_XY.y - 40);
            return {
                id, gamePlanHoleId: 'ph1', parentShotId: null, sortOrder,
                lat: p.lat, lon: p.lon, elevation: null, clubId: null, label: null, version: 1,
            };
        };
        const a = mk('opt-a', 0, -12);
        const b = mk('opt-b', 1, 12);
        const plan = new PlanService();
        plan.holes.set([{
            id: 'ph1', gamePlanId: 'p1', holeNumber: 1, teeId: null, preferredClubId: null,
            plannedDirectionDeg: null, windSpeedMps: null, windDirectionDeg: null,
            notes: null, version: 1,
        }]);
        plan.shots.set([a, b]);
        di.set(PlanService, plan);
        return { plan, a, b };
    }

    test('sibling options get chips on the enrich pass; a drag frame empties them without re-enriching', async () => {
        seedHoleWithGreen(hole('h1', 1));
        const { plan, a } = seedOptionPlan();
        selectHole(1);
        const { api } = stubAnalysisApi(tiltedGreenGrid());

        const svc = new PlannerToolService(api);
        const disposers: Array<() => void> = [];
        svc.start(d => disposers.push(d));
        await settle();

        // Both options of the tee decision point are priced.
        const chips = svc.optionChips.get();
        expect(chips.map(c => c.shotId).sort()).toEqual(['opt-a', 'opt-b']);
        for (const chip of chips) {
            expect(chip.strokesBefore).toBe(0);
            expect(chip.probableScore).toBeGreaterThan(1);
        }
        const enrichesBefore = svc.enrichCount.get();

        // A per-frame drag patch (no network, cadence-exempt): the live plan
        // moves past the priced base → chips drop out, and NO enrichment runs.
        plan.patchShotLocal(a.id, { lat: a.lat + 0.0002 });
        expect(svc.optionChips.get()).toEqual([]);
        await settle();
        expect(svc.optionChips.get()).toEqual([]);
        expect(svc.enrichCount.get()).toBe(enrichesBefore); // cadence held

        for (const dispose of disposers) dispose();
    });
});

describe('PlannerToolService — green-slope caddy seam (D10)', () => {
    test('selecting a hole with a tilted, mapped green fetches the slope grid and the caddy surfaces green-slope-half advice', async () => {
        seedHoleWithGreen(hole('h1', 1));
        selectHole(1);
        const { api, calls } = stubAnalysisApi(tiltedGreenGrid());

        const svc = new PlannerToolService(api);
        const disposers: Array<() => void> = [];
        svc.start(d => disposers.push(d));
        await settle();

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ courseId: 'c1', featureId: 'green-feat-1' });

        const summary = svc.greenSlopeSummary.get();
        expect(summary).not.toBeNull();
        expect(summary!.fallLinePct).toBeGreaterThan(3);
        expect(summary!.fallLineBearingDeg).toBeCloseTo(180, 0);

        const advice = svc.caddyAdvice.get();
        const slopeAdvice = advice.find(a => a.ruleId === 'green-slope-half');
        expect(slopeAdvice).toBeDefined();
        expect(slopeAdvice!.headline).toContain('short half');

        for (const dispose of disposers) dispose();
    });

    test('changing the selected hole clears greenSlopeSummary immediately (no stale advice)', async () => {
        seedHoleWithGreen(hole('h1', 1));
        // A second hole with NO green feature at all — the fetch should never
        // fire for it, and the previous hole's summary must not survive.
        const courseDetail = di.get(CourseDetailService);
        courseDetail.holeStore.set([hole('h1', 1), hole('h2', 2)]);
        selectHole(1);
        const { api, calls } = stubAnalysisApi(tiltedGreenGrid());

        const svc = new PlannerToolService(api);
        const disposers: Array<() => void> = [];
        svc.start(d => disposers.push(d));
        await settle();
        expect(svc.greenSlopeSummary.get()).not.toBeNull();
        expect(calls).toHaveLength(1);

        selectHole(2); // hole 2 has no green feature mapped
        // Cleared SYNCHRONOUSLY on the hole-change effect run, before any
        // microtask/fetch — no stale advice window.
        expect(svc.greenSlopeSummary.get()).toBeNull();
        expect(svc.caddyAdvice.get().find(a => a.ruleId === 'green-slope-half')).toBeUndefined();

        await settle();
        // No green on hole 2 → no fetch, stays cleared, degrades silently.
        expect(calls).toHaveLength(1);
        expect(svc.greenSlopeSummary.get()).toBeNull();

        for (const dispose of disposers) dispose();
    });

    test('a hole with a mapped green but no furniture green row degrades silently (no crash, no summary)', async () => {
        seedHoleWithGreen(hole('h1', 1), { withGreenRow: false });
        selectHole(1);
        const { api, calls } = stubAnalysisApi(tiltedGreenGrid());

        const svc = new PlannerToolService(api);
        const disposers: Array<() => void> = [];
        svc.start(d => disposers.push(d));
        await settle();

        expect(calls).toHaveLength(0); // never reached the fetch — no axis to fetch for
        expect(svc.greenSlopeSummary.get()).toBeNull();

        for (const dispose of disposers) dispose();
    });

    test('a DEM fetch error degrades silently to no summary', async () => {
        seedHoleWithGreen(hole('h1', 1));
        selectHole(1);
        const api: AnalysisApi = {
            async sampleGrid() { throw new Error('boom'); },
            async sampleElevations() { return { elevations: [] }; },
        };

        const svc = new PlannerToolService(api);
        const disposers: Array<() => void> = [];
        svc.start(d => disposers.push(d));
        await settle();

        expect(svc.greenSlopeSummary.get()).toBeNull();
        expect(svc.caddyAdvice.get().find(a => a.ruleId === 'green-slope-half')).toBeUndefined();

        for (const dispose of disposers) dispose();
    });
});

describe('PlannerToolService — box query (B + drag copies EPSG:3006 bounds)', () => {
    afterEach(() => { di.reset(); _reset(); });

    test('B arms the box pick, B again or Esc disarms it, and typing in a field is ignored', async () => {
        seedHoleWithGreen(hole('h1', 1));
        selectHole(1);
        const { api } = stubAnalysisApi(tiltedGreenGrid());
        const svc = new PlannerToolService(api);
        const disposers: Array<() => void> = [];
        svc.start(d => disposers.push(d));
        await settle();

        const press = (key: string, target?: EventTarget) => {
            const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            (target ?? window).dispatchEvent(e);
            return e.defaultPrevented;
        };
        expect(svc.boxArmed.get()).toBe(false);
        expect(press('b')).toBe(true);
        expect(svc.boxArmed.get()).toBe(true);
        expect(press('Escape')).toBe(true);
        expect(svc.boxArmed.get()).toBe(false);
        press('B');
        expect(svc.boxArmed.get()).toBe(true);
        press('b');
        expect(svc.boxArmed.get()).toBe(false);

        const input = document.createElement('input');
        document.body.appendChild(input);
        expect(press('b', input)).toBe(false);
        expect(svc.boxArmed.get()).toBe(false);
        input.remove();

        press('b');
        for (const d of disposers) d();
        expect(svc.boxArmed.get()).toBe(false);   // teardown disarms
    });
});
