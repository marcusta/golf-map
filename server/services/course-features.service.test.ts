import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { CourseFeaturesService, InvalidFeatureError, ODBL_ATTRIBUTION } from './course-features.service';
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

describe('CourseFeaturesService — feature provenance (T49)', () => {
    test('create stores provenance and rows expose it everywhere', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'water',
            geometry: squareGeometry(),
            source: 'osm',
            sourceRef: 'way/123456',
            license: 'ODbL',
        });
        expect(created.source).toBe('osm');
        expect(created.sourceRef).toBe('way/123456');
        expect(created.license).toBe('ODbL');

        const listed = (await svc.listByCourse(TEST_COURSE_ID)).find((f) => f.id === created.id)!;
        expect(listed.source).toBe('osm');
        expect(listed.sourceRef).toBe('way/123456');
        expect(listed.license).toBe('ODbL');

        const fetched = await svc.findById(created.id);
        expect(fetched.sourceRef).toBe('way/123456');
    });

    test('provenance defaults to null for hand-drawn features', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'bunker',
            geometry: squareGeometry(),
        });
        expect(created.source).toBeNull();
        expect(created.sourceRef).toBeNull();
        expect(created.license).toBeNull();

        // Pre-migration rows (the shared seed's green) read back as null too.
        const seeded = (await svc.listByCourse(TEST_COURSE_ID)).find((f) => f.type === 'green')!;
        expect(seeded.source).toBeNull();
        expect(seeded.license).toBeNull();
    });

    test('geojsonByCourse carries provenance properties and the ODbL attribution', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const osmWater = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: null,
            type: 'water',
            geometry: squareGeometry(100, 100, 20),
            source: 'osm',
            sourceRef: 'relation/42',
            license: 'ODbL',
        });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.attribution).toBe(ODBL_ATTRIBUTION);
        const props = fc.features.find((f) => f.id === osmWater.id)!.properties;
        expect(props.source).toBe('osm');
        expect(props.sourceRef).toBe('relation/42');
        expect(props.license).toBe('ODbL');
        // Hand-drawn features carry explicit nulls.
        const seeded = fc.features.find((f) => f.properties.type === 'green')!;
        expect(seeded.properties.source).toBeNull();
        expect(seeded.properties.license).toBeNull();

        // Resolved (bundle) output carries the attribution too.
        const resolved = await svc.geojsonByCourse(TEST_COURSE_ID, { resolved: true });
        expect(resolved.attribution).toBe(ODBL_ATTRIBUTION);
    });

    test('geojsonByCourse has no attribution member without ODbL features', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        // Non-ODbL provenance (e.g. Lantmäteriet CC BY) does not trigger it.
        await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: null,
            type: 'water',
            geometry: squareGeometry(100, 100, 20),
            source: 'lantmateriet-marktacke',
            license: 'CC BY 4.0',
        });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.attribution).toBeUndefined();
        expect('attribution' in fc).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Attributes (migration 015) and generated-feature replacement
// ---------------------------------------------------------------------------

function ring(cx: number, cy: number, half: number): number[][] {
    return [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
    ];
}

function treeFeature(
    cx: number,
    cy: number,
    source = 'lidar-canopy',
    extraProps: Record<string, unknown> = {},
    holes: number[][][] = [],
) {
    return {
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [ring(cx, cy, 4), ...holes] },
        properties: {
            type: 'trees',
            source,
            source_ref: `blob/${cx}-${cy}`,
            license: 'CC0',
            heightMaxM: 18.2,
            heightP90M: 16.1,
            heightMeanM: 12.4,
            areaM2: 64,
            ...extraProps,
        },
    };
}

function collection(features: unknown[], crs?: unknown) {
    return { type: 'FeatureCollection' as const, features, ...(crs !== undefined ? { crs } : {}) } as any;
}

describe('CourseFeaturesService attributes', () => {
    test('create stores attributes and read/update round-trips them; null clears', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const created = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: null,
            type: 'trees',
            geometry: squareGeometry(),
            attributes: { heightMaxM: 12.5, species: 'pine', evergreen: true },
        });
        expect(created.attributes).toEqual({ heightMaxM: 12.5, species: 'pine', evergreen: true });

        const read = await svc.findById(created.id);
        expect(read.attributes).toEqual({ heightMaxM: 12.5, species: 'pine', evergreen: true });

        const listed = await svc.listByCourse(TEST_COURSE_ID);
        expect(listed.find((f) => f.id === created.id)!.attributes).toEqual(created.attributes);

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.features.find((f) => f.id === created.id)!.properties.attributes).toEqual(created.attributes);

        // Update without `attributes` leaves them untouched.
        const moved = await svc.update(created.id, 1, { geometry: squareGeometry(1, 1) });
        expect(moved.attributes).toEqual(created.attributes);

        const replaced = await svc.update(created.id, 2, { attributes: { heightMaxM: 13 } });
        expect(replaced.attributes).toEqual({ heightMaxM: 13 });

        const cleared = await svc.update(created.id, 3, { attributes: null });
        expect(cleared.attributes).toBeNull();
    });

    test('features created without attributes read back null', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const f = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry: squareGeometry() });
        expect(f.attributes).toBeNull();
        expect((await svc.findById(f.id)).attributes).toBeNull();
    });

    test('rejects nested values, arrays, non-finite numbers and more than 32 keys', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const base = { courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry: squareGeometry() };

        for (const bad of [
            { nested: { a: 1 } },
            { list: [1, 2] },
            { nan: NaN },
            [1, 2],
            Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])),
        ]) {
            await expect(svc.create({ ...base, attributes: bad as any })).rejects.toBeInstanceOf(InvalidFeatureError);
        }
        // Exactly 32 keys is allowed.
        const ok = await svc.create({
            ...base,
            attributes: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i])),
        });
        expect(Object.keys(ok.attributes!)).toHaveLength(32);
    });
});

describe('CourseFeaturesService.replaceGenerated', () => {
    test('replaces only features of the given source and keeps hand-drawn and other-source features', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const hand = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry: squareGeometry(0, 0) });
        const osm = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry(50, 50), source: 'osm', license: 'ODbL',
        });
        const oldLidar = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry: squareGeometry(90, 90), source: 'lidar-canopy',
        });
        const oldLidarOnHole = await svc.create({
            courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'trees', geometry: squareGeometry(70, 70), source: 'lidar-canopy',
        });

        const result = await svc.replaceGenerated(
            TEST_COURSE_ID,
            'lidar-canopy',
            collection([treeFeature(100, 100), treeFeature(120, 100), treeFeature(140, 100)]),
        );
        expect(result).toEqual({ deleted: 2, inserted: 3 });

        const all = await svc.listByCourse(TEST_COURSE_ID);
        const ids = new Set(all.map((f) => f.id));
        expect(ids.has(hand.id)).toBe(true);
        expect(ids.has(osm.id)).toBe(true);
        expect(ids.has(oldLidar.id)).toBe(false);
        expect(ids.has(oldLidarOnHole.id)).toBe(false);

        const lidar = all.filter((f) => f.source === 'lidar-canopy');
        expect(lidar).toHaveLength(3);
        for (const f of lidar) {
            expect(f.holeId).toBeNull();
            expect(f.type).toBe('trees');
            expect(f.license).toBe('CC0');
            expect(f.sourceRef).toMatch(/^blob\//);
            expect(f.attributes).toEqual({ heightMaxM: 18.2, heightP90M: 16.1, heightMeanM: 12.4, areaM2: 64 });
            expect(f.geometry.crs).toBe('EPSG:3006');
            // Straight-edge ring: 4 corners, closing point dropped, no handles.
            expect(f.geometry.rings[0].points).toHaveLength(4);
            expect(f.geometry.rings[0].points.every((p) => p.hIn === undefined && p.hOut === undefined)).toBe(true);
            expect(f.geojson!.type).toBe('Polygon');
        }
        // Input order preserved via sort_order; unique within the course group.
        const orders = all.filter((f) => f.holeId === null).map((f) => f.sortOrder);
        expect(new Set(orders).size).toBe(orders.length);
        expect(lidar.map((f) => f.geometry.rings[0].points[0].x)).toEqual([96, 116, 136]);
    });

    test('inserted trees sit above lower-ranked surfaces and below bunkers in the course stack', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const rough = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry: squareGeometry(0, 0, 500) });
        const bunker = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: squareGeometry(10, 10) });

        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([treeFeature(100, 100), treeFeature(120, 120)]));

        const group = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.holeId === null);
        const order = (id: string) => group.find((f) => f.id === id)!.sortOrder;
        const trees = group.filter((f) => f.type === 'trees').map((f) => f.sortOrder);
        expect(Math.min(...trees)).toBeGreaterThan(order(rough.id));
        expect(Math.max(...trees)).toBeLessThan(order(bunker.id));
    });

    test('a second call with an empty collection removes the previous generation', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([treeFeature(0, 0), treeFeature(10, 0)]));
        expect(await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([]))).toEqual({ deleted: 2, inserted: 0 });
        expect((await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.source === 'lidar-canopy')).toHaveLength(0);
    });

    test('hole rings round-trip as interior rings', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const hole = ring(0, 0, 1);
        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([treeFeature(0, 0, 'lidar-canopy', {}, [hole])]));

        const [f] = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.source === 'lidar-canopy');
        expect(f.geometry.rings).toHaveLength(2);
        expect(f.geometry.rings[1].points).toHaveLength(4);
        expect(f.geometry.rings[1].points.map((p) => [p.x, p.y])).toEqual(hole.slice(0, 4));
        expect(f.geojson!.coordinates).toHaveLength(2);
        expect(f.geojson!.coordinates[1]).toHaveLength(5);
    });

    test('accepts an EPSG:3006 crs member in either GeoJSON form and rejects any other', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const f = [treeFeature(0, 0)];

        expect(
            (await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection(f, { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } }))).inserted,
        ).toBe(1);
        expect(
            (await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection(f, { type: 'name', properties: { name: 'EPSG:3006' } }))).inserted,
        ).toBe(1);
        expect((await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection(f, { type: 'EPSG', properties: { code: 3006 } }))).inserted).toBe(1);

        for (const bad of [
            { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
            { type: 'name', properties: { name: 'EPSG:4326' } },
            { type: 'EPSG', properties: { code: 3857 } },
            'EPSG:3006',
        ]) {
            await expect(svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection(f, bad))).rejects.toBeInstanceOf(InvalidFeatureError);
        }
        // The rejections above wrote nothing: still exactly the last accepted generation.
        expect((await svc.listByCourse(TEST_COURSE_ID)).filter((x) => x.source === 'lidar-canopy')).toHaveLength(1);
    });

    test('rejects a source mismatch, an empty source, and bad features without touching existing rows', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const hand = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry: squareGeometry() });
        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([treeFeature(0, 0)]));

        const cases: Array<[string, unknown]> = [
            ['lidar-canopy', collection([treeFeature(0, 0, 'osm')])], // source mismatch
            ['', collection([treeFeature(0, 0, '')])], // empty source
            ['   ', collection([])],
            ['lidar-canopy', collection([{ ...treeFeature(0, 0), geometry: { type: 'MultiPolygon', coordinates: [] } }])],
            ['lidar-canopy', collection([treeFeature(0, 0, 'lidar-canopy', { type: 'not-a-type' })])],
            ['lidar-canopy', collection([treeFeature(0, 0, 'lidar-canopy', { nested: { a: 1 } })])],
            ['lidar-canopy', collection([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, properties: { type: 'trees', source: 'lidar-canopy' } }])],
            ['lidar-canopy', { type: 'Feature' }],
        ];
        for (const [source, body] of cases) {
            await expect(svc.replaceGenerated(TEST_COURSE_ID, source, body as any)).rejects.toBeInstanceOf(InvalidFeatureError);
        }

        const all = await svc.listByCourse(TEST_COURSE_ID);
        expect(all.some((f) => f.id === hand.id)).toBe(true);
        expect(all.filter((f) => f.source === 'lidar-canopy')).toHaveLength(1);
    });

    test('null-valued properties are dropped from attributes; a feature with only reserved props has null attributes', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.replaceGenerated(
            TEST_COURSE_ID,
            'lidar-canopy',
            collection([
                { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(0, 0, 3)] }, properties: { type: 'trees', source: 'lidar-canopy' } },
                { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(20, 0, 3)] }, properties: { type: 'trees', source: 'lidar-canopy', heightMaxM: 9, note: null } },
            ]),
        );
        const lidar = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.source === 'lidar-canopy');
        expect(lidar.map((f) => f.attributes)).toEqual([null, { heightMaxM: 9 }]);
        expect(lidar[0].sourceRef).toBeNull();
        expect(lidar[0].license).toBeNull();
    });

    test('unknown course -> NotFoundError', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await expect(svc.replaceGenerated('nope', 'lidar-canopy', collection([]))).rejects.toBeInstanceOf(NotFoundError);
    });
});
