import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError } from '@basics/core/server/auth';
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

    test('accepts trees, penalty-area, and OOB feature types', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        for (const type of ['trees', 'penalty_red', 'penalty_yellow', 'oob']) {
            const feature = await svc.create({
                courseId: TEST_COURSE_ID,
                holeId: TEST_HOLE_1_ID,
                type,
                geometry: squareGeometry(),
            });
            expect(feature.type).toBe(type);
        }
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
                sort_order: 0,
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
                sort_order: 0,
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

    test('resolved mode clips lower surfaces out from under higher ones', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        // Same hole, overlapping squares: the bunker is created after the
        // fairway so it sits higher in the stack and must win the overlap.
        await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: squareGeometry(0, 0, 10) });
        await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'bunker', geometry: squareGeometry(0, 0, 3) });

        const raw = await svc.geojsonByCourse(TEST_COURSE_ID);
        const resolved = await svc.geojsonByCourse(TEST_COURSE_ID, { resolved: true });
        expect(resolved.features).toHaveLength(raw.features.length);

        const ringArea = (ring: number[][]) => {
            let area = 0;
            for (let i = 0; i < ring.length - 1; i++) {
                area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            }
            return Math.abs(area) / 2;
        };
        const featureArea = (feature: (typeof raw.features)[number]) => {
            const polygons = feature.geometry.type === 'Polygon'
                ? [feature.geometry.coordinates]
                : feature.geometry.coordinates;
            // Outer rings minus holes.
            return polygons.reduce(
                (sum, rings) => sum + rings.reduce(
                    (acc, ring, i) => acc + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0), 0);
        };

        const rawFairway = raw.features.find(f => f.properties.type === 'fairway')!;
        const resolvedFairway = resolved.features.find(f => f.properties.type === 'fairway')!;
        const resolvedBunker = resolved.features.find(f => f.properties.type === 'bunker')!;
        // The bunker keeps its full footprint; the fairway loses the overlap.
        expect(featureArea(resolvedBunker)).toBeGreaterThan(0);
        expect(featureArea(resolvedFairway)).toBeLessThan(featureArea(rawFairway));
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

    test('moving to another hole inserts into that hole stack and shifts higher features', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const moved = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'bunker',
            geometry: squareGeometry(),
        });
        const rough = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_2_ID,
            type: 'rough',
            geometry: squareGeometry(20, 20, 3),
        });
        const path = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_2_ID,
            type: 'path',
            geometry: squareGeometry(40, 40, 3),
        });

        const updated = await svc.update(moved.id, moved.version, { holeId: TEST_HOLE_2_ID });

        expect(updated.holeId).toBe(TEST_HOLE_2_ID);
        expect(updated.sortOrder).toBe(rough.sortOrder + 1);

        const targetStack = await svc.listByHole(TEST_HOLE_2_ID);
        expect(targetStack.map(f => f.id)).toEqual([rough.id, moved.id, path.id]);
        expect(targetStack.find(f => f.id === path.id)?.sortOrder).toBe(path.sortOrder + 1);
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

describe('CourseFeaturesService.create — D26 insertion order', () => {
    // Builds the group's stack bottom -> top: [rough, fairway, bunker, water]
    // (acceptance scenario 4's fixture), returning the type sequence
    // bottom -> top after the new feature is inserted.
    async function stackAfterInserting(newType: string): Promise<string[]> {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        // Course-level group (holeId: null) so the seed's own hole-1 'green'
        // feature doesn't interfere.
        for (const type of ['rough', 'fairway', 'bunker', 'water']) {
            await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type, geometry: squareGeometry() });
        }
        await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: newType, geometry: squareGeometry() });

        // listByCourse spans every group (grouping stays client-side per T22);
        // filter to the course-level (holeId: null) group being tested here.
        const stack = await svc.listByCourse(TEST_COURSE_ID);
        return stack.filter((f) => f.holeId === null).map((f) => f.type);
    }

    test('new fairway lands above the existing fairway, below bunker', async () => {
        const stack = await stackAfterInserting('fairway');
        expect(stack).toEqual(['rough', 'fairway', 'fairway', 'bunker', 'water']);
    });

    test('new green lands above fairway', async () => {
        const stack = await stackAfterInserting('green');
        expect(stack).toEqual(['rough', 'fairway', 'green', 'bunker', 'water']);
    });

    test('new path lands above water (top of stack)', async () => {
        const stack = await stackAfterInserting('path');
        expect(stack).toEqual(['rough', 'fairway', 'bunker', 'water', 'path']);
    });

    test('new outside (lowest rank) lands at the bottom when nothing qualifies', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'fairway', geometry: squareGeometry() });
        await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'outside', geometry: squareGeometry() });

        const stack = await svc.listByCourse(TEST_COURSE_ID);
        expect(stack.filter((f) => f.holeId === null).map((f) => f.type)).toEqual(['outside', 'fairway']);
    });

    test('insertion stays correct after remove() leaves a sort_order gap', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const created: Record<string, { id: string; version: number }> = {};
        for (const type of ['rough', 'fairway', 'bunker', 'water']) {
            created[type] = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type, geometry: squareGeometry() });
        }
        // Gap: [rough(0), bunker(2), water(3)] — remove() does not compact.
        await svc.remove(created['fairway'].id, created['fairway'].version);

        // Top-ranked path must land ABOVE water, not in the gap below it
        // (position derives from sort_order, not the stack array index).
        await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'path', geometry: squareGeometry() });
        const stack = await svc.listByCourse(TEST_COURSE_ID);
        expect(stack.filter((f) => f.holeId === null).map((f) => f.type)).toEqual(['rough', 'bunker', 'water', 'path']);
    });

    test('insertion position is scoped per group — a hole-1 fairway does not shift a course-level stack', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry() });
        const hole1Feature = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'fairway',
            geometry: squareGeometry(),
        });

        // fairway (rank 4) ranks below the seed's existing hole-1 'green' (rank
        // 6), so it inserts at the bottom (index 0) and the green shifts to 1.
        expect(hole1Feature.sortOrder).toBe(0);
        const hole1Stack = await svc.listByHole(TEST_HOLE_1_ID);
        expect(hole1Stack.find((f) => f.type === 'green')?.sortOrder).toBe(1);

        const courseLevel = await svc.listByCourse(TEST_COURSE_ID);
        const water = courseLevel.find((f) => f.type === 'water');
        expect(water?.sortOrder).toBe(0);
    });
});

describe('CourseFeaturesService.reorder', () => {
    test('rewrites sort_order for a scoped group', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const a = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry: squareGeometry() });
        const b = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'fairway', geometry: squareGeometry() });

        await svc.reorder(TEST_COURSE_ID, null, [b.id, a.id]);

        const stack = await svc.listByCourse(TEST_COURSE_ID);
        expect(stack.filter((f) => f.holeId === null).map((f) => f.id)).toEqual([b.id, a.id]);
    });

    test('rejects an orderedIds set that does not match the scope (missing member)', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const a = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry: squareGeometry() });
        await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'fairway', geometry: squareGeometry() });

        await expect(svc.reorder(TEST_COURSE_ID, null, [a.id])).rejects.toBeInstanceOf(ConflictError);
    });

    test('rejects an orderedIds set with an id from a different group', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const a = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry: squareGeometry() });
        const holeFeature = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'fairway',
            geometry: squareGeometry(),
        });

        await expect(svc.reorder(TEST_COURSE_ID, null, [a.id, holeFeature.id])).rejects.toBeInstanceOf(ConflictError);
    });

    test('does not affect other groups', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const hole2Feature = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_2_ID,
            type: 'bunker',
            geometry: squareGeometry(),
        });

        await svc.reorder(TEST_COURSE_ID, TEST_HOLE_1_ID, [`${TEST_COURSE_ID}-feature-green-1`]);

        const hole2 = await svc.listByHole(TEST_HOLE_2_ID);
        expect(hole2[0].id).toBe(hole2Feature.id);
        expect(hole2[0].sortOrder).toBe(0);
    });
});

describe('CourseFeaturesService.geojsonByCourse — D24 stackKey', () => {
    test('course-level features get groupRank 0; hole features get groupRank = hole number', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const courseLevel = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry() });
        const hole1Fairway = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID, // hole number 1
            type: 'fairway',
            geometry: squareGeometry(),
        });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        const byId = new Map(fc.features.map((f) => [f.id, f.properties]));

        expect(byId.get(courseLevel.id)?.stackKey).toBe(0 * 4096 + courseLevel.sortOrder);
        expect(byId.get(hole1Fairway.id)?.stackKey).toBe(1 * 4096 + hole1Fairway.sortOrder);
        // Any hole-1 feature outranks any course-level feature (D24 composition order).
        expect(byId.get(hole1Fairway.id)!.stackKey).toBeGreaterThan(byId.get(courseLevel.id)!.stackKey);
    });
});
