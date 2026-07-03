import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_GREEN_1_ID } from '../db/seeds/course';
import { GreensService } from './greens.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

test('getByHole returns the green for a hole', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new GreensService(db);

    const green = await svc.getByHole(TEST_HOLE_1_ID);
    expect(green).not.toBeNull();
    expect(green!.id).toBe(TEST_GREEN_1_ID);
    expect(green!.centerLat).toBeCloseTo(58.403, 2);
});

test('getByHole returns null for a hole without a green', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new GreensService(db);

    const green = await svc.getByHole('nonexistent-hole');
    expect(green).toBeNull();
});

test('create adds a green for a hole without one', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new GreensService(db);

    // Insert a bare hole (no green) directly — seedCourse gives every hole a green.
    await db
        .insertInto('holes')
        .values({
            id: 'hole-3',
            course_id: TEST_COURSE_ID,
            number: 3,
            par: 4,
            notes: null,
            saved_region_json: null,
            version: 1,
        })
        .execute();

    const green = await svc.create({
        holeId: 'hole-3',
        centerLat: 58.41,
        centerLon: 15.56,
        frontLat: 58.4099,
        frontLon: 15.5601,
        elevation: 76,
    });

    expect(green.holeId).toBe('hole-3');
    expect(green.centerLat).toBe(58.41);
    expect(green.version).toBe(1);

    const fetched = await svc.getByHole('hole-3');
    expect(fetched!.id).toBe(green.id);
});

test('update changes center/front/back lat-lon, elevation, boundaryJson and bumps version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new GreensService(db);

    const green = await svc.getByHole(TEST_HOLE_1_ID);
    const updated = await svc.update(green!.id, 1, {
        centerLat: 58.5,
        centerLon: 15.6,
        elevation: 90,
        boundaryJson: JSON.stringify({ kind: 'polygon', points: [[0, 0]] }),
    });

    expect(updated.centerLat).toBe(58.5);
    expect(updated.centerLon).toBe(15.6);
    expect(updated.elevation).toBe(90);
    expect(updated.boundaryJson).toBe(JSON.stringify({ kind: 'polygon', points: [[0, 0]] }));
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new GreensService(db);

    const green = await svc.getByHole(TEST_HOLE_1_ID);
    await expect(svc.update(green!.id, 99, { centerLat: 58.5 })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for nonexistent green', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new GreensService(db);

    await expect(svc.update('nonexistent', 1, { centerLat: 58.5 })).rejects.toBeInstanceOf(NotFoundError);
});
