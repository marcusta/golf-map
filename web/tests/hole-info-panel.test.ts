import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { playingLength, pathMeters } from '../src/course-detail/hole-length';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FurnitureService } from '../src/furniture/furniture.service';
import type { Tee } from '../../shared/api/tees.gen';
import type { AimPoint } from '../../shared/api/aim-points.gen';
import type { Green } from '../../shared/api/greens.gen';
import type { Course, CoursesApi } from '../../shared/api/courses.gen';
import type { Hole, HolesApi } from '../../shared/api/holes.gen';

afterEach(() => _reset());

const LAT = 58.4015;
const LON = 15.5658;

function tee(over: Partial<Tee> = {}): Tee {
    return { id: 't1', holeId: 'h1', name: 'Yellow', color: 'yellow', lat: LAT, lon: LON, elevation: null, sortOrder: 0, version: 1, ...over };
}
function aim(lat: number, lon: number, over: Partial<AimPoint> = {}): AimPoint {
    return { id: 'a', holeId: 'h1', lat, lon, elevation: null, label: null, sortOrder: 0, version: 1, ...over };
}

// ── Playing-length pure function ────────────────────────────────────────────

describe('playingLength', () => {
    test('tee → single aim → green center sums projected legs, rounded', () => {
        const t = tee({ lat: LAT, lon: LON });
        const a = aim(LAT + 0.001, LON + 0.0005);
        const green = { lat: LAT + 0.002, lon: LON + 0.001 };

        // Reference: same legs measured directly in EPSG:3006.
        const p = (lat: number, lon: number) => wgs84ToSweref99tm(lat, lon);
        const pt = p(t.lat, t.lon), pa = p(a.lat, a.lon), pg = p(green.lat, green.lon);
        const expected = Math.round(
            Math.hypot(pa.x - pt.x, pa.y - pt.y) + Math.hypot(pg.x - pa.x, pg.y - pa.y),
        );

        const res = playingLength(t, [a], green);
        expect(res.meters).toBe(expected);
        expect(res.approximate).toBe(false);
    });

    test('multi-aim path adds every leg in order', () => {
        const t = tee();
        const a1 = aim(LAT + 0.0008, LON, { id: 'a1', sortOrder: 0 });
        const a2 = aim(LAT + 0.0016, LON + 0.0006, { id: 'a2', sortOrder: 1 });
        const green = { lat: LAT + 0.0024, lon: LON };

        const direct = pathMeters([
            { lat: t.lat, lon: t.lon },
            { lat: a1.lat, lon: a1.lon },
            { lat: a2.lat, lon: a2.lon },
            green,
        ]);
        expect(playingLength(t, [a1, a2], green).meters).toBe(Math.round(direct));
    });

    test('no green center → tee→aims only, flagged approximate', () => {
        const t = tee();
        const a = aim(LAT + 0.001, LON);
        const res = playingLength(t, [a], null);
        expect(res.approximate).toBe(true);
        const direct = Math.round(pathMeters([{ lat: t.lat, lon: t.lon }, { lat: a.lat, lon: a.lon }]));
        expect(res.meters).toBe(direct);
    });

    test('tee with no aims and no green → null (single point)', () => {
        expect(playingLength(tee(), [], null)).toEqual({ meters: null, approximate: true });
    });

    test('tee-only with a green center still measures the direct leg', () => {
        const t = tee();
        const green = { lat: LAT + 0.001, lon: LON };
        const res = playingLength(t, [], green);
        expect(res.approximate).toBe(false);
        expect(res.meters).toBeGreaterThan(0);
    });

    test('null tee → null length', () => {
        expect(playingLength(null, [aim(LAT, LON)], { lat: LAT, lon: LON })).toEqual({ meters: null, approximate: false });
    });
});

// ── Active-tee radio resolution (the binding the panel uses) ─────────────────

function fakeTeesApi(rows: Tee[]) {
    const map = new Map(rows.map(r => [r.id, r]));
    return {
        async listByHole({ holeId }: { holeId: string }) { return rows.filter(r => r.holeId === holeId); },
        async listByCourse() { return [...map.values()]; },
        async create() { throw new Error('nope'); },
        async update() { throw new Error('nope'); },
        async remove() { return { ok: true }; },
        async reorder() { return { ok: true }; },
    } as any;
}
function fakeGreensApi(rows: Green[]) {
    return {
        async getByHole({ holeId }: { holeId: string }) { return rows.find(r => r.holeId === holeId) ?? null; },
        async create() { throw new Error('nope'); },
        async update() { throw new Error('nope'); },
    } as any;
}
const emptyPins = { async listByGreen() { return []; }, async listByCourse() { return []; }, async create() { throw 0; }, async update() { throw 0; }, async remove() { return { ok: true }; }, async setActive() { throw 0; } } as any;
const emptyAims = { async listByHole() { return []; }, async create() { throw 0; }, async update() { throw 0; }, async remove() { return { ok: true }; }, async reorder() { return { ok: true }; } } as any;

describe('active-tee radio resolution', () => {
    test('default (no active name) checks the first tee by sortOrder; setActive flips it', async () => {
        const tees = [
            tee({ id: 'tA', name: 'White', sortOrder: 0 }),
            tee({ id: 'tB', name: 'Yellow', sortOrder: 1 }),
        ];
        const svc = new FurnitureService(fakeTeesApi(tees), fakeGreensApi([]), emptyPins, emptyAims);
        await svc.load('c1', ['h1']);

        // Panel binds: radio.checked = lineOriginTee(holeId)?.id === tee.id
        expect(svc.lineOriginTee('h1')?.id).toBe('tA');

        svc.setActiveTeeName('Yellow');
        expect(svc.lineOriginTee('h1')?.id).toBe('tB');
    });

    test('active name is case-insensitive and sticky across holes with fallback', async () => {
        const tees = [
            tee({ id: 'h1w', holeId: 'h1', name: 'White', sortOrder: 0 }),
            tee({ id: 'h1y', holeId: 'h1', name: 'Yellow', sortOrder: 1 }),
            tee({ id: 'h2w', holeId: 'h2', name: 'White', sortOrder: 0 }),
            // hole 2 has NO yellow tee
        ];
        const svc = new FurnitureService(fakeTeesApi(tees), fakeGreensApi([]), emptyPins, emptyAims);
        await svc.load('c1', ['h1', 'h2']);

        svc.setActiveTeeName('yellow'); // lower-case
        expect(svc.lineOriginTee('h1')?.id).toBe('h1y'); // matched
        expect(svc.lineOriginTee('h2')?.id).toBe('h2w'); // fallback to first
    });
});

// ── updateHole flow (par / stroke index) ────────────────────────────────────

function course(id: string): Course {
    return { id, name: 'Masters', status: 'draft', revision: 1, crs: 'EPSG:3006', georeferenceJson: null, homeLat: null, homeLon: null, notes: null, version: 1, createdAt: '', updatedAt: '' };
}
function hole(over: Partial<Hole> = {}): Hole {
    return { id: 'h1', courseId: 'c1', number: 5, par: 4, strokeIndex: null, notes: null, savedRegionJson: null, version: 1, createdAt: '', updatedAt: '', ...over };
}

function fakeHolesApi(initial: Hole[], opts: { conflict?: boolean } = {}) {
    const rows = new Map(initial.map(h => [h.id, { ...h }]));
    const calls = { update: 0, get: 0 };
    const api: HolesApi = {
        async listByCourse({ courseId }) { return [...rows.values()].filter(h => h.courseId === courseId); },
        async get({ id }: { id: string }) { calls.get++; const r = rows.get(id); if (!r) throw new ApiError(404, 'nf'); return { ...r }; },
        async create() { throw new Error('nope'); },
        async update(input) {
            calls.update++;
            const r = rows.get(input.id);
            if (!r) throw new ApiError(404, 'nf');
            if (opts.conflict || r.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.par !== undefined) r.par = input.par;
            if (input.strokeIndex !== undefined) r.strokeIndex = input.strokeIndex;
            r.version++;
            return { ...r };
        },
        async remove() { return { ok: true }; },
    };
    const coursesApi: CoursesApi = {
        list: async () => [], get: async ({ id }: { id: string }) => course(id), create: async () => { throw 0; },
        update: async () => { throw 0; }, remove: async () => ({ ok: true }), publish: async () => { throw 0; },
    } as any;
    return { api, coursesApi, calls, rows };
}

describe('CourseDetailService.updateHole', () => {
    test('updates par optimistically and bumps version in the holes signal', async () => {
        const { api, coursesApi, calls } = fakeHolesApi([hole()]);
        const svc = new CourseDetailService(coursesApi, api);
        await svc.load('c1');

        const updated = await svc.updateHole('h1', { par: 5 });
        expect(updated?.par).toBe(5);
        expect(updated?.version).toBe(2);
        expect(svc.holes.get().find(h => h.id === 'h1')?.par).toBe(5);
        expect(svc.totalPar.get()).toBe(5);
        expect(calls.update).toBe(1);
    });

    test('sets and clears stroke index (blank → null)', async () => {
        const { api, coursesApi } = fakeHolesApi([hole()]);
        const svc = new CourseDetailService(coursesApi, api);
        await svc.load('c1');

        await svc.updateHole('h1', { strokeIndex: 7 });
        expect(svc.holes.get()[0].strokeIndex).toBe(7);

        await svc.updateHole('h1', { strokeIndex: null });
        expect(svc.holes.get()[0].strokeIndex).toBeNull();
    });

    test('version conflict refetches the hole so the next edit self-heals', async () => {
        const { api, coursesApi, calls } = fakeHolesApi([hole({ version: 9 })], { conflict: true });
        const svc = new CourseDetailService(coursesApi, api);
        await svc.load('c1');

        const res = await svc.updateHole('h1', { par: 5 });
        expect(res).toBeUndefined();
        expect(calls.get).toBeGreaterThan(0); // refetched
        // signal still holds a coherent (server) row
        expect(svc.holes.get()[0].id).toBe('h1');
    });

    test('unknown hole id is a no-op', async () => {
        const { api, coursesApi, calls } = fakeHolesApi([hole()]);
        const svc = new CourseDetailService(coursesApi, api);
        await svc.load('c1');
        expect(await svc.updateHole('missing', { par: 5 })).toBeUndefined();
        expect(calls.update).toBe(0);
    });
});
