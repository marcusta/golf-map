import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedUsers } from '../db/seeds/users';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { HolesService } from './holes.service';
import { CoursesService } from './courses.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';
import { UniqueViolationError } from '@basics/core/server/unique-violation';
import { CourseFeaturesService } from './course-features.service';
import { drawScopeRanks } from '../../shared/render/stack-key';

test('one layer stack reorders playable holes and groups while preserving hole and feature identities', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);
    const features = new CourseFeaturesService(db);
    const group = await svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: 'Clubhouse' });
    const shape = await features.create({ courseId: TEST_COURSE_ID, holeId: group.id, type: 'bunker', geometry: {
        crs: 'EPSG:3006', rings: [{ points: [{ x: 600000, y: 6400000 }, { x: 600010, y: 6400000 }, { x: 600010, y: 6400010 }] }],
    } });
    const order = async () => {
        const scopes = await svc.listByCourse(TEST_COURSE_ID, true);
        const ranks = drawScopeRanks(scopes);
        const json = await features.geojsonByCourse(TEST_COURSE_ID);
        expect(Math.floor(json.features.find(f => f.id === shape.id)!.properties.stackKey / 4096)).toBe(ranks.get(group.id)!);
        return scopes.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!).map(h => h.id);
    };
    await svc.update(TEST_HOLE_1_ID, 1, { layerBeforeId: null });
    expect(await order()).toEqual([TEST_HOLE_2_ID, group.id, TEST_HOLE_1_ID]);
    const moved = await svc.update(group.id, (await svc.get(group.id)).version, { layerBeforeId: TEST_HOLE_2_ID });
    expect(await order()).toEqual([group.id, TEST_HOLE_2_ID, TEST_HOLE_1_ID]);
    await expect(svc.update(group.id, group.version, { layerBeforeId: null })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(svc.update(group.id, moved.version, { layerBeforeId: 'missing-layer' })).rejects.toThrow('same course');
    await expect(svc.update('__roughs', 1, { layerBeforeId: null })).rejects.toBeInstanceOf(NotFoundError);
    expect((await svc.get(TEST_HOLE_1_ID)).number).toBe(1);
    expect((await svc.get(TEST_HOLE_2_ID)).number).toBe(2);
    expect((await svc.get(group.id)).number).toBe(group.number);
    expect((await features.listByCourse(TEST_COURSE_ID)).find(f => f.id === shape.id)?.no).toBe(shape.no);
    const added = await svc.create({ courseId: TEST_COURSE_ID, number: 3, par: 4 });
    const nextGroup = await svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: 'Range' });
    expect(await order()).toEqual([group.id, TEST_HOLE_2_ID, TEST_HOLE_1_ID, added.id, nextGroup.id]);
});

test('drawing groups move between holes and among peers without renaming meshes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);
    const features = new CourseFeaturesService(db);
    const a = await svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: 'A' });
    const b = await svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: 'B' });
    const geometry = { crs: 'EPSG:3006', rings: [{ points: [{ x: 600000, y: 6400000 }, { x: 600010, y: 6400000 }, { x: 600010, y: 6400010 }] }] };
    const shape = await features.create({ courseId: TEST_COURSE_ID, holeId: a.id, type: 'bunker', geometry });
    await svc.update(a.id, a.version, { drawingGroupAfter: 1 });
    await svc.update(b.id, b.version, { drawingGroupAfter: 1 });
    const order = async () => {
        const scopes = await svc.listByCourse(TEST_COURSE_ID, true);
        const ranks = drawScopeRanks(scopes);
        const geojson = await features.geojsonByCourse(TEST_COURSE_ID);
        expect(Math.floor(geojson.features.find(f => f.id === shape.id)!.properties.stackKey / 4096)).toBe(ranks.get(a.id)!);
        return scopes.sort((x, y) => ranks.get(x.id)! - ranks.get(y.id)!).map(h => h.id);
    };
    expect(await order()).toEqual([TEST_HOLE_1_ID, a.id, b.id, TEST_HOLE_2_ID]);
    const freshA = await svc.get(a.id);
    await svc.update(a.id, freshA.version, { drawingGroupBeforeId: null });
    expect(await order()).toEqual([TEST_HOLE_1_ID, b.id, a.id, TEST_HOLE_2_ID]);
    await expect(svc.update(a.id, freshA.version, { drawingGroupBeforeId: b.id })).rejects.toBeInstanceOf(VersionConflictError);
    for (const id of [a.id, b.id]) await svc.update(id, (await svc.get(id)).version, { drawingGroupAfter: 0 });
    expect(await order()).toEqual([b.id, a.id, TEST_HOLE_1_ID, TEST_HOLE_2_ID]);
    await svc.update(a.id, (await svc.get(a.id)).version, { drawingGroupBeforeId: b.id });
    expect(await order()).toEqual([a.id, b.id, TEST_HOLE_1_ID, TEST_HOLE_2_ID]);
    await svc.update(a.id, (await svc.get(a.id)).version, { drawingGroupAfter: null });
    await expect(svc.update(a.id, (await svc.get(a.id)).version, { drawingGroupBeforeId: b.id })).rejects.toThrow('same layer position');
    await expect(svc.update(b.id, (await svc.get(b.id)).version, { drawingGroupAfter: 99 })).rejects.toThrow('playable hole');
    await svc.update(b.id, (await svc.get(b.id)).version, { drawingGroupAfter: 2 });
    await svc.remove(TEST_HOLE_1_ID, 1);
    expect((await svc.get(b.id)).drawingGroupAfter).toBe(1);
    expect((await svc.get(a.id)).number).toBe(100);
    expect((await features.listByCourse(TEST_COURSE_ID)).find(f => f.id === shape.id)?.no).toBe(shape.no);
});

test('named drawing groups keep shapes and mesh scope stable without becoming playable holes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);
    const features = new CourseFeaturesService(db);
    const group = await svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: ' Clubhouse ' });
    const second = await svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: 'Practice area' });
    expect(group.drawingGroupName).toBe('Clubhouse');
    expect(group.number).toBe(100);
    expect(second.number).toBe(101);
    expect(await svc.listByCourse(TEST_COURSE_ID)).toHaveLength(2);
    expect(await svc.listByCourse(TEST_COURSE_ID, true)).toHaveLength(4);
    const shape = await features.create({ courseId: TEST_COURSE_ID, holeId: group.id, type: 'water', geometry: {
        crs: 'EPSG:3006', curveType: 'bezier', rings: [{ points: [{ x: 600000, y: 6400000 }, { x: 600010, y: 6400000 }, { x: 600010, y: 6400010 }] }],
    } });
    const summary = (await new CoursesService(db).list()).items.find(c => c.id === TEST_COURSE_ID)!;
    expect(summary.holeCount).toBe(2);
    expect(summary.parTotal).toBe(7);
    expect(summary.mappedHoleCount).toBe(1);
    const renamed = await svc.update(group.id, group.version, { drawingGroupName: 'Clubhouse & garden' });
    expect(renamed.number).toBe(group.number);
    expect((await features.listByCourse(TEST_COURSE_ID)).find(f => f.id === shape.id)?.holeId).toBe(group.id);
    await expect(svc.remove(group.id, renamed.version)).rejects.toThrow('Move the shapes');
    await svc.remove(TEST_HOLE_1_ID, 1);
    expect((await svc.get(group.id)).number).toBe(100);
    expect((await svc.listByCourse(TEST_COURSE_ID))[0].number).toBe(1);
    await svc.remove(second.id, second.version);
    expect(await svc.listByCourse(TEST_COURSE_ID, true)).toHaveLength(2);
    await expect(svc.create({ courseId: TEST_COURSE_ID, number: 0, par: 0, drawingGroupName: ' ' })).rejects.toThrow('1–80');
    await expect(svc.update(TEST_HOLE_2_ID, 2, { drawingGroupName: 'Not a group' })).rejects.toThrow('playable hole');
});

test('listByCourse returns empty array with no seed', async () => {
    const { db } = await createTestDb();
    const svc = new HolesService(db);

    const holes = await svc.listByCourse('missing-course');
    expect(holes).toHaveLength(0);
});

test('listByCourse returns holes ordered by number', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(2);
    expect(holes[0].id).toBe(TEST_HOLE_1_ID);
    expect(holes[0].number).toBe(1);
    expect(holes[0].par).toBe(4);
    expect(holes[1].id).toBe(TEST_HOLE_2_ID);
    expect(holes[1].number).toBe(2);
    expect(holes[1].par).toBe(3);
});

test('get returns hole by id', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const hole = await svc.get(TEST_HOLE_1_ID);
    expect(hole.id).toBe(TEST_HOLE_1_ID);
    expect(hole.courseId).toBe(TEST_COURSE_ID);
    expect(hole.number).toBe(1);
    expect(hole.par).toBe(4);
    expect(hole.version).toBe(1);
});

test('get throws NotFoundError for missing hole', async () => {
    const { db } = await createTestDb();
    const svc = new HolesService(db);

    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
});

test('create adds a hole', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const hole = await svc.create({ courseId: TEST_COURSE_ID, number: 3, par: 5 });
    expect(hole.courseId).toBe(TEST_COURSE_ID);
    expect(hole.number).toBe(3);
    expect(hole.par).toBe(5);
    expect(hole.version).toBe(1);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(3);
});

test('create throws UniqueViolationError on duplicate course+number', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await expect(svc.create({ courseId: TEST_COURSE_ID, number: 1, par: 4 })).rejects.toBeInstanceOf(UniqueViolationError);
});

test('update changes par and bumps version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const updated = await svc.update(TEST_HOLE_1_ID, 1, { par: 5, notes: 'tricky dogleg' });
    expect(updated.par).toBe(5);
    expect(updated.notes).toBe('tricky dogleg');
    expect(updated.version).toBe(2);
});

test('stroke_index defaults to null and round-trips through update', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    // Nullable, no seed value → starts null.
    const before = await svc.get(TEST_HOLE_1_ID);
    expect(before.strokeIndex).toBeNull();

    // Set it.
    const set = await svc.update(TEST_HOLE_1_ID, before.version, { strokeIndex: 7 });
    expect(set.strokeIndex).toBe(7);
    expect(set.version).toBe(before.version + 1);

    // Persisted on re-read.
    expect((await svc.get(TEST_HOLE_1_ID)).strokeIndex).toBe(7);

    // Explicit null clears it.
    const cleared = await svc.update(TEST_HOLE_1_ID, set.version, { strokeIndex: null });
    expect(cleared.strokeIndex).toBeNull();

    // Omitting strokeIndex leaves it untouched.
    const withSi = await svc.update(TEST_HOLE_1_ID, cleared.version, { strokeIndex: 12 });
    const parOnly = await svc.update(TEST_HOLE_1_ID, withSi.version, { par: 5 });
    expect(parOnly.par).toBe(5);
    expect(parOnly.strokeIndex).toBe(12);
});

test('update changes savedRegionJson', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    const updated = await svc.update(TEST_HOLE_1_ID, 1, { savedRegionJson: '{"zoom":15}' });
    expect(updated.savedRegionJson).toBe('{"zoom":15}');
});

test('update throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await expect(svc.update(TEST_HOLE_1_ID, 99, { par: 5 })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for missing hole', async () => {
    const { db } = await createTestDb();
    const svc = new HolesService(db);

    await expect(svc.update('nope', 1, { par: 5 })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes hole', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await svc.remove(TEST_HOLE_1_ID, 1);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(1);
    expect(holes[0].id).toBe(TEST_HOLE_2_ID);
    expect(holes[0].number).toBe(1);
});

test('remove renumbers later holes without changing earlier holes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);
    const third = await svc.create({ courseId: TEST_COURSE_ID, number: 3, par: 5 });

    await svc.remove(TEST_HOLE_2_ID, 1);

    const holes = await svc.listByCourse(TEST_COURSE_ID);
    expect(holes.map(h => [h.id, h.number])).toEqual([
        [TEST_HOLE_1_ID, 1],
        [third.id, 2],
    ]);
});

test('remove deletes matching game-plan holes and renumbers later plan holes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);
    await svc.create({ courseId: TEST_COURSE_ID, number: 3, par: 5 });
    await db.insertInto('game_plans').values({
        id: 'plan-1',
        course_id: TEST_COURSE_ID,
        user_id: null,
        wind_speed_mps: null,
        wind_direction_deg: null,
        version: 1,
    }).execute();
    await db.insertInto('game_plan_holes').values([
        { id: 'plan-hole-1', game_plan_id: 'plan-1', hole_number: 1, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
        { id: 'plan-hole-2', game_plan_id: 'plan-1', hole_number: 2, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
        { id: 'plan-hole-3', game_plan_id: 'plan-1', hole_number: 3, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
    ]).execute();

    await svc.remove(TEST_HOLE_2_ID, 1);

    const planHoles = await db
        .selectFrom('game_plan_holes')
        .select(['id', 'hole_number', 'version'])
        .orderBy('hole_number')
        .execute();
    expect(planHoles).toEqual([
        { id: 'plan-hole-1', hole_number: 1, version: 1 },
        { id: 'plan-hole-3', hole_number: 2, version: 2 },
    ]);
});

test('remove last real hole drops imported phantom game-plan holes beyond the course', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);
    await db.insertInto('game_plans').values({
        id: 'plan-1',
        course_id: TEST_COURSE_ID,
        user_id: null,
        wind_speed_mps: null,
        wind_direction_deg: null,
        version: 1,
    }).execute();
    await db.insertInto('game_plan_holes').values([
        { id: 'plan-hole-1', game_plan_id: 'plan-1', hole_number: 1, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
        { id: 'plan-hole-2', game_plan_id: 'plan-1', hole_number: 2, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
        { id: 'plan-hole-3', game_plan_id: 'plan-1', hole_number: 3, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
        { id: 'plan-hole-4', game_plan_id: 'plan-1', hole_number: 4, tee_id: null, preferred_club_id: null, planned_direction_deg: null, wind_speed_mps: null, wind_direction_deg: null, notes: null, version: 1 },
    ]).execute();

    await svc.remove(TEST_HOLE_2_ID, 1);

    const planHoles = await db
        .selectFrom('game_plan_holes')
        .select(['id', 'hole_number'])
        .orderBy('hole_number')
        .execute();
    expect(planHoles).toEqual([
        { id: 'plan-hole-1', hole_number: 1 },
    ]);
});

test('remove throws VersionConflictError with wrong version', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const svc = new HolesService(db);

    await expect(svc.remove(TEST_HOLE_1_ID, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('removing course cascades to remove its holes', async () => {
    const { db } = await createTestDb(seedUsers, seedCourse);
    const holesSvc = new HolesService(db);
    const coursesSvc = new CoursesService(db);

    await coursesSvc.remove(TEST_COURSE_ID, 1);

    const holes = await holesSvc.listByCourse(TEST_COURSE_ID);
    expect(holes).toHaveLength(0);
});
