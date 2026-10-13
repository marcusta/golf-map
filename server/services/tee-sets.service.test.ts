import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { TeeSetsService } from './tee-sets.service';
import { TeesService } from './tees.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

test('tees written without a set are adopted into the set of their name', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeeSetsService(db);
    const tees = new TeesService(db);
    expect((await tees.listByCourse(TEST_COURSE_ID)).every(t => t.teeSetId === null)).toBe(true);

    const sets = await svc.listByCourse(TEST_COURSE_ID);
    expect(sets.map(s => [s.name, s.teeCount])).toEqual([['yellow', 2], ['blue', 2]]);
    expect(sets[0]).toMatchObject({ ratingMen: null, slopeWomen: null, gsproRating: 'men' });

    const adopted = await tees.listByCourse(TEST_COURSE_ID);
    expect(adopted.filter(t => t.name === 'yellow').every(t => t.teeSetId === sets[0].id)).toBe(true);
    // Listing again makes nothing new.
    expect(await svc.listByCourse(TEST_COURSE_ID)).toHaveLength(2);
});

test('a set keeps both ratings, and its name and colour go onto its tees', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeeSetsService(db);
    const tees = new TeesService(db);
    const [yellow, blue] = await svc.listByCourse(TEST_COURSE_ID);

    const rated = await svc.update(yellow.id, yellow.version, {
        ratingMen: 71.5, slopeMen: 135, ratingWomen: 77.2, slopeWomen: 141, gsproRating: 'women',
    });
    expect(rated).toMatchObject({ ratingMen: 71.5, slopeMen: 135, ratingWomen: 77.2, slopeWomen: 141, gsproRating: 'women' });
    await expect(svc.update(yellow.id, yellow.version, { slopeMen: 136 })).rejects.toThrow(VersionConflictError);
    expect((await svc.update(yellow.id, rated.version, { slopeMen: null })).slopeMen).toBeNull();

    const before = (await tees.listByHole(TEST_HOLE_1_ID)).find(t => t.teeSetId === yellow.id)!;
    const renamed = await svc.update(yellow.id, rated.version + 1, { name: 'Gul', color: 'yellow' });
    expect(renamed.name).toBe('Gul');
    const after = (await tees.listByCourse(TEST_COURSE_ID)).filter(t => t.teeSetId === yellow.id);
    expect(after.map(t => [t.name, t.color])).toEqual([['Gul', 'yellow'], ['Gul', 'yellow']]);
    expect(after.find(t => t.id === before.id)!.version).toBe(before.version + 1);

    await expect(svc.update(blue.id, blue.version, { name: ' gul ' })).rejects.toThrow(/already has a tee set named Gul/);
    await expect(svc.update('nope', 1, { name: 'x' })).rejects.toThrow(NotFoundError);
});

test('a new set starts empty, takes tees by id, and can only be removed empty', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeeSetsService(db);
    const tees = new TeesService(db);
    await svc.listByCourse(TEST_COURSE_ID);

    const red = await svc.create({ courseId: TEST_COURSE_ID, name: ' Red ', color: 'red' });
    expect(red).toMatchObject({ name: 'Red', color: 'red', sortOrder: 2, teeCount: 0 });
    await expect(svc.create({ courseId: TEST_COURSE_ID, name: 'red' })).rejects.toThrow(ConflictError);
    await expect(svc.create({ courseId: 'nope', name: 'White' })).rejects.toThrow(NotFoundError);

    // A tee placed on a set takes the set's name and colour.
    const tee = await tees.create({ holeId: TEST_HOLE_1_ID, teeSetId: red.id, lat: 58.4, lon: 15.56 });
    expect(tee).toMatchObject({ teeSetId: red.id, name: 'Red', color: 'red' });
    await expect(tees.create({ holeId: TEST_HOLE_1_ID, lat: 58.4, lon: 15.56 })).rejects.toThrow(/tee set or a name/);
    await expect(tees.create({ holeId: TEST_HOLE_1_ID, teeSetId: 'nope', lat: 58.4, lon: 15.56 })).rejects.toThrow(ConflictError);

    // An existing tee moved to the set.
    const other = (await tees.listByHole(TEST_HOLE_2_ID))[0];
    const moved = await tees.update(other.id, other.version, { teeSetId: red.id });
    expect(moved).toMatchObject({ teeSetId: red.id, name: 'Red', color: 'red' });

    const full = await svc.get(red.id);
    expect(full.teeCount).toBe(2);
    await expect(svc.remove(red.id, full.version)).rejects.toThrow(/still has 2 tees/);
    await tees.remove(tee.id, tee.version);
    await tees.remove(moved.id, moved.version);
    await svc.remove(red.id, full.version);
    expect((await svc.listByCourse(TEST_COURSE_ID)).map(s => s.name)).toEqual(['yellow', 'blue']);
});

test('a set is exported as the GSPro tee it says, whatever the club calls it, and a GSPro-only set marks its tees', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new TeeSetsService(db);
    const tees = new TeesService(db);
    const [yellow, blue] = await svc.listByCourse(TEST_COURSE_ID);
    // Adopted sets start as the GSPro tee their name or colour says.
    expect([yellow.gsproTee, blue.gsproTee, yellow.gsproOnly]).toEqual(['Yellow', 'Blue', false]);

    // The club's own name does not move it.
    const renamed = await svc.update(yellow.id, yellow.version, { name: '57' });
    expect(renamed).toMatchObject({ name: '57', gsproTee: 'Yellow' });
    // A second set that would be Yellow by name starts without one: Yellow is taken.
    expect((await svc.create({ courseId: TEST_COURSE_ID, name: 'Yellow' })).gsproTee).toBeNull();

    // A set the club does not have: GSPro's Junior, out of the course guide, with its own rating.
    const junior = await svc.create({ courseId: TEST_COURSE_ID, name: 'Knatte' });
    expect(junior).toMatchObject({ gsproTee: null, gsproOnly: false });
    const marked = await svc.update(junior.id, junior.version, { gsproTee: 'Junior', gsproOnly: true, ratingMen: 60.1, slopeMen: 101 });
    expect(marked).toMatchObject({ gsproTee: 'Junior', gsproOnly: true, ratingMen: 60.1 });
    const tee = await tees.create({ holeId: TEST_HOLE_1_ID, teeSetId: junior.id, lat: 58.4, lon: 15.56 });
    expect(tee.gsproOnly).toBe(true);
    // Unmarking the set unmarks its tees; a tee moved onto a marked set takes the mark.
    const unmarked = await svc.update(junior.id, marked.version, { gsproOnly: false });
    expect((await tees.listByCourse(TEST_COURSE_ID)).find(t => t.id === tee.id)!.gsproOnly).toBe(false);
    await svc.update(junior.id, unmarked.version, { gsproOnly: true });
    const other = (await tees.listByHole(TEST_HOLE_2_ID)).find(t => t.teeSetId === blue.id)!;
    expect((await tees.update(other.id, other.version, { teeSetId: junior.id })).gsproOnly).toBe(true);

    // Taking a GSPro tee another set has moves it; null takes the set out of GSPro.
    const taken = await svc.update(blue.id, blue.version, { gsproTee: 'Yellow' });
    expect(taken.gsproTee).toBe('Yellow');
    const was = await svc.get(yellow.id);
    expect(was.gsproTee).toBeNull();
    expect(was.version).toBe(renamed.version + 1);
    expect((await svc.update(blue.id, taken.version, { gsproTee: null })).gsproTee).toBeNull();
});
