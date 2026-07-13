import { test, expect, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { CoursesService } from '../src/courses/courses.service';
import type { CoursesApi, CourseSummary } from '../../shared/api/courses.gen';

// CoursesService against a fake CoursesApi injected through the constructor —
// real service, real EntityStore, real request() wrapper.

afterEach(() => _reset());

function summary(id: string, name: string): CourseSummary {
    return {
        id,
        name,
        status: 'draft',
        revision: 0,
        siteId: null,
        homeLat: null,
        homeLon: null,
        holeCount: 18,
        updatedAt: '2026-07-04T00:00:00Z',
        parTotal: 72,
        lengthM: 5800,
        mappedHoleCount: 0,
        siteName: null,
        routing: [],
    };
}

/** Fake CoursesApi: serves `all` through list(); records the calls it gets. */
function fakeCoursesApi(all: CourseSummary[]): CoursesApi & { calls: { offset: number; limit: number }[] } {
    const calls: { offset: number; limit: number }[] = [];
    const reject = () => Promise.reject(new Error('not under test'));
    return {
        calls,
        list: async (input) => {
            calls.push(input);
            return {
                items: all.slice(input.offset, input.offset + input.limit),
                total: all.length,
            };
        },
        get: reject,
        create: reject,
        update: reject,
        remove: reject,
        publish: reject,
    };
}

test('load populates the store with items and total', async () => {
    const api = fakeCoursesApi([summary('c1', 'Landeryd Masters'), summary('c2', 'Landeryd Classic')]);
    const svc = new CoursesService(api);

    await svc.load();

    expect(svc.store.items.get()).toHaveLength(2);
    expect(svc.store.total.get()).toBe(2);
    expect(svc.store.item('c1').get().name).toBe('Landeryd Masters');
    expect(svc.loading.get()).toBe(false);
    expect(svc.error.get()).toBeNull();
});

test('load sends required pagination params', async () => {
    const api = fakeCoursesApi([summary('c1', 'A')]);
    const svc = new CoursesService(api);

    await svc.load();

    expect(api.calls).toEqual([{ offset: 0, limit: svc.pageSize }]);
});

test('load is cached — second call does not refetch', async () => {
    const api = fakeCoursesApi([summary('c1', 'A')]);
    const svc = new CoursesService(api);

    await svc.load();
    await svc.load();

    expect(api.calls).toHaveLength(1);
});

test('nextPage advances offset and refetches; prevPage returns', async () => {
    const all = Array.from({ length: 60 }, (_, i) => summary(`c${i}`, `Course ${i}`));
    const api = fakeCoursesApi(all);
    const svc = new CoursesService(api);

    await svc.load();
    expect(svc.pageCount.get()).toBe(2);
    expect(svc.store.items.get()).toHaveLength(50);

    await svc.nextPage();
    expect(svc.page.get()).toBe(1);
    expect(api.calls[1]).toEqual({ offset: 50, limit: 50 });
    expect(svc.store.items.get()).toHaveLength(10);

    await svc.prevPage();
    expect(svc.page.get()).toBe(0);
    expect(api.calls[2]).toEqual({ offset: 0, limit: 50 });
});

test('nextPage past the last page is a no-op', async () => {
    const api = fakeCoursesApi([summary('c1', 'A')]);
    const svc = new CoursesService(api);

    await svc.load();
    await svc.nextPage();

    expect(svc.page.get()).toBe(0);
    expect(api.calls).toHaveLength(1);
});

test('prevPage on the first page is a no-op', async () => {
    const api = fakeCoursesApi([summary('c1', 'A')]);
    const svc = new CoursesService(api);

    await svc.load();
    await svc.prevPage();

    expect(svc.page.get()).toBe(0);
    expect(api.calls).toHaveLength(1);
});

test('server error sets error signal and keeps store empty', async () => {
    const api = fakeCoursesApi([]);
    api.list = () => Promise.reject(new ApiError(500, 'boom'));
    const svc = new CoursesService(api);

    await svc.load();

    expect(svc.error.get()?.code).toBe('server');
    expect(svc.store.items.get()).toHaveLength(0);
    expect(svc.loading.get()).toBe(false);
});

test('retry after error refetches (cache not set on failure)', async () => {
    const good = fakeCoursesApi([summary('c1', 'A')]);
    const svc = new CoursesService(good);
    const realList = good.list;
    good.list = () => Promise.reject(new ApiError(500, 'boom'));

    await svc.load();
    expect(svc.error.get()?.code).toBe('server');

    good.list = realList;
    await svc.load();

    expect(svc.error.get()).toBeNull();
    expect(svc.store.items.get()).toHaveLength(1);
});
