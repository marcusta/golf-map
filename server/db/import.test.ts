import { test, expect } from 'bun:test';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from './schema';
import { importV1Export } from './import';

const migrationFolder = path.join(import.meta.dir, 'migrations');

async function freshDb() {
    const db = createDb<Database>(':memory:');
    await runMigrations(db, migrationFolder);
    return db;
}

/**
 * Small inline fixture exercising the v1 export shape: 2 courses, plan
 * linkage via courseId, and parallel-array edge cases (missing elevations,
 * empty aimpoints, hazard variants, an unresolvable club ref, an unlinked
 * plan with an unknown courseId).
 */
function makeFixture() {
    return {
        version: 1,
        exportDate: '2026-03-24',
        clubs: [
            { id: 'club-driver', name: 'Driver', distance: 243, dispersion: 65 },
            { id: 'club-7i', name: '7i', distance: 155, dispersion: 32 },
            { id: 'club-pw', name: 'PW', distance: 115, dispersion: 27 },
        ],
        courses: [
            {
                id: 'course-1',
                name: 'Course One',
                distance: 100,
                startCoordinates: { latitude: 58.4, longitude: 15.5 },
                holes: [
                    {
                        id: 'course-1-hole-1',
                        number: 1,
                        teebox: { latitude: 58.401, longitude: 15.501 },
                        teeboxElevation: 78.2,
                        green: { latitude: 58.402, longitude: 15.502 },
                        frontGreen: { latitude: 58.4019, longitude: 15.5019 },
                        backGreen: { latitude: 58.4021, longitude: 15.5021 },
                        greenElevation: 75.9,
                        // par 5: 2 aimpoints
                        aimpoints: [
                            { latitude: 58.4013, longitude: 15.5013 },
                            { latitude: 58.4016, longitude: 15.5016 },
                        ],
                        // shorter than aimpoints + contains a null -> handle gracefully
                        aimpointElevations: [74.3],
                        bunkers: [
                            {
                                frontLocation: { latitude: 58.4018, longitude: 15.5018 },
                                elevation: 75.3,
                            },
                            {
                                // no elevation field at all
                                frontLocation: { latitude: 58.4017, longitude: 15.5017 },
                            },
                        ],
                        redWaterHazards: [
                            {
                                frontLocation: { latitude: 58.4031, longitude: 15.5031 },
                                backLocation: { latitude: 58.4032, longitude: 15.5032 },
                            },
                        ],
                        yellowWaterHazards: [],
                        savedRegion: {
                            center: { latitude: 58.4015, longitude: 15.5015 },
                            span: { latitudeDelta: 0.003, longitudeDelta: 0.009 },
                        },
                    },
                    {
                        id: 'course-1-hole-2',
                        number: 2,
                        teebox: { latitude: 58.411, longitude: 15.511 },
                        // no teeboxElevation
                        green: { latitude: 58.412, longitude: 15.512 },
                        // no front/back green, no greenElevation
                        // empty aimpoints -> par 3
                        aimpoints: [],
                        aimpointElevations: [],
                        bunkers: [],
                        redWaterHazards: [],
                        yellowWaterHazards: [],
                    },
                ],
            },
            {
                id: 'course-2',
                name: 'Course Two',
                distance: 50,
                startCoordinates: { latitude: 59.0, longitude: 16.0 },
                holes: [
                    {
                        id: 'course-2-hole-1',
                        number: 1,
                        teebox: { latitude: 59.001, longitude: 16.001 },
                        teeboxElevation: 10,
                        green: { latitude: 59.002, longitude: 16.002 },
                        greenElevation: 12,
                        // 1 aimpoint -> par 4
                        aimpoints: [{ latitude: 59.0015, longitude: 16.0015 }],
                        aimpointElevations: [null],
                        bunkers: [],
                        redWaterHazards: [],
                        yellowWaterHazards: [
                            {
                                frontLocation: { latitude: 59.0018, longitude: 16.0018 },
                            },
                        ],
                    },
                ],
            },
        ],
        gamePlans: [
            {
                courseId: 'course-1',
                courseName: 'Course One',
                gamePlan: {
                    id: 'plan-1',
                    windSpeedMph: 10,
                    windDirection: 180,
                    holes: [
                        {
                            id: 'plan-1-hole-1',
                            holeNumber: 1,
                            preferredClub: { id: 'club-driver', name: 'Driver', distance: 243, dispersion: 65 },
                            plannedDirection: 5,
                            planLocations: [
                                {
                                    id: 'plan-1-hole-1-loc-1',
                                    coordinate: { latitude: 58.4013, longitude: 15.5013 },
                                    elevation: 74,
                                },
                                {
                                    id: 'plan-1-hole-1-loc-2',
                                    coordinate: { latitude: 58.4016, longitude: 15.5016 },
                                    // no elevation
                                },
                            ],
                        },
                        {
                            id: 'plan-1-hole-2',
                            holeNumber: 2,
                            // no preferredClub at all
                            plannedDirection: 0,
                            planLocations: [],
                        },
                    ],
                },
            },
            {
                // references a club id that doesn't exist in imported clubs
                courseId: 'course-2',
                courseName: 'Course Two',
                gamePlan: {
                    id: 'plan-2',
                    windSpeedMph: null,
                    windDirection: null,
                    holes: [
                        {
                            id: 'plan-2-hole-1',
                            holeNumber: 1,
                            preferredClub: {
                                id: 'club-unknown',
                                name: 'Mystery Wedge',
                                distance: 90,
                                dispersion: 20,
                            },
                            plannedDirection: -3,
                            planLocations: [],
                        },
                    ],
                },
            },
            {
                // unresolvable course linkage -> plan should be skipped
                courseId: 'course-does-not-exist',
                courseName: 'Ghost Course',
                gamePlan: {
                    id: 'plan-orphan',
                    holes: [],
                },
            },
        ],
    };
}

test('importV1Export inserts expected counts', async () => {
    const db = await freshDb();
    const fixture = makeFixture();

    const result = await importV1Export(db, fixture as any);

    expect(result.counts.courses).toBe(2);
    expect(result.counts.holes).toBe(3);
    expect(result.counts.tees).toBe(3); // one default tee per hole
    expect(result.counts.greens).toBe(3);
    expect(result.counts.aimPoints).toBe(3); // 2 + 0 + 1
    expect(result.counts.hazards).toBe(4); // 2 bunkers + 1 red water + 1 yellow water
    expect(result.counts.clubs).toBe(3);
    expect(result.counts.gamePlans).toBe(2); // orphan plan skipped
    expect(result.counts.gamePlanHoles).toBe(3); // plan-1: 2 holes, plan-2: 1 hole
    expect(result.counts.planShots).toBe(2);

    const importedShots = await db
        .selectFrom('plan_shots')
        .selectAll()
        .where('game_plan_hole_id', '=', 'plan-1-hole-1')
        .orderBy('id')
        .execute();
    expect(importedShots).toEqual([
        expect.objectContaining({
            id: 'plan-1-hole-1-loc-1',
            parent_shot_id: null,
            sort_order: 0,
        }),
        expect.objectContaining({
            id: 'plan-1-hole-1-loc-2',
            parent_shot_id: 'plan-1-hole-1-loc-1',
            sort_order: 0,
        }),
    ]);

    await db.destroy();
});

test('importV1Export reports the unlinked plan and missing club ref as warnings', async () => {
    const db = await freshDb();
    const fixture = makeFixture();

    const result = await importV1Export(db, fixture as any);

    const messages = result.warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('course-does-not-exist'))).toBe(true);
    expect(messages.some((m) => m.includes('club-unknown'))).toBe(true);

    await db.destroy();
});

test('par is derived from aimpoint count (v1 rule: 0->3, 1->4, 2+->5)', async () => {
    const db = await freshDb();
    const fixture = makeFixture();
    await importV1Export(db, fixture as any);

    const holes = await db
        .selectFrom('holes')
        .selectAll()
        .orderBy('id')
        .execute();

    const hole1 = holes.find((h) => h.id === 'course-1-hole-1')!;
    const hole2 = holes.find((h) => h.id === 'course-1-hole-2')!;
    const hole3 = holes.find((h) => h.id === 'course-2-hole-1')!;

    expect(hole1.par).toBe(5); // 2 aimpoints
    expect(hole2.par).toBe(3); // 0 aimpoints
    expect(hole3.par).toBe(4); // 1 aimpoint

    const expectedSavedRegion = (fixture.courses[0].holes[0] as { savedRegion?: unknown })
        .savedRegion;
    expect(hole1.saved_region_json).toBeTruthy();
    expect(JSON.parse(hole1.saved_region_json!)).toEqual(expectedSavedRegion);
    expect(hole2.saved_region_json).toBeNull();

    await db.destroy();
});

test('aim points merge coordinates with the parallel elevations array, tolerating short/null arrays', async () => {
    const db = await freshDb();
    const fixture = makeFixture();
    await importV1Export(db, fixture as any);

    const aimPoints = await db
        .selectFrom('aim_points')
        .selectAll()
        .where('hole_id', '=', 'course-1-hole-1')
        .orderBy('sort_order')
        .execute();

    expect(aimPoints).toHaveLength(2);
    expect(aimPoints[0].elevation).toBe(74.3);
    expect(aimPoints[1].elevation).toBeNull(); // elevations array was shorter

    const hole3AimPoints = await db
        .selectFrom('aim_points')
        .selectAll()
        .where('hole_id', '=', 'course-2-hole-1')
        .execute();
    expect(hole3AimPoints).toHaveLength(1);
    expect(hole3AimPoints[0].elevation).toBeNull(); // explicit null in source array

    await db.destroy();
});

test('wind speed converts mph to m/s; missing wind fields stay null', async () => {
    const db = await freshDb();
    const fixture = makeFixture();
    await importV1Export(db, fixture as any);

    const plan1 = await db
        .selectFrom('game_plans')
        .selectAll()
        .where('id', '=', 'plan-1')
        .executeTakeFirstOrThrow();
    expect(plan1.wind_speed_mps).toBeCloseTo(10 * 0.44704, 5);
    expect(plan1.wind_direction_deg).toBe(180);

    const plan2 = await db
        .selectFrom('game_plans')
        .selectAll()
        .where('id', '=', 'plan-2')
        .executeTakeFirstOrThrow();
    expect(plan2.wind_speed_mps).toBeNull();
    expect(plan2.wind_direction_deg).toBeNull();

    await db.destroy();
});

test('game_plan_holes: preferred_club_id resolves when known, null when unresolvable or absent', async () => {
    const db = await freshDb();
    const fixture = makeFixture();
    await importV1Export(db, fixture as any);

    const gph1 = await db
        .selectFrom('game_plan_holes')
        .selectAll()
        .where('id', '=', 'plan-1-hole-1')
        .executeTakeFirstOrThrow();
    expect(gph1.preferred_club_id).toBe('club-driver');

    const gph2 = await db
        .selectFrom('game_plan_holes')
        .selectAll()
        .where('id', '=', 'plan-1-hole-2')
        .executeTakeFirstOrThrow();
    expect(gph2.preferred_club_id).toBeNull(); // no preferredClub in source

    const gph3 = await db
        .selectFrom('game_plan_holes')
        .selectAll()
        .where('id', '=', 'plan-2-hole-1')
        .executeTakeFirstOrThrow();
    expect(gph3.preferred_club_id).toBeNull(); // unresolvable club-unknown

    await db.destroy();
});

test('hazards: bunker/water_red/water_yellow kinds map correctly with front/back/elevation', async () => {
    const db = await freshDb();
    const fixture = makeFixture();
    await importV1Export(db, fixture as any);

    const hazards = await db
        .selectFrom('hazards')
        .selectAll()
        .where('hole_id', '=', 'course-1-hole-1')
        .execute();

    const bunkers = hazards.filter((h) => h.kind === 'bunker');
    expect(bunkers).toHaveLength(2);
    expect(bunkers.some((b) => b.elevation === 75.3)).toBe(true);
    expect(bunkers.some((b) => b.elevation === null)).toBe(true); // missing elevation field

    const redWater = hazards.filter((h) => h.kind === 'water_red');
    expect(redWater).toHaveLength(1);
    expect(redWater[0].back_lat).toBeCloseTo(58.4032, 5);

    const hole3Hazards = await db
        .selectFrom('hazards')
        .selectAll()
        .where('hole_id', '=', 'course-2-hole-1')
        .execute();
    const yellowWater = hole3Hazards.filter((h) => h.kind === 'water_yellow');
    expect(yellowWater).toHaveLength(1);
    expect(yellowWater[0].back_lat).toBeNull(); // no backLocation in source

    await db.destroy();
});

test('clubs sorted by descending carry distance', async () => {
    const db = await freshDb();
    const fixture = makeFixture();
    await importV1Export(db, fixture as any);

    const clubs = await db.selectFrom('clubs').selectAll().orderBy('sort_order').execute();
    expect(clubs.map((c) => c.id)).toEqual(['club-driver', 'club-7i', 'club-pw']);
    expect(clubs[0].carry_m).toBe(243);
    expect(clubs[0].dispersion_m).toBe(65);

    await db.destroy();
});
