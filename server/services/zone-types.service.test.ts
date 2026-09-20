import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { ZoneTypesService, InvalidZoneTypeError, DEFAULT_ZONE_TYPES } from './zone-types.service';

async function setup() {
    const ctx = await createTestDb(seedCourse);
    return { db: ctx.db, svc: new ZoneTypesService(ctx.db) };
}

describe('ZoneTypesService.listByCourse', () => {
    test('seeds the four default zone types on the first list', async () => {
        const { svc } = await setup();

        const types = await svc.listByCourse(TEST_COURSE_ID);
        expect(types.map((z) => z.key)).toEqual(['rough_tall', 'shrub', 'fern', 'meadow']);
        expect(types.map((z) => z.name)).toEqual(['Tall rough', 'Shrubs', 'Ferns', 'Meadow']);
        expect(types.map((z) => z.color)).toEqual(['#8a9a3c', '#6b8f3a', '#4f8c5a', '#b8a94a']);
        expect(types.map((z) => z.textureIndex)).toEqual([0, 0, 0, 0]);
        expect(types.map((z) => z.channel)).toEqual([0, 1, 2, 3]);
        expect(types.map((z) => z.sortOrder)).toEqual([0, 1, 2, 3]);
        expect(types.every((z) => z.items.length === 0)).toBe(true);
    });

    test('seeding happens once — a second list returns the same rows', async () => {
        const { svc } = await setup();
        const first = await svc.listByCourse(TEST_COURSE_ID);
        const second = await svc.listByCourse(TEST_COURSE_ID);
        expect(second.map((z) => z.id)).toEqual(first.map((z) => z.id));
    });

    test('an edited table is never re-seeded', async () => {
        const { svc } = await setup();
        const [first] = await svc.listByCourse(TEST_COURSE_ID);
        await svc.remove(first!.id);
        const after = await svc.listByCourse(TEST_COURSE_ID);
        expect(after.map((z) => z.key)).toEqual(['shrub', 'fern', 'meadow']);
    });

    test('404s for an unknown course rather than seeding one into existence', async () => {
        const { svc } = await setup();
        await expect(svc.listByCourse('nope')).rejects.toBeInstanceOf(NotFoundError);
    });

    test('is scoped to the course', async () => {
        const { db, svc } = await setup();
        await db.insertInto('courses').values({
            id: 'course-2', name: 'Other', status: 'draft', revision: 1, crs: 'EPSG:3006',
            georeference_json: null, home_lat: null, home_lon: null, notes: null, version: 1,
        }).execute();

        await svc.listByCourse(TEST_COURSE_ID);
        await svc.create({ courseId: 'course-2', key: 'heather', name: 'Heather', color: '#7a5f8a' });

        expect((await svc.listByCourse('course-2')).map((z) => z.key)).toEqual(['heather']);
        expect((await svc.listByCourse(TEST_COURSE_ID)).map((z) => z.key)).toEqual(
            DEFAULT_ZONE_TYPES.map((z) => z.key),
        );
    });
});

describe('ZoneTypesService.create', () => {
    test('takes the lowest free mask slot when none is given', async () => {
        const { svc } = await setup();
        const a = await svc.create({ courseId: TEST_COURSE_ID, key: 'a', name: 'A', color: '#112233' });
        const b = await svc.create({ courseId: TEST_COURSE_ID, key: 'b', name: 'B', color: '#112233' });
        expect([a.textureIndex, a.channel]).toEqual([0, 0]);
        expect([b.textureIndex, b.channel]).toEqual([0, 1]);
    });

    test('opens a second texture once four channels are used', async () => {
        const { svc } = await setup();
        await svc.listByCourse(TEST_COURSE_ID); // seeds 0:0..0:3
        const fifth = await svc.create({ courseId: TEST_COURSE_ID, key: 'heather', name: 'Heather', color: '#7a5f8a' });
        expect([fifth.textureIndex, fifth.channel]).toEqual([1, 0]);
    });

    test('stores item bindings', async () => {
        const { svc } = await setup();
        const zt = await svc.create({
            courseId: TEST_COURSE_ID,
            key: 'shrub',
            name: 'Shrubs',
            color: '#6b8f3a',
            items: [{ item: 'Hazel bush', minDensity: 0, maxDensity: 1 }],
        });
        expect(zt.items).toEqual([{ item: 'Hazel bush', minDensity: 0, maxDensity: 1 }]);
        expect((await svc.get(zt.id)).items).toEqual([{ item: 'Hazel bush', minDensity: 0, maxDensity: 1 }]);
    });

    test('rejects a bad key, name, colour, texture, channel or item', async () => {
        const { svc } = await setup();
        const base = { courseId: TEST_COURSE_ID, key: 'ok', name: 'Ok', color: '#123456' };
        const bad = [
            { ...base, key: 'Tall Rough' },
            { ...base, key: '' },
            { ...base, name: '  ' },
            { ...base, color: 'green' },
            { ...base, color: '#12345' },
            { ...base, textureIndex: -1 },
            { ...base, channel: 4 },
            { ...base, channel: 1.5 },
            { ...base, items: [{ item: '', minDensity: 0, maxDensity: 1 }] },
            { ...base, items: [{ item: 'Fern', minDensity: -0.1, maxDensity: 1 }] },
            { ...base, items: [{ item: 'Fern', minDensity: 0.9, maxDensity: 0.2 }] },
        ];
        for (const input of bad) {
            await expect(svc.create(input as never)).rejects.toBeInstanceOf(InvalidZoneTypeError);
        }
    });

    test('rejects a duplicate key or a taken mask channel', async () => {
        const { svc } = await setup();
        await svc.create({ courseId: TEST_COURSE_ID, key: 'shrub', name: 'Shrubs', color: '#6b8f3a', textureIndex: 0, channel: 1 });

        await expect(svc.create({ courseId: TEST_COURSE_ID, key: 'shrub', name: 'Again', color: '#6b8f3a' }))
            .rejects.toBeInstanceOf(ConflictError);
        await expect(svc.create({ courseId: TEST_COURSE_ID, key: 'fern', name: 'Ferns', color: '#4f8c5a', textureIndex: 0, channel: 1 }))
            .rejects.toBeInstanceOf(ConflictError);
    });
});

describe('ZoneTypesService.update / remove / reorder', () => {
    test('patches the named fields and leaves the rest alone', async () => {
        const { svc } = await setup();
        const zt = await svc.create({ courseId: TEST_COURSE_ID, key: 'shrub', name: 'Shrubs', color: '#6b8f3a' });

        const updated = await svc.update(zt.id, {
            name: 'Bushes',
            color: '#123456',
            channel: 2,
            items: [{ item: 'Hazel bush', minDensity: 0.2, maxDensity: 0.8 }],
        });
        expect(updated.key).toBe('shrub');
        expect(updated.name).toBe('Bushes');
        expect(updated.color).toBe('#123456');
        expect(updated.textureIndex).toBe(0);
        expect(updated.channel).toBe(2);
        expect(updated.items).toEqual([{ item: 'Hazel bush', minDensity: 0.2, maxDensity: 0.8 }]);
    });

    test('a zone type may keep its own key and channel while being patched', async () => {
        const { svc } = await setup();
        const zt = await svc.create({ courseId: TEST_COURSE_ID, key: 'shrub', name: 'Shrubs', color: '#6b8f3a' });
        const updated = await svc.update(zt.id, { key: 'shrub', channel: zt.channel, name: 'Shrubbery' });
        expect(updated.name).toBe('Shrubbery');
    });

    test('rejects moving onto another type’s key or channel', async () => {
        const { svc } = await setup();
        const [roughTall, shrub] = await svc.listByCourse(TEST_COURSE_ID);

        await expect(svc.update(shrub!.id, { key: roughTall!.key })).rejects.toBeInstanceOf(ConflictError);
        await expect(svc.update(shrub!.id, { channel: roughTall!.channel })).rejects.toBeInstanceOf(ConflictError);
        await expect(svc.update(shrub!.id, { color: 'chartreuse' })).rejects.toBeInstanceOf(InvalidZoneTypeError);
    });

    test('remove drops one row; get/update/remove 404 afterwards', async () => {
        const { svc } = await setup();
        const zt = await svc.create({ courseId: TEST_COURSE_ID, key: 'shrub', name: 'Shrubs', color: '#6b8f3a' });

        await svc.remove(zt.id);
        await expect(svc.get(zt.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(svc.update(zt.id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
        await expect(svc.remove(zt.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    test('deleting a course cascades to its zone types', async () => {
        const { db, svc } = await setup();
        await svc.listByCourse(TEST_COURSE_ID);
        await db.deleteFrom('courses').where('id', '=', TEST_COURSE_ID).execute();
        const rows = await db.selectFrom('course_zone_types').selectAll()
            .where('course_id', '=', TEST_COURSE_ID).execute();
        expect(rows).toHaveLength(0);
    });

    test('reorder rewrites sort_order; a partial list conflicts', async () => {
        const { svc } = await setup();
        const types = await svc.listByCourse(TEST_COURSE_ID);
        const reversed = [...types].reverse().map((z) => z.id);

        const after = await svc.reorder(TEST_COURSE_ID, reversed);
        expect(after.map((z) => z.id)).toEqual(reversed);
        expect(after.map((z) => z.sortOrder)).toEqual([0, 1, 2, 3]);

        await expect(svc.reorder(TEST_COURSE_ID, reversed.slice(1))).rejects.toBeInstanceOf(ConflictError);
    });
});

describe('ZoneTypesService.addDefaults', () => {
    test('fills in only the missing default keys', async () => {
        const { svc } = await setup();
        const types = await svc.listByCourse(TEST_COURSE_ID);
        await svc.remove(types.find((z) => z.key === 'fern')!.id);

        const added = await svc.addDefaults(TEST_COURSE_ID);
        expect(added.map((z) => z.key)).toEqual(['fern']);
        expect((await svc.listByCourse(TEST_COURSE_ID)).map((z) => z.key).sort())
            .toEqual(['fern', 'meadow', 'rough_tall', 'shrub']);
    });
});
