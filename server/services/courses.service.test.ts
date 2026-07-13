import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers } from '../db/seeds/users';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

test('list returns empty page with no seed', async () => {
    const { db } = await createTestDb();
    const svc = new CoursesService(db);

    const page = await svc.list();
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
});

test('list returns seeded course with hole count', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    const page = await svc.list();
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    const summary = page.items[0];
    expect(summary.id).toBe(TEST_COURSE_ID);
    expect(summary.name).toBe('Linkan');
    expect(summary.status).toBe('draft');
    expect(summary.revision).toBe(1);
    expect(summary.homeLat).toBeCloseTo(58.4015);
    expect(summary.homeLon).toBeCloseTo(15.5658);
    expect(summary.holeCount).toBe(2);
    expect(summary.updatedAt).toBeTruthy();
});

test('list computes parTotal, lengthM, mappedHoleCount, siteName and routing for a fully seeded course', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    const page = await svc.list();
    const summary = page.items[0];

    // par: hole 1 = 4, hole 2 = 3
    expect(summary.parTotal).toBe(7);

    // one course_feature seeded, scoped to hole 1 only
    expect(summary.mappedHoleCount).toBe(1);

    // no site assigned in the base seed
    expect(summary.siteName).toBeNull();

    // sum of great-circle distance from each hole's primary (lowest
    // sort_order) tee to its green center — independently computed from
    // the seeded coordinates (see seeds/course.ts), not via the service's
    // own haversine helper.
    expect(summary.lengthM).toBeCloseTo(598.02, 1);

    expect(summary.routing).toHaveLength(2);
    expect(summary.routing[0].hole).toBe(1);
    expect(summary.routing[0].tee[0]).toBeCloseTo(58.4022);
    expect(summary.routing[0].tee[1]).toBeCloseTo(15.5688);
    expect(summary.routing[0].green[0]).toBeCloseTo(58.403);
    expect(summary.routing[0].green[1]).toBeCloseTo(15.5639);
    expect(summary.routing[1].hole).toBe(2);
});

test('list reports siteName when the course is assigned to a site', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    await db
        .insertInto('sites')
        .values({ id: 'site-1', name: 'Linkoping Links', notes: null, version: 1 })
        .execute();
    await db.updateTable('courses').set({ site_id: 'site-1' }).where('id', '=', TEST_COURSE_ID).execute();

    const page = await svc.list();
    expect(page.items[0].siteName).toBe('Linkoping Links');
});

test('list zeroes parTotal/lengthM/mappedHoleCount and empties routing for a course with no holes', async () => {
    const { db } = await createTestDb(seedUsers);
    const svc = new CoursesService(db);

    await svc.create({ name: 'Empty Course' });

    const page = await svc.list();
    expect(page.items).toHaveLength(1);
    const summary = page.items[0];
    expect(summary.holeCount).toBe(0);
    expect(summary.parTotal).toBe(0);
    expect(summary.lengthM).toBe(0);
    expect(summary.mappedHoleCount).toBe(0);
    expect(summary.routing).toEqual([]);
});

test('list excludes a hole missing a tee or green from lengthM/routing but still counts it in holeCount/parTotal', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    // hole-3: par counted, but no tee and no green seeded for it
    await db
        .insertInto('holes')
        .values({
            id: 'hole-3',
            course_id: TEST_COURSE_ID,
            number: 3,
            par: 5,
            notes: null,
            saved_region_json: null,
            version: 1,
        })
        .execute();

    const page = await svc.list();
    const summary = page.items[0];

    expect(summary.holeCount).toBe(3);
    expect(summary.parTotal).toBe(12); // 4 + 3 + 5
    // unchanged from the fully-seeded case: hole 3 contributes nothing
    expect(summary.lengthM).toBeCloseTo(598.02, 1);
    expect(summary.routing).toHaveLength(2);
    expect(summary.routing.some((r) => r.hole === 3)).toBe(false);
});

test('get returns full course row', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    const course = await svc.get(TEST_COURSE_ID);
    expect(course.id).toBe(TEST_COURSE_ID);
    expect(course.name).toBe('Linkan');
    expect(course.crs).toBe('EPSG:3006');
    expect(course.georeferenceJson).toBeNull();
    expect(course.notes).toBeNull();
    expect(course.version).toBe(1);
});

test('get throws NotFoundError for missing course', async () => {
    const { db } = await createTestDb();
    const svc = new CoursesService(db);

    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
});

test('create adds a course with draft status and revision 0', async () => {
    const { db } = await createTestDb();
    const svc = new CoursesService(db);

    const course = await svc.create({ name: 'New Course' });
    expect(course.name).toBe('New Course');
    expect(course.status).toBe('draft');
    expect(course.revision).toBe(0);
    expect(course.version).toBe(1);
    expect(course.crs).toBe('EPSG:3006');

    const page = await svc.list();
    expect(page.items).toHaveLength(1);
});

test('create honors optional fields', async () => {
    const { db } = await createTestDb();
    const svc = new CoursesService(db);

    const course = await svc.create({
        name: 'Custom Course',
        crs: 'EPSG:4326',
        homeLat: 1.23,
        homeLon: 4.56,
        notes: 'hello',
    });
    expect(course.crs).toBe('EPSG:4326');
    expect(course.homeLat).toBe(1.23);
    expect(course.homeLon).toBe(4.56);
    expect(course.notes).toBe('hello');
});

test('update changes name and bumps version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    const updated = await svc.update(TEST_COURSE_ID, 1, { name: 'Linkan GK' });
    expect(updated.name).toBe('Linkan GK');
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    await expect(svc.update(TEST_COURSE_ID, 99, { name: 'Nope' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for missing course', async () => {
    const { db } = await createTestDb();
    const svc = new CoursesService(db);

    await expect(svc.update('nope', 1, { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes course', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    await svc.remove(TEST_COURSE_ID, 1);

    const page = await svc.list();
    expect(page.items).toHaveLength(0);
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    await expect(svc.remove(TEST_COURSE_ID, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove cascades to holes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    await svc.remove(TEST_COURSE_ID, 1);

    const remainingHoles = await db.selectFrom('holes').selectAll().execute();
    expect(remainingHoles).toHaveLength(0);
});

test('publish sets status to published and bumps revision', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    const published = await svc.publish(TEST_COURSE_ID, 1);
    expect(published.status).toBe('published');
    expect(published.revision).toBe(2);
    expect(published.version).toBe(2);
});

test('publish throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new CoursesService(db);

    await expect(svc.publish(TEST_COURSE_ID, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('publish throws NotFoundError for missing course', async () => {
    const { db } = await createTestDb();
    const svc = new CoursesService(db);

    await expect(svc.publish('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
});
