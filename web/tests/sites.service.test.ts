import { test, expect, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { SitesService, boundsCenter } from '../src/sites/sites.service';
import type { SitesApi, SiteOverview } from '../../shared/api/sites.gen';
import type { CoursesApi, Course, CourseSummary } from '../../shared/api/courses.gen';

// SitesService against an in-memory sites + courses backend injected through
// the constructor: real service, real request() wrapper, versions enforced.

afterEach(() => _reset());

const EKERUM_BOUNDS = { west: 16.55, south: 56.77, east: 16.59, north: 56.79 };

type Backend = {
    sites: SiteOverview[];
    courses: Course[];
    sitesApi: SitesApi;
    coursesApi: CoursesApi;
    failNextCourseCreate: boolean;
};

function backend(): Backend {
    let nextId = 1;
    const reject = () => Promise.reject(new Error('not under test'));
    const b: Backend = { sites: [], courses: [], failNextCourseCreate: false } as unknown as Backend;

    const site = (id: string) => {
        const found = b.sites.find(s => s.id === id);
        if (!found) throw new ApiError(404, 'not found');
        return found;
    };
    const course = (id: string) => {
        const found = b.courses.find(c => c.id === id);
        if (!found) throw new ApiError(404, 'not found');
        return found;
    };

    b.sitesApi = {
        list: reject,
        get: reject,
        courses: reject,
        overview: async () => b.sites.map(s => ({
            ...s,
            courses: b.courses.filter(c => c.siteId === s.id).map(c => ({ id: c.id, name: c.name })),
        })),
        create: async (input) => {
            const created: SiteOverview = {
                id: `site-${nextId++}`, name: input.name, notes: input.notes ?? null, version: 1,
                createdAt: '', updatedAt: '', courses: [], mapBounds: null, mapBuiltAt: null,
            };
            b.sites.push(created);
            return created;
        },
        update: async (input) => {
            const s = site(input.id);
            if (s.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.name !== undefined) s.name = input.name;
            if (input.notes !== undefined) s.notes = input.notes;
            s.version++;
            return s;
        },
        remove: async (input) => {
            const s = site(input.id);
            if (s.version !== input.version) throw new ApiError(409, 'conflict');
            if (b.courses.some(c => c.siteId === s.id)) throw new ApiError(409, 'has courses');
            b.sites = b.sites.filter(x => x !== s);
            return { ok: true };
        },
    };

    b.coursesApi = {
        remove: reject,
        publish: reject,
        list: async (input) => {
            if (input.limit > 100) throw new ApiError(400, 'Validation failed');
            return {
                items: b.courses.slice(input.offset, input.offset + input.limit)
                    .map(c => ({ id: c.id, name: c.name, siteId: c.siteId }) as CourseSummary),
                total: b.courses.length,
            };
        },
        get: async (input) => ({ ...course(input.id) }),
        create: async (input) => {
            if (b.failNextCourseCreate) {
                b.failNextCourseCreate = false;
                throw new ApiError(500, 'boom');
            }
            const created = {
                id: `course-${nextId++}`, name: input.name, siteId: input.siteId ?? null,
                homeLat: input.homeLat ?? null, homeLon: input.homeLon ?? null, version: 1,
            } as Course;
            b.courses.push(created);
            return created;
        },
        update: async (input) => {
            const c = course(input.id);
            if (c.version !== input.version) throw new ApiError(409, 'conflict');
            if (input.name !== undefined) c.name = input.name;
            if (input.siteId !== undefined) c.siteId = input.siteId;
            c.version++;
            return c;
        },
    };
    return b;
}

/** Ekerum Resort with one misnamed course, plus one course that has no site. */
async function ekerum() {
    const b = backend();
    const site = await b.sitesApi.create({ name: 'Ekerum Resort' });
    b.sites[0].mapBounds = EKERUM_BOUNDS;
    const erik = await b.coursesApi.create({ name: 'Ekerum Resort', siteId: site.id });
    const loose = await b.coursesApi.create({ name: 'Mjölby' });
    const svc = new SitesService(b.sitesApi, b.coursesApi);
    await svc.load();
    return { b, svc, siteId: site.id, erikId: erik.id, looseId: loose.id };
}

test('load splits sites with their courses from courses that have no site', async () => {
    const { svc, erikId, looseId } = await ekerum();
    expect(svc.sites.get().map(s => s.name)).toEqual(['Ekerum Resort']);
    expect(svc.sites.get()[0].courses.map(c => c.id)).toEqual([erikId]);
    expect(svc.unassigned.get().map(c => c.id)).toEqual([looseId]);
});

test('load pages past the server cap of 100 courses per request', async () => {
    const b = backend();
    for (let i = 0; i < 230; i++) await b.coursesApi.create({ name: `Course ${i}` });
    const svc = new SitesService(b.sitesApi, b.coursesApi);

    await svc.load();

    expect(svc.error.get()).toBeNull();
    expect(svc.unassigned.get()).toHaveLength(230);
});

test('renaming a course leaves the site name alone', async () => {
    const { svc, erikId } = await ekerum();

    expect(await svc.renameCourse(erikId, '  Långe Erik ')).toBe(true);

    const site = svc.sites.get()[0];
    expect(site.name).toBe('Ekerum Resort');
    expect(site.courses.map(c => c.name)).toEqual(['Långe Erik']);
    expect(svc.revision.get()).toBe(1);
});

test('a second course on the site shares it and starts at the map centre', async () => {
    const { b, svc, siteId } = await ekerum();

    const jan = await svc.addCourse(siteId, 'Långe Jan');

    expect(jan?.siteId).toBe(siteId);
    expect({ lat: jan?.homeLat, lon: jan?.homeLon }).toEqual(boundsCenter(EKERUM_BOUNDS));
    expect(svc.sites.get()[0].courses.map(c => c.name).sort()).toEqual(['Ekerum Resort', 'Långe Jan']);
    expect(b.sites).toHaveLength(1);
});

test('rename uses the current version after an earlier write', async () => {
    const { svc, siteId } = await ekerum();
    expect(await svc.renameSite(siteId, 'Ekerum')).toBe(true);
    expect(await svc.setSiteNotes(siteId, 'Öland')).toBe(true);
    expect(svc.sites.get()[0]).toMatchObject({ name: 'Ekerum', notes: 'Öland', version: 3 });
});

test('blank and unchanged names write nothing', async () => {
    const { svc, siteId } = await ekerum();
    expect(await svc.renameSite(siteId, '   ')).toBe(false);
    expect(await svc.renameSite(siteId, 'Ekerum Resort')).toBe(false);
    expect(svc.revision.get()).toBe(0);
});

test('a site with courses cannot be removed; detaching its courses allows it', async () => {
    const { svc, siteId, erikId } = await ekerum();

    expect(await svc.removeSite(siteId)).toBe(false);
    expect(svc.error.get()?.code).toBe('conflict');
    expect(svc.sites.get()).toHaveLength(1);

    expect(await svc.detachCourse(erikId)).toBe(true);
    expect(svc.unassigned.get().map(c => c.id)).toContain(erikId);

    expect(await svc.removeSite(siteId)).toBe(true);
    expect(svc.sites.get()).toHaveLength(0);
});

test('a new site takes its own name, not the course name', async () => {
    const b = backend();
    const svc = new SitesService(b.sitesApi, b.coursesApi);

    const course = await svc.createSiteWithCourse({
        siteName: 'Ekerum Resort', courseName: 'Långe Erik', home: { lat: 56.78, lon: 16.57 },
    });

    expect(b.sites.map(s => s.name)).toEqual(['Ekerum Resort']);
    expect(course).toMatchObject({ name: 'Långe Erik', siteId: b.sites[0].id, homeLat: 56.78, homeLon: 16.57 });
});

test('a failed course create does not leave an empty site behind', async () => {
    const b = backend();
    b.failNextCourseCreate = true;
    const svc = new SitesService(b.sitesApi, b.coursesApi);

    const course = await svc.createSiteWithCourse({
        siteName: 'Ekerum Resort', courseName: 'Långe Erik', home: { lat: 56.78, lon: 16.57 },
    });

    expect(course).toBeNull();
    expect(svc.error.get()?.code).toBe('server');
    expect(b.sites).toHaveLength(0);
});
