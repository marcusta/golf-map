import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers, TEST_USER_ID } from '../db/seeds/users';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { seedClubs, TEST_CLUB_DRIVER_ID, TEST_CLUB_7I_ID } from '../db/seeds/clubs';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError } from '@basics/core/server/auth';
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

test('addShot without parentShotId appends to the primary-line tail', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});

    const shot1 = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5, clubId: TEST_CLUB_DRIVER_ID });
    const shot2 = await svc.addShot(hole.id, { lat: 58.41, lon: 15.51, elevation: 12.5 });

    expect(shot1.sortOrder).toBe(0);
    expect(shot1.parentShotId).toBeNull();
    expect(shot2.sortOrder).toBe(0);
    expect(shot2.parentShotId).toBe(shot1.id);
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

test('addShot with parentShotId appends within that sibling group; explicit null adds a root option', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const root = await svc.addShot(hole.id, { lat: 1, lon: 1 });
    const rootOption = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const child = await svc.addShot(hole.id, { parentShotId: root.id, lat: 3, lon: 3 });
    const childOption = await svc.addShot(hole.id, { parentShotId: root.id, lat: 4, lon: 4 });
    const appended = await svc.addShot(hole.id, { lat: 5, lon: 5 });

    expect(rootOption.parentShotId).toBeNull();
    expect(rootOption.sortOrder).toBe(1);
    expect(child.parentShotId).toBe(root.id);
    expect(child.sortOrder).toBe(0);
    expect(childOption.parentShotId).toBe(root.id);
    expect(childOption.sortOrder).toBe(1);
    expect(appended.parentShotId).toBe(child.id);
    expect(appended.sortOrder).toBe(0);
});

test('removeShot splice re-parents children into the removed sibling slot and preserves descendants', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const removed = await svc.addShot(hole.id, { lat: 1, lon: 1 });
    const rootSibling = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const child = await svc.addShot(hole.id, { parentShotId: removed.id, lat: 3, lon: 3 });
    const childOption = await svc.addShot(hole.id, { parentShotId: removed.id, lat: 4, lon: 4 });
    const grandchild = await svc.addShot(hole.id, { parentShotId: child.id, lat: 5, lon: 5 });

    await svc.removeShot(removed.id, removed.version);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const shots = fetched?.holes.find((candidate) => candidate.id === hole.id)?.shots ?? [];
    expect(shots.some((shot) => shot.id === removed.id)).toBe(false);
    expect(shots.find((shot) => shot.id === child.id)).toMatchObject({ parentShotId: null, sortOrder: 0 });
    expect(shots.find((shot) => shot.id === childOption.id)).toMatchObject({ parentShotId: null, sortOrder: 1 });
    expect(shots.find((shot) => shot.id === rootSibling.id)).toMatchObject({ parentShotId: null, sortOrder: 2 });
    expect(shots.find((shot) => shot.id === grandchild.id)?.parentShotId).toBe(child.id);
});

test('removeShot cascade deletes the whole branch and compacts the surviving siblings', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const removed = await svc.addShot(hole.id, { lat: 1, lon: 1 });
    const survivor = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const child = await svc.addShot(hole.id, { parentShotId: removed.id, lat: 3, lon: 3 });
    const grandchild = await svc.addShot(hole.id, { parentShotId: child.id, lat: 4, lon: 4 });

    await svc.removeShot(removed.id, removed.version, 'cascade');

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const shots = fetched?.holes.find((candidate) => candidate.id === hole.id)?.shots ?? [];
    expect(shots.map((shot) => shot.id)).toEqual([survivor.id]);
    expect(shots[0]).toMatchObject({ parentShotId: null, sortOrder: 0 });
    expect(shots.some((shot) => shot.id === child.id || shot.id === grandchild.id)).toBe(false);
});

test('setPrimary promotes a sibling, preserves relative order, and is idempotent', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const first = await svc.addShot(hole.id, { parentShotId: null, lat: 1, lon: 1 });
    const second = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const third = await svc.addShot(hole.id, { parentShotId: null, lat: 3, lon: 3 });

    await svc.setPrimary(third.id);
    await svc.setPrimary(third.id);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const shots = fetched?.holes.find((candidate) => candidate.id === hole.id)?.shots ?? [];
    expect(shots.map((shot) => shot.id)).toEqual([third.id, first.id, second.id]);
    expect(shots.map((shot) => shot.sortOrder)).toEqual([0, 1, 2]);
    expect(shots.map((shot) => shot.version)).toEqual([1, 1, 1]);
});

test('option shots retain optimistic version conflicts for update and remove', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    await svc.addShot(hole.id, { lat: 1, lon: 1 });
    const option = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });

    await expect(svc.updateShot(option.id, 99, { label: 'stale' }))
        .rejects.toBeInstanceOf(VersionConflictError);
    await expect(svc.removeShot(option.id, 99, 'cascade'))
        .rejects.toBeInstanceOf(VersionConflictError);
});

test('reorderShots persists new sort order', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot1 = await svc.addShot(hole.id, { parentShotId: null, lat: 1, lon: 1 });
    const shot2 = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const shot3 = await svc.addShot(hole.id, { parentShotId: null, lat: 3, lon: 3 });

    await svc.reorderShots(hole.id, [shot3.id, shot1.id, shot2.id]);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole = fetched?.holes.find((h) => h.id === hole.id);
    expect(fetchedHole?.shots.map((s) => s.id)).toEqual([shot3.id, shot1.id, shot2.id]);
});

test('getByCourse returns flat parent-linked shots ordered by hole number and primary traversal', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 4 });

    const hole2 = await svc.setHole(plan.id, 2, { preferredClubId: TEST_CLUB_7I_ID });
    const hole1 = await svc.setHole(plan.id, 1, { preferredClubId: TEST_CLUB_DRIVER_ID });

    const first = await svc.addShot(hole1.id, { lat: 1, lon: 1 });
    const second = await svc.addShot(hole1.id, { lat: 2, lon: 2 });
    await svc.addShot(hole2.id, { lat: 3, lon: 3 });

    const tree = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    expect(tree).not.toBeNull();
    expect(tree!.windSpeedMps).toBe(4);
    expect(tree!.holes.map((h) => h.holeNumber)).toEqual([1, 2]);
    expect(tree!.holes[0].shots).toEqual([
        expect.objectContaining({ id: first.id, parentShotId: null, sortOrder: 0 }),
        expect.objectContaining({ id: second.id, parentShotId: first.id, sortOrder: 0 }),
    ]);
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

// --- Per-hole wind override & notes (Phase 5) ---

test('setHole sets per-hole wind override and notes on create', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 5, windDirectionDeg: 90 });

    const hole = await svc.setHole(plan.id, 1, {
        windSpeedMps: 6.5,
        windDirectionDeg: 200,
        notes: 'Watch the crosswind off the trees',
    });

    expect(hole.windSpeedMps).toBe(6.5);
    expect(hole.windDirectionDeg).toBe(200);
    expect(hole.notes).toBe('Watch the crosswind off the trees');
});

test('setHole per-hole wind override defaults to null (inherit plan wind) when unset', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID, windSpeedMps: 5, windDirectionDeg: 90 });

    const hole = await svc.setHole(plan.id, 1, { teeId: `${TEST_HOLE_1_ID}-tee-yellow` });

    expect(hole.windSpeedMps).toBeNull();
    expect(hole.windDirectionDeg).toBeNull();
    expect(hole.notes).toBeNull();
});

test('setHole clears per-hole wind override and notes by passing null', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, { windSpeedMps: 4, windDirectionDeg: 180, notes: 'Draft note' });

    const cleared = await svc.setHole(plan.id, 1, {
        version: hole.version,
        windSpeedMps: null,
        windDirectionDeg: null,
        notes: null,
    });

    expect(cleared.windSpeedMps).toBeNull();
    expect(cleared.windDirectionDeg).toBeNull();
    expect(cleared.notes).toBeNull();
});

test('setHole preserves per-hole wind override when patch omits it', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, { windSpeedMps: 4, windDirectionDeg: 180 });

    const updated = await svc.setHole(plan.id, 1, {
        version: hole.version,
        preferredClubId: TEST_CLUB_7I_ID,
    });

    expect(updated.windSpeedMps).toBe(4);
    expect(updated.windDirectionDeg).toBe(180);
});

// --- Shot label round-trip (Phase 5) ---

test('addShot and updateShot round-trip a label', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});

    const shot = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5, label: 'Layup left of bunker' });
    expect(shot.label).toBe('Layup left of bunker');

    const updated = await svc.updateShot(shot.id, shot.version, { label: 'Aim at right edge' });
    expect(updated.label).toBe('Aim at right edge');

    const cleared = await svc.updateShot(updated.id, updated.version, { label: null });
    expect(cleared.label).toBeNull();
});

test('addShot defaults label to null when omitted', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});

    const shot = await svc.addShot(hole.id, { lat: 58.4, lon: 15.5 });
    expect(shot.label).toBeNull();
});

// --- Gates (Phase 5) ---

test('addGate creates a manual-source gate with increasing sort order', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});

    const gate1 = await svc.addGate(hole.id, {
        lat: 58.401, lon: 15.501, directionDeg: 45, halfWidthLeftM: 12, halfWidthRightM: 18,
    });
    const gate2 = await svc.addGate(hole.id, {
        lat: 58.402, lon: 15.502, directionDeg: 50, halfWidthLeftM: 10, halfWidthRightM: 10, source: 'computed',
    });

    expect(gate1.source).toBe('manual');
    expect(gate1.sortOrder).toBe(0);
    expect(gate1.version).toBe(1);
    expect(gate2.source).toBe('computed');
    expect(gate2.sortOrder).toBe(1);
});

test('updateGate patches fields, bumps version, and throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const gate = await svc.addGate(hole.id, {
        lat: 58.401, lon: 15.501, directionDeg: 45, halfWidthLeftM: 12, halfWidthRightM: 18,
    });

    const updated = await svc.updateGate(gate.id, gate.version, { halfWidthLeftM: 20, source: 'computed' });
    expect(updated.halfWidthLeftM).toBe(20);
    expect(updated.source).toBe('computed');
    expect(updated.halfWidthRightM).toBe(18); // unchanged
    expect(updated.version).toBe(2);

    await expect(svc.updateGate(gate.id, 99, { halfWidthLeftM: 1 })).rejects.toBeInstanceOf(VersionConflictError);
});

test('removeGate deletes a gate and throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const gate = await svc.addGate(hole.id, {
        lat: 58.401, lon: 15.501, directionDeg: 45, halfWidthLeftM: 12, halfWidthRightM: 18,
    });

    await expect(svc.removeGate(gate.id, 99)).rejects.toBeInstanceOf(VersionConflictError);

    await svc.removeGate(gate.id, gate.version);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole = fetched?.holes.find((h) => h.id === hole.id);
    expect(fetchedHole?.gates).toHaveLength(0);
});

test('getByCourse includes gates on each hole ordered by sort_order', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});

    const gateA = await svc.addGate(hole.id, { lat: 1, lon: 1, directionDeg: 0, halfWidthLeftM: 5, halfWidthRightM: 5 });
    const gateB = await svc.addGate(hole.id, { lat: 2, lon: 2, directionDeg: 0, halfWidthLeftM: 5, halfWidthRightM: 5 });

    const tree = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole = tree?.holes.find((h) => h.id === hole.id);
    expect(fetchedHole?.gates.map((g) => g.id)).toEqual([gateA.id, gateB.id]);
});

test('removeByCourse cascades plan -> holes -> gates', async () => {
    const { db, svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    await svc.addGate(hole.id, { lat: 1, lon: 1, directionDeg: 0, halfWidthLeftM: 5, halfWidthRightM: 5 });

    await svc.removeByCourse(TEST_COURSE_ID, plan.version, TEST_USER_ID);

    const remainingGates = await db.selectFrom('plan_gates').selectAll().where('game_plan_hole_id', '=', hole.id).execute();
    expect(remainingGates).toHaveLength(0);
});

// --- O3 sibling-scoped reorder validation ---

test('reorderShots rejects an incomplete id set', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot1 = await svc.addShot(hole.id, { parentShotId: null, lat: 1, lon: 1 });
    await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });

    await expect(svc.reorderShots(hole.id, [shot1.id])).rejects.toBeInstanceOf(ConflictError);
});

test('reorderShots rejects ids foreign to the hole', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole1 = await svc.setHole(plan.id, 1, {});
    const hole2 = await svc.setHole(plan.id, 2, {});
    const shot1 = await svc.addShot(hole1.id, { lat: 1, lon: 1 });
    const foreignShot = await svc.addShot(hole2.id, { lat: 2, lon: 2 });

    await expect(svc.reorderShots(hole1.id, [shot1.id, foreignShot.id])).rejects.toBeInstanceOf(ConflictError);

    // Original order/state untouched.
    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole1 = fetched?.holes.find((h) => h.id === hole1.id);
    expect(fetchedHole1?.shots.map((s) => s.id)).toEqual([shot1.id]);
});

test('reorderShots rejects ids spanning sibling groups in the same hole', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const root = await svc.addShot(hole.id, { lat: 1, lon: 1 });
    const rootOption = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const child = await svc.addShot(hole.id, { parentShotId: root.id, lat: 3, lon: 3 });

    await expect(svc.reorderShots(hole.id, [root.id, rootOption.id, child.id]))
        .rejects.toBeInstanceOf(ConflictError);
});

test('reorderShots rejects duplicate ids even when their set matches the sibling group', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot = await svc.addShot(hole.id, { lat: 1, lon: 1 });

    await expect(svc.reorderShots(hole.id, [shot.id, shot.id]))
        .rejects.toBeInstanceOf(ConflictError);
});

test('reorderShots rejects unknown/nonexistent ids', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot1 = await svc.addShot(hole.id, { lat: 1, lon: 1 });

    await expect(svc.reorderShots(hole.id, [shot1.id, 'nonexistent'])).rejects.toBeInstanceOf(ConflictError);
});

test('reorderShots still succeeds on a valid permutation', async () => {
    const { svc } = await setup();
    const plan = await svc.upsertByCourse(TEST_COURSE_ID, { userId: TEST_USER_ID });
    const hole = await svc.setHole(plan.id, 1, {});
    const shot1 = await svc.addShot(hole.id, { parentShotId: null, lat: 1, lon: 1 });
    const shot2 = await svc.addShot(hole.id, { parentShotId: null, lat: 2, lon: 2 });
    const shot3 = await svc.addShot(hole.id, { parentShotId: null, lat: 3, lon: 3 });

    await svc.reorderShots(hole.id, [shot3.id, shot1.id, shot2.id]);

    const fetched = await svc.getByCourse(TEST_COURSE_ID, TEST_USER_ID);
    const fetchedHole = fetched?.holes.find((h) => h.id === hole.id);
    expect(fetchedHole?.shots.map((s) => s.id)).toEqual([shot3.id, shot1.id, shot2.id]);
});
