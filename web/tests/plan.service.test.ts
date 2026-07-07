import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { PlanService } from '../src/planner/plan.service';
import type {
    GamePlan,
    GamePlanHole,
    GamePlansApi,
    PlanGate,
    PlanShot,
} from '../../shared/api/game-plans.gen';

afterEach(() => _reset());

// Landeryd-ish coordinates.
const LAT = 58.4015;
const LON = 15.5658;

// ── Fake client ────────────────────────────────────────────────────────────

/**
 * In-memory fake of the gamePlans API with server-accurate semantics:
 * upsert/setHole CREATE when absent (no version) and version-check when
 * present (mismatch or missing version → 409); shots/gates get appended
 * sort orders and per-row optimistic locking.
 */
function fakeApi() {
    interface PlanRow {
        id: string;
        courseId: string;
        windSpeedMps: number | null;
        windDirectionDeg: number | null;
        version: number;
    }
    type HoleRow = Omit<GamePlanHole, 'shots' | 'gates'>;

    const plans = new Map<string, PlanRow>(); // by courseId
    const holes = new Map<string, HoleRow>();
    const shots = new Map<string, PlanShot>();
    const gates = new Map<string, PlanGate>();
    let seq = 0;
    const calls = { getByCourse: 0, upsert: 0, setHole: 0, addShot: 0, updateShot: 0, addGate: 0 };

    const holeTree = (h: HoleRow): GamePlanHole => ({
        ...structuredClone(h),
        shots: [...shots.values()].filter(s => s.gamePlanHoleId === h.id)
            .sort((a, b) => a.sortOrder - b.sortOrder).map(x => structuredClone(x)),
        gates: [...gates.values()].filter(g => g.gamePlanHoleId === h.id)
            .sort((a, b) => a.sortOrder - b.sortOrder).map(x => structuredClone(x)),
    });
    const tree = (p: PlanRow): GamePlan => ({
        id: p.id,
        courseId: p.courseId,
        userId: null,
        windSpeedMps: p.windSpeedMps,
        windDirectionDeg: p.windDirectionDeg,
        version: p.version,
        holes: [...holes.values()].filter(h => h.gamePlanId === p.id)
            .sort((a, b) => a.holeNumber - b.holeNumber).map(holeTree),
    });

    const api: GamePlansApi = {
        async getByCourse({ courseId }) {
            calls.getByCourse++;
            const p = plans.get(courseId);
            // Server-accurate: the API framework serialises a null result as
            // `{ ok: true }` (mount.ts `result ?? { ok: true }`), so a plan-less
            // course never returns literal null over the wire.
            return p ? tree(p) : ({ ok: true } as unknown as GamePlan);
        },
        async upsert(input) {
            calls.upsert++;
            const existing = plans.get(input.courseId);
            if (!existing) {
                const row: PlanRow = {
                    id: `plan${++seq}`,
                    courseId: input.courseId,
                    windSpeedMps: input.windSpeedMps ?? null,
                    windDirectionDeg: input.windDirectionDeg ?? null,
                    version: 1,
                };
                plans.set(input.courseId, row);
                return tree(row);
            }
            if (input.version === undefined || existing.version !== input.version) {
                throw new ApiError(409, 'Version conflict');
            }
            if (input.windSpeedMps !== undefined) existing.windSpeedMps = input.windSpeedMps;
            if (input.windDirectionDeg !== undefined) existing.windDirectionDeg = input.windDirectionDeg;
            existing.version++;
            return tree(existing);
        },
        remove: () => Promise.reject(new Error('not under test')),
        async setHole(input) {
            calls.setHole++;
            // Server-accurate: `planId` is a required schema field — a missing
            // one is a 400, not a silent hole with an undefined FK.
            if (!input.planId) throw new ApiError(400, 'Validation failed');
            const existing = [...holes.values()]
                .find(h => h.gamePlanId === input.planId && h.holeNumber === input.holeNumber);
            if (!existing) {
                const row: HoleRow = {
                    id: `hole${++seq}`,
                    gamePlanId: input.planId,
                    holeNumber: input.holeNumber,
                    teeId: input.teeId ?? null,
                    preferredClubId: input.preferredClubId ?? null,
                    plannedDirectionDeg: input.plannedDirectionDeg ?? null,
                    windSpeedMps: input.windSpeedMps ?? null,
                    windDirectionDeg: input.windDirectionDeg ?? null,
                    notes: input.notes ?? null,
                    version: 1,
                };
                holes.set(row.id, row);
                return holeTree(row);
            }
            if (input.version === undefined || existing.version !== input.version) {
                throw new ApiError(409, 'Version conflict');
            }
            if (input.teeId !== undefined) existing.teeId = input.teeId;
            if (input.preferredClubId !== undefined) existing.preferredClubId = input.preferredClubId;
            if (input.plannedDirectionDeg !== undefined) existing.plannedDirectionDeg = input.plannedDirectionDeg;
            if (input.windSpeedMps !== undefined) existing.windSpeedMps = input.windSpeedMps;
            if (input.windDirectionDeg !== undefined) existing.windDirectionDeg = input.windDirectionDeg;
            if (input.notes !== undefined) existing.notes = input.notes;
            existing.version++;
            return holeTree(existing);
        },
        async addShot(input) {
            calls.addShot++;
            const siblings = [...shots.values()].filter(s => s.gamePlanHoleId === input.gamePlanHoleId);
            const row: PlanShot = {
                id: `shot${++seq}`,
                gamePlanHoleId: input.gamePlanHoleId,
                sortOrder: siblings.length === 0 ? 0 : Math.max(...siblings.map(s => s.sortOrder)) + 1,
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
        async updateShot(input) {
            calls.updateShot++;
            const row = shots.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.lat !== undefined) row.lat = input.lat;
            if (input.lon !== undefined) row.lon = input.lon;
            if (input.elevation !== undefined) row.elevation = input.elevation;
            if (input.clubId !== undefined) row.clubId = input.clubId;
            if (input.label !== undefined) row.label = input.label;
            row.version++;
            return structuredClone(row);
        },
        async removeShot(input) {
            const row = shots.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            shots.delete(input.id);
            return { ok: true };
        },
        reorderShots: () => Promise.reject(new Error('not under test')),
        async addGate(input) {
            calls.addGate++;
            const siblings = [...gates.values()].filter(g => g.gamePlanHoleId === input.gamePlanHoleId);
            const row: PlanGate = {
                id: `gate${++seq}`,
                gamePlanHoleId: input.gamePlanHoleId,
                lat: input.lat,
                lon: input.lon,
                directionDeg: input.directionDeg,
                halfWidthLeftM: input.halfWidthLeftM,
                halfWidthRightM: input.halfWidthRightM,
                source: input.source ?? 'manual',
                sortOrder: siblings.length === 0 ? 0 : Math.max(...siblings.map(g => g.sortOrder)) + 1,
                version: 1,
            };
            gates.set(row.id, row);
            return structuredClone(row);
        },
        async updateGate(input) {
            const row = gates.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.lat !== undefined) row.lat = input.lat;
            if (input.lon !== undefined) row.lon = input.lon;
            if (input.directionDeg !== undefined) row.directionDeg = input.directionDeg;
            if (input.halfWidthLeftM !== undefined) row.halfWidthLeftM = input.halfWidthLeftM;
            if (input.halfWidthRightM !== undefined) row.halfWidthRightM = input.halfWidthRightM;
            if (input.source !== undefined) row.source = input.source;
            row.version++;
            return structuredClone(row);
        },
        async removeGate(input) {
            const row = gates.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            gates.delete(input.id);
            return { ok: true };
        },
    };
    return { api, plans, holes, shots, gates, calls };
}

// ── Loading ────────────────────────────────────────────────────────────────

describe('load', () => {
    test('no plan yet → null head, empty stores; cached per courseId', async () => {
        const { api, calls } = fakeApi();
        const svc = new PlanService(api);

        await svc.load('c1');
        expect(svc.plan.get()).toBeNull();
        expect(svc.holes.items.get()).toEqual([]);
        expect(svc.shots.items.get()).toEqual([]);
        expect(svc.gates.items.get()).toEqual([]);

        await svc.load('c1');
        expect(calls.getByCourse).toBe(1); // cached
    });

    test('no-plan sentinel {ok:true} is treated as null (not a poisoned head)', async () => {
        const { api } = fakeApi();
        const svc = new PlanService(api);

        await svc.load('c1'); // getByCourse returns {ok:true}, not literal null
        // Must NOT have poisoned `plan` with the id-less sentinel object.
        expect(svc.plan.get()).toBeNull();
        expect(svc.holes.items.get()).toEqual([]);
    });

    test('flattens the plan tree into head + hole/shot/gate stores', async () => {
        const { api } = fakeApi();
        const seeded = await api.upsert({ courseId: 'c1', windSpeedMps: 4, windDirectionDeg: 270 });
        const hole = await api.setHole({ planId: seeded.id, holeNumber: 1, teeId: 't1' });
        await api.addShot({ gamePlanHoleId: hole.id, lat: LAT, lon: LON, clubId: 'club-d' });
        await api.addShot({ gamePlanHoleId: hole.id, lat: LAT + 0.001, lon: LON });
        await api.addGate({
            gamePlanHoleId: hole.id, lat: LAT, lon: LON,
            directionDeg: 10, halfWidthLeftM: 30, halfWidthRightM: 30,
        });

        const svc = new PlanService(api);
        await svc.load('c1');

        expect(svc.plan.get()?.windSpeedMps).toBe(4);
        expect(svc.plan.get()?.version).toBe(1);
        expect(svc.holeRow(1)?.teeId).toBe('t1');
        expect(svc.shotsForHole(hole.id).map(s => s.sortOrder)).toEqual([0, 1]);
        expect(svc.gatesForHole(hole.id)).toHaveLength(1);
        // The head signal must not carry the nested tree.
        expect('holes' in (svc.plan.get() as object)).toBe(false);
    });
});

// ── Lazy creation ──────────────────────────────────────────────────────────

describe('lazy plan/hole creation', () => {
    test('addShot on a fresh course creates plan + hole exactly once (no versions on create)', async () => {
        const { api, calls, holes } = fakeApi();
        const svc = new PlanService(api);
        await svc.load('c1'); // no plan yet — arrives as the {ok:true} sentinel

        const created = await svc.addShot(7, { lat: LAT, lon: LON, elevation: 42 });
        expect(created?.sortOrder).toBe(0);
        expect(created?.elevation).toBe(42);
        expect(calls.upsert).toBe(1);
        expect(calls.setHole).toBe(1);
        expect(svc.saveError.get()).toBeNull(); // no 400 from an empty planId
        const planId = svc.plan.get()?.id;
        expect(planId).toBeDefined();
        // The hole row must be wired to the just-created plan — i.e. setHole
        // received the real planId, not undefined.
        expect([...holes.values()][0].gamePlanId).toBe(planId!);
        expect(svc.holeRow(7)?.holeNumber).toBe(7);

        // Second shot reuses the created rows.
        const second = await svc.addShot(7, { lat: LAT, lon: LON + 0.001 });
        expect(second?.sortOrder).toBe(1);
        expect(calls.upsert).toBe(1);
        expect(calls.setHole).toBe(1);
        expect(svc.shots.items.get()).toHaveLength(2);
    });

    test('setHoleFields creates the hole row on first touch, then updates version-aware', async () => {
        const { api, holes } = fakeApi();
        const svc = new PlanService(api);
        await svc.load('c1');

        const row = await svc.setHoleFields(3, { teeId: 't9' });
        expect(row?.teeId).toBe('t9');
        expect(row?.version).toBe(1);

        const updated = await svc.setHoleFields(3, { notes: 'lay up short', windSpeedMps: 6.5 });
        expect(updated?.version).toBe(2);
        expect(updated?.notes).toBe('lay up short');
        expect(updated?.teeId).toBe('t9'); // sparse patch left it alone

        // Explicit null clears (inherit-plan semantics for the wind override).
        const cleared = await svc.setHoleFields(3, { windSpeedMps: null });
        expect(cleared?.windSpeedMps).toBeNull();
        expect([...holes.values()][0].windSpeedMps).toBeNull();
    });

    test('setPlanWind creates the plan with the wind, then version-aware updates', async () => {
        const { api, plans } = fakeApi();
        const svc = new PlanService(api);
        await svc.load('c1');

        await svc.setPlanWind({ windSpeedMps: 5, windDirectionDeg: 180 });
        expect(svc.plan.get()?.windSpeedMps).toBe(5);
        expect(svc.plan.get()?.version).toBe(1);

        await svc.setPlanWind({ windSpeedMps: 7.5 });
        expect(svc.plan.get()?.windSpeedMps).toBe(7.5);
        expect(svc.plan.get()?.windDirectionDeg).toBe(180);
        expect(svc.plan.get()?.version).toBe(2);
        expect(plans.get('c1')?.version).toBe(2);
    });
});

// ── Shot mutation + conflicts ──────────────────────────────────────────────

describe('shots', () => {
    async function seeded() {
        const { api, shots, calls } = fakeApi();
        const plan = await api.upsert({ courseId: 'c1' });
        const hole = await api.setHole({ planId: plan.id, holeNumber: 1 });
        const shot = await api.addShot({ gamePlanHoleId: hole.id, lat: LAT, lon: LON });
        const svc = new PlanService(api);
        await svc.load('c1');
        return { api, shots, calls, svc, shot };
    }

    test('updateShot uses the store version and patches the bumped row', async () => {
        const { svc, shot, shots } = await seeded();

        const updated = await svc.updateShot(shot.id, { clubId: 'club-7i', label: 'layup' });
        expect(updated?.version).toBe(2);
        expect(updated?.clubId).toBe('club-7i');
        expect(svc.shots.items.get()[0].label).toBe('layup');
        expect(shots.get(shot.id)?.version).toBe(2);
    });

    test('patchShotLocal keeps the version, so the next update still succeeds', async () => {
        const { svc, shot, calls } = await seeded();

        svc.patchShotLocal(shot.id, { lat: LAT + 0.002, lon: LON + 0.002 });
        expect(svc.shots.items.get()[0].lat).toBeCloseTo(LAT + 0.002);
        expect(svc.shots.items.get()[0].version).toBe(1); // unchanged — no network
        expect(calls.updateShot).toBe(0);

        const persisted = await svc.updateShot(shot.id, { lat: LAT + 0.002, lon: LON + 0.002 });
        expect(persisted?.version).toBe(2);
    });

    test('version conflict sets saveError=conflict and re-syncs from the server', async () => {
        const { svc, shot, shots } = await seeded();

        // A competing writer bumps the server row behind our back.
        shots.get(shot.id)!.version = 5;
        shots.get(shot.id)!.label = 'other client';

        const result = await svc.updateShot(shot.id, { label: 'mine' });
        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');

        await Bun.sleep(0); // reload() fired — wait for it to land
        expect(svc.shots.items.get()[0].label).toBe('other client');
        expect(svc.shots.items.get()[0].version).toBe(5);
    });

    test('removeShot deletes with the store version', async () => {
        const { svc, shot, shots } = await seeded();
        expect(await svc.removeShot(shot.id)).toBe(true);
        expect(svc.shots.items.get()).toHaveLength(0);
        expect(shots.has(shot.id)).toBe(false);
    });
});

// ── Gates ──────────────────────────────────────────────────────────────────

describe('gates', () => {
    test('addGate lazily creates rows; update adjusts a half-width; conflict re-syncs', async () => {
        const { api, gates } = fakeApi();
        const svc = new PlanService(api);
        await svc.load('c1');

        const gate = await svc.addGate(2, {
            lat: LAT, lon: LON, directionDeg: 42.5,
            halfWidthLeftM: 30, halfWidthRightM: 30, source: 'manual',
        });
        expect(gate?.sortOrder).toBe(0);
        expect(gate?.source).toBe('manual');
        expect(svc.holeRow(2)).toBeDefined();

        const updated = await svc.updateGate(gate!.id, { halfWidthLeftM: 18.5 });
        expect(updated?.halfWidthLeftM).toBe(18.5);
        expect(updated?.halfWidthRightM).toBe(30);
        expect(updated?.directionDeg).toBe(42.5); // stored bearing untouched
        expect(updated?.version).toBe(2);

        // Conflict path: external bump → saveError + re-sync.
        gates.get(gate!.id)!.version = 9;
        gates.get(gate!.id)!.halfWidthRightM = 55;
        const conflicted = await svc.updateGate(gate!.id, { halfWidthRightM: 20 });
        expect(conflicted).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');
        await Bun.sleep(0);
        expect(svc.gates.items.get()[0].halfWidthRightM).toBe(55);

        // The re-sync healed the version, so the next mutation succeeds.
        expect(await svc.removeGate(gate!.id)).toBe(true);
    });

    test('removeGate deletes with the store version', async () => {
        const { api, gates } = fakeApi();
        const svc = new PlanService(api);
        await svc.load('c1');
        const gate = await svc.addGate(1, {
            lat: LAT, lon: LON, directionDeg: 0,
            halfWidthLeftM: 30, halfWidthRightM: 30,
        });
        expect(await svc.removeGate(gate!.id)).toBe(true);
        expect(gates.size).toBe(0);
        expect(svc.gates.items.get()).toHaveLength(0);
    });
});
