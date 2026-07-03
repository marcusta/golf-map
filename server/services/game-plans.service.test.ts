import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers, TEST_USER_ID } from '../db/seeds/users';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { seedClubs, TEST_CLUB_DRIVER_ID, TEST_CLUB_7I_ID } from '../db/seeds/clubs';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { GamePlansService } from './game-plans.service';

async function setup() {
    const { db } = await createTestDb(seedUsers, seedCourse, seedClubs);
    return { db, svc: new GamePlansService(db) };
}

test('getByCourse returns null when no plan exists', async () => {
    const { svc } = await setup();

    expect(await svc.getByCourse(TEST_COURSE_ID)).toBeNull();
});

test('upsertByCourse creates a plan when none exists', async () => {
    const { svc } = await setup();

    const plan = await svc.upsertByCourse(TEST_COURSE_ID, {
        userId: TEST_USER_ID,
        windSpeedMps: 5,
        windDirectionDeg: 180,
    });

    expect(plan.courseId).toBe(TEST_COURSE_ID);
    expect(plan.userId).toBe(TEST_USER_ID);
    expect(plan.windSpeedMps).toBe(5);
    expect(plan.windDirectionDeg).toBe(180);
    expect(plan.holes).toEqual([]);
    expect(plan.version).toBe(1);
});

test('upsertByCourse updates the same plan on second call (one plan per course)', async () => {
    const { svc } = await setup();

    const first = await svc.upsertByCourse(TEST_COURSE_ID, {
        userId: TEST_USER_ID,
        windSpeedMps: 5,
        windDirectionDeg: 180,
    });

    const second = await svc.upsertByCourse(TEST_COURSE_ID, {
        userId: TEST_USER_ID,
        version: first.version,
        windSpeedMps: 8,
        windDirectionDeg: 200,
    });

    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.windSpeedMps).toBe(8);
    expect(second.windDirectionDeg).toBe(200);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    expect(fetched?.id).toBe(first.id);
    expect(fetched?.windSpeedMps).toBe(8);
});

test('upsertByCourse throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();

    await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 5 });

    await expect(
        svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, version: 99, windSpeedMps: 10 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
});

test('upsertByCourse without version on existing plan conflicts', async () => {
    const { svc } = await setup();

    await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 5 });

    await expect(
        svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 10 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
});

test('setHole creates a game_plan_hole row on first call', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });

    const hole = await svc.setHole(plan.id, 1, {
        teeId: `${TEST_HOLE_1_ID}-tee-yellow`,
        preferredClubId: TEST_CLUB_DRIVER_ID,
        plannedDirectionDeg: 45,
    });

    expect(hole.gamePlanId).toBe(plan.id);
    expect(hole.holeNumber).toBe(1);
    expect(hole.teeId).toBe(`${TEST_HOLE_1_ID}-tee-yellow`);
    expect(hole.preferredClubId).toBe(TEST_CLUB_DRIVER_ID);
    expect(hole.plannedDirectionDeg).toBe(45);
    expect(hole.shots).toEqual([]);
    expect(hole.version).toBe(1);
});

test('setHole updates existing hole with version check', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, { teeId: `${TEST_HOLE_1_ID}-tee-yellow` });

    const updated = await svc.setHole(plan.id, 1, {
        version: hole.version,
        preferredClubId: TEST_CLUB_7I_ID,
    });

    expect(updated.id).toBe(hole.id);
    expect(updated.version).toBe(2);
    expect(updated.preferredClubId).toBe(TEST_CLUB_7I_ID);
    expect(updated.teeId).toBe(`${TEST_HOLE_1_ID}-tee-yellow`); // preserved
});

test('setHole throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    await svc.setHole(plan.id, 1, { teeId: `${TEST_HOLE_1_ID}-tee-yellow` });

    await expect(
        svc.setHole(plan.id, 1, { version: 99, preferredClubId: TEST_CLUB_7I_ID }),
    ).rejects.toBeInstanceOf(VersionConflictError);
});

test('addShot appends shots with increasing sort order', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});

    const shot1 = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5, clubId: TEST_CLUB_DRIVER_ID });
    const shot2 = await svc.addShot(hole.id, { lat: 58.41, lon: 15.51, elevation: 12.5 });

    expect(shot1.sortOrder).toBe(0);
    expect(shot2.sortOrder).toBe(1);
    expect(shot1.version).toBe(1);
    expect(shot2.elevation).toBe(12.5);
    expect(shot2.clubId).toBeNull();
});

test('updateShot patches fields and bumps version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5 });

    const updated = await svc.updateShot(shot.id, 1, { clubId: TEST_CLUB_DRIVER_ID, elevation: 3.2 });
    expect(updated.clubId).toBe(TEST_CLUB_DRIVER_ID);
    expect(updated.elevation).toBe(3.2);
    expect(updated.version).toBe(2);
    expect(updated.lat).toBe(58.4); // unchanged
});

test('updateShot throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5 });

    await expect(svc.updateShot(shot.id, 99, { lat: 1 })).rejects.toBeInstanceOf(VersionConflictError);
});

test('removeShot deletes shot', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5 });

    await svc.removeShot(shot.id, 1);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole = fetched?.holes.find((h) => h.id === hole.id);
    expect(fetchedHole?.shots).toHaveLength(0);
});

test('removeShot throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5 });

    await expect(svc.removeShot(shot.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('reorderShots persists new sort order', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot1 = await svc.addShot(hole.id, { lat: 1, lon: 1 });
    const shot2 = await svc.addShot(hole.id, { lat: 2, lon: 2 });
    const shot3 = await svc.addShot(hole.id, { lat: 3, lon: 3 });

    await svc.reorderShots(hole.id, [shot3.id, shot1.id, shot2.id]);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole = fetched?.holes.find((h) => h.id === hole.id);
    expect(fetchedHole?.shots.map((s) => s.id)).toEqual([shot3.id, shot1.id, shot2.id]);
});

test('getByCourse returns full plan tree ordered by hole number and shot sort order', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 4 });

    const hole2 = await svc.setHole(plan.id, 2, { preferredClubId: TEST_CLUB_7I_ID });
    const hole1 = await svc.setHole(plan.id, 1, { preferredClubId: TEST_CLUB_DRIVER_ID });

    await svc.addShot(hole1.id, { lat: 1, lon: 1 });
    await svc.addShot(hole1.id, { lat: 2, lon: 2 });
    await svc.addShot(hole2.id, { lat: 3, lon: 3 });

    const tree = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    expect(tree).not.toBeNull();
    expect(tree!.windSpeedMps).toBe(4);
    expect(tree!.holes.map((h) => h.holeNumber)).toEqual([1, 2]);
    expect(tree!.holes[0].shots).toHaveLength(2);
    expect(tree!.holes[1].shots).toHaveLength(1);
});

test('removeByCourse deletes plan and cascades to holes and shots', async () => {
    const { db, svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    await svc.addShot(hole.id, { lat: 1, lon: 1 });

    await svc.removeByCourse(TEST_COURSE_ID, plan.version, TEST_USER_ID);

    expect(await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID)).toBeNull();

    const remainingHoles = await db.selectFrom('game_plan_holes').selectAll().where('game_plan_id', '=', plan.id).execute();
    expect(remainingHoles).toHaveLength(0);

    const remainingShots = await db.selectFrom('plan_shots').selectAll().where('game_plan_hole_id', '=', hole.id).execute();
    expect(remainingShots).toHaveLength(0);
});

test('removeByCourse throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });

    await expect(svc.removeByCourse(TEST_COURSE_ID, 99, TEST_USER_ID)).rejects.toBeInstanceOf(VersionConflictError);
});
