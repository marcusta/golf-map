import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { FurnitureService, defaultTeeName, finiteWgs84Point, greenPointFields, type ElevationSampler } from '../src/furniture/furniture.service';
import { buildFurnitureGeojson } from '../src/furniture/furniture-overlay';
import type { Feature } from 'geojson';
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
    const calls = { create: 0, update: 0 };
    const api: GreensApi = {
        async getByHole({ holeId }) { return rows.get(holeId) ? structuredClone(rows.get(holeId)!) : null; },
        async create(input) {
            calls.create++;
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
        async update(input) {
            calls.update++;
            const row = [...rows.values()].find(g => g.id === input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.centerLat !== undefined) row.centerLat = input.centerLat;
            if (input.centerLon !== undefined) row.centerLon = input.centerLon;
            if (input.frontLat !== undefined) row.frontLat = input.frontLat;
            if (input.frontLon !== undefined) row.frontLon = input.frontLon;
            if (input.backLat !== undefined) row.backLat = input.backLat;
            if (input.backLon !== undefined) row.backLon = input.backLon;
            if (input.elevation !== undefined) row.elevation = input.elevation;
            row.version++;
            return structuredClone(row);
        },
    };
    return { api, rows, calls };
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

    test('failed reload does not poison later tee creates', async () => {
        const t = fakeTees();
        const { svc, tees } = makeService({ tees: t });
        await svc.load('c1', ['h1']);

        t.api.listByCourse = () => Promise.reject(new ApiError(500, 'boom'));
        await svc.reload(['h1', 'h2']);
        expect(svc.error.get()?.code).toBe('server');

        const created = await svc.createTee({ holeId: 'h2', name: 'White', color: 'white', lat: LAT, lon: LON });
        expect(created?.holeId).toBe('h2');
        expect(tees.calls.create).toBe(1);
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

    test('arm and select clear any transient notice', () => {
        const { svc } = makeService();
        svc.notice.set('boom');
        svc.arm('tee');
        expect(svc.notice.get()).toBeNull();

        svc.notice.set('boom again');
        svc.select({ kind: 'aim', id: 'a1' });
        expect(svc.notice.get()).toBeNull();
    });
});

describe('duplicate tee-name handling', () => {
    function teeRow(id: string, holeId: string, name: string, color: string): Tee {
        return { id, holeId, name, color, lat: LAT, lon: LON, elevation: null, sortOrder: 0, version: 1 };
    }

    test('teeNameTaken matches case-insensitively per hole', async () => {
        const t = fakeTees([teeRow('t1', 'h1', 'Blue', 'blue')]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        expect(svc.teeNameTaken('h1', 'Blue')).toBe(true);
        expect(svc.teeNameTaken('h1', ' blue ')).toBe(true); // trimmed + lowercased
        expect(svc.teeNameTaken('h1', 'Red')).toBe(false);
        expect(svc.teeNameTaken('h2', 'Blue')).toBe(false); // different hole
    });

    test('advancePendingTee skips taken presets to the next free colour', async () => {
        // Black, White, Yellow already placed on the hole; pending is white.
        const t = fakeTees([
            teeRow('t1', 'h1', 'Black', 'black'),
            teeRow('t2', 'h1', 'White', 'white'),
            teeRow('t3', 'h1', 'Yellow', 'yellow'),
        ]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        svc.pendingTeeColor.set('white');

        const advanced = svc.advancePendingTee('h1');
        expect(advanced).toBe(true);
        // Next free preset after white/yellow is blue.
        expect(svc.pendingTeeColor.get()).toBe('blue');
        expect(svc.pendingTeeName.get()).toBe(''); // cleared → falls back to default name
    });

    test('advancePendingTee returns false when every preset is used', async () => {
        const t = fakeTees([
            teeRow('t1', 'h1', 'Black', 'black'),
            teeRow('t2', 'h1', 'White', 'white'),
            teeRow('t3', 'h1', 'Yellow', 'yellow'),
            teeRow('t4', 'h1', 'Blue', 'blue'),
            teeRow('t5', 'h1', 'Red', 'red'),
        ]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        expect(svc.advancePendingTee('h1')).toBe(false);
    });

    test('defaultTeeName capitalizes the colour', () => {
        expect(defaultTeeName('blue')).toBe('Blue');
        expect(defaultTeeName('red')).toBe('Red');
    });
});

describe('green points: move / place / create-row', () => {
    test('greenPointFields maps each point to its lat/lon pair', () => {
        expect(greenPointFields('center', 1, 2)).toEqual({ centerLat: 1, centerLon: 2 });
        expect(greenPointFields('front', 1, 2)).toEqual({ frontLat: 1, frontLon: 2 });
        expect(greenPointFields('back', 1, 2)).toEqual({ backLat: 1, backLon: 2 });
    });

    test('setGreenPoint(front) on an existing row updates the front pair, re-samples elevation, bumps version', async () => {
        const green = greenRow('h1'); // has front/back set, version 1
        const g = fakeGreens([green]);
        const elevation = fakeElevation(81.4);
        const { svc } = makeService({ greens: g, elevation });
        await svc.load('c1', ['h1']);

        const nLat = LAT - 0.0005, nLon = LON + 0.0003;
        const result = await svc.setGreenPoint('h1', 'front', nLat, nLon);
        expect(result?.frontLat).toBeCloseTo(nLat, 9);
        expect(result?.frontLon).toBeCloseTo(nLon, 9);
        expect(result?.centerLat).toBe(green.centerLat); // untouched
        expect(result?.elevation).toBe(81.4);
        expect(result?.version).toBe(2);
        // Persisted + reflected in the store; selection points at the moved point.
        expect(g.rows.get('h1')!.frontLat).toBeCloseTo(nLat, 9);
        expect(g.calls.update).toBe(1);
        expect(svc.selection.get()).toEqual({ kind: 'green', holeId: 'h1', point: 'front' });
        expect(elevation.queries.at(-1)).toEqual({ lng: nLon, lat: nLat });
    });

    test('setGreenPoint(center) moves only the center pair', async () => {
        const green = greenRow('h1');
        const g = fakeGreens([green]);
        const { svc } = makeService({ greens: g });
        await svc.load('c1', ['h1']);

        const result = await svc.setGreenPoint('h1', 'center', LAT + 0.001, LON);
        expect(result?.centerLat).toBeCloseTo(LAT + 0.001, 9);
        expect(result?.frontLat).toBe(green.frontLat); // untouched
    });

    test('setGreenPoint on a green-less hole with CENTER creates the row', async () => {
        const g = fakeGreens([]); // no rows
        const elevation = fakeElevation(50);
        const { svc } = makeService({ greens: g, elevation });
        await svc.load('c1', ['h1']);
        expect(svc.greenForHole('h1')).toBeNull();

        const created = await svc.setGreenPoint('h1', 'center', LAT, LON);
        expect(created).toBeDefined();
        expect(g.calls.create).toBe(1);
        expect(created?.centerLat).toBe(LAT);
        expect(created?.elevation).toBe(50);
        expect(svc.greenForHole('h1')?.id).toBe(created!.id);
        expect(svc.greens.get()).toHaveLength(1);
        expect(svc.selection.get()).toEqual({ kind: 'green', holeId: 'h1', point: 'center' });
    });

    test('setGreenPoint FRONT on a green-less hole is rejected (center required first) with a notice', async () => {
        const g = fakeGreens([]);
        const { svc } = makeService({ greens: g });
        await svc.load('c1', ['h1']);

        const result = await svc.setGreenPoint('h1', 'front', LAT, LON);
        expect(result).toBeUndefined();
        expect(g.calls.create).toBe(0);
        expect(svc.greenForHole('h1')).toBeNull();
        expect(svc.notice.get()).toMatch(/Center first/i);
    });

    test('version conflict on update re-syncs the greens store', async () => {
        const green = greenRow('h1');
        const g = fakeGreens([green]);
        const { svc } = makeService({ greens: g });
        svc.setHoleIds(['h1']);
        await svc.load('c1', ['h1']);
        g.rows.get('h1')!.version = 9; // competing writer

        const result = await svc.setGreenPoint('h1', 'back', LAT + 0.002, LON);
        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');
        await Bun.sleep(0);
        expect(svc.greens.get()[0].version).toBe(9);
    });

    test('greenPointStatus reports which points exist', async () => {
        const green: Green = { ...greenRow('h1'), frontLat: LAT, frontLon: LON, backLat: null, backLon: null };
        const g = fakeGreens([green]);
        const { svc } = makeService({ greens: g });
        await svc.load('c1', ['h1']);
        expect(svc.greenPointStatus('h1')).toEqual({ center: true, front: true, back: false });
        expect(svc.greenPointStatus('nope')).toBeNull();
    });

    test('green point helpers treat missing and non-finite coordinates as absent', async () => {
        const green = {
            ...greenRow('h1'),
            frontLat: undefined,
            frontLon: undefined,
            backLat: Number.NaN,
            backLon: LON,
        } as unknown as Green;
        const g = fakeGreens([green]);
        const { svc } = makeService({ greens: g });
        await svc.load('c1', ['h1']);

        expect(svc.greenPointPos(green, 'center')).toEqual({ lat: LAT, lon: LON });
        expect(svc.greenPointPos(green, 'front')).toBeNull();
        expect(svc.greenPointPos(green, 'back')).toBeNull();
        expect(svc.greenPointStatus('h1')).toEqual({ center: true, front: false, back: false });
    });

    test('selectedGreen resolves the row + point for a green selection', async () => {
        const green = greenRow('h1');
        const g = fakeGreens([green]);
        const { svc } = makeService({ greens: g });
        await svc.load('c1', ['h1']);
        svc.select({ kind: 'green', holeId: 'h1', point: 'back' });
        const sel = svc.selectedGreen.get();
        expect(sel?.point).toBe('back');
        expect(sel?.green.id).toBe(green.id);
    });
});

// ── Overlay rebuild (Issue 1: stale overlay after a move commit) ─────────────
//
// The always-on overlay is (re)built by an effect in FurnitureToolService that
// derives an OverlayInput from the service's stores and feeds it to
// buildFurnitureGeojson. We can't mount MapLibre here, but we can assert the
// derivation the effect performs — reading the SAME store signals it reads —
// yields updated coordinates immediately after a move commit. If moveTee left
// the store stale (the bug), the rebuilt geojson would still show old coords.

/** Mirror the tool's overlay-input derivation from the live service stores. */
function overlayInputFrom(svc: FurnitureService, holeIds: string[]) {
    const lineOriginByHole = new Map<string, string>();
    for (const holeId of holeIds) {
        const origin = svc.lineOriginTee(holeId);
        if (origin) lineOriginByHole.set(holeId, origin.id);
    }
    return {
        tees: svc.tees.items.get(),
        pins: svc.pins.items.get(),
        greens: svc.greens.get(),
        aims: svc.aims.items.get(),
        holeIds,
        selection: svc.selection.get(),
        lineOriginByHole,
    };
}

function teePoint(fc: { features: Feature[] }, id: string): [number, number] | null {
    const f = fc.features.find(x => x.properties?.role === 'tee' && x.properties?.id === id);
    return f ? (f.geometry as unknown as { coordinates: [number, number] }).coordinates : null;
}

function aimLineStart(fc: { features: Feature[] }): [number, number] | null {
    const f = fc.features.find(x => x.properties?.role === 'aim-line');
    if (!f) return null;
    return (f.geometry as unknown as { coordinates: [number, number][] }).coordinates[0] ?? null;
}

function allPositions(fc: { features: Feature[] }): [number, number][] {
    const out: [number, number][] = [];
    for (const feature of fc.features) {
        const geometry = feature.geometry as unknown as { type: string; coordinates: unknown };
        if (geometry.type === 'Point') {
            out.push(geometry.coordinates as [number, number]);
        } else if (geometry.type === 'LineString') {
            out.push(...(geometry.coordinates as [number, number][]));
        }
    }
    return out;
}

describe('aim polyline on holes without aim points (par 3s)', () => {
    test('draws the direct tee → green-center line when a hole has zero aims', async () => {
        const green = greenRow('h1');
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const { svc } = makeService({ tees: t, greens: fakeGreens([green]) });
        await svc.load('c1', ['h1']);

        const fc = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        const line = fc.features.find(x => x.properties?.role === 'aim-line');
        expect(line).toBeDefined();
        const coords = (line!.geometry as unknown as { coordinates: [number, number][] }).coordinates;
        expect(coords).toHaveLength(2);
        expect(coords[0]).toEqual([LON, LAT]);
        expect(coords[1]).toEqual([green.centerLon, green.centerLat]);
    });

    test('no line when the hole has only a tee (no green, no aims)', async () => {
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        const fc = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        expect(fc.features.find(x => x.properties?.role === 'aim-line')).toBeUndefined();
    });

    test('skips missing green front/back points instead of emitting non-finite coordinates', async () => {
        const green = {
            ...greenRow('h1'),
            frontLat: undefined,
            frontLon: undefined,
            backLat: Number.NaN,
            backLon: LON,
        } as unknown as Green;
        const t = fakeTees([
            { id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 },
            { id: 'bad-tee', holeId: 'h1', name: 'Bad', color: null, lat: Number.NaN, lon: LON, elevation: null, sortOrder: 1, version: 1 },
        ]);
        const a = fakeAims([
            { id: 'a1', holeId: 'h1', lat: LAT + 0.001, lon: LON, elevation: null, label: 'A1', sortOrder: 0, version: 1 },
            { id: 'bad-aim', holeId: 'h1', lat: LAT, lon: Number.NaN, elevation: null, label: 'bad', sortOrder: 1, version: 1 },
        ]);
        const { svc } = makeService({ tees: t, greens: fakeGreens([green]), aims: a });
        await svc.load('c1', ['h1']);

        const fc = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        expect(fc.features.find(x => x.properties?.role === 'green-front')).toBeUndefined();
        expect(fc.features.find(x => x.properties?.role === 'green-back')).toBeUndefined();
        expect(fc.features.find(x => x.properties?.role === 'tee' && x.properties?.id === 'bad-tee')).toBeUndefined();
        expect(fc.features.find(x => x.properties?.role === 'aim' && x.properties?.id === 'bad-aim')).toBeUndefined();
        expect(allPositions(fc).every(([lon, lat]) => finiteWgs84Point(lat, lon) !== null)).toBe(true);
    });
});

describe('overlay rebuild reflects data changes (Issue 1)', () => {
    test('rebuilt geojson shows the moved tee coords immediately after moveTee', async () => {
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);

        const before = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        expect(teePoint(before, 't1')).toEqual([LON, LAT]);

        const nLat = LAT + 0.001, nLon = LON - 0.001;
        await svc.moveTee('t1', nLat, nLon);

        const after = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        const pt = teePoint(after, 't1')!;
        expect(pt[0]).toBeCloseTo(nLon, 9);
        expect(pt[1]).toBeCloseTo(nLat, 9);
    });

    test('the aim polyline start follows the moved origin tee after commit', async () => {
        const t = fakeTees([{ id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: 55, sortOrder: 0, version: 1 }]);
        const a = fakeAims([
            { id: 'a1', holeId: 'h1', lat: LAT + 0.002, lon: LON, elevation: 60, label: 'A1', sortOrder: 0, version: 1 },
        ]);
        const g = fakeGreens([greenRow('h1')]);
        const { svc } = makeService({ tees: t, aims: a, greens: g });
        await svc.load('c1', ['h1']);

        expect(aimLineStart(buildFurnitureGeojson(overlayInputFrom(svc, ['h1'])))).toEqual([LON, LAT]);

        const nLat = LAT - 0.0007, nLon = LON + 0.0009;
        await svc.moveTee('t1', nLat, nLon);

        const start = aimLineStart(buildFurnitureGeojson(overlayInputFrom(svc, ['h1'])))!;
        expect(start[0]).toBeCloseTo(nLon, 9);
        expect(start[1]).toBeCloseTo(nLat, 9);
    });

    test('rebuilt geojson drops a deleted aim and shows a moved green center', async () => {
        const a = fakeAims([
            { id: 'a1', holeId: 'h1', lat: LAT, lon: LON, elevation: 60, label: 'A1', sortOrder: 0, version: 1 },
            { id: 'a2', holeId: 'h1', lat: LAT + 0.001, lon: LON, elevation: 61, label: 'A2', sortOrder: 1, version: 1 },
        ]);
        const g = fakeGreens([greenRow('h1')]);
        const { svc } = makeService({ aims: a, greens: g });
        await svc.load('c1', ['h1']);

        await svc.removeAim('a1');
        const after = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        const aimIds = after.features.filter(f => f.properties?.role === 'aim').map(f => f.properties?.id);
        expect(aimIds).toEqual(['a2']);

        const nLat = LAT + 0.003, nLon = LON + 0.003;
        await svc.setGreenPoint('h1', 'center', nLat, nLon);
        const after2 = buildFurnitureGeojson(overlayInputFrom(svc, ['h1']));
        const center = after2.features.find(f => f.properties?.role === 'green-center');
        const c = (center!.geometry as unknown as { coordinates: [number, number] }).coordinates;
        expect(c[0]).toBeCloseTo(nLon, 9);
        expect(c[1]).toBeCloseTo(nLat, 9);
    });
});

// ── Line-origin tee (Issue 2: course-level sticky active teebox) ─────────────

describe('active teebox / line-origin resolution', () => {
    function teeRow(id: string, holeId: string, name: string, color: string | null, sortOrder: number, lat = LAT, lon = LON): Tee {
        return { id, holeId, name, color, lat, lon, elevation: null, sortOrder, version: 1 };
    }

    test('defaults to the hole\'s first tee by sortOrder when no active name is set', async () => {
        const t = fakeTees([
            teeRow('t2', 'h1', 'Red', 'red', 1),
            teeRow('t1', 'h1', 'default', null, 0),
        ]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        expect(svc.activeTeeName.get()).toBeNull();
        expect(svc.lineOriginTee('h1')?.id).toBe('t1'); // sortOrder 0
    });

    test('resolves the active name (case-insensitive) to the matching tee', async () => {
        const t = fakeTees([
            teeRow('t1', 'h1', 'default', null, 0),
            teeRow('t2', 'h1', 'Red', 'red', 1),
        ]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1']);
        svc.setActiveTeeName('red');
        expect(svc.lineOriginTee('h1')?.id).toBe('t2');
    });

    test('is sticky across holes by name, falling back per hole when absent', async () => {
        // h1 has Yellow + default; h2 has only default (no Yellow).
        const t = fakeTees([
            teeRow('t1', 'h1', 'default', null, 0),
            teeRow('t2', 'h1', 'Yellow', 'yellow', 1),
            teeRow('t3', 'h2', 'default', null, 0),
        ]);
        const { svc } = makeService({ tees: t });
        await svc.load('c1', ['h1', 'h2']);
        svc.setActiveTeeName('Yellow');
        expect(svc.lineOriginTee('h1')?.id).toBe('t2'); // Yellow present
        expect(svc.lineOriginTee('h2')?.id).toBe('t3'); // falls back to first
    });

    test('null when the hole has no tees', async () => {
        const { svc } = makeService();
        await svc.load('c1', ['h1']);
        expect(svc.lineOriginTee('h1')).toBeNull();
    });

    test('deleting the active tee clears the stale name when none survives course-wide', async () => {
        const t = fakeTees([
            teeRow('t1', 'h1', 'default', null, 0),
            teeRow('t2', 'h1', 'Red', 'red', 1),
        ]);
        const { svc } = makeService({ tees: t });
        svc.setHoleIds(['h1']);
        await svc.load('c1', ['h1']);
        svc.setActiveTeeName('Red');

        await svc.removeTee('t2');
        expect(svc.activeTeeName.get()).toBeNull(); // stale entry cleared
        expect(svc.lineOriginTee('h1')?.id).toBe('t1'); // back to default
    });

    test('deleting one Red tee keeps the active name while another Red survives', async () => {
        const t = fakeTees([
            teeRow('t1', 'h1', 'Red', 'red', 0),
            teeRow('t2', 'h2', 'Red', 'red', 0),
        ]);
        const { svc } = makeService({ tees: t });
        svc.setHoleIds(['h1', 'h2']);
        await svc.load('c1', ['h1', 'h2']);
        svc.setActiveTeeName('Red');

        await svc.removeTee('t1');
        expect(svc.activeTeeName.get()).toBe('Red'); // h2's Red still exists
        expect(svc.lineOriginTee('h2')?.id).toBe('t2');
    });

    test('changing the active name re-anchors the rebuilt aim polyline immediately', async () => {
        const t = fakeTees([
            teeRow('t1', 'h1', 'default', null, 0, LAT, LON),
            teeRow('t2', 'h1', 'Red', 'red', 1, LAT + 0.0005, LON + 0.0005),
        ]);
        const a = fakeAims([{ id: 'a1', holeId: 'h1', lat: LAT + 0.002, lon: LON, elevation: 60, label: 'A1', sortOrder: 0, version: 1 }]);
        const { svc } = makeService({ tees: t, aims: a });
        await svc.load('c1', ['h1']);

        // Default origin = first tee (t1).
        expect(aimLineStart(buildFurnitureGeojson(overlayInputFrom(svc, ['h1'])))).toEqual([LON, LAT]);

        svc.setActiveTeeName('Red');
        const start = aimLineStart(buildFurnitureGeojson(overlayInputFrom(svc, ['h1'])))!;
        expect(start[0]).toBeCloseTo(LON + 0.0005, 9);
        expect(start[1]).toBeCloseTo(LAT + 0.0005, 9);
    });
});
