import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { seedUsers, TEST_USER_ID } from '../db/seeds/users';
import { seedClubs, TEST_CLUB_DRIVER_ID, TEST_CLUB_PW_ID } from '../db/seeds/clubs';
import { RoundsService } from './rounds.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

async function setup() {
    const ctx = await createTestDb(seedUsers, seedCourse, seedClubs);
    return new RoundsService(ctx.db);
}

test('listByCourse returns empty array with no rounds', async () => {
    const svc = await setup();
    const rounds = await svc.listByCourse(TEST_COURSE_ID);
    expect(rounds).toHaveLength(0);
});

test('start creates a round', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID, '2026-01-01T10:00:00.000Z');
    expect(round.courseId).toBe(TEST_COURSE_ID);
    expect(round.userId).toBe(TEST_USER_ID);
    expect(round.startedAt).toBe('2026-01-01T10:00:00.000Z');
    expect(round.endedAt).toBeNull();
    expect(round.version).toBe(1);
});

test('start defaults startedAt when omitted', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID);
    expect(round.userId).toBeNull();
    expect(typeof round.startedAt).toBe('string');
    expect(round.startedAt.length).toBeGreaterThan(0);
});

test('listByCourse returns rounds for that course only', async () => {
    const svc = await setup();
    await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const rounds = await svc.listByCourse(TEST_COURSE_ID);
    expect(rounds).toHaveLength(2);

    const other = await svc.listByCourse('nonexistent-course');
    expect(other).toHaveLength(0);
});

test('get returns round with empty shots array', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const found = await svc.get(round.id);
    expect(found.id).toBe(round.id);
    expect(found.shots).toEqual([]);
});

test('get throws NotFoundError for missing round', async () => {
    const svc = await setup();
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
});

test('end sets endedAt, notes, and bumps version', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const ended = await svc.end(round.id, 1, '2026-01-01T14:00:00.000Z', 'Great round');
    expect(ended.endedAt).toBe('2026-01-01T14:00:00.000Z');
    expect(ended.notes).toBe('Great round');
    expect(ended.version).toBe(2);
});

test('end throws VersionConflictError on stale version', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(svc.end(round.id, 99, '2026-01-01T14:00:00.000Z')).rejects.toBeInstanceOf(VersionConflictError);
});

test('end throws NotFoundError for missing round', async () => {
    const svc = await setup();
    await expect(svc.end('nope', 1, '2026-01-01T14:00:00.000Z')).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes the round', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    await svc.remove(round.id, 1);
    await expect(svc.get(round.id)).rejects.toBeInstanceOf(NotFoundError);
});

test('remove throws VersionConflictError on stale version', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(svc.remove(round.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove cascades to delete shots', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });

    await svc.remove(round.id, 1);

    // The round row (and its shots) are gone; updating the now-deleted shot
    // should behave as "not found" rather than silently succeeding.
    await expect(svc.updateShot(shot.id, 1, { lie: 'rough' })).rejects.toBeInstanceOf(NotFoundError);
});

test('addShot throws NotFoundError for missing round', async () => {
    const svc = await setup();
    await expect(svc.addShot('nope', { holeNumber: 1, lat: 1, lon: 1 })).rejects.toBeInstanceOf(NotFoundError);
});

test('addShot appends sort_order within a hole, independently per hole', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);

    const h1s1 = await svc.addShot(round.id, { holeNumber: 1, lat: 1, lon: 1 });
    const h1s2 = await svc.addShot(round.id, { holeNumber: 1, lat: 2, lon: 2 });
    const h2s1 = await svc.addShot(round.id, { holeNumber: 2, lat: 3, lon: 3 });
    const h1s3 = await svc.addShot(round.id, { holeNumber: 1, lat: 4, lon: 4 });

    expect(h1s1.sortOrder).toBe(0);
    expect(h1s2.sortOrder).toBe(1);
    expect(h2s1.sortOrder).toBe(0);
    expect(h1s3.sortOrder).toBe(2);
});

test('get orders shots by hole_number then sort_order', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);

    await svc.addShot(round.id, { holeNumber: 2, lat: 1, lon: 1 });
    await svc.addShot(round.id, { holeNumber: 1, lat: 2, lon: 2 });
    await svc.addShot(round.id, { holeNumber: 1, lat: 3, lon: 3 });
    await svc.addShot(round.id, { holeNumber: 2, lat: 4, lon: 4 });

    const found = await svc.get(round.id);
    expect(found.shots.map((s) => [s.holeNumber, s.sortOrder])).toEqual([
        [1, 0],
        [1, 1],
        [2, 0],
        [2, 1],
    ]);
});

test('addShot stores optional clubId, lie, recordedAt', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, {
        holeNumber: 1,
        lat: 58.4,
        lon: 15.5,
        clubId: TEST_CLUB_DRIVER_ID,
        lie: 'fairway',
        recordedAt: '2026-01-01T11:00:00.000Z',
    });
    expect(shot.clubId).toBe(TEST_CLUB_DRIVER_ID);
    expect(shot.lie).toBe('fairway');
    expect(shot.recordedAt).toBe('2026-01-01T11:00:00.000Z');
    expect(shot.version).toBe(1);
});

test('updateShot patches fields and bumps version', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 1, lon: 1 });

    const updated = await svc.updateShot(shot.id, 1, { lie: 'bunker', clubId: TEST_CLUB_PW_ID });
    expect(updated.lie).toBe('bunker');
    expect(updated.clubId).toBe(TEST_CLUB_PW_ID);
    expect(updated.lat).toBe(1);
    expect(updated.version).toBe(2);
});

test('updateShot throws VersionConflictError on stale version', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 1, lon: 1 });
    await expect(svc.updateShot(shot.id, 99, { lie: 'rough' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('updateShot throws NotFoundError for missing shot', async () => {
    const svc = await setup();
    await expect(svc.updateShot('nope', 1, { lie: 'rough' })).rejects.toBeInstanceOf(NotFoundError);
});

test('removeShot deletes the shot', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 1, lon: 1 });

    await svc.removeShot(shot.id, 1);

    const found = await svc.get(round.id);
    expect(found.shots).toHaveLength(0);
});

test('removeShot throws VersionConflictError on stale version', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 1, lon: 1 });
    await expect(svc.removeShot(shot.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('removeShot throws NotFoundError for missing shot', async () => {
    const svc = await setup();
    await expect(svc.removeShot('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
});

// --- Shot-capture schema extension (T12) ---

test('start defaults game_plan_id and wind snapshot to null when omitted', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    expect(round.gamePlanId).toBeNull();
    expect(round.windSpeedMps).toBeNull();
    expect(round.windDirectionDeg).toBeNull();
});

test('start accepts game_plan_id and wind snapshot', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID, undefined, {
        gamePlanId: 'plan-123',
        windSpeedMps: 4.5,
        windDirectionDeg: 270,
    });
    expect(round.gamePlanId).toBe('plan-123');
    expect(round.windSpeedMps).toBe(4.5);
    expect(round.windDirectionDeg).toBe(270);
});

test('end can set game_plan_id and wind snapshot after the fact', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const ended = await svc.end(round.id, 1, '2026-01-01T14:00:00.000Z', undefined, {
        gamePlanId: 'plan-456',
        windSpeedMps: 3.2,
        windDirectionDeg: 90,
    });
    expect(ended.gamePlanId).toBe('plan-456');
    expect(ended.windSpeedMps).toBe(3.2);
    expect(ended.windDirectionDeg).toBe(90);
});

test('addShot defaults shot_type to full and penalty_strokes to 0, targets to null', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    expect(shot.shotType).toBe('full');
    expect(shot.penaltyStrokes).toBe(0);
    expect(shot.targetLat).toBeNull();
    expect(shot.targetLon).toBeNull();
});

test('addShot stores shot_type, target_lat/lon, and penalty_strokes', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, {
        holeNumber: 1,
        lat: 58.4,
        lon: 15.5,
        shotType: 'putt',
        targetLat: 58.401,
        targetLon: 15.501,
        penaltyStrokes: 1,
    });
    expect(shot.shotType).toBe('putt');
    expect(shot.targetLat).toBe(58.401);
    expect(shot.targetLon).toBe(15.501);
    expect(shot.penaltyStrokes).toBe(1);
});

test('updateShot round-trips shot_type, target_lat/lon, and penalty_strokes', async () => {
    const svc = await setup();
    const round = await svc.start(TEST_COURSE_ID, TEST_USER_ID);
    const shot = await svc.addShot(round.id, { holeNumber: 1, lat: 1, lon: 1 });

    const updated = await svc.updateShot(shot.id, 1, {
        shotType: 'recovery',
        targetLat: 2.5,
        targetLon: 3.5,
        penaltyStrokes: 2,
    });
    expect(updated.shotType).toBe('recovery');
    expect(updated.targetLat).toBe(2.5);
    expect(updated.targetLon).toBe(3.5);
    expect(updated.penaltyStrokes).toBe(2);
    expect(updated.version).toBe(2);
});
