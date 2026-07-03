/**
 * v1 export importer CLI: loads the iOS GolfCourseMap JSON export into the
 * new server's DB schema.
 *
 * Usage:
 *   bun run import [path-to-json] [--force]
 *
 * Defaults to the known v1 export location if no path is given. Connects
 * directly to config.dbPath (same DB main.ts uses) via createDb + runMigrations,
 * mirroring create-user.ts.
 *
 * Idempotency: refuses to run if any courses already exist in the DB, unless
 * --force is passed, in which case it deletes all courses/clubs/game_plans/
 * rounds first (cascades handle the rest) before importing.
 */
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from '@basics/core/server/config';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Kysely } from 'kysely';
import type { Database } from './schema';

const DEFAULT_EXPORT_PATH =
    '/Users/marcust/dev/golf-course-map/GolfCourseMap/golfcoursemap-export-2026-03-24.json';

// --- v1 export JSON shapes ---

interface LatLon {
    latitude: number;
    longitude: number;
}

interface V1Bunker {
    frontLocation: LatLon;
    backLocation?: LatLon;
    elevation?: number;
}

interface V1WaterHazard {
    frontLocation: LatLon;
    backLocation?: LatLon;
    elevation?: number;
}

interface V1Hole {
    id: string;
    number: number;
    teebox: LatLon;
    teeboxElevation?: number;
    green: LatLon;
    frontGreen?: LatLon;
    backGreen?: LatLon;
    greenElevation?: number;
    aimpoints: LatLon[];
    aimpointElevations: (number | null)[];
    bunkers: V1Bunker[];
    redWaterHazards: V1WaterHazard[];
    yellowWaterHazards: V1WaterHazard[];
    savedRegion?: unknown;
}

interface V1Course {
    id: string;
    name: string;
    distance?: number;
    startCoordinates: LatLon;
    holes: V1Hole[];
}

interface V1Club {
    id: string;
    name: string;
    distance: number;
    dispersion: number;
}

interface V1PlanLocation {
    id: string;
    coordinate: LatLon;
    elevation?: number;
}

interface V1GamePlanHole {
    id: string;
    holeNumber: number;
    preferredClub?: V1Club;
    plannedDirection?: number;
    planLocations: V1PlanLocation[];
}

interface V1GamePlan {
    courseId: string;
    courseName: string;
    gamePlan: {
        id: string;
        holes: V1GamePlanHole[];
        windSpeedMph?: number | null;
        windDirection?: number | null;
    };
}

interface V1Export {
    version: unknown;
    exportDate: unknown;
    clubs: V1Club[];
    courses: V1Course[];
    gamePlans: V1GamePlan[];
}

// --- Import result / reporting ---

export interface ImportWarning {
    message: string;
}

export interface ImportCounts {
    courses: number;
    holes: number;
    tees: number;
    greens: number;
    aimPoints: number;
    hazards: number;
    clubs: number;
    gamePlans: number;
    gamePlanHoles: number;
    planShots: number;
}

export interface ImportResult {
    counts: ImportCounts;
    warnings: ImportWarning[];
}

const MPH_TO_MPS = 0.44704;
const nowIso = () => new Date().toISOString();

/** v1 par derivation: aimpoint count 0 -> par 3, 1 -> par 4, 2+ -> par 5. */
function parFromAimpointCount(n: number): number {
    if (n <= 0) return 3;
    if (n === 1) return 4;
    return 5;
}

/**
 * Runs the v1 export import inside a single transaction. Assumes the caller
 * has already checked/handled the "courses already exist" guard (and, if
 * --force, already cleared prior data) — this function always inserts.
 */
export async function importV1Export(
    db: Kysely<Database>,
    data: V1Export,
): Promise<ImportResult> {
    const warnings: ImportWarning[] = [];
    const counts: ImportCounts = {
        courses: 0,
        holes: 0,
        tees: 0,
        greens: 0,
        aimPoints: 0,
        hazards: 0,
        clubs: 0,
        gamePlans: 0,
        gamePlanHoles: 0,
        planShots: 0,
    };

    await db.transaction().execute(async (trx) => {
        const ts = nowIso();

        // --- Clubs ---
        // sort_order by descending carry (longest club first)
        const clubIds = new Set<string>();
        const sortedClubs = [...data.clubs].sort((a, b) => b.distance - a.distance);
        for (let i = 0; i < sortedClubs.length; i++) {
            const club = sortedClubs[i];
            clubIds.add(club.id);
            await trx
                .insertInto('clubs')
                .values({
                    id: club.id,
                    user_id: null,
                    name: club.name,
                    carry_m: club.distance,
                    dispersion_m: club.dispersion,
                    sort_order: i,
                    version: 1,
                    created_at: ts,
                    updated_at: ts,
                })
                .execute();
            counts.clubs++;
        }

        // --- Courses / holes / tees / greens / aim points / hazards ---
        const courseIds = new Set<string>();
        for (const course of data.courses) {
            courseIds.add(course.id);
            await trx
                .insertInto('courses')
                .values({
                    id: course.id,
                    name: course.name,
                    status: 'published',
                    revision: 1,
                    crs: 'EPSG:3006',
                    georeference_json: null,
                    home_lat: course.startCoordinates?.latitude ?? null,
                    home_lon: course.startCoordinates?.longitude ?? null,
                    notes: null,
                    version: 1,
                    created_at: ts,
                    updated_at: ts,
                })
                .execute();
            counts.courses++;

            for (const hole of course.holes) {
                const par = parFromAimpointCount(hole.aimpoints.length);
                await trx
                    .insertInto('holes')
                    .values({
                        id: hole.id,
                        course_id: course.id,
                        number: hole.number,
                        par,
                        notes: null,
                        saved_region_json: hole.savedRegion
                            ? JSON.stringify(hole.savedRegion)
                            : null,
                        version: 1,
                        created_at: ts,
                        updated_at: ts,
                    })
                    .execute();
                counts.holes++;

                if (!hole.green) {
                    warnings.push({
                        message: `Course "${course.name}" hole ${hole.number}: no green data`,
                    });
                }

                // Single default tee from teebox.
                await trx
                    .insertInto('tees')
                    .values({
                        id: `${hole.id}-tee-default`,
                        hole_id: hole.id,
                        name: 'default',
                        color: null,
                        lat: hole.teebox.latitude,
                        lon: hole.teebox.longitude,
                        elevation: hole.teeboxElevation ?? null,
                        sort_order: 0,
                        version: 1,
                        created_at: ts,
                        updated_at: ts,
                    })
                    .execute();
                counts.tees++;

                // Green: hand-placed center point becomes provisional green center.
                if (hole.green) {
                    await trx
                        .insertInto('greens')
                        .values({
                            id: `${hole.id}-green`,
                            hole_id: hole.id,
                            boundary_json: null,
                            center_lat: hole.green.latitude,
                            center_lon: hole.green.longitude,
                            front_lat: hole.frontGreen?.latitude ?? null,
                            front_lon: hole.frontGreen?.longitude ?? null,
                            back_lat: hole.backGreen?.latitude ?? null,
                            back_lon: hole.backGreen?.longitude ?? null,
                            elevation: hole.greenElevation ?? null,
                            version: 1,
                            created_at: ts,
                            updated_at: ts,
                        })
                        .execute();
                    counts.greens++;
                }

                // Aim points: merge aimpoints[i] + aimpointElevations[i]
                // (elevations array may be shorter or contain nulls).
                for (let i = 0; i < hole.aimpoints.length; i++) {
                    const pt = hole.aimpoints[i];
                    const elev = hole.aimpointElevations?.[i] ?? null;
                    await trx
                        .insertInto('aim_points')
                        .values({
                            id: `${hole.id}-aimpoint-${i}`,
                            hole_id: hole.id,
                            sort_order: i,
                            lat: pt.latitude,
                            lon: pt.longitude,
                            elevation: elev,
                            label: null,
                            version: 1,
                            created_at: ts,
                            updated_at: ts,
                        })
                        .execute();
                    counts.aimPoints++;
                }

                // Hazards: bunkers, red/yellow water hazards.
                const hazardRows: Array<{
                    id: string;
                    hole_id: string;
                    kind: string;
                    front_lat: number | null;
                    front_lon: number | null;
                    back_lat: number | null;
                    back_lon: number | null;
                    elevation: number | null;
                    version: number;
                    created_at: string;
                    updated_at: string;
                }> = [];

                (hole.bunkers ?? []).forEach((b, i) => {
                    hazardRows.push({
                        id: `${hole.id}-bunker-${i}`,
                        hole_id: hole.id,
                        kind: 'bunker',
                        front_lat: b.frontLocation?.latitude ?? null,
                        front_lon: b.frontLocation?.longitude ?? null,
                        back_lat: b.backLocation?.latitude ?? null,
                        back_lon: b.backLocation?.longitude ?? null,
                        elevation: b.elevation ?? null,
                        version: 1,
                        created_at: ts,
                        updated_at: ts,
                    });
                });

                (hole.redWaterHazards ?? []).forEach((w, i) => {
                    hazardRows.push({
                        id: `${hole.id}-water-red-${i}`,
                        hole_id: hole.id,
                        kind: 'water_red',
                        front_lat: w.frontLocation?.latitude ?? null,
                        front_lon: w.frontLocation?.longitude ?? null,
                        back_lat: w.backLocation?.latitude ?? null,
                        back_lon: w.backLocation?.longitude ?? null,
                        elevation: w.elevation ?? null,
                        version: 1,
                        created_at: ts,
                        updated_at: ts,
                    });
                });

                (hole.yellowWaterHazards ?? []).forEach((w, i) => {
                    hazardRows.push({
                        id: `${hole.id}-water-yellow-${i}`,
                        hole_id: hole.id,
                        kind: 'water_yellow',
                        front_lat: w.frontLocation?.latitude ?? null,
                        front_lon: w.frontLocation?.longitude ?? null,
                        back_lat: w.backLocation?.latitude ?? null,
                        back_lon: w.backLocation?.longitude ?? null,
                        elevation: w.elevation ?? null,
                        version: 1,
                        created_at: ts,
                        updated_at: ts,
                    });
                });

                if (hazardRows.length > 0) {
                    await trx.insertInto('hazards').values(hazardRows).execute();
                    counts.hazards += hazardRows.length;
                }
            }
        }

        // --- Game plans ---
        for (const plan of data.gamePlans) {
            if (!plan.courseId || !courseIds.has(plan.courseId)) {
                warnings.push({
                    message: `Game plan "${plan.gamePlan?.id}" (course "${plan.courseName}") skipped: courseId "${plan.courseId}" not found among imported courses`,
                });
                continue;
            }

            const windSpeedMps =
                typeof plan.gamePlan.windSpeedMph === 'number'
                    ? plan.gamePlan.windSpeedMph * MPH_TO_MPS
                    : null;
            const windDirectionDeg =
                typeof plan.gamePlan.windDirection === 'number'
                    ? plan.gamePlan.windDirection
                    : null;

            await trx
                .insertInto('game_plans')
                .values({
                    id: plan.gamePlan.id,
                    course_id: plan.courseId,
                    user_id: null,
                    wind_speed_mps: windSpeedMps,
                    wind_direction_deg: windDirectionDeg,
                    version: 1,
                    created_at: ts,
                    updated_at: ts,
                })
                .execute();
            counts.gamePlans++;

            for (const gph of plan.gamePlan.holes) {
                let preferredClubId: string | null = null;
                if (gph.preferredClub) {
                    if (clubIds.has(gph.preferredClub.id)) {
                        preferredClubId = gph.preferredClub.id;
                    } else {
                        warnings.push({
                            message: `Game plan "${plan.gamePlan.id}" hole ${gph.holeNumber}: preferredClub id "${gph.preferredClub.id}" not found among imported clubs`,
                        });
                    }
                }

                await trx
                    .insertInto('game_plan_holes')
                    .values({
                        id: gph.id,
                        game_plan_id: plan.gamePlan.id,
                        hole_number: gph.holeNumber,
                        tee_id: null,
                        preferred_club_id: preferredClubId,
                        planned_direction_deg: gph.plannedDirection ?? null,
                        version: 1,
                        created_at: ts,
                        updated_at: ts,
                    })
                    .execute();
                counts.gamePlanHoles++;

                for (let i = 0; i < (gph.planLocations ?? []).length; i++) {
                    const loc = gph.planLocations[i];
                    await trx
                        .insertInto('plan_shots')
                        .values({
                            id: loc.id,
                            game_plan_hole_id: gph.id,
                            sort_order: i,
                            lat: loc.coordinate.latitude,
                            lon: loc.coordinate.longitude,
                            elevation: loc.elevation ?? null,
                            club_id: null,
                            version: 1,
                            created_at: ts,
                            updated_at: ts,
                        })
                        .execute();
                    counts.planShots++;
                }
            }
        }
    });

    return { counts, warnings };
}

function printSummary(result: ImportResult): void {
    const { counts, warnings } = result;
    console.log('\nImport summary:');
    console.log('  entity          count');
    console.log('  --------------  -----');
    console.log(`  courses         ${counts.courses}`);
    console.log(`  holes           ${counts.holes}`);
    console.log(`  tees            ${counts.tees}`);
    console.log(`  greens          ${counts.greens}`);
    console.log(`  aim_points      ${counts.aimPoints}`);
    console.log(`  hazards         ${counts.hazards}`);
    console.log(`  clubs           ${counts.clubs}`);
    console.log(`  game_plans      ${counts.gamePlans}`);
    console.log(`  game_plan_holes ${counts.gamePlanHoles}`);
    console.log(`  plan_shots      ${counts.planShots}`);

    if (warnings.length > 0) {
        console.log(`\nWarnings (${warnings.length}):`);
        for (const w of warnings) {
            console.log(`  - ${w.message}`);
        }
    } else {
        console.log('\nNo warnings.');
    }
}

async function main() {
    const args = Bun.argv.slice(2);
    const force = args.includes('--force');
    const positional = args.filter((a) => a !== '--force');
    const jsonPath = positional[0] ?? DEFAULT_EXPORT_PATH;

    mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = createDb<Database>(config.dbPath);
    await runMigrations(db, path.join(import.meta.dir, 'migrations'));

    try {
        const existingCourse = await db
            .selectFrom('courses')
            .select('id')
            .limit(1)
            .executeTakeFirst();

        if (existingCourse) {
            if (!force) {
                console.error(
                    'Refusing to import: courses already exist in the database.\n' +
                        'Use a fresh DB (delete the DB file / point DB_PATH elsewhere), or pass --force to wipe ' +
                        'courses/clubs/game_plans/rounds (and their children via cascade) before importing.',
                );
                process.exit(1);
            }

            console.log('--force passed: deleting existing courses, clubs, game_plans, rounds...');
            // game_plans/rounds reference courses; delete them explicitly first
            // in case ordering matters, though FK cascades would handle it too.
            await db.deleteFrom('game_plans').execute();
            await db.deleteFrom('rounds').execute();
            await db.deleteFrom('courses').execute();
            await db.deleteFrom('clubs').execute();
        }

        console.log(`Reading export: ${jsonPath}`);
        const file = Bun.file(jsonPath);
        if (!(await file.exists())) {
            console.error(`File not found: ${jsonPath}`);
            process.exit(1);
        }
        const data = (await file.json()) as V1Export;

        console.log(
            `Parsed: ${data.courses?.length ?? 0} courses, ${data.clubs?.length ?? 0} clubs, ${data.gamePlans?.length ?? 0} game plans`,
        );

        const result = await importV1Export(db, data);
        printSummary(result);
    } finally {
        await db.destroy();
    }
}

if (import.meta.main) {
    await main();
}
