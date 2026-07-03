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
