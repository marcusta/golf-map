import type { TestContext } from '../../testing/db';
import type { FeatureGeometry } from '../../services/geo';

export const TEST_COURSE_ID = 'course-1';
export const TEST_HOLE_1_ID = 'hole-1';
export const TEST_HOLE_2_ID = 'hole-2';
export const TEST_GREEN_1_ID = 'green-1';
export const TEST_GREEN_2_ID = 'green-2';

/**
 * Seeds one course with 2 holes. Each hole gets 2 tees, a green, 2 pins,
 * 1 aim point, and a hazard; the course also gets one course_feature.
 * Raw Kysely inserts (no service layer yet) — see note in seeds/users.ts.
 */
export async function seedCourse(ctx: TestContext): Promise<void> {
    const { db } = ctx;

    await db
        .insertInto('courses')
        .values({
            id: TEST_COURSE_ID,
            name: 'Linkan',
            status: 'draft',
            revision: 1,
            crs: 'EPSG:3006',
            georeference_json: null,
            home_lat: 58.4015,
            home_lon: 15.5658,
            notes: null,
            version: 1,
        })
        .execute();

    const holes = [
        { id: TEST_HOLE_1_ID, greenId: TEST_GREEN_1_ID, number: 1, par: 4 },
        { id: TEST_HOLE_2_ID, greenId: TEST_GREEN_2_ID, number: 2, par: 3 },
    ];

    for (const hole of holes) {
        await db
            .insertInto('holes')
            .values({
                id: hole.id,
                course_id: TEST_COURSE_ID,
                number: hole.number,
                par: hole.par,
                notes: null,
                saved_region_json: null,
                version: 1,
            })
            .execute();

        await db
            .insertInto('tees')
            .values([
                {
                    id: `${hole.id}-tee-yellow`,
                    hole_id: hole.id,
                    name: 'yellow',
                    color: 'yellow',
                    lat: 58.4012 + hole.number * 0.001,
                    lon: 15.5698 - hole.number * 0.001,
                    elevation: 78.28,
                    sort_order: 0,
                    version: 1,
                },
                {
                    id: `${hole.id}-tee-blue`,
                    hole_id: hole.id,
                    name: 'blue',
                    color: 'blue',
                    lat: 58.4011 + hole.number * 0.001,
                    lon: 15.5699 - hole.number * 0.001,
                    elevation: 78.5,
                    sort_order: 1,
                    version: 1,
                },
            ])
            .execute();

        await db
            .insertInto('greens')
            .values({
                id: hole.greenId,
                hole_id: hole.id,
                boundary_json: null,
                center_lat: 58.402 + hole.number * 0.001,
                center_lon: 15.5649 - hole.number * 0.001,
                front_lat: 58.4019 + hole.number * 0.001,
                front_lon: 15.565 - hole.number * 0.001,
                back_lat: 58.4021 + hole.number * 0.001,
                back_lon: 15.5647 - hole.number * 0.001,
                elevation: 75.94,
                version: 1,
            })
            .execute();

        await db
            .insertInto('pins')
            .values([
                {
                    id: `${hole.greenId}-pin-front`,
                    green_id: hole.greenId,
                    name: 'Front',
                    lat: 58.4019 + hole.number * 0.001,
                    lon: 15.565 - hole.number * 0.001,
                    difficulty: 'easy',
                    active: 1,
                    version: 1,
                },
                {
                    id: `${hole.greenId}-pin-back`,
                    green_id: hole.greenId,
                    name: 'Back Left',
                    lat: 58.4021 + hole.number * 0.001,
                    lon: 15.5647 - hole.number * 0.001,
                    difficulty: 'hard',
                    active: 0,
                    version: 1,
                },
            ])
            .execute();

        await db
            .insertInto('aim_points')
            .values({
                id: `${hole.id}-aimpoint-1`,
                hole_id: hole.id,
                sort_order: 0,
                lat: 58.4014 + hole.number * 0.001,
                lon: 15.5664 - hole.number * 0.001,
                elevation: 74.31,
                label: null,
                version: 1,
            })
            .execute();

        await db
            .insertInto('hazards')
            .values([
                {
                    id: `${hole.id}-hazard-bunker`,
                    hole_id: hole.id,
                    kind: 'bunker',
                    front_lat: 58.4019 + hole.number * 0.001,
                    front_lon: 15.5652 - hole.number * 0.001,
                    back_lat: null,
                    back_lon: null,
                    elevation: 75.36,
                    version: 1,
                },
                {
                    id: `${hole.id}-hazard-water`,
                    hole_id: hole.id,
                    kind: 'water_yellow',
                    front_lat: 58.4013 + hole.number * 0.001,
                    front_lon: 15.5661 - hole.number * 0.001,
                    back_lat: 58.4012 + hole.number * 0.001,
                    back_lon: 15.566 - hole.number * 0.001,
                    elevation: null,
                    version: 1,
                },
            ])
            .execute();
    }

    const featureGeometry: FeatureGeometry = {
        crs: 'EPSG:3006',
        rings: [
            {
                points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 10 },
                    { x: 0, y: 10 },
                ],
            },
        ],
    };

    await db
        .insertInto('course_features')
        .values({
            id: `${TEST_COURSE_ID}-feature-green-1`,
            course_id: TEST_COURSE_ID,
            hole_id: TEST_HOLE_1_ID,
            type: 'green',
            geometry_json: JSON.stringify(featureGeometry),
            geojson: null,
            sort_order: 0,
            version: 1,
        })
        .execute();
}
