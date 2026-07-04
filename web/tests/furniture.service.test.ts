import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { FurnitureService, type ElevationSampler } from '../src/furniture/furniture.service';
import type { Tee, TeesApi } from '../../shared/api/tees.gen';
import type { Green, GreensApi } from '../../shared/api/greens.gen';
import type { Pin, PinsApi } from '../../shared/api/pins.gen';
import type { AimPoint, AimPointsApi } from '../../shared/api/aim-points.gen';

afterEach(() => _reset());

// Landeryd-ish coordinates.
const LAT = 58.4015;
const LON = 15.5658;

// ── Fake clients ──────────────────────────────────────────────────────────

function fakeTees(initial: Tee[] = []) {
    const rows = new Map(initial.map(t => [t.id, structuredClone(t)]));
    let seq = 0;
    const calls = { create: 0, update: 0, remove: 0, reorder: 0, listCourse: 0 };
    const api: TeesApi = {
        async listByHole({ holeId }) { return [...rows.values()].filter(t => t.holeId === holeId).map(x => structuredClone(x)); },
        async listByCourse() { calls.listCourse++; return [...rows.values()].map(x => structuredClone(x)); },
        async create(input) {
            calls.create++;
            const row: Tee = {
                id: `t${++seq}`, holeId: input.holeId, name: input.name, color: input.color ?? null,
                lat: input.lat, lon: input.lon, elevation: input.elevation ?? null,
                sortOrder: [...rows.values()].filter(t => t.holeId === input.holeId).length, version: 1,
            };
            rows.set(row.id, row);
            return structuredClone(row);
        },
        async update(input) {
            calls.update++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.name !== undefined) row.name = input.name;
            if (input.color !== undefined) row.color = input.color;
            if (input.lat !== undefined) row.lat = input.lat;
            if (input.lon !== undefined) row.lon = input.lon;
            if (input.elevation !== undefined) row.elevation = input.elevation;
            row.version++;
            return structuredClone(row);
        },
        async remove(input) {
            calls.remove++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            rows.delete(input.id);
            return { ok: true };
        },
        async reorder(input) {
            calls.reorder++;
            input.orderedIds.forEach((id, i) => { const r = rows.get(id); if (r) r.sortOrder = i; });
            return { ok: true };
        },
    };
    return { api, rows, calls };
}

function fakeGreens(initial: Green[] = []) {
    const rows = new Map(initial.map(g => [g.holeId, structuredClone(g)]));
    const api: GreensApi = {
        async getByHole({ holeId }) { return rows.get(holeId) ? structuredClone(rows.get(holeId)!) : null; },
        async create(input) {
            const row: Green = {
                id: `g-${input.holeId}`, holeId: input.holeId, boundaryJson: null,
                centerLat: input.centerLat, centerLon: input.centerLon,
                frontLat: input.frontLat ?? null, frontLon: input.frontLon ?? null,
                backLat: input.backLat ?? null, backLon: input.backLon ?? null,
                elevation: input.elevation ?? null, version: 1,
            };
            rows.set(row.holeId, row);
            return structuredClone(row);
        },
        async update() { throw new Error('not under test'); },
    };
    return { api, rows };
}

function fakePins(initial: Pin[] = []) {
    const rows = new Map(initial.map(p => [p.id, structuredClone(p)]));
    let seq = 0;
    const calls = { create: 0, update: 0, remove: 0, setActive: 0, listGreen: 0, listCourse: 0 };
    const api: PinsApi = {
        async listByGreen({ greenId }) { calls.listGreen++; return [...rows.values()].filter(p => p.greenId === greenId).map(x => structuredClone(x)); },
        async listByCourse() { calls.listCourse++; return [...rows.values()].map(x => structuredClone(x)); },
        async create(input) {
            calls.create++;
            const row: Pin = {
                id: `p${++seq}`, greenId: input.greenId, name: input.name, lat: input.lat, lon: input.lon,
                difficulty: input.difficulty ?? null, active: false, version: 1,
            };
            rows.set(row.id, row);
            return structuredClone(row);
        },
        async update(input) {
            calls.update++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.name !== undefined) row.name = input.name;
            if (input.lat !== undefined) row.lat = input.lat;
            if (input.lon !== undefined) row.lon = input.lon;
            if (input.difficulty !== undefined) row.difficulty = input.difficulty;
            row.version++;
            return structuredClone(row);
        },
        async remove(input) {
            calls.remove++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            rows.delete(input.id);
            return { ok: true };
        },
        async setActive(input) {
            calls.setActive++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            // Exclusive per green.
            for (const p of rows.values()) if (p.greenId === row.greenId) p.active = false;
            row.active = true;
            row.version++;
            return structuredClone(row);
        },
    };
    return { api, rows, calls };
}

function fakeAims(initial: AimPoint[] = []) {
    const rows = new Map(initial.map(a => [a.id, structuredClone(a)]));
    let seq = 0;
    const calls = { create: 0, update: 0, remove: 0, reorder: 0 };
    const api: AimPointsApi = {
        async listByHole({ holeId }) { return [...rows.values()].filter(a => a.holeId === holeId).map(x => structuredClone(x)); },
        async create(input) {
            calls.create++;
            const row: AimPoint = {
                id: `a${++seq}`, holeId: input.holeId, lat: input.lat, lon: input.lon,
                elevation: input.elevation ?? null, label: input.label ?? null,
                sortOrder: [...rows.values()].filter(a => a.holeId === input.holeId).length, version: 1,
            };
            rows.set(row.id, row);
            return structuredClone(row);
        },
        async update(input) {
            calls.update++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.lat !== undefined) row.lat = input.lat;
            if (input.lon !== undefined) row.lon = input.lon;
            if (input.elevation !== undefined) row.elevation = input.elevation;
            if (input.label !== undefined) row.label = input.label;
            row.version++;
            return structuredClone(row);
        },
        async remove(input) {
            calls.remove++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            rows.delete(input.id);
            return { ok: true };
        },
        async reorder(input) {
            calls.reorder++;
            input.orderedIds.forEach((id, i) => { const r = rows.get(id); if (r) r.sortOrder = i; });
            return { ok: true };
        },
    };
    return { api, rows, calls };
}

/** Elevation sampler that returns a fixed value (and records queries). */
function fakeElevation(value: number | null = 72.5): ElevationSampler & { queries: Array<{ lng: number; lat: number }> } {
    const queries: Array<{ lng: number; lat: number }> = [];
    return {
        queries,
        async elevationAt(lngLat) { queries.push(lngLat); return value; },
    };
}

function makeService(opts: {
    tees?: ReturnType<typeof fakeTees>;
    greens?: ReturnType<typeof fakeGreens>;
    pins?: ReturnType<typeof fakePins>;
    aims?: ReturnType<typeof fakeAims>;
    elevation?: ReturnType<typeof fakeElevation>;
} = {}) {
    const tees = opts.tees ?? fakeTees();
    const greens = opts.greens ?? fakeGreens();
    const pins = opts.pins ?? fakePins();
    const aims = opts.aims ?? fakeAims();
    const elevation = opts.elevation ?? fakeElevation();
    const svc = new FurnitureService(tees.api, greens.api, pins.api, aims.api, elevation);
    return { svc, tees, greens, pins, aims, elevation };
}

function greenRow(holeId: string): Green {
    return {
        id: `g-${holeId}`, holeId, boundaryJson: null, centerLat: LAT, centerLon: LON,
        frontLat: LAT - 0.0002, frontLon: LON, backLat: LAT + 0.0002, backLon: LON,
        elevation: 60, version: 1,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('load', () => {
    test('populates all stores; cached per courseId', async () => {
        const green = greenRow('h1');
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const g = fakeGreens([green]);
        const p = fakePins([{ id: 'p1', greenId: green.id, name: 'Pin', lat: LAT, lon: LON, difficulty: 'easy', active: true, version: 1 }]);
        const a = fakeAims([{ id: 'a1', holeId: 'h1', lat: LAT, lon: LON, elevation: 60, label: 'A1', sortOrder: 0, version: 1 }]);
        const { svc } = makeService({ tees: t, greens: g, pins: p, aims: a });

        svc.setHoleIds(['h1']);
        await svc.load('c1', ['h1']);
        expect(svc.tees.items.get().map(x => x.id)).toEqual(['t1']);
        expect(svc.pins.items.get().map(x => x.id)).toEqual(['p1']);
        expect(svc.aims.items.get().map(x => x.id)).toEqual(['a1']);
        expect(svc.greens.get()).toHaveLength(1);

        await svc.load('c1', ['h1']);
        expect(t.calls.listCourse).toBe(1); // cached
    });

    test('load failure sets error and leaves cache open for retry', async () => {
        const t = fakeTees();
        t.api.listByCourse = () => Promise.reject(new ApiError(500, 'boom'));
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        expect(svc.error.get()?.code).toBe('server');
    });
});

describe('createTee (elevation auto-sampled)', () => {
    test('samples elevation at placement, stores it, selects the new tee', async () => {
        const elevation = fakeElevation(88.2);
        const { svc, tees } = makeService({ elevation });
        await svc.load('c1', ['h1']);

        const created = await svc.createTee({ holeId: 'h1', name: 'Red', color: 'red', lat: LAT, lon: LON });
        expect(created?.elevation).toBe(88.2);
        expect(elevation.queries).toEqual([{ lng: LON, lat: LAT }]);
        expect(svc.selection.get()).toEqual({ kind: 'tee', id: created!.id });
        expect(tees.rows.get(created!.id)!.elevation).toBe(88.2);
    });

    test('omits elevation from payload when the sampler returns null (no coverage)', async () => {
        const { svc, tees } = makeService({ elevation: fakeElevation(null) });
        await svc.load('c1', ['h1']);
        const created = await svc.createTee({ holeId: 'h1', name: 'Red', color: 'red', lat: LAT, lon: LON });
        expect(created?.elevation).toBeNull();
        expect(tees.rows.get(created!.id)!.elevation).toBeNull();
    });
});

describe('moveTee', () => {
    test('re-samples elevation, patches locally then persists', async () => {
        const elevation = fakeElevation(70);
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const { svc, tees } = makeService({ tees: t, elevation });
        await svc.load('c1', ['h1']);

        const moved = await svc.moveTee('t1', LAT + 0.001, LON + 0.001);
        expect(moved?.version).toBe(2);
        expect(moved?.elevation).toBe(70);
        expect(tees.rows.get('t1')!.lat).toBeCloseTo(LAT + 0.001, 9);
        expect(elevation.queries.at(-1)).toEqual({ lng: LON + 0.001, lat: LAT + 0.001 });
    });

    test('version conflict re-syncs stores from the server', async () => {
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Y', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const { svc } = makeService({ tees: t });
        svc.setHoleIds(['h1']);
        await svc.load('c1', ['h1']);
        t.rows.get('t1')!.version = 5; // competing writer

        const result = await svc.moveTee('t1', LAT, LON);
        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');
        await Bun.sleep(0);
        expect(svc.tees.items.get()[0].version).toBe(5);
    });
});

describe('removeTee', () => {
    test('removes from server + store and clears selection', async () => {
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Y', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const { svc, tees } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        svc.select({ kind: 'tee', id: 't1' });

        const ok = await svc.removeTee('t1');
        expect(ok).toBe(true);
        expect(svc.tees.items.get()).toHaveLength(0);
        expect(svc.selection.get()).toBeNull();
        expect(tees.rows.size).toBe(0);
    });
});

describe('pins: create / set-active exclusivity', () => {
    test('createPin adds and selects; greenForHole resolves the green', async () => {
        const green = greenRow('h1');
        const g = fakeGreens([green]);
        const { svc } = makeService({ greens: g });
        await svc.load('c1', ['h1']);
        expect(svc.greenForHole('h1')?.id).toBe(green.id);

        const created = await svc.createPin({ greenId: green.id, name: 'Front-left', difficulty: 'easy', lat: LAT, lon: LON });
        expect(created?.name).toBe('Front-left');
        expect(svc.selection.get()).toEqual({ kind: 'pin', id: created!.id });
    });

    test('setPinActive flips exclusivity across the green after refetch', async () => {
        const green = greenRow('h1');
        const p = fakePins([
            { id: 'p1', greenId: green.id, name: 'A', lat: LAT, lon: LON, difficulty: 'easy', active: true, version: 1 },
            { id: 'p2', greenId: green.id, name: 'B', lat: LAT, lon: LON, difficulty: 'hard', active: false, version: 1 },
        ]);
        const { svc } = makeService({ greens: fakeGreens([green]), pins: p });
        await svc.load('c1', ['h1']);

        const ok = await svc.setPinActive('p2');
        expect(ok).toBe(true);
        const byId = new Map(svc.pins.items.get().map(x => [x.id, x]));
        expect(byId.get('p2')!.active).toBe(true);
        expect(byId.get('p1')!.active).toBe(false); // exclusivity refreshed
        expect(p.calls.setActive).toBe(1);
        expect(p.calls.listGreen).toBe(1);
    });
});

describe('aim points: create ordering + reorder', () => {
    test('createAim appends with an increasing sortOrder and stores elevation', async () => {
        const elevation = fakeElevation(63);
        const { svc } = makeService({ elevation });
        await svc.load('c1', ['h1']);

        const a1 = await svc.createAim({ holeId: 'h1', lat: LAT, lon: LON, label: 'A1' });
        const a2 = await svc.createAim({ holeId: 'h1', lat: LAT + 0.001, lon: LON, label: 'A2' });
        expect(a1?.sortOrder).toBe(0);
        expect(a2?.sortOrder).toBe(1);
        expect(a1?.elevation).toBe(63);
        expect(svc.aimsForHole('h1').map(a => a.id)).toEqual([a1!.id, a2!.id]);
    });

    test('reorderAims swaps ordering locally and on the server', async () => {
        const a = fakeAims([
            { id: 'a1', holeId: 'h1', lat: LAT, lon: LON, elevation: 60, label: 'A1', sortOrder: 0, version: 1 },
            { id: 'a2', holeId: 'h1', lat: LAT, lon: LON, elevation: 61, label: 'A2', sortOrder: 1, version: 1 },
        ]);
        const { svc } = makeService({ aims: a });
        await svc.load('c1', ['h1']);

        const ok = await svc.reorderAims('h1', ['a2', 'a1']);
        expect(ok).toBe(true);
        expect(svc.aimsForHole('h1').map(x => x.id)).toEqual(['a2', 'a1']);
        expect(a.rows.get('a2')!.sortOrder).toBe(0);
        expect(a.calls.reorder).toBe(1);
    });
});

describe('placement state machine', () => {
    test('arm sets the kind and clears selection; arming the same kind toggles off', () => {
        const { svc } = makeService();
        svc.select({ kind: 'tee', id: 't1' });
        svc.arm('pin');
        expect(svc.placing.get()).toBe('pin');
        expect(svc.selection.get()).toBeNull();

        svc.arm('pin'); // toggle
        expect(svc.placing.get()).toBeNull();

        svc.arm('aim');
        expect(svc.placing.get()).toBe('aim');
    });

    test('select clears any armed placement', () => {
        const { svc } = makeService();
        svc.arm('tee');
        svc.select({ kind: 'aim', id: 'a1' });
        expect(svc.placing.get()).toBeNull();
        expect(svc.selection.get()).toEqual({ kind: 'aim', id: 'a1' });
    });

    test('disarm leaves select mode', () => {
        const { svc } = makeService();
        svc.arm('tee');
        svc.disarm();
        expect(svc.placing.get()).toBeNull();
    });
});
