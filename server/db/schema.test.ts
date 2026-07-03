import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers, TEST_USER_ID, TEST_USERNAME } from './seeds/users';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from './seeds/course';
import { seedClubs, TEST_CLUB_DRIVER_ID } from './seeds/clubs';

test('seeded user is queryable with correct columns', async () => {
    const { db } = await createTestDb(seedUsers);

    const user = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', TEST_USER_ID)
        .executeTakeFirstOrThrow();

    expect(user.username).toBe(TEST_USERNAME);
    expect(typeof user.password_hash).toBe('string');
    expect(user.created_at).toBeTruthy();
});

test('seeded course joins holes and counts tees/pins/aim points/hazards', async () => {
    const { db } = await createTestDb(seedCourse);

    const course = await db
        .selectFrom('courses')
        .selectAll()
        .where('id', '=', TEST_COURSE_ID)
        .executeTakeFirstOrThrow();
    expect(course.name).toBe('Linkan');
    expect(course.status).toBe('draft');
    expect(course.revision).toBe(1);
    expect(course.crs).toBe('EPSG:3006');
    expect(course.version).toBe(1);

    const holes = await db
        .selectFrom('holes')
        .selectAll()
        .where('course_id', '=', TEST_COURSE_ID)
        .orderBy('number')
        .execute();
    expect(holes).toHaveLength(2);
    expect(holes[0].number).toBe(1);
    expect(holes[0].par).toBe(4);
    expect(holes[1].par).toBe(3);

    const joined = await db
        .selectFrom('holes')
        .innerJoin('courses', 'courses.id', 'holes.course_id')
        .select(['holes.id as hole_id', 'courses.name as course_name'])
        .where('holes.id', '=', TEST_HOLE_1_ID)
        .executeTakeFirstOrThrow();
    expect(joined.course_name).toBe('Linkan');

    const teeCount = await db
        .selectFrom('tees')
        .select((eb) => eb.fn.countAll().as('count'))
        .where('hole_id', '=', TEST_HOLE_1_ID)
        .executeTakeFirstOrThrow();
    expect(Number(teeCount.count)).toBe(2);

    const greens = await db
        .selectFrom('greens')
        .selectAll()
        .where('hole_id', '=', TEST_HOLE_1_ID)
        .execute();
    expect(greens).toHaveLength(1);

    const pins = await db
        .selectFrom('pins')
        .selectAll()
        .where('green_id', '=', greens[0].id)
        .execute();
    expect(pins).toHaveLength(2);
    expect(pins.some((p) => p.active === 1)).toBe(true);
    expect(pins.some((p) => p.active === 0)).toBe(true);

    const aimPoints = await db
        .selectFrom('aim_points')
        .selectAll()
        .where('hole_id', '=', TEST_HOLE_1_ID)
        .execute();
    expect(aimPoints).toHaveLength(1);

    const hazards = await db
        .selectFrom('hazards')
        .selectAll()
        .where('hole_id', '=', TEST_HOLE_1_ID)
        .execute();
    expect(hazards).toHaveLength(2);
    expect(hazards.map((h) => h.kind).sort()).toEqual(['bunker', 'water_yellow']);

    const features = await db
        .selectFrom('course_features')
        .selectAll()
        .where('course_id', '=', TEST_COURSE_ID)
        .execute();
    expect(features).toHaveLength(1);
    expect(features[0].type).toBe('green');
    expect(JSON.parse(features[0].geometry_json).crs).toBe('EPSG:3006');
});

test('seeded clubs are queryable and sorted', async () => {
    const { db } = await createTestDb(seedUsers, seedClubs);

    const clubs = await db
        .selectFrom('clubs')
        .selectAll()
        .orderBy('sort_order')
        .execute();

    expect(clubs).toHaveLength(3);
    expect(clubs[0].id).toBe(TEST_CLUB_DRIVER_ID);
    expect(clubs[0].name).toBe('Driver');
    expect(clubs[0].carry_m).toBeGreaterThan(clubs[1].carry_m);
});

test('multiple seeds compose in one createTestDb call', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse, seedClubs);

    const [userCount, courseCount, clubCount] = await Promise.all([
        db.selectFrom('users').select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow(),
        db.selectFrom('courses').select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow(),
        db.selectFrom('clubs').select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow(),
    ]);

    expect(Number(userCount.count)).toBe(1);
    expect(Number(courseCount.count)).toBe(1);
    expect(Number(clubCount.count)).toBe(3);
});

test('foreign keys cascade on delete (course -> holes -> tees)', async () => {
    const { db } = await createTestDb(seedCourse);

    await db.deleteFrom('courses').where('id', '=', TEST_COURSE_ID).execute();

    const holes = await db.selectFrom('holes').selectAll().execute();
    const tees = await db.selectFrom('tees').selectAll().execute();
    expect(holes).toHaveLength(0);
    expect(tees).toHaveLength(0);
});
