import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers, TEST_USER_ID } from '../db/seeds/users';
import { seedClubs, TEST_CLUB_DRIVER_ID, TEST_CLUB_7I_ID, TEST_CLUB_PW_ID } from '../db/seeds/clubs';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ClubsService } from './clubs.service';

test('list returns empty array with no seed', async () => {
    const { db } = await createTestDb();
    const svc = new ClubsService(db);

    expect(await svc.list()).toHaveLength(0);
});

test('list returns seeded clubs ordered by sort_order', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    const clubs = await svc.list();
    expect(clubs).toHaveLength(3);
    expect(clubs.map((c) => c.id)).toEqual([TEST_CLUB_DRIVER_ID, TEST_CLUB_7I_ID, TEST_CLUB_PW_ID]);
    expect(clubs[0].name).toBe('Driver');
    expect(clubs[0].carryM).toBe(222.2);
    expect(clubs[0].dispersionM).toBe(59.4);
    expect(clubs[0].version).toBe(1);
});

test('list filters by userId', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    const clubs = await svc.list(TEST_USER_ID);
    expect(clubs).toHaveLength(3);

    const otherUserClubs = await svc.list('someone-else');
    expect(otherUserClubs).toHaveLength(0);
});

test('create appends to end of sort order', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    const club = await svc.create({ userId: TEST_USER_ID, name: '9i', carryM: 120, dispersionM: 20 });
    expect(club.sortOrder).toBe(3);
    expect(club.version).toBe(1);

    const clubs = await svc.list(TEST_USER_ID);
    expect(clubs).toHaveLength(4);
    expect(clubs[3].id).toBe(club.id);
});

test('create on empty table starts sort order at 0', async () => {
    const { db } = await createTestDb();
    const svc = new ClubsService(db);

    const club = await svc.create({ name: 'Driver', carryM: 220, dispersionM: 55 });
    expect(club.sortOrder).toBe(0);
});

test('findById returns club', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    const club = await svc.findById(TEST_CLUB_DRIVER_ID);
    expect(club.name).toBe('Driver');
});

test('findById throws when not found', async () => {
    const { db } = await createTestDb();
    const svc = new ClubsService(db);

    await expect(svc.findById('nope')).rejects.toThrow();
});

test('update changes fields and bumps version', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    const updated = await svc.update(TEST_CLUB_DRIVER_ID, 1, { carryM: 225 });
    expect(updated.carryM).toBe(225);
    expect(updated.name).toBe('Driver');
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    await expect(svc.update(TEST_CLUB_DRIVER_ID, 99, { name: 'Nope' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove deletes club', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    await svc.remove(TEST_CLUB_PW_ID, 1);

    const clubs = await svc.list();
    expect(clubs.find((c) => c.id === TEST_CLUB_PW_ID)).toBeUndefined();
    expect(clubs).toHaveLength(2);
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    await expect(svc.remove(TEST_CLUB_PW_ID, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('reorder persists new sort order', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);
    const svc = new ClubsService(db);

    await svc.reorder([TEST_CLUB_PW_ID, TEST_CLUB_DRIVER_ID, TEST_CLUB_7I_ID]);

    const clubs = await svc.list();
    expect(clubs.map((c) => c.id)).toEqual([TEST_CLUB_PW_ID, TEST_CLUB_DRIVER_ID, TEST_CLUB_7I_ID]);
    expect(clubs[0].sortOrder).toBe(0);
    expect(clubs[1].sortOrder).toBe(1);
    expect(clubs[2].sortOrder).toBe(2);
});
