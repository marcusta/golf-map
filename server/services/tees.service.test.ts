import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { TeesService } from './tees.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

test('listByHole returns tees ordered by sort_order', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    expect(tees).toHaveLength(2);
    expect(tees[0].name).toBe('yellow');
    expect(tees[0].sortOrder).toBe(0);
    expect(tees[1].name).toBe('blue');
    expect(tees[1].sortOrder).toBe(1);
});

test('listByCourse returns tees for all holes joined via holes table', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByCourse(TEST_COURSE_ID);
    expect(tees).toHaveLength(4);
    const holeIds = new Set(tees.map((t) => t.holeId));
    expect(holeIds).toEqual(new Set([TEST_HOLE_1_ID, TEST_HOLE_2_ID]));
});

test('create adds a tee with next sort_order appended', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tee = await svc.create({
        holeId: TEST_HOLE_1_ID,
        name: 'red',
        color: 'red',
        lat: 58.401,
        lon: 15.567,
        elevation: 77.5,
    });

    expect(tee.name).toBe('red');
    expect(tee.sortOrder).toBe(2);
    expect(tee.version).toBe(1);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    expect(tees).toHaveLength(3);
});

test('create throws on unique(hole_id, name) violation', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    await expect(svc.create({
        holeId: TEST_HOLE_1_ID,
        name: 'yellow',
        lat: 58.401,
        lon: 15.567,
    })).rejects.toThrow();
});

test('update changes fields and bumps version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    const yellow = tees.find((t) => t.name === 'yellow')!;

    const updated = await svc.update(yellow.id, 1, { color: 'gold', elevation: 80 });
    expect(updated.color).toBe('gold');
    expect(updated.elevation).toBe(80);
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    const yellow = tees.find((t) => t.name === 'yellow')!;

    await expect(svc.update(yellow.id, 99, { color: 'gold' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for nonexistent tee', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    await expect(svc.update('nonexistent', 1, { color: 'gold' })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes a tee', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    const blue = tees.find((t) => t.name === 'blue')!;

    await svc.remove(blue.id, 1);

    const after = await svc.listByHole(TEST_HOLE_1_ID);
    expect(after).toHaveLength(1);
    expect(after.find((t) => t.id === blue.id)).toBeUndefined();
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    const blue = tees.find((t) => t.name === 'blue')!;

    await expect(svc.remove(blue.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove throws NotFoundError for nonexistent tee', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    await expect(svc.remove('nonexistent', 1)).rejects.toBeInstanceOf(NotFoundError);
});

test('reorder persists new sort_order transactionally', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeesService(db);

    const tees = await svc.listByHole(TEST_HOLE_1_ID);
    const yellow = tees.find((t) => t.name === 'yellow')!;
    const blue = tees.find((t) => t.name === 'blue')!;

    await svc.reorder(TEST_HOLE_1_ID, [blue.id, yellow.id]);

    const reordered = await svc.listByHole(TEST_HOLE_1_ID);
    expect(reordered[0].id).toBe(blue.id);
    expect(reordered[0].sortOrder).toBe(0);
    expect(reordered[1].id).toBe(yellow.id);
    expect(reordered[1].sortOrder).toBe(1);
});
