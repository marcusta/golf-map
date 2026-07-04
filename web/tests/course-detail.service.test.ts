import { test, expect, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import type { Course, CoursesApi } from '../../shared/api/courses.gen';
import type { Hole, HolesApi } from '../../shared/api/holes.gen';

afterEach(() => _reset());

function course(id: string, name: string): Course {
    return {
        id,
        name,
        status: 'published',
        revision: 3,
        crs: 'EPSG:3006',
        georeferenceJson: null,
        homeLat: null,
        homeLon: null,
        notes: null,
        version: 1,
        createdAt: '2026-07-04T00:00:00Z',
        updatedAt: '2026-07-04T00:00:00Z',
    };
}

function hole(id: string, courseId: string, number: number, par = 4): Hole {
    return {
        id,
        courseId,
        number,
        par,
        notes: null,
        savedRegionJson: null,
        version: 1,
        createdAt: '2026-07-04T00:00:00Z',
        updatedAt: '2026-07-04T00:00:00Z',
    };
}

function fakeApis(courses: Course[], holes: Hole[], opts: { publishFails?: boolean } = {}) {
    const reject = () => Promise.reject(new Error('not under test'));
    let getCalls = 0;
    let publishCalls = 0;
    const coursesApi: CoursesApi = {
        list: reject,
        get: async ({ id }) => {
            getCalls++;
            const found = courses.find(c => c.id === id);
            if (!found) throw new ApiError(404, 'Not found');
            return found;
        },
        create: reject,
        update: reject,
        remove: reject,
        publish: async ({ id, version }) => {
            publishCalls++;
            const found = courses.find(c => c.id === id);
            if (!found) throw new ApiError(404, 'Not found');
            if (opts.publishFails || version !== found.version) throw new ApiError(409, 'Version conflict');
            return {
                ...found,
                status: 'published',
                revision: found.revision + 1,
                version: found.version + 1,
            };
        },
    };
    const holesApi: HolesApi = {
        listByCourse: async ({ courseId }) => holes.filter(h => h.courseId === courseId),
        get: reject,
        create: reject,
        update: reject,
        remove: reject,
    };
    return { coursesApi, holesApi, getCalls: () => getCalls, publishCalls: () => publishCalls };
}

test('load sets course and holes sorted by number', async () => {
    const { coursesApi, holesApi } = fakeApis(
        [course('c1', 'Landeryd Masters')],
        [hole('h3', 'c1', 3), hole('h1', 'c1', 1), hole('h2', 'c1', 2, 5)],
    );
    const svc = new CourseDetailService(coursesApi, holesApi);

    await svc.load('c1');

    expect(svc.course.get()?.name).toBe('Landeryd Masters');
    expect(svc.holes.get().map(h => h.number)).toEqual([1, 2, 3]);
    expect(svc.totalPar.get()).toBe(13);
    expect(svc.error.get()).toBeNull();
});

test('load is cached per courseId; a new id refetches', async () => {
    const { coursesApi, holesApi, getCalls } = fakeApis(
        [course('c1', 'Masters'), course('c2', 'Classic')],
        [hole('h1', 'c1', 1), hole('h2', 'c2', 1)],
    );
    const svc = new CourseDetailService(coursesApi, holesApi);

    await svc.load('c1');
    await svc.load('c1');
    expect(getCalls()).toBe(1);

    await svc.load('c2');
    expect(getCalls()).toBe(2);
    expect(svc.course.get()?.name).toBe('Classic');
    expect(svc.holes.get().map(h => h.id)).toEqual(['h2']);
});

test('load failure sets error and does not cache', async () => {
    const { coursesApi, holesApi, getCalls } = fakeApis([], []);
    const svc = new CourseDetailService(coursesApi, holesApi);

    await svc.load('missing');
    expect(svc.error.get()?.code).toBe('server');
    expect(svc.course.get()).toBeNull();

    // retry hits the API again — failed loads are not cached
    await svc.load('missing');
    expect(getCalls()).toBe(2);
});

// ─── publish ────────────────────────────────────────────────────────────────

test('publish bumps status/revision/version on the course signal', async () => {
    const draft = { ...course('c1', 'Masters'), status: 'draft', revision: 3, version: 5 };
    const { coursesApi, holesApi, publishCalls } = fakeApis([draft], []);
    const svc = new CourseDetailService(coursesApi, holesApi);
    await svc.load('c1');

    const updated = await svc.publish();

    expect(publishCalls()).toBe(1);
    expect(updated?.status).toBe('published');
    expect(svc.course.get()?.status).toBe('published');
    expect(svc.course.get()?.revision).toBe(4);
    expect(svc.course.get()?.version).toBe(6);
    expect(svc.publishError.get()).toBeNull();
    expect(svc.publishing.get()).toBe(false);
});

test('publish without a loaded course is a no-op', async () => {
    const { coursesApi, holesApi, publishCalls } = fakeApis([], []);
    const svc = new CourseDetailService(coursesApi, holesApi);
    expect(await svc.publish()).toBeUndefined();
    expect(publishCalls()).toBe(0);
});

test('publish failure sets publishError and refetches the course', async () => {
    const { coursesApi, holesApi, getCalls } = fakeApis([course('c1', 'Masters')], [], { publishFails: true });
    const svc = new CourseDetailService(coursesApi, holesApi);
    await svc.load('c1');
    const before = getCalls();

    const updated = await svc.publish();

    expect(updated).toBeUndefined();
    expect(svc.publishError.get()).not.toBeNull();
    // re-synced from the server so a stale version self-heals
    expect(getCalls()).toBe(before + 1);
    expect(svc.course.get()?.name).toBe('Masters');
});
