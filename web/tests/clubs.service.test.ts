import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { ClubsService } from '../src/player/clubs.service';
import type { Club, ClubsApi } from '../../shared/api/clubs.gen';

// ClubsService against an in-memory fake ClubsApi injected through the
// constructor — real service, real EntityStore, real request() wrapper.
// Mirrors the fake-API style of features.service.test.ts / courses.service.test.ts.

afterEach(() => _reset());

function club(id: string, name: string, carryM: number, dispersionM: number, sortOrder: number, version = 1): Club {
    return { id, userId: null, name, carryM, dispersionM, sortOrder, version };
}

/**
 * In-memory fake of the clubs API client: full CRUD + reorder with
 * server-accurate optimistic locking (version mismatch → 409 ApiError).
 * `list` always returns rows ordered by sortOrder, matching ClubsService.list
 * (server/services/clubs.service.ts orders by sort_order).
 */
function fakeApi(initial: Club[] = []) {
    const rows = new Map(initial.map(c => [c.id, structuredClone(c)]));
    let idSeq = 0;
    const calls = { list: 0, create: 0, update: 0, remove: 0, reorder: 0 };

    const api: ClubsApi = {
        async list() {
            calls.list++;
            return [...rows.values()].sort((a, b) => a.sortOrder - b.sortOrder).map(c => structuredClone(c));
        },
        async create(input) {
            calls.create++;
            const maxOrder = Math.max(-1, ...[...rows.values()].map(c => c.sortOrder));
            const created: Club = {
                id: `c${++idSeq}`,
                userId: null,
                name: input.name,
                carryM: input.carryM,
                dispersionM: input.dispersionM,
                sortOrder: maxOrder + 1,
                version: 1,
            };
            rows.set(created.id, created);
            return structuredClone(created);
        },
        async update(input) {
            calls.update++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.name !== undefined) row.name = input.name;
            if (input.carryM !== undefined) row.carryM = input.carryM;
            if (input.dispersionM !== undefined) row.dispersionM = input.dispersionM;
            row.version = input.version + 1;
            return structuredClone(row);
        },
        async remove(input) {
            calls.remove++;
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            rows.delete(input.id);
            return { ok: true };
        },
        async reorder(input) {
            calls.reorder++;
            input.orderedIds.forEach((id, i) => {
                const row = rows.get(id);
                if (row) row.sortOrder = i;
            });
            return { ok: true };
        },
    };
    return { api, rows, calls };
}

describe('load', () => {
    test('populates the store ordered by sortOrder; cached', async () => {
        const { api, calls } = fakeApi([
            club('b', 'Driver', 220, 20, 1),
            club('a', '7 Iron', 150, 10, 0),
        ]);
        const svc = new ClubsService(api);

        await svc.load();
        expect(svc.store.items.get().map(c => c.id)).toEqual(['a', 'b']);

        await svc.load();
        expect(calls.list).toBe(1); // cached
    });

    test('load failure sets error and leaves cache open for retry', async () => {
        const { api } = fakeApi();
        api.list = () => Promise.reject(new ApiError(500, 'boom'));
        const svc = new ClubsService(api);

        await svc.load();
        expect(svc.error.get()?.code).toBe('server');
        expect(svc.store.items.get()).toHaveLength(0);
    });
});

describe('create', () => {
    test('appends the new club at the end of the sort order', async () => {
        const { api, rows } = fakeApi([club('a', '7 Iron', 150, 10, 0)]);
        const svc = new ClubsService(api);
        await svc.load();

        const created = await svc.create('Driver', 220, 20);

        expect(created?.name).toBe('Driver');
        expect(created?.sortOrder).toBe(1);
        expect(svc.store.items.get().map(c => c.id)).toEqual(['a', created!.id]);
        expect(svc.saving.get()).toBe(false);
        expect(svc.saveError.get()).toBeNull();
        expect(rows.size).toBe(2);
    });
});

describe('update (optimistic locking)', () => {
    test('sends the store version, patches the store with the bumped version', async () => {
        const { api, rows } = fakeApi([club('a', '7 Iron', 150, 10, 0, 3)]);
        const svc = new ClubsService(api);
        await svc.load();

        const updated = await svc.update('a', { carryM: 155 });

        expect(updated?.version).toBe(4);
        expect(updated?.carryM).toBe(155);
        expect(svc.store.items.get()[0].carryM).toBe(155);
        expect(rows.get('a')!.carryM).toBe(155);
    });

    test('version conflict sets saveError=conflict and re-syncs the store from the server', async () => {
        const { api, rows } = fakeApi([club('a', '7 Iron', 150, 10, 0, 1)]);
        const svc = new ClubsService(api);
        await svc.load();

        // A competing writer bumps the server version behind our back.
        rows.get('a')!.version = 2;
        rows.get('a')!.carryM = 160;

        const result = await svc.update('a', { carryM: 170 });
        expect(result).toBeUndefined();
        expect(svc.saveError.get()?.code).toBe('conflict');

        // reload() fired — wait for it to land, then the store shows server truth.
        await Bun.sleep(0);
        expect(svc.store.items.get()[0].carryM).toBe(160);
        expect(svc.store.items.get()[0].version).toBe(2);
    });
});

describe('reorder', () => {
    test('applies the new order to the store immediately and calls the API', async () => {
        const { api, calls } = fakeApi([
            club('a', '7 Iron', 150, 10, 0),
            club('b', 'Driver', 220, 20, 1),
            club('c', 'Wedge', 90, 8, 2),
        ]);
        const svc = new ClubsService(api);
        await svc.load();

        const ok = await svc.reorder(['c', 'a', 'b']);

        expect(ok).toBe(true);
        expect(svc.store.items.get().map(x => x.id)).toEqual(['c', 'a', 'b']);
        expect(svc.store.items.get().map(x => x.sortOrder)).toEqual([0, 1, 2]);
        expect(calls.reorder).toBe(1);
    });

    test('reorder failure re-syncs the store from the server', async () => {
        const { api } = fakeApi([
            club('a', '7 Iron', 150, 10, 0),
            club('b', 'Driver', 220, 20, 1),
        ]);
        const svc = new ClubsService(api);
        await svc.load();
        api.reorder = () => Promise.reject(new ApiError(500, 'boom'));

        const ok = await svc.reorder(['b', 'a']);
        expect(ok).toBe(false);
        expect(svc.saveError.get()?.code).toBe('server');

        await Bun.sleep(0);
        expect(svc.store.items.get().map(x => x.id)).toEqual(['a', 'b']); // server truth restored
    });
});

describe('remove', () => {
    test('removes from server + store', async () => {
        const { api, rows } = fakeApi([club('a', '7 Iron', 150, 10, 0)]);
        const svc = new ClubsService(api);
        await svc.load();

        const ok = await svc.remove('a');

        expect(ok).toBe(true);
        expect(svc.store.items.get()).toHaveLength(0);
        expect(rows.size).toBe(0);
    });

    test('conflict on remove keeps server state and re-syncs', async () => {
        const { api, rows } = fakeApi([club('a', '7 Iron', 150, 10, 0, 1)]);
        const svc = new ClubsService(api);
        await svc.load();
        rows.get('a')!.version = 2;

        const ok = await svc.remove('a');
        expect(ok).toBe(false);
        expect(svc.saveError.get()?.code).toBe('conflict');

        await Bun.sleep(0);
        expect(svc.store.items.get()).toHaveLength(1);
    });

    test('removing an id not in the store is a no-op', async () => {
        const { api, calls } = fakeApi([club('a', '7 Iron', 150, 10, 0)]);
        const svc = new ClubsService(api);
        await svc.load();

        const ok = await svc.remove('missing');
        expect(ok).toBe(false);
        expect(calls.remove).toBe(0);
    });
});
