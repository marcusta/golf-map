import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_HOLE_1_ID } from '../db/seeds/course';
import { AimPointsService } from './aim-points.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

test('listByHole returns aim points ordered by sort_order', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const points = await svc.listByHole(TEST_HOLE_1_ID);
    expect(points).toHaveLength(1);
    expect(points[0].sortOrder).toBe(0);
});

test('create appends a new aim point with next sort_order', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const point = await svc.create({
        holeId: TEST_HOLE_1_ID,
        lat: 58.4016,
        lon: 15.566,
        elevation: 74,
        label: 'Layup',
    });

    expect(point.sortOrder).toBe(1);
    expect(point.label).toBe('Layup');
    expect(point.version).toBe(1);

    const points = await svc.listByHole(TEST_HOLE_1_ID);
    expect(points).toHaveLength(2);
    expect(points[1].id).toBe(point.id);
});

test('update changes fields and bumps version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const points = await svc.listByHole(TEST_HOLE_1_ID);
    const first = points[0];

    const updated = await svc.update(first.id, 1, { label: 'Drive target', elevation: 80 });
    expect(updated.label).toBe('Drive target');
    expect(updated.elevation).toBe(80);
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const points = await svc.listByHole(TEST_HOLE_1_ID);
    const first = points[0];

    await expect(svc.update(first.id, 99, { label: 'Nope' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for nonexistent aim point', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    await expect(svc.update('nonexistent', 1, { label: 'Nope' })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes an aim point', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const points = await svc.listByHole(TEST_HOLE_1_ID);
    const first = points[0];

    await svc.remove(first.id, 1);

    const after = await svc.listByHole(TEST_HOLE_1_ID);
    expect(after).toHaveLength(0);
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const points = await svc.listByHole(TEST_HOLE_1_ID);
    const first = points[0];

    await expect(svc.remove(first.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove throws NotFoundError for nonexistent aim point', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    await expect(svc.remove('nonexistent', 1)).rejects.toBeInstanceOf(NotFoundError);
});

test('reorder persists new sort_order transactionally', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new AimPointsService(db);

    const second = await svc.create({ holeId: TEST_HOLE_1_ID, lat: 58.4017, lon: 15.5661 });
    const third = await svc.create({ holeId: TEST_HOLE_1_ID, lat: 58.4018, lon: 15.5662 });
    const points = await svc.listByHole(TEST_HOLE_1_ID);
    const first = points[0];

    await svc.reorder(TEST_HOLE_1_ID, [third.id, first.id, second.id]);

    const reordered = await svc.listByHole(TEST_HOLE_1_ID);
    expect(reordered.map((p) => p.id)).toEqual([third.id, first.id, second.id]);
    expect(reordered.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
});
