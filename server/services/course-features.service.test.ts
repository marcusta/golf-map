import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { CourseFeaturesService, InvalidFeatureError } from './course-features.service';
import type { FeatureGeometry } from './geo';

function squareGeometry(cx = 0, cy = 0, half = 5): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [
            {
                points: [
                    { x: cx - half, y: cy - half },
                    { x: cx + half, y: cy - half },
                    { x: cx + half, y: cy + half },
                    { x: cx - half, y: cy + half },
                ],
            },
        ],
    };
}

describe('CourseFeaturesService.create', () => {
    test('creates a feature and derives geojson', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const feature = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'fairway',
            geometry: squareGeometry(),
        });

        expect(feature.type).toBe('fairway');
        expect(feature.courseId).toBe(TEST_COURSE_ID);
        expect(feature.holeId).toBe(TEST_HOLE_1_ID);
        expect(feature.version).toBe(1);
        expect(feature.geojson).not.toBeNull();
        expect(feature.geojson!.type).toBe('Polygon');
        expect(feature.geojson!.coordinates[0].length).toBeGreaterThan(3);
    });

    test('allows a null holeId (course-wide feature)', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const feature = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: null,
            type: 'outside',
            geometry: squareGeometry(100, 100, 50),
        });
        expect(feature.holeId).toBeNull();
    });

    test('rejects an invalid type', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        await expect(
            svc.create({
                courseId: TEST_COURSE_ID,
                holeId: TEST_HOLE_1_ID,
                type: 'not-a-real-type',
                geometry: squareGeometry(),
            }),
        ).rejects.toBeInstanceOf(InvalidFeatureError);
    });

    test('rejects geometry with fewer than 3 points in a ring', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const badGeometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
        };

        await expect(
            svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'green', geometry: badGeometry }),
        ).rejects.toBeInstanceOf(InvalidFeatureError);
    });

    test('rejects geometry missing crs', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const badGeometry = { rings: [squareGeometry().rings[0]] } as unknown as FeatureGeometry;

        await expect(
            svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'green', geometry: badGeometry }),
        ).rejects.toBeInstanceOf(InvalidFeatureError);
    });

    test('rejects non-finite coordinates', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const badGeometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [{ points: [{ x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }],
        };

        await expect(
            svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'green', geometry: badGeometry }),
        ).rejects.toBeInstanceOf(InvalidFeatureError);
    });
});

describe('CourseFeaturesService.listByCourse / listByHole', () => {
    test('listByCourse includes the seeded feature plus newly created ones, skipping legacy rows', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        // Insert a row with a legacy geometry_json shape
        // ({kind:'polygon', points:[[x,y],...]}) that predates the
        // FeatureGeometry {crs, rings} schema. listByCourse must not throw
        // on it -- it should just be skipped.
        await db
            .insertInto('course_features')
            .values({
                id: `${TEST_COURSE_ID}-legacy-feature`,
                course_id: TEST_COURSE_ID,
                hole_id: TEST_HOLE_1_ID,
                type: 'green',
                geometry_json: JSON.stringify({ kind: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }),
                geojson: null,
                version: 1,
            })
            .execute();

        // The shared seed already inserts one schema-valid 'green' feature on
        // TEST_HOLE_1_ID; the legacy row above must be skipped, not counted.
        const before = await svc.listByCourse(TEST_COURSE_ID);
        expect(before).toHaveLength(1);
        expect(before[0].type).toBe('green');

        await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'fairway',
            geometry: squareGeometry(),
        });
        await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_2_ID,
            type: 'bunker',
            geometry: squareGeometry(20, 20, 3),
        });

        const after = await svc.listByCourse(TEST_COURSE_ID);
        expect(after).toHaveLength(3);
        expect(after.map((f) => f.type).sort()).toEqual(['bunker', 'fairway', 'green']);
    });

    test('listByHole filters to a single hole', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: squareGeometry() });
        await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type: 'bunker', geometry: squareGeometry(20, 20, 3) });

        // The shared seed's 'green' feature is also on TEST_HOLE_1_ID.
        const hole1Features = await svc.listByHole(TEST_HOLE_1_ID);
        expect(hole1Features).toHaveLength(2);
        expect(hole1Features.map((f) => f.type).sort()).toEqual(['fairway', 'green']);
    });
});

describe('CourseFeaturesService.geojsonByCourse', () => {
    test('produces a FeatureCollection with one Feature per course feature', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: squareGeometry() });
        await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type: 'bunker', geometry: squareGeometry(20, 20, 3) });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.type).toBe('FeatureCollection');
        // +1 for the shared seed's own schema-valid 'green' feature.
        expect(fc.features).toHaveLength(3);
        for (const feature of fc.features) {
            expect(feature.type).toBe('Feature');
            expect(feature.geometry.type).toBe('Polygon');
            expect(feature.properties.courseId).toBe(TEST_COURSE_ID);
        }
    });

    test('skips a legacy-shaped row and does not throw', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        await db
            .insertInto('course_features')
            .values({
                id: `${TEST_COURSE_ID}-legacy-feature`,
                course_id: TEST_COURSE_ID,
                hole_id: TEST_HOLE_1_ID,
                type: 'green',
                geometry_json: JSON.stringify({ kind: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }),
                geojson: null,
                version: 1,
            })
            .execute();

        // The shared seed's own schema-valid 'green' feature is included;
        // the legacy row inserted above must be skipped, not counted or thrown on.
        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].properties.type).toBe('green');
    });
});

describe('CourseFeaturesService.update', () => {
    test('updates type and bumps version', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'fairway',
            geometry: squareGeometry(),
        });

        const updated = await svc.update(created.id, created.version, { type: 'rough' });
        expect(updated.type).toBe('rough');
        expect(updated.version).toBe(2);
    });

    test('re-derives geojson when geometry changes', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'green',
            geometry: squareGeometry(0, 0, 5),
        });
        const originalGeojson = created.geojson;

        const updated = await svc.update(created.id, created.version, {
            geometry: squareGeometry(500, 500, 30),
        });

        expect(updated.geojson).not.toEqual(originalGeojson);
        expect(updated.geojson!.type).toBe('Polygon');
    });

    test('throws VersionConflictError on stale version', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'green',
            geometry: squareGeometry(),
        });

        await expect(svc.update(created.id, 99, { type: 'rough' })).rejects.toBeInstanceOf(VersionConflictError);
    });

    test('rejects invalid type on update', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'green',
            geometry: squareGeometry(),
        });

        await expect(svc.update(created.id, created.version, { type: 'lava' })).rejects.toBeInstanceOf(
            InvalidFeatureError,
        );
    });
});

describe('CourseFeaturesService.remove', () => {
    test('removes a feature', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'green',
            geometry: squareGeometry(),
        });

        await svc.remove(created.id, created.version);
        const after = await svc.listByCourse(TEST_COURSE_ID);
        expect(after.find((f) => f.id === created.id)).toBeUndefined();
    });

    test('throws VersionConflictError on stale version', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'green',
            geometry: squareGeometry(),
        });

        await expect(svc.remove(created.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
    });
});
