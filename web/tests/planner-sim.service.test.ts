// T62 — the hole simulator's SERVICE-level contracts (feature-hole-sim-and-
// variants Phase B + the web half of Phase C).
//
// Exercises the real PlannerToolService + the real HoleSimService + the real
// simulation engine (via `createInlineSimClient`, the same pure code the worker
// runs — house rule: hand-built seams, no mocking library), with DI fakes for
// the data services and an in-memory GamePlansApi for the write path.
//
// Two things are worth protecting here, and neither is visible from a unit
// test:
//   1. The V8 invalidation state machine — simulate → fresh, ANY plan edit →
//      stale (greyed, still shown), and never an auto-recompute. This is what
//      keeps 800 rollouts off the drag path (DECADE §4.5).
//   2. The V7 ghost-accept flow — accepting a suggested line materialises
//      ORDINARY plan shots through the existing addShot(parentShotId) chain,
//      with the signature label prefilled, and then forgets the ghost.

import { test, expect, describe, afterEach } from 'bun:test';
import { di, Router } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { PlannerToolService } from '../src/planner/planner-tool.service';
import { PlanService } from '../src/planner/plan.service';
import { HoleSimService, PRIMARY_BRANCH_ID } from '../src/planner/hole-sim.service';
import { createInlineSimClient, type SimClient } from '../src/planner/sim-client';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FeaturesService } from '../src/draw/features.service';
import { FurnitureService } from '../src/furniture/furniture.service';
import { ClubsService } from '../src/player/clubs.service';
import { MapService } from '../src/map/map.service';
import { sweref99tmToWgs84 } from '../src/geo/transform';
import type { Club } from '../../shared/api/clubs.gen';
import type { Hole } from '../../shared/api/holes.gen';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import type { Tee } from '../../shared/api/tees.gen';
import type { Green } from '../../shared/api/greens.gen';
import type { GamePlan, GamePlanHole, GamePlansApi, PlanShot } from '../../shared/api/game-plans.gen';
import type { AnalysisApi } from '../../shared/api/analysis.gen';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { ScoredVariant } from '../../shared/strategy';

afterEach(() => { _reset(); di.reset(); });

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const TEE_XY = { x: 500000, y: 6468000 };
const GREEN_XY = { x: 500000, y: 6468300 }; // 300 m due north
const TEE_LATLON = sweref99tmToWgs84(TEE_XY.x, TEE_XY.y);
const GREEN_LATLON = sweref99tmToWgs84(GREEN_XY.x, GREEN_XY.y);

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

function seedCourse(holes: Hole[]): void {
    const courseDetail = new CourseDetailService();
    courseDetail.holeStore.set(holes);
    di.set(CourseDetailService, courseDetail);

    const features = new FeaturesService();
    features.store.set(holes.map((h, i): CourseFeature => ({
        id: `green-feat-${i}`, courseId: 'c1', holeId: h.id, type: 'green',
        geometry: square(15, GREEN_XY.x, GREEN_XY.y),
        geojson: null, sortOrder: 0, source: null, sourceRef: null, license: null, version: 1,
    })));
    di.set(FeaturesService, features);

    const furniture = new FurnitureService();
    furniture.tees.set(holes.map((h, i): Tee => ({
        id: `tee-${i}`, holeId: h.id, name: 'White', color: 'white',
        lat: TEE_LATLON.lat, lon: TEE_LATLON.lon, elevation: 0, sortOrder: 0, version: 1,
    })));
    furniture.greens.set(holes.map((h, i): Green => ({
        id: `green-row-${i}`, holeId: h.id, boundaryJson: null,
        centerLat: GREEN_LATLON.lat, centerLon: GREEN_LATLON.lon,
        frontLat: null, frontLon: null, backLat: null, backLon: null,
        elevation: 0, version: 1,
    })));
    di.set(FurnitureService, furniture);
}

function selectHole(number: number): void {
    di.get(Router).navigate('/planner', { query: { hole: String(number) } });
}

/** No network in these tests — the green-slope fetch resolves to nothing. */
const noAnalysis: AnalysisApi = {
    async sampleGrid() {
        return { heights: [], insideMask: [], origin: { e: 0, n: 0 }, resolution: 1, width: 0, height: 0 };
    },
    async sampleElevations() {
        return { elevations: [] };
    },
};

/** Register a HoleSimService running the real engine on this thread. */
function useInlineSim(client: SimClient = createInlineSimClient()): HoleSimService {
    const sim = new HoleSimService(client);
    di.set(HoleSimService, sim);
    return sim;
}

/** Shot rows placed as a straight primary chain up the hole. */
function shotAt(id: string, sortOrder: number, parentShotId: string | null, y: number): PlanShot {
    const p = sweref99tmToWgs84(TEE_XY.x, y);
    return {
        id, gamePlanHoleId: 'ph1', parentShotId, sortOrder,
        lat: p.lat, lon: p.lon, elevation: null, clubId: null, label: null, version: 1,
    };
}

function seedPlanWithShots(shots: PlanShot[]): PlanService {
    const plan = new PlanService();
    plan.holes.set([{
        id: 'ph1', gamePlanId: 'p1', holeNumber: 1, teeId: null, preferredClubId: null,
        plannedDirectionDeg: null, windSpeedMps: null, windDirectionDeg: null,
        notes: null, version: 1,
    }]);
    plan.shots.set(shots);
    di.set(PlanService, plan);
    return plan;
}

const DRIVER: Club =
    { id: 'driver', userId: null, name: 'Driver', carryM: 235, dispersionM: 30, sortOrder: 0, version: 1 };
const IRON5: Club =
    { id: 'iron5', userId: null, name: '5 iron', carryM: 165, dispersionM: 18, sortOrder: 1, version: 1 };

/** A two-club bag, so club auto-pick and the variant's own picks can differ. */
function seedClubs(): void {
    const clubs = new ClubsService();
    clubs.store.set([DRIVER, IRON5]);
    di.set(ClubsService, clubs);
}

/**
 * A MapService whose map answers `project()` — enough for the tool's real
 * `hitTest`, so tests can drive the ACTUAL mousedown/move/up path instead of
 * setting `selection` by hand. Everything within 1 m of `target` projects onto
 * the hit point; anything else lands far off screen.
 */
function useFakeMap(target: { lat: number; lon: number }): MapService {
    const map = new MapService();
    const fake = {
        project: ([lon, lat]: [number, number]) =>
            Math.abs(lat - target.lat) < 1e-5 && Math.abs(lon - target.lon) < 1e-5
                ? { x: 100, y: 100 }
                : { x: 9999, y: 9999 },
        dragPan: { enable() {}, disable() {} },
    };
    map.map.set(fake as unknown as NonNullable<ReturnType<MapService['map']['peek']>>);
    di.set(MapService, map);
    return map;
}

/** The tool's private raw-input handlers — the path a real gesture takes. */
interface MousePath {
    onMouseDown(e: unknown, map: unknown): void;
    onMouseMove(e: unknown): void;
    onMouseUp(map: unknown): void;
}
const mouse = (svc: PlannerToolService): MousePath => svc as unknown as MousePath;
const fakeMapHandle = { dragPan: { enable() {}, disable() {} } };
const downEvent = (x: number, y: number) => ({
    point: { x, y },
    originalEvent: { button: 0, metaKey: false, ctrlKey: false },
    preventDefault() {},
});

async function startTool(): Promise<{ svc: PlannerToolService; stop: () => void }> {
    const svc = new PlannerToolService(noAnalysis);
    const disposers: Array<() => void> = [];
    svc.start(d => disposers.push(d));
    await settle();
    return { svc, stop: () => { for (const d of disposers) d(); } };
}

describe('hole simulation — the V8 invalidation state machine', () => {
    test('simulate publishes a fresh distribution for the primary line', async () => {
        seedCourse([hole('h1', 1)]);
        seedPlanWithShots([shotAt('s1', 0, null, TEE_XY.y + 200)]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        expect(sim.branches.get()).toEqual([]); // nothing until explicitly asked

        await svc.simulateNow();

        const branches = sim.branches.get();
        expect(branches).toHaveLength(1);
        expect(branches[0].branchId).toBe('primary');
        expect(branches[0].par).toBe(4);
        // A real rollout distribution: normalised, positive mean, five buckets.
        expect(branches[0].buckets).toHaveLength(5);
        expect(branches[0].buckets.reduce((s, b) => s + b.prob, 0)).toBeCloseTo(1, 6);
        expect(branches[0].mean).toBeGreaterThan(1);
        expect(branches[0].onScriptRate).toBeGreaterThanOrEqual(0);
        expect(branches[0].onScriptRate).toBeLessThanOrEqual(1);
        expect(sim.stale.get()).toBe(false);

        stop();
    });

    test('a plan edit GREYS the result — kept, marked stale, never auto-recomputed', async () => {
        seedCourse([hole('h1', 1)]);
        const shot = shotAt('s1', 0, null, TEE_XY.y + 200);
        const plan = seedPlanWithShots([shot]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        await svc.simulateNow();
        const first = sim.branches.get()[0];
        expect(sim.stale.get()).toBe(false);
        const enrichesBefore = svc.enrichCount.get();

        // A per-frame drag patch: the cheapest possible plan edit.
        plan.patchShotLocal('s1', { lat: shot.lat + 0.0004 });

        expect(sim.stale.get()).toBe(true);
        // Still shown (V8 greys, it does not clear) and still the SAME numbers.
        expect(sim.branches.get()[0]).toBe(first);

        await settle();
        // And it stays stale: no effect re-runs the simulation behind the user.
        expect(sim.stale.get()).toBe(true);
        expect(sim.branches.get()[0]).toBe(first);
        expect(svc.enrichCount.get()).toBe(enrichesBefore); // enrich cadence held too

        // Asking again is what makes it fresh.
        await svc.simulateNow();
        expect(sim.stale.get()).toBe(false);
        expect(sim.branches.get()[0]).not.toBe(first);

        stop();
    });

    test('everything the engine reads is in the signature — the bag and the surfaces too', async () => {
        // The rule: if it changes `simulateChain`'s inputs, it must grey the
        // result. Club set and green/surface geometry reach the engine
        // indirectly (dispersion, target, lie classification), so they are the
        // two that are easy to forget — and a distribution priced with a club
        // the player no longer carries is simply wrong.
        seedCourse([hole('h1', 1)]);
        seedClubs();
        seedPlanWithShots([shotAt('s1', 0, null, TEE_XY.y + 200)]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        await svc.simulateNow();
        expect(sim.stale.get()).toBe(false);

        // Bag change (a club's carry edited) → stale.
        di.get(ClubsService).store.set([{ ...DRIVER, carryM: 250, version: 2 }, IRON5]);
        expect(sim.stale.get()).toBe(true);

        await svc.simulateNow();
        expect(sim.stale.get()).toBe(false);

        // Surface edit (the green moved / was reshaped) → stale.
        const features = di.get(FeaturesService);
        features.store.set(features.store.items.peek().map(f => ({
            ...f, geometry: square(25, GREEN_XY.x + 10, GREEN_XY.y), version: 2,
        })));
        expect(sim.stale.get()).toBe(true);

        stop();
    });

    test('a failed run reports the error WITHOUT throwing away the last good result', async () => {
        seedCourse([hole('h1', 1)]);
        seedPlanWithShots([shotAt('s1', 0, null, TEE_XY.y + 200)]);
        selectHole(1);
        let fail = false;
        const sim = useInlineSim({
            ...createInlineSimClient(),
            async simulate(legs, ctx, opts) {
                if (fail) throw new Error('worker died');
                return createInlineSimClient().simulate(legs, ctx, opts);
            },
        });

        const { svc, stop } = await startTool();
        await svc.simulateNow();
        const good = sim.branches.get();
        expect(good).toHaveLength(1);

        fail = true;
        await svc.simulateNow();
        // The last good distribution is still the best thing on screen; the
        // failure is reported ALONGSIDE it, not instead of it.
        expect(sim.simError.get()).toContain('worker died');
        expect(sim.branches.get()).toBe(good);
        // Discovery has its own error slot, so one half can't blank the other.
        expect(sim.discoverError.get()).toBeNull();

        fail = false;
        await svc.simulateNow();
        expect(sim.simError.get()).toBeNull();

        stop();
    });

    test('the sampled-landing scatter is suppressed while a result is stale', async () => {
        seedCourse([hole('h1', 1)]);
        const shot = shotAt('s1', 0, null, TEE_XY.y + 200);
        const plan = seedPlanWithShots([shot]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        await svc.simulateNow();
        expect(sim.branches.get()[0].perLegLandings.flat().length).toBeGreaterThan(0);
        // Capped at the §5 subsample per leg.
        for (const leg of sim.branches.get()[0].perLegLandings) {
            expect(leg.length).toBeLessThanOrEqual(200);
        }

        sim.scatterVisible.set(true);
        plan.patchShotLocal('s1', { lat: shot.lat + 0.0004 });
        // A dot cloud drawn against a plan it no longer matches would be the
        // most misleading thing this feature could put on the map.
        expect(sim.stale.get()).toBe(true);

        stop();
    });

    test('selecting an option at a decision point auto-simulates BOTH siblings, once', async () => {
        seedCourse([hole('h1', 1)]);
        const left = shotAt('opt-a', 0, null, TEE_XY.y + 200);
        const right = shotAt('opt-b', 1, null, TEE_XY.y + 220);
        seedPlanWithShots([left, right]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        svc.selection.set({ kind: 'shot', id: 'opt-a' });
        await settle();
        await settle();

        expect(sim.branches.get().map(b => b.branchId).sort()).toEqual(['opt-a', 'opt-b']);
        const runs = sim.branches.get();

        // Re-selecting the sibling under an unchanged plan is deduped — the
        // same branch set and signature, so nothing recomputes.
        svc.selection.set({ kind: 'shot', id: 'opt-b' });
        await settle();
        await settle();
        expect(sim.branches.get()).toBe(runs);

        stop();
    });

    test('CLICKING an option marker on the map auto-simulates (the real mouse path)', async () => {
        // The regression this pins: `onMouseDown` sets the selection AND opens a
        // drag object in the same handler, and the auto-sim microtask runs after
        // it — so a guard of "bail if a drag exists" made marker clicks, the
        // primary way anyone selects an option, never simulate at all. Driving
        // `selection` directly (as the test above does) cannot see that.
        seedCourse([hole('h1', 1)]);
        const left = shotAt('opt-a', 0, null, TEE_XY.y + 200);
        const right = shotAt('opt-b', 1, null, TEE_XY.y + 220);
        seedPlanWithShots([left, right]);
        selectHole(1);
        const sim = useInlineSim();
        useFakeMap({ lat: left.lat, lon: left.lon });

        const { svc, stop } = await startTool();
        mouse(svc).onMouseDown(downEvent(100, 100), fakeMapHandle);
        expect(svc.selection.get()).toEqual({ kind: 'shot', id: 'opt-a' });
        await settle();
        await settle();

        expect(sim.branches.get().map(b => b.branchId).sort()).toEqual(['opt-a', 'opt-b']);
        mouse(svc).onMouseUp(fakeMapHandle); // release with no movement: a click

        stop();
    });

    test('a drag that MOVED never triggers a simulation (DECADE §4.5 / V8)', async () => {
        seedCourse([hole('h1', 1)]);
        const left = shotAt('opt-a', 0, null, TEE_XY.y + 200);
        const right = shotAt('opt-b', 1, null, TEE_XY.y + 220);
        seedPlanWithShots([left, right]);
        selectHole(1);
        const sim = useInlineSim();
        useFakeMap({ lat: left.lat, lon: left.lon });

        const { svc, stop } = await startTool();
        mouse(svc).onMouseDown(downEvent(100, 100), fakeMapHandle);
        await settle();
        await settle();
        const afterClick = sim.branches.get();
        expect(afterClick).toHaveLength(2);

        // Now the gesture actually moves: geometry changes per frame, and the
        // distribution must go stale WITHOUT anything recomputing.
        mouse(svc).onMouseMove({
            point: { x: 160, y: 160 },
            lngLat: { lat: left.lat + 0.0004, lng: left.lon },
        });
        // A selection change arriving mid-drag must not sneak a run in either.
        svc.selection.set({ kind: 'shot', id: 'opt-b' });
        await settle();
        await settle();
        expect(sim.stale.get()).toBe(true);
        expect(sim.branches.get()).toBe(afterClick); // same objects — nothing re-ran

        stop();
    });

    test('switching holes forgets the distribution (derived state, never persisted)', async () => {
        seedCourse([hole('h1', 1), hole('h2', 2)]);
        seedPlanWithShots([shotAt('s1', 0, null, TEE_XY.y + 200)]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        await svc.simulateNow();
        expect(sim.branches.get()).toHaveLength(1);

        selectHole(2);
        expect(sim.branches.get()).toEqual([]);
        expect(sim.stale.get()).toBe(false); // nothing to be stale about

        stop();
    });

    test('a hole with no shots reports a notice rather than simulating nothing', async () => {
        seedCourse([hole('h1', 1)]);
        seedPlanWithShots([]);
        selectHole(1);
        const sim = useInlineSim();

        const { svc, stop } = await startTool();
        await svc.simulateNow();
        expect(sim.branches.get()).toEqual([]);
        expect(svc.notice.get()).toContain('Nothing to simulate');

        stop();
    });
});

// ── Suggest lines (V7) ─────────────────────────────────────────────────────

/**
 * A hand-built SimClient serving one fixed variant. The enumeration itself is
 * covered by the engine's own tests (shared/strategy/variant-graph); what needs
 * protecting HERE is the ghost lifecycle and the accept write path.
 */
function stubDiscoverClient(
    nodes: Array<{ x: number; y: number }>,
    legs: Array<{
        origin?: { x: number; y: number };
        landing?: { x: number; y: number };
        club?: { name: string; carryM: number; dispersionM: number };
    }> = [],
): SimClient {
    const variant = {
        nodes: nodes.map((point, i) => ({
            id: `n${i}`,
            point,
            chainage: point.y - TEE_XY.y,
            kind: i === 0 ? 'tee' : i === nodes.length - 1 ? 'green' : 'aim',
        })),
        legs,
        score: { expectedStrokes: 4.2, penaltyProb: 0.12, worstCaseStrokes: 6, legs: [] },
        signature: {
            shotCount: nodes.length - 2,
            hazards: [{ hazardId: 'hazard-0', relation: 'passed-left' }],
            key: 'sig-left',
        },
    } as unknown as ScoredVariant;
    return {
        ...createInlineSimClient(),
        async discover() {
            return [variant];
        },
    };
}

/** Minimal in-memory GamePlansApi — only the create path these tests walk. */
function fakePlansApi(): { api: GamePlansApi; added: Array<Record<string, unknown>> } {
    const shots = new Map<string, PlanShot>();
    const added: Array<Record<string, unknown>> = [];
    let seq = 0;
    const notUnderTest = () => Promise.reject(new Error('not under test'));
    const holeTree = (): GamePlanHole => ({
        id: 'ph1', gamePlanId: 'p1', holeNumber: 1, teeId: null, preferredClubId: null,
        plannedDirectionDeg: null, windSpeedMps: null, windDirectionDeg: null, notes: null,
        version: 1,
        shots: [...shots.values()].sort((a, b) => a.sortOrder - b.sortOrder),
        gates: [],
    });
    const plan = (): GamePlan => ({
        id: 'p1', courseId: 'c1', userId: null, windSpeedMps: null, windDirectionDeg: null,
        version: 1, holes: [holeTree()],
    });
    const api: GamePlansApi = {
        async getByCourse() { return plan(); },
        async upsert() { return plan(); },
        async setHole() { return holeTree(); },
        async addShot(input: Parameters<GamePlansApi['addShot']>[0]) {
            added.push({ ...input });
            const parentShotId = input.parentShotId ?? null;
            const siblings = [...shots.values()].filter(s => s.parentShotId === parentShotId);
            const row: PlanShot = {
                id: `new${++seq}`,
                gamePlanHoleId: input.gamePlanHoleId,
                parentShotId,
                sortOrder: siblings.length,
                lat: input.lat,
                lon: input.lon,
                elevation: input.elevation ?? null,
                clubId: input.clubId ?? null,
                label: input.label ?? null,
                version: 1,
            };
            shots.set(row.id, row);
            return structuredClone(row);
        },
        remove: notUnderTest,
        updateShot: notUnderTest,
        removeShot: notUnderTest,
        reorderShots: notUnderTest,
        setPrimary: notUnderTest,
        addGate: notUnderTest,
        updateGate: notUnderTest,
        removeGate: notUnderTest,
    } as unknown as GamePlansApi;
    return { api, added };
}

describe('suggest lines (V7) — ghosts and the accept write path', () => {
    test('discovered lines become labelled ghosts, and hover/dismiss are transient', async () => {
        seedCourse([hole('h1', 1)]);
        seedPlanWithShots([]);
        selectHole(1);
        const sim = useInlineSim(stubDiscoverClient([
            TEE_XY, { x: TEE_XY.x - 20, y: TEE_XY.y + 180 }, GREEN_XY,
        ]));

        const { svc, stop } = await startTool();
        const count = await svc.suggestLines();
        expect(count).toBe(1);

        const ghosts = sim.variants.get();
        expect(ghosts).toHaveLength(1);
        // The label V7 prefills onto the accepted branch, straight off the
        // signature — no hazard kind registered, so it degrades gracefully.
        expect(ghosts[0].label).toContain('· 1 shot');
        expect(ghosts[0].label).toMatch(/left of the/);

        svc.hoverVariant(ghosts[0].id);
        expect(sim.hoveredVariantId.get()).toBe(ghosts[0].id);

        svc.dismissVariant(ghosts[0].id);
        expect(sim.variants.get()).toEqual([]);
        expect(sim.hoveredVariantId.get()).toBeNull(); // hover follows the ghost out

        stop();
    });

    test('selecting a ghost PINS it — hover leaving no longer drops the corridor', async () => {
        seedCourse([hole('h1', 1)]);
        seedPlanWithShots([]);
        selectHole(1);
        const sim = useInlineSim(stubDiscoverClient([
            TEE_XY, { x: TEE_XY.x - 20, y: TEE_XY.y + 180 }, GREEN_XY,
        ]));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        const id = sim.variants.get()[0].id;

        svc.selectVariant(id);
        expect(sim.selectedVariantId.get()).toBe(id);
        svc.hoverVariant(null); // pointer leaves — selection outlives it
        expect(sim.selectedVariantId.get()).toBe(id);

        svc.selectVariant(id); // same row again unpins
        expect(sim.selectedVariantId.get()).toBeNull();

        stop();
    });

    test('selecting a ghost simulates it alongside the primary line (§V5, on selection)', async () => {
        seedCourse([hole('h1', 1)]);
        seedClubs();
        seedPlanWithShots([shotAt('s1', 0, null, TEE_XY.y + 200)]);
        selectHole(1);
        const landing = { x: TEE_XY.x - 20, y: TEE_XY.y + 180 };
        const sim = useInlineSim(stubDiscoverClient(
            [TEE_XY, landing, GREEN_XY],
            [
                { origin: TEE_XY, landing, club: { name: 'Driver', carryM: 235, dispersionM: 30 } },
                { origin: landing, landing: GREEN_XY, club: { name: '5 iron', carryM: 165, dispersionM: 18 } },
            ],
        ));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        const ghost = sim.variants.get()[0];

        svc.selectVariant(ghost.id);
        await settle();

        const branches = sim.branches.get();
        expect(branches.map(b => b.branchId))
            .toEqual([PRIMARY_BRANCH_ID, `variant:${ghost.id}`]);
        const suggestion = branches[1];
        expect(suggestion.label).toBe(ghost.label);
        expect(suggestion.mean).toBeGreaterThan(0);
        // Landing clouds are what makes the ghost inspectable on the map.
        expect(suggestion.perLegLandings[0].length).toBeGreaterThan(0);

        stop();
    });

    test('dismissing the pinned ghost clears the pin with it', async () => {
        seedCourse([hole('h1', 1)]);
        seedPlanWithShots([]);
        selectHole(1);
        const sim = useInlineSim(stubDiscoverClient([
            TEE_XY, { x: TEE_XY.x - 20, y: TEE_XY.y + 180 }, GREEN_XY,
        ]));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        const id = sim.variants.get()[0].id;
        svc.selectVariant(id);
        svc.dismissVariant(id);
        expect(sim.selectedVariantId.get()).toBeNull();

        stop();
    });

    test('ghosts clear on hole switch', async () => {
        seedCourse([hole('h1', 1), hole('h2', 2)]);
        seedPlanWithShots([]);
        selectHole(1);
        const sim = useInlineSim(stubDiscoverClient([
            TEE_XY, { x: TEE_XY.x - 20, y: TEE_XY.y + 180 }, GREEN_XY,
        ]));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        expect(sim.variants.get()).toHaveLength(1);

        selectHole(2);
        expect(sim.variants.get()).toEqual([]);

        stop();
    });

    test('accepting materialises ORDINARY plan shots through addShot(parentShotId)', async () => {
        seedCourse([hole('h1', 1)]);
        const { api, added } = fakePlansApi();
        const plan = new PlanService(api);
        await plan.load('c1');
        di.set(PlanService, plan);
        selectHole(1);
        const sim = useInlineSim(stubDiscoverClient([
            TEE_XY,
            { x: TEE_XY.x - 25, y: TEE_XY.y + 150 },
            { x: TEE_XY.x - 5, y: TEE_XY.y + 260 },
            GREEN_XY,
        ]));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        const ghost = sim.variants.get()[0];

        const created = await svc.acceptVariant(ghost.id);

        // Both intermediate landings become shots; the tee and the green do not.
        expect(created).toBe(2);
        expect(added).toHaveLength(2);
        // A chain, not two roots: the second hangs off the first.
        expect(added[0].parentShotId).toBeNull();
        expect(added[1].parentShotId).toBe(plan.shots.items.peek()[0].id);
        // Only the branch HEAD carries the signature label — the continuation
        // shots look like hand-placed ones, because that is what they now are.
        expect(added[0].label).toBe(ghost.label);
        expect(added[1].label).toBeNull();
        // Provenance ends at creation: the ghost is forgotten.
        expect(sim.variants.get()).toEqual([]);

        stop();
    });

    test('accepting anchors at the TEE whatever is selected — it is a whole line', async () => {
        // Discovery always searches tee → green (`variantContext`), so the first
        // landing's leg IS a tee shot. Hanging it off a mid-chain selection
        // would draw that leg from some landing halfway up the hole — a line
        // nobody saw and the chip never priced.
        seedCourse([hole('h1', 1)]);
        const { api, added } = fakePlansApi();
        const plan = new PlanService(api);
        await plan.load('c1');
        // An existing two-shot chain, with the SECOND shot selected.
        const first = await plan.addShot(1, { lat: TEE_LATLON.lat, lon: TEE_LATLON.lon });
        const second = await plan.addShot(1, {
            lat: GREEN_LATLON.lat, lon: GREEN_LATLON.lon, parentShotId: first!.id,
        });
        di.set(PlanService, plan);
        selectHole(1);
        const landing = { x: TEE_XY.x - 25, y: TEE_XY.y + 150 };
        const sim = useInlineSim(stubDiscoverClient([TEE_XY, landing, GREEN_XY]));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        svc.selection.set({ kind: 'shot', id: second!.id });
        await settle();

        added.length = 0;
        await svc.acceptVariant(sim.variants.get()[0].id);

        // A ROOT option: its leg starts at the tee, not at `first`'s landing.
        expect(added).toHaveLength(1);
        expect(added[0].parentShotId).toBeNull();
        // And it sits exactly where the ghost's first landing was drawn.
        const expected = sweref99tmToWgs84(landing.x, landing.y);
        expect(added[0].lat as number).toBeCloseTo(expected.lat, 9);
        expect(added[0].lon as number).toBeCloseTo(expected.lon, 9);

        stop();
    });

    test('accepted legs keep the CLUBS the variant was priced with', async () => {
        // The graph picks clubs by wind-adjusted reachability; re-deriving them
        // from plays-like distance on write can pick a different one, and then
        // the branch prices unlike the chip the user clicked.
        seedCourse([hole('h1', 1)]);
        seedClubs();
        const { api, added } = fakePlansApi();
        const plan = new PlanService(api);
        await plan.load('c1');
        di.set(PlanService, plan);
        selectHole(1);
        // Leg 0 is a ~230 m carry the auto-picker would call Driver — but the
        // variant chose the 5 iron, and that is what must be written. Leg 1 is
        // another ~230 m and carries NO club, so it falls back to the auto pick
        // (Driver) — proving the fallback still works and the two paths differ.
        const sim = useInlineSim(stubDiscoverClient(
            [TEE_XY, { x: TEE_XY.x, y: TEE_XY.y + 230 }, { x: TEE_XY.x, y: TEE_XY.y + 460 }, GREEN_XY],
            [{ club: { name: IRON5.name, carryM: IRON5.carryM, dispersionM: IRON5.dispersionM } }, {}],
        ));

        const { svc, stop } = await startTool();
        await svc.suggestLines();
        await svc.acceptVariant(sim.variants.get()[0].id);

        expect(added).toHaveLength(2);
        expect(added[0].clubId).toBe(IRON5.id); // the variant's pick, NOT the nearest
        expect(added[1].clubId).toBe(DRIVER.id); // clubless leg → the auto pick

        stop();
    });

    test('a hole with no green declines to suggest rather than throwing', async () => {
        seedCourse([hole('h1', 1)]);
        di.get(FurnitureService).greens.set([]);
        di.get(FeaturesService).store.set([]);
        seedPlanWithShots([]);
        selectHole(1);
        const sim = useInlineSim(stubDiscoverClient([TEE_XY, GREEN_XY]));

        const { svc, stop } = await startTool();
        expect(await svc.suggestLines()).toBe(0);
        expect(sim.variants.get()).toEqual([]);
        expect(svc.notice.get()).toBeTruthy();

        stop();
    });
});
