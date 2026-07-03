import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_GREEN_1_ID, TEST_GREEN_2_ID } from '../db/seeds/course';
import { PinsService } from './pins.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

test('listByGreen returns pins for a green', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    expect(pins).toHaveLength(2);
    expect(pins.map((p) => p.name).sort()).toEqual(['Back Left', 'Front']);
});

test('listByCourse returns pins across all greens joined via greens->holes', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByCourse(TEST_COURSE_ID);
    expect(pins).toHaveLength(4);
    const greenIds = new Set(pins.map((p) => p.greenId));
    expect(greenIds).toEqual(new Set([TEST_GREEN_1_ID, TEST_GREEN_2_ID]));
});

test('create adds a pin, inactive by default', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pin = await svc.create({
        greenId: TEST_GREEN_1_ID,
        name: 'Middle Right',
        lat: 58.402,
        lon: 15.564,
        difficulty: 'medium',
    });

    expect(pin.name).toBe('Middle Right');
    expect(pin.active).toBe(false);
    expect(pin.version).toBe(1);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    expect(pins).toHaveLength(3);
});

test('update changes fields and bumps version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const front = pins.find((p) => p.name === 'Front')!;

    const updated = await svc.update(front.id, 1, { name: 'Front Center', difficulty: 'hard' });
    expect(updated.name).toBe('Front Center');
    expect(updated.difficulty).toBe('hard');
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const front = pins.find((p) => p.name === 'Front')!;

    await expect(svc.update(front.id, 99, { name: 'Nope' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for nonexistent pin', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    await expect(svc.update('nonexistent', 1, { name: 'Nope' })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes a pin', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const back = pins.find((p) => p.name === 'Back Left')!;

    await svc.remove(back.id, 1);

    const after = await svc.listByGreen(TEST_GREEN_1_ID);
    expect(after).toHaveLength(1);
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const back = pins.find((p) => p.name === 'Back Left')!;

    await expect(svc.remove(back.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('setActive sets active=1 on target and active=0 on all other pins of the same green', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const front = pins.find((p) => p.name === 'Front')!;
    const back = pins.find((p) => p.name === 'Back Left')!;
    expect(front.active).toBe(true);
    expect(back.active).toBe(false);

    const activated = await svc.setActive(back.id, 1);
    expect(activated.active).toBe(true);
    expect(activated.version).toBe(2);

    const after = await svc.listByGreen(TEST_GREEN_1_ID);
    const afterFront = after.find((p) => p.id === front.id)!;
    const afterBack = after.find((p) => p.id === back.id)!;
    expect(afterFront.active).toBe(false);
    expect(afterBack.active).toBe(true);
});

test('setActive does not affect pins on other greens', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const green1Pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const green2PinsBefore = await svc.listByGreen(TEST_GREEN_2_ID);
    const back1 = green1Pins.find((p) => p.name === 'Back Left')!;

    await svc.setActive(back1.id, 1);

    const green2PinsAfter = await svc.listByGreen(TEST_GREEN_2_ID);
    expect(green2PinsAfter.map((p) => p.active)).toEqual(green2PinsBefore.map((p) => p.active));
});

test('setActive throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    const pins = await svc.listByGreen(TEST_GREEN_1_ID);
    const back = pins.find((p) => p.name === 'Back Left')!;

    await expect(svc.setActive(back.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('setActive throws NotFoundError for nonexistent pin', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PinsService(db);

    await expect(svc.setActive('nonexistent', 1)).rejects.toBeInstanceOf(NotFoundError);
});
