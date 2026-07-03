import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers } from '../db/seeds/users';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { HolesService } from './holes.service';
import { CoursesService } from './courses.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';
import { UniqueViolationError } from '@basics/core/server/unique-violation';

test('listByCourse returns empty array with no seed', async () => {
    const { db } = await createTestDb();
    const svc = new HolesService(db);

    const holes = await svc.listByCourse('missing-course');
    expect(holes).toHaveLength(0);
});

test('listByCourse returns holes ordered by number', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(2);
    expect(holes[0].id).toBe(TEST_HOLE_1_ID);
    expect(holes[0].number).toBe(1);
    expect(holes[0].par).toBe(4);
    expect(holes[1].id).toBe(TEST_HOLE_2_ID);
    expect(holes[1].number).toBe(2);
    expect(holes[1].par).toBe(3);
});

test('get returns hole by id', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const hole = await svc.get(TEST_HOLE_1_ID);
    expect(hole.id).toBe(TEST_HOLE_1_ID);
    expect(hole.courseId).toBe(TEST_COURSE_ID);
    expect(hole.number).toBe(1);
    expect(hole.par).toBe(4);
    expect(hole.version).toBe(1);
});

test('get throws NotFoundError for missing hole', async () => {
    const { db } = await createTestDb();
    const svc = new HolesService(db);

    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
});

test('create adds a hole', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const hole = await svc.create({ courseId: TEST_COURSE_ID, number: 3, par: 5 });
    expect(hole.courseId).toBe(TEST_COURSE_ID);
    expect(hole.number).toBe(3);
    expect(hole.par).toBe(5);
    expect(hole.version).toBe(1);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(3);
});

test('create throws UniqueViolationError on duplicate course+number', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await expect(svc.create({ courseId: TEST_COURSE_ID, number: 1, par: 4 })).rejects.toBeInstanceOf(UniqueViolationError);
});

test('update changes par and bumps version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const updated = await svc.update(TEST_HOLE_1_ID, 1, { par: 5, notes: 'tricky dogleg' });
    expect(updated.par).toBe(5);
    expect(updated.notes).toBe('tricky dogleg');
    expect(updated.version).toBe(2);
});

test('update changes savedRegionJson', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const updated = await svc.update(TEST_HOLE_1_ID, 1, { savedRegionJson: '{"zoom":15}' });
    expect(updated.savedRegionJson).toBe('{"zoom":15}');
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await expect(svc.update(TEST_HOLE_1_ID, 99, { par: 5 })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for missing hole', async () => {
    const { db } = await createTestDb();
    const svc = new HolesService(db);

    await expect(svc.update('nope', 1, { par: 5 })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes hole', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await svc.remove(TEST_HOLE_1_ID, 1);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(1);
    expect(holes[0].id).toBe(TEST_HOLE_2_ID);
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await expect(svc.remove(TEST_HOLE_1_ID, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('removing course cascades to remove its holes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const holesSvc = new HolesService(db);
    const coursesSvc = new CoursesService(db);

    await coursesSvc.remove(TEST_COURSE_ID, 1);

    const holes = await holesSvc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(0);
});
