import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { CourseFeaturesService, InvalidFeatureError, ODBL_ATTRIBUTION } from './course-features.service';
import type { FeatureGeometry } from './geo';
import { pathTransitionDefaults } from '../../shared/features/path-transitions';

test('path transitions persist and validate against merged geometry and surface on updates', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new CourseFeaturesService(db);
    const geometry = { ...squareGeometry(), centerline: { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], widthM: 4 } };
    const transition = { ...pathTransitionDefaults('wheel-tracks'), id: 'tracks' };
    const road = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', pathTransitions: [transition] } });
    expect((await svc.findById(road.id)).attributes?.pathTransitions).toEqual([transition]);
    const tongue = { ...transition, centerGrassReachM: 10 };
    const tongued = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', pathTransitions: [tongue] } });
    expect((await svc.findById(tongued.id)).attributes?.pathTransitions).toEqual([tongue]);
    await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', pathTransitions: [transition, { ...transition, id: 'overlap' }] } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', unrelated: [] } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'fairway', geometry: squareGeometry(), attributes: { pathTransitions: [transition] } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.update(road.id, road.version, { geometry: { ...geometry, crs: 'EPSG:4326' } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.update(road.id, road.version, { attributes: { surface: 'asphalt', pathTransitions: [transition] } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.update(road.id, road.version, { geometry: { ...geometry, centerline: { ...geometry.centerline, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] } } })).rejects.toBeInstanceOf(InvalidFeatureError);
    for (const bad of [{ ...transition, variation: NaN }, { ...transition, direction: 0 }, { ...transition, placement: 'section', startM: 39 }]) {
        await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', pathTransitions: [bad as typeof transition] } })).rejects.toBeInstanceOf(InvalidFeatureError);
    }
    const cleared = await svc.update(road.id, road.version, { attributes: { surface: 'gravel' } });
    expect(cleared.attributes?.pathTransitions).toBeUndefined();
    await db.destroy();
});

test('render = ram only on a centerline path, on create and on the merged update', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new CourseFeaturesService(db);
    const geometry = { ...squareGeometry(), centerline: { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], widthM: 4 } };
    const road = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', render: 'ram' } });
    expect((await svc.findById(road.id)).attributes?.render).toBe('ram');
    await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry, attributes: { surface: 'gravel', render: 'spline' } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: squareGeometry(), attributes: { surface: 'gravel', render: 'ram' } })).rejects.toBeInstanceOf(InvalidFeatureError);
    await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'fairway', geometry: squareGeometry(), attributes: { render: 'ram' } })).rejects.toBeInstanceOf(InvalidFeatureError);
    expect((await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: squareGeometry(), attributes: { render: 'opcd' } })).attributes?.render).toBe('opcd');
    await expect(svc.update(road.id, road.version, { type: 'fairway' })).rejects.toBeInstanceOf(InvalidFeatureError);
    const back = await svc.update(road.id, road.version, { attributes: { surface: 'gravel' } });
    expect(back.attributes?.render).toBeUndefined();
    await db.destroy();
});

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
        expect('geojson' in feature).toBe(false);

        // The derived polygon is stored and served by the geojson route only.
        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        const served = fc.features.find((f) => f.id === feature.id)!;
        expect(served.geometry.type).toBe('Polygon');
        expect((served.geometry.coordinates as number[][][])[0].length).toBeGreaterThan(3);
        const stored = await db.selectFrom('course_features').select('geojson').where('id', '=', feature.id).executeTakeFirstOrThrow();
        expect(stored.geojson).not.toBeNull();
        expect(JSON.parse(stored.geojson!)).toEqual(served.geometry);
    });

    test('list, findById and update responses carry no geojson key', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const created = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'green', geometry: squareGeometry() });

        const list = await svc.listByCourse(TEST_COURSE_ID);
        expect(list.length).toBeGreaterThan(0);
        for (const f of list) expect(Object.keys(f)).not.toContain('geojson');
        for (const f of await svc.listByHole(TEST_HOLE_1_ID)) expect(Object.keys(f)).not.toContain('geojson');
        expect(Object.keys(await svc.findById(created.id))).not.toContain('geojson');
        const updated = await svc.update(created.id, created.version, { type: 'fairway' });
        expect(Object.keys(updated)).not.toContain('geojson');
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

    test('accepts a vegetation_zone (with its zone attributes)', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const feature = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID,
            type: 'vegetation_zone',
            geometry: squareGeometry(),
            attributes: { zoneType: 'shrub', weight: 1, feather: 2, noise: 0 },
        });
        expect(feature.type).toBe('vegetation_zone');
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
        const servedGeometry = async () =>
            (await svc.geojsonByCourse(TEST_COURSE_ID)).features.find((f) => f.id === created.id)!.geometry;
        const originalGeojson = await servedGeometry();

        await svc.update(created.id, created.version, {
            geometry: squareGeometry(500, 500, 30),
        });

        const updatedGeojson = await servedGeometry();
        expect(updatedGeojson).not.toEqual(originalGeojson);
        expect(updatedGeojson.type).toBe('Polygon');
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

describe('CourseFeaturesService batch endpoints (createMany / updateMany / removeMany)', () => {
    test('explicit insertions override type defaults and batch replies carry final stack slots', async () => {
        const { db } = await createTestDb(seedCourse);
        try {
            const svc = new CourseFeaturesService(db);
            const green = await svc.create({ courseId: TEST_COURSE_ID, type: 'green', geometry: squareGeometry() });
            const rough = await svc.create({ courseId: TEST_COURSE_ID, type: 'rough', geometry: squareGeometry(50) });
            await svc.reorder(TEST_COURSE_ID, null, [green.id, rough.id]);
            const rings = await svc.createMany(TEST_COURSE_ID, [
                { type: 'fairway', sortOrder: 0, geometry: squareGeometry(0, 0, 6) },
                { type: 'semi_rough', sortOrder: 0, geometry: squareGeometry(0, 0, 7) },
            ]);
            expect(rings.map(f => f.sortOrder)).toEqual([1, 0]);
            const stack = (await svc.listByCourse(TEST_COURSE_ID)).filter(f => f.holeId === null);
            expect(stack.map(f => f.type)).toEqual(['semi_rough', 'fairway', 'green', 'rough']);
            expect(stack.map(f => f.sortOrder)).toEqual([0, 1, 2, 3]);
            for (const sortOrder of [-1, 0.5, NaN]) {
                await expect(svc.create({ courseId: TEST_COURSE_ID, type: 'rough', sortOrder, geometry: squareGeometry() }))
                    .rejects.toBeInstanceOf(InvalidFeatureError);
            }
        } finally {
            await db.destroy();
        }
    });

    async function threeGreens(svc: CourseFeaturesService) {
        return svc.createMany(TEST_COURSE_ID, [
            { holeId: TEST_HOLE_1_ID, type: 'green', geometry: squareGeometry(0, 0) },
            { holeId: TEST_HOLE_1_ID, type: 'bunker', geometry: squareGeometry(20, 0) },
            { holeId: TEST_HOLE_1_ID, type: 'green', geometry: squareGeometry(40, 0) },
        ]);
    }

    test('createMany inserts in input order with the same stack positions as sequential creates', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const before = await svc.listByHole(TEST_HOLE_1_ID);

        const created = await threeGreens(svc);
        expect(created.map((f) => f.type)).toEqual(['green', 'bunker', 'green']);
        expect(created.every((f) => f.version === 1 && f.courseId === TEST_COURSE_ID)).toBe(true);

        // Same result as three create() calls on a fresh DB.
        const { db: db2 } = await createTestDb(seedCourse);
        const svc2 = new CourseFeaturesService(db2);
        for (const item of [
            { type: 'green', geometry: squareGeometry(0, 0) },
            { type: 'bunker', geometry: squareGeometry(20, 0) },
            { type: 'green', geometry: squareGeometry(40, 0) },
        ]) {
            await svc2.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, ...item });
        }
        const types = (list: { type: string }[]) => list.map((f) => f.type);
        expect(types(await svc.listByHole(TEST_HOLE_1_ID))).toEqual(types(await svc2.listByHole(TEST_HOLE_1_ID)));
        expect((await svc.listByHole(TEST_HOLE_1_ID)).length).toBe(before.length + 3);
    });

    test('createMany with one invalid item writes nothing', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const before = (await svc.listByCourse(TEST_COURSE_ID)).length;

        await expect(
            svc.createMany(TEST_COURSE_ID, [
                { holeId: TEST_HOLE_1_ID, type: 'green', geometry: squareGeometry() },
                { holeId: TEST_HOLE_1_ID, type: 'lava', geometry: squareGeometry() },
            ]),
        ).rejects.toBeInstanceOf(InvalidFeatureError);
        expect((await svc.listByCourse(TEST_COURSE_ID)).length).toBe(before);
    });

    test('updateMany updates every row and bumps each version once', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const [a, b, c] = await threeGreens(svc);

        const updated = await svc.updateMany([
            { id: a.id, version: a.version, geometry: squareGeometry(100, 100) },
            { id: b.id, version: b.version, type: 'rough' },
            { id: c.id, version: c.version, holeId: TEST_HOLE_2_ID },
        ]);
        expect(updated.map((f) => f.id)).toEqual([a.id, b.id, c.id]);
        expect(updated.map((f) => f.version)).toEqual([2, 2, 2]);
        expect(updated[0].geometry).toEqual(squareGeometry(100, 100));
        expect(updated[1].type).toBe('rough');
        expect(updated[2].holeId).toBe(TEST_HOLE_2_ID);
        expect((await svc.findById(c.id)).holeId).toBe(TEST_HOLE_2_ID);
    });

    test('updateMany with one stale version throws VersionConflictError and rolls back every row', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const [a, b] = await threeGreens(svc);

        await expect(
            svc.updateMany([
                { id: a.id, version: a.version, type: 'rough' },
                { id: b.id, version: 99, type: 'rough' },
            ]),
        ).rejects.toBeInstanceOf(VersionConflictError);
        const rowA = await svc.findById(a.id);
        expect(rowA.type).toBe('green');
        expect(rowA.version).toBe(1);
    });

    test('updateMany with a missing row conflicts', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await expect(svc.updateMany([{ id: 'nope', version: 1, type: 'rough' }])).rejects.toBeInstanceOf(
            VersionConflictError,
        );
    });

    test('removeMany deletes every row', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const created = await threeGreens(svc);

        await svc.removeMany(created.map((f) => ({ id: f.id, version: f.version })));
        const ids = new Set((await svc.listByCourse(TEST_COURSE_ID)).map((f) => f.id));
        expect(created.some((f) => ids.has(f.id))).toBe(false);
    });

    test('removeMany with one stale version deletes nothing', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const [a, b, c] = await threeGreens(svc);

        await expect(
            svc.removeMany([
                { id: a.id, version: a.version },
                { id: b.id, version: 7 },
                { id: c.id, version: c.version },
            ]),
        ).rejects.toBeInstanceOf(VersionConflictError);
        const ids = new Set((await svc.listByCourse(TEST_COURSE_ID)).map((f) => f.id));
        expect([a, b, c].every((f) => ids.has(f.id))).toBe(true);
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

    test('stored kerb fillets are no part of orderedIds and ride along with the row below them', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const line = (pts: number[][]) => ({ crs: 'EPSG:3006' as const, rings: [], centerline: { points: pts.map(([x, y]) => ({ x: 500000 + x, y: 6500000 + y })), widthM: 4 } });
        const road = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[-50, 0], [50, 0]]) });
        const branch = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[0, 0], [0, 40]]) });
        const fairway = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'fairway', geometry: squareGeometry() });
        const courseLevel = async () => (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.holeId === null && f.layer == null);
        const before = await courseLevel();
        const filletIds = before.filter((f) => f.source === 'road-junctions').map((f) => f.id);
        expect(filletIds.length).toBeGreaterThan(0);
        const drawn = before.filter((f) => f.source !== 'road-junctions').map((f) => f.id);

        const next = [fairway.id, ...drawn.filter((id) => id !== fairway.id)].reverse();
        await svc.reorder(TEST_COURSE_ID, null, next);

        const after = await courseLevel();
        expect(after.filter((f) => f.source !== 'road-junctions').map((f) => f.id)).toEqual(next);
        expect(after.map((f) => f.sortOrder)).toEqual(after.map((_, i) => i));
        expect(after.filter((f) => f.source === 'road-junctions').map((f) => f.id).sort()).toEqual([...filletIds].sort());
        expect([road.id, branch.id].every((id) => next.includes(id))).toBe(true);
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

describe('CourseFeaturesService.geojsonByCourse — D28 stackKey', () => {
    test('Roughs group under every hole, holes by number, course-level on top', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const courseLevel = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry() });
        const roughsRough = await svc.create({ courseId: TEST_COURSE_ID, layer: 'roughs', type: 'rough', geometry: squareGeometry() });
        const hole1Fairway = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: TEST_HOLE_1_ID, // hole number 1
            type: 'fairway',
            geometry: squareGeometry(),
        });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        const byId = new Map(fc.features.map((f) => [f.id, f.properties]));

        expect(byId.get(roughsRough.id)?.layer).toBe('roughs');
        expect(byId.get(roughsRough.id)?.stackKey).toBe(0 * 4096 + roughsRough.sortOrder);
        expect(byId.get(hole1Fairway.id)?.stackKey).toBe(1 * 4096 + hole1Fairway.sortOrder);
        expect(byId.get(courseLevel.id)?.stackKey).toBe(1023 * 4096 + courseLevel.sortOrder);
        // Roughs < any hole < course-level (D28 composition order).
        expect(byId.get(hole1Fairway.id)!.stackKey).toBeGreaterThan(byId.get(roughsRough.id)!.stackKey);
        expect(byId.get(courseLevel.id)!.stackKey).toBeGreaterThan(byId.get(hole1Fairway.id)!.stackKey);
    });

    test('roads paint on top of everything, on a hole or course-level', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const holeRoad = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'path', geometry: squareGeometry() });
        const courseRoad = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'path', geometry: squareGeometry() });
        // Created after the roads, so higher in their own groups' sort order.
        const courseWater = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry() });
        const holeBunker = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'bunker', geometry: squareGeometry() });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        const key = new Map(fc.features.map((f) => [f.id, f.properties.stackKey]));
        const order = new Map(fc.features.map((f) => [f.id, f.properties.sortOrder]));

        expect(key.get(courseRoad.id)).toBe(1024 * 4096 + order.get(courseRoad.id)!);
        expect(key.get(holeRoad.id)).toBe(1024 * 4096 + order.get(holeRoad.id)!);
        for (const road of [holeRoad, courseRoad]) {
            expect(key.get(road.id)!).toBeGreaterThan(key.get(courseWater.id)!);
            expect(key.get(road.id)!).toBeGreaterThan(key.get(holeBunker.id)!);
        }
    });
});

describe('CourseFeaturesService — Roughs layer (D28)', () => {
    test('is its own stack group, separate from course-level', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const courseRough = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rough', geometry: squareGeometry() });
        const a = await svc.create({ courseId: TEST_COURSE_ID, layer: 'roughs', type: 'rough', geometry: squareGeometry() });
        const b = await svc.create({ courseId: TEST_COURSE_ID, layer: 'roughs', type: 'deep_rough', geometry: squareGeometry() });

        // deep_rough ranks under rough (D26), inside the Roughs group only.
        const rows = new Map((await svc.listByCourse(TEST_COURSE_ID)).map((f) => [f.id, f]));
        expect(rows.get(b.id)?.sortOrder).toBe(0);
        expect(rows.get(a.id)?.sortOrder).toBe(1);
        expect(rows.get(courseRough.id)?.sortOrder).toBe(courseRough.sortOrder);

        await svc.reorder(TEST_COURSE_ID, null, [a.id, b.id], 'roughs');
        expect((await svc.findById(a.id)).sortOrder).toBe(0);
        // The course-level scope does not see Roughs members.
        await expect(svc.reorder(TEST_COURSE_ID, null, [a.id, b.id])).rejects.toBeInstanceOf(ConflictError);
    });

    test('rejects non-rough types and hole-assigned features', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await expect(
            svc.create({ courseId: TEST_COURSE_ID, layer: 'roughs', type: 'fairway', geometry: squareGeometry() }),
        ).rejects.toBeInstanceOf(InvalidFeatureError);
        await expect(
            svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, layer: 'roughs', type: 'rough', geometry: squareGeometry() }),
        ).rejects.toBeInstanceOf(InvalidFeatureError);

        const fairway = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: squareGeometry() });
        await expect(svc.update(fairway.id, fairway.version, { layer: 'roughs' })).rejects.toBeInstanceOf(InvalidFeatureError);
    });

    test('moving in drops the hole; a hole or a non-rough type moves it back out', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const rough = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'rough', geometry: squareGeometry() });

        const moved = await svc.update(rough.id, rough.version, { layer: 'roughs' });
        expect(moved.layer).toBe('roughs');
        expect(moved.holeId).toBeNull();
        expect(moved.sortOrder).toBe(0);

        const onHole = await svc.update(moved.id, moved.version, { holeId: TEST_HOLE_2_ID });
        expect(onHole.layer).toBeNull();
        expect(onHole.holeId).toBe(TEST_HOLE_2_ID);

        const back = await svc.update(onHole.id, onHole.version, { layer: 'roughs' });
        const retyped = await svc.update(back.id, back.version, { type: 'fairway' });
        expect(retyped.layer).toBeNull();
        expect(retyped.holeId).toBeNull();
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
    test('only bulk-replace output is generated; wizard imports with the same source survive', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        // The GeoJSON import wizard creates ordinary editable features that
        // merely record where they came from (T49).
        const importedWater = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry(10, 10),
            source: 'osm', sourceRef: 'way/1', license: 'ODbL',
        });
        expect(importedWater.generated).toBe(false);
        expect((await svc.findById(importedWater.id)).generated).toBe(false);

        // A generator claiming the same source id replaces only its own rows.
        await svc.replaceGenerated(TEST_COURSE_ID, 'osm', collection([treeFeature(200, 200, 'osm')]));
        const all = await svc.listByCourse(TEST_COURSE_ID);
        expect(all.find((f) => f.id === importedWater.id)?.generated).toBe(false);
        expect(all.filter((f) => f.generated)).toHaveLength(1);
    });

    test('replaces only features of the given source and keeps hand-drawn and other-source features', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const hand = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'trees', geometry: squareGeometry(0, 0) });
        const osm = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry(50, 50), source: 'osm', license: 'ODbL',
        });
        // The previous generation comes from the route itself — create()
        // never marks a feature generated, however it is stamped.
        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([treeFeature(90, 90), treeFeature(70, 70)]));
        const previous = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.generated);
        expect(previous).toHaveLength(2);
        // A generated row sitting on a hole (legacy data — the route inserts
        // at course level) is replaced too: the delete is not hole-scoped.
        await db.updateTable('course_features').set({ hole_id: TEST_HOLE_1_ID }).where('id', '=', previous[1].id).execute();

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
        for (const f of previous) expect(ids.has(f.id)).toBe(false);

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
        }
        const served = (await svc.geojsonByCourse(TEST_COURSE_ID)).features.filter((f) => f.properties.source === 'lidar-canopy');
        expect(served).toHaveLength(3);
        for (const f of served) expect(f.geometry.type).toBe('Polygon');
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

    test('making room for the batch moves sort_order only — never the updated_at of the features above it', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const bunker = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: squareGeometry(10, 10) });
        await db.updateTable('course_features').set({ updated_at: '2000-01-01 00:00:00' })
            .where('course_id', '=', TEST_COURSE_ID).execute();

        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', collection([treeFeature(100, 100), treeFeature(120, 120)]));

        // The bunker was pushed up by the two inserted rows, but it was not EDITED: a generator run
        // that bumped its `updated_at` marked every GSPro target stale and invalidated the export
        // fingerprints that hash the feature high-water mark (feature-history.service.ts).
        const row = await db.selectFrom('course_features').select(['sort_order', 'updated_at'])
            .where('id', '=', bunker.id).executeTakeFirstOrThrow();
        expect(row.sort_order).toBe(bunker.sortOrder + 2);
        expect(row.updated_at).toBe('2000-01-01 00:00:00');
        // The move is still on the record, as the migration-025 `restack` the counting skips.
        const history = await db.selectFrom('course_feature_history').select('op')
            .where('feature_id', '=', bunker.id).execute();
        expect(history.map(h => h.op)).toEqual(['restack']);
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
        const served = (await svc.geojsonByCourse(TEST_COURSE_ID)).features.find((g) => g.id === f.id)!;
        expect(served.geometry.type).toBe('Polygon');
        const coords = served.geometry.coordinates as number[][][];
        expect(coords).toHaveLength(2);
        expect(coords[1]).toHaveLength(5);
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

    // D-VZ7: the lidar low-vegetation detector PUTs shrub proposals here with
    // the zone attributes as ordinary GeoJSON properties.
    test('vegetation_zone proposals carry their zone attributes through', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const result = await svc.replaceGenerated(
            TEST_COURSE_ID,
            'lidar-lowveg',
            collection([
                {
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring(0, 0, 5)] },
                    properties: {
                        type: 'vegetation_zone', source: 'lidar-lowveg',
                        zoneType: 'shrub', weight: 0.8, feather: 3, noise: 0.5, areaM2: 100,
                    },
                },
                {
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring(40, 0, 5)] },
                    properties: { type: 'vegetation_zone', source: 'lidar-lowveg', zoneType: 'shrub' },
                },
            ]),
        );
        expect(result.inserted).toBe(2);

        const zones = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.type === 'vegetation_zone');
        expect(zones).toHaveLength(2);
        expect(zones[0].generated).toBe(true);
        expect(zones[0].attributes).toEqual({ zoneType: 'shrub', weight: 0.8, feather: 3, noise: 0.5, areaM2: 100 });
        // Only zoneType is required; the rest fall back to the defaults.
        expect(zones[1].attributes).toEqual({ zoneType: 'shrub' });

        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.features.find((f) => f.id === zones[0].id)!.properties.attributes!.zoneType).toBe('shrub');
    });

    test('a vegetation_zone proposal without a zoneType is rejected whole', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const bad = [
            { type: 'vegetation_zone', source: 'lidar-lowveg' },
            { type: 'vegetation_zone', source: 'lidar-lowveg', zoneType: '' },
            { type: 'vegetation_zone', source: 'lidar-lowveg', zoneType: 'shrub', weight: 1.4 },
            { type: 'vegetation_zone', source: 'lidar-lowveg', zoneType: 'shrub', feather: -1 },
        ];
        for (const properties of bad) {
            await expect(svc.replaceGenerated(TEST_COURSE_ID, 'lidar-lowveg', collection([
                { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(0, 0, 5)] }, properties },
            ]))).rejects.toBeInstanceOf(InvalidFeatureError);
        }
        expect((await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.type === 'vegetation_zone')).toHaveLength(0);
    });
});

describe('CourseFeaturesService — vegetation_zone', () => {
    const zoneAttributes = { zoneType: 'shrub', weight: 1, feather: 2, noise: 0 };

    test('create stores the four zone attributes and update round-trips them', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const zone = await svc.create({
            courseId: TEST_COURSE_ID,
            holeId: null,
            type: 'vegetation_zone',
            geometry: squareGeometry(),
            attributes: zoneAttributes,
        });
        expect(zone.type).toBe('vegetation_zone');
        expect(zone.attributes).toEqual(zoneAttributes);

        const updated = await svc.update(zone.id, 1, {
            attributes: { zoneType: 'fern', weight: 0.5, feather: 4.5, noise: 1.25 },
        });
        expect(updated.attributes).toEqual({ zoneType: 'fern', weight: 0.5, feather: 4.5, noise: 1.25 });
        expect((await svc.findById(zone.id)).attributes).toEqual(updated.attributes);
    });

    test('the numeric keys are optional (absent = the defaults), zoneType is not', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const zone = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
            geometry: squareGeometry(), attributes: { zoneType: 'meadow' },
        });
        expect(zone.attributes).toEqual({ zoneType: 'meadow' });

        for (const attributes of [undefined, null, {}, { zoneType: '  ' }, { zoneType: 7 }]) {
            await expect(svc.create({
                courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
                geometry: squareGeometry(), attributes: attributes as never,
            })).rejects.toBeInstanceOf(InvalidFeatureError);
        }
    });

    test('zoneVariant is an optional string: kept through create, update and GeoJSON; non-strings rejected', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const zone = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
            geometry: squareGeometry(), attributes: { ...zoneAttributes, zoneVariant: 'dry_straw' },
        });
        expect(zone.attributes).toEqual({ ...zoneAttributes, zoneVariant: 'dry_straw' });

        // '' is Default; so is an absent key.
        const cleared = await svc.update(zone.id, 1, { attributes: { ...zoneAttributes, zoneVariant: '' } });
        expect(cleared.attributes!.zoneVariant).toBe('');
        const reset = await svc.update(zone.id, 2, { attributes: zoneAttributes });
        expect(reset.attributes).toEqual(zoneAttributes);

        // Not checked against the zone-type table (like zoneType).
        const unknown = await svc.update(zone.id, 3, { attributes: { ...zoneAttributes, zoneVariant: 'no_such_variant' } });
        expect(unknown.attributes!.zoneVariant).toBe('no_such_variant');
        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.features.find((f) => f.id === zone.id)!.properties.attributes!.zoneVariant).toBe('no_such_variant');

        for (const zoneVariant of [7, true]) {
            await expect(svc.create({
                courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
                geometry: squareGeometry(), attributes: { ...zoneAttributes, zoneVariant } as never,
            })).rejects.toBeInstanceOf(InvalidFeatureError);
            await expect(svc.update(zone.id, 4, { attributes: { ...zoneAttributes, zoneVariant } as never }))
                .rejects.toBeInstanceOf(InvalidFeatureError);
        }
        expect((await svc.findById(zone.id)).version).toBe(4);
    });

    test('blend and extraPalettes are optional: kept through create, update and GeoJSON; malformed ones rejected', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const layered = { ...zoneAttributes, blend: 'mix', extraPalettes: 'shrub/rocks=0.4, fern' };

        const zone = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone', geometry: squareGeometry(), attributes: layered,
        });
        expect(zone.attributes).toEqual(layered);
        const fc = await svc.geojsonByCourse(TEST_COURSE_ID);
        expect(fc.features.find((f) => f.id === zone.id)!.properties.attributes).toEqual(layered);
        const replaced = await svc.update(zone.id, 1, { attributes: { ...zoneAttributes, blend: 'replace', extraPalettes: '' } });
        expect(replaced.attributes).toEqual({ ...zoneAttributes, blend: 'replace', extraPalettes: '' });

        const bad: Record<string, unknown>[] = [
            { blend: 'multiply' },
            { blend: 1 },
            { extraPalettes: 3 },
            { extraPalettes: 'Shrub' },
            { extraPalettes: 'shrub/rocks=1.5' },
            { extraPalettes: 'fern, shrub rocks' },
        ];
        for (const patch of bad) {
            await expect(svc.create({
                courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
                geometry: squareGeometry(), attributes: { ...zoneAttributes, ...patch } as never,
            })).rejects.toBeInstanceOf(InvalidFeatureError);
            await expect(svc.update(zone.id, 2, { attributes: { ...zoneAttributes, ...patch } as never }))
                .rejects.toBeInstanceOf(InvalidFeatureError);
        }
        expect((await svc.findById(zone.id)).version).toBe(2);
    });

    test('heightMin and heightMax are a range in metres, both or neither', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const tall = { ...zoneAttributes, heightMin: 2, heightMax: 3 };

        const zone = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone', geometry: squareGeometry(), attributes: tall,
        });
        expect(zone.attributes).toEqual(tall);
        const fixed = await svc.update(zone.id, 1, { attributes: { ...zoneAttributes, heightMin: 2.5, heightMax: 2.5 } });
        expect(fixed.attributes).toEqual({ ...zoneAttributes, heightMin: 2.5, heightMax: 2.5 });
        const cleared = await svc.update(zone.id, 2, { attributes: zoneAttributes });
        expect(cleared.attributes).toEqual(zoneAttributes);

        const bad: Record<string, unknown>[] = [
            { heightMin: 2 },
            { heightMax: 3 },
            { heightMin: 3, heightMax: 2 },
            { heightMin: 0, heightMax: 2 },
            { heightMin: 2, heightMax: 12.5 },
            { heightMin: '2', heightMax: 3 },
        ];
        for (const patch of bad) {
            await expect(svc.create({
                courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
                geometry: squareGeometry(), attributes: { ...zoneAttributes, ...patch } as never,
            })).rejects.toBeInstanceOf(InvalidFeatureError);
            await expect(svc.update(zone.id, 3, { attributes: { ...zoneAttributes, ...patch } as never }))
                .rejects.toBeInstanceOf(InvalidFeatureError);
        }
        expect((await svc.findById(zone.id)).version).toBe(3);
    });

    test('rejects out-of-range weight / feather / noise on create and update', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const zone = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
            geometry: squareGeometry(), attributes: zoneAttributes,
        });

        for (const bad of [
            { zoneType: 'shrub', weight: -0.1 },
            { zoneType: 'shrub', weight: 1.0001 },
            { zoneType: 'shrub', feather: -0.5 },
            { zoneType: 'shrub', noise: -1 },
            { zoneType: 'shrub', weight: 'lots' },
        ]) {
            await expect(svc.create({
                courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
                geometry: squareGeometry(), attributes: bad as never,
            })).rejects.toBeInstanceOf(InvalidFeatureError);
            await expect(svc.update(zone.id, 1, { attributes: bad as never }))
                .rejects.toBeInstanceOf(InvalidFeatureError);
        }
        // The rejected updates never bumped the version.
        expect((await svc.findById(zone.id)).version).toBe(1);
    });

    test('is an overlay in the stack: it lands above green and below trees', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const at = async (type: string, attributes?: Record<string, unknown>) => svc.create({
            courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type,
            geometry: squareGeometry(), attributes: attributes as never,
        });

        await at('trees');
        await at('green');
        await at('vegetation_zone', zoneAttributes);

        const stack = (await svc.listByHole(TEST_HOLE_2_ID)).map((f) => f.type);
        expect(stack).toEqual(['green', 'vegetation_zone', 'trees']);
    });
});

describe('CourseFeaturesService — clearing imports', () => {
    async function seeded() {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const make = (type: string, x: number, source?: string) => svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type, geometry: squareGeometry(x, x),
            ...(source ? { source, license: source === 'osm' ? 'ODbL' : 'CC0-1.0' } : {}),
        });
        await make('path', 10, 'osm');
        await make('path', 20, 'osm');
        await make('path', 30, 'nvdb');
        await make('fairway', 40, 'osm');
        await make('water', 50, 'lantmateriet-hydrografi');
        const handDrawn = await make('path', 60);
        // Generated rows share a source namespace but are never imports.
        await svc.replaceGenerated(TEST_COURSE_ID, 'osm', collection([treeFeature(200, 200, 'osm')]));
        return { db, svc, handDrawn };
    }

    test('imported features are counted per source and type; hand-drawn and generated ones are not imports', async () => {
        const { svc } = await seeded();
        expect(await svc.importedByCourse(TEST_COURSE_ID)).toEqual([
            { source: 'lantmateriet-hydrografi', type: 'water', count: 1 },
            { source: 'nvdb', type: 'path', count: 1 },
            { source: 'osm', type: 'fairway', count: 1 },
            { source: 'osm', type: 'path', count: 2 },
        ]);
        await expect(svc.importedByCourse('no-such-course')).rejects.toThrow(NotFoundError);
    });

    test('removing the roads (osm + nvdb paths) keeps OSM fairways, hand-drawn paths and generated rows', async () => {
        const { svc, handDrawn } = await seeded();
        expect(await svc.removeImported(TEST_COURSE_ID, ['osm', 'nvdb'], ['path'])).toEqual({ removed: 3 });
        const left = await svc.listByCourse(TEST_COURSE_ID);
        expect(left.some((f) => f.id === handDrawn.id)).toBe(true);
        expect(left.filter((f) => f.source === 'osm').map((f) => [f.type, f.generated])).toEqual(
            expect.arrayContaining([['fairway', false], ['trees', true]]),
        );
        expect(left.filter((f) => f.type === 'path' && f.source !== null)).toHaveLength(0);

        // Without types, everything the source imported goes.
        expect(await svc.removeImported(TEST_COURSE_ID, ['lantmateriet-hydrografi'])).toEqual({ removed: 1 });
        expect(await svc.importedByCourse(TEST_COURSE_ID)).toEqual([{ source: 'osm', type: 'fairway', count: 1 }]);
        expect(await svc.removeImported(TEST_COURSE_ID, ['nvdb'])).toEqual({ removed: 0 });
    });

    test('an empty source list and an unknown course are refused before anything is deleted', async () => {
        const { svc } = await seeded();
        await expect(svc.removeImported(TEST_COURSE_ID, [])).rejects.toThrow(InvalidFeatureError);
        await expect(svc.removeImported('no-such-course', ['osm'])).rejects.toThrow(NotFoundError);
        expect((await svc.importedByCourse(TEST_COURSE_ID)).reduce((n, g) => n + g.count, 0)).toBe(5);
    });
});

describe('CourseFeaturesService — path surface', () => {
    test('a path may carry a known surface; anything else is refused on create and update', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const road = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'path', geometry: squareGeometry(), attributes: { surface: 'gravel' },
        });
        expect(road.attributes).toEqual({ surface: 'gravel' });
        // Unknown (absent) is fine, and other keys ride along untouched.
        const plain = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'path', geometry: squareGeometry(20, 20) });
        const updated = await svc.update(plain.id, plain.version, { attributes: { surface: 'asphalt', note: 'clubhouse' } });
        expect(updated.attributes).toEqual({ surface: 'asphalt', note: 'clubhouse' });

        await expect(svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'path', geometry: squareGeometry(), attributes: { surface: 'lava' },
        })).rejects.toThrow(InvalidFeatureError);
        await expect(svc.update(road.id, road.version, { attributes: { surface: 3 } })).rejects.toThrow(/attributes.surface must be one of/);
        // Other types don't know the key: a bunker's `surface` is just a free attribute.
        const bunker = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: squareGeometry(40, 40), attributes: { surface: 'lava' },
        });
        expect(bunker.attributes).toEqual({ surface: 'lava' });
    });
});

describe('CourseFeaturesService — creek bank vegetation', () => {
    test('a creek may name a bank palette, cover and cap; bad values are refused on create and update', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const creek = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'water_creek', geometry: squareGeometry(),
            attributes: { bankVeg: 'reed', bankVegCover: 0.4, digPreset: 'meadow_brook' },
        });
        expect(creek.attributes).toEqual({ bankVeg: 'reed', bankVegCover: 0.4, digPreset: 'meadow_brook' });
        // '' = not planted, like an absent key.
        const off = await svc.update(creek.id, creek.version, { attributes: { bankVeg: '', bankVegMaxM: 4 } });
        expect(off.attributes).toEqual({ bankVeg: '', bankVegMaxM: 4 });

        for (const attributes of [{ bankVeg: 'Reed grass' }, { bankVeg: 3 }, { bankVegCover: 1.5 }, { bankVegCover: '0.5' }, { bankVegMaxM: 0 }]) {
            await expect(svc.create({
                courseId: TEST_COURSE_ID, holeId: null, type: 'water_creek', geometry: squareGeometry(), attributes: attributes as never,
            })).rejects.toThrow(InvalidFeatureError);
            await expect(svc.update(creek.id, off.version, { attributes: attributes as never })).rejects.toThrow(/attributes.bankVeg/);
        }
        // Other types don't know the keys.
        const bunker = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: squareGeometry(40, 40), attributes: { bankVeg: 'Reed grass' },
        });
        expect(bunker.attributes).toEqual({ bankVeg: 'Reed grass' });
    });

    test('a water polygon (a dug pond or channel) takes the same keys, validated the same way', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const pond = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry(40, 40),
            attributes: { digPreset: 'parkland_shelf', bankVeg: 'reed' },
        });
        expect(pond.attributes).toEqual({ digPreset: 'parkland_shelf', bankVeg: 'reed' });
        await expect(svc.update(pond.id, pond.version, { attributes: { bankVeg: 'Reed grass' } })).rejects.toThrow(/attributes.bankVeg/);
        // The water plants' reach up the bank: 0..10 m.
        const edge = await svc.update(pond.id, pond.version, { attributes: { bankVeg: 'vass', bankVegWetM: 0.3 } });
        expect(edge.attributes).toEqual({ bankVeg: 'vass', bankVegWetM: 0.3 });
        await expect(svc.update(pond.id, edge.version, { attributes: { bankVegWetM: -1 } })).rejects.toThrow(/attributes.bankVegWetM/);
        await expect(svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: squareGeometry(80, 80), attributes: { bankVegCover: 2 },
        })).rejects.toThrow(InvalidFeatureError);
    });
});

describe('CourseFeaturesService — centerline paths', () => {
    const X = 538_000, Y = 6_398_000;
    const line = (dx = 0) => ({
        crs: 'EPSG:3006',
        // Whatever the client sends as rings is replaced by the corridor.
        rings: squareGeometry(0, 0, 1).rings,
        centerline: { points: [{ x: X + dx, y: Y }, { x: X + dx + 40, y: Y }, { x: X + dx + 40, y: Y + 30, corner: false }], widthM: 4 },
    });
    const xs = (f: { geometry: FeatureGeometry }) => f.geometry.rings[0].points.map(p => p.x);

    test('create derives the corridor rings from the centerline and keeps the line', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const f = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line() });
        expect(f.geometry.centerline).toEqual({ points: [{ x: X, y: Y }, { x: X + 40, y: Y }, { x: X + 40, y: Y + 30 }], widthM: 4 });
        expect(f.geometry.curveType).toBe('bezier');
        // The corridor spans the line plus the 2 m round caps.
        expect(Math.min(...xs(f))).toBeCloseTo(X - 2, 1);
        expect(Math.max(...xs(f))).toBeGreaterThan(X + 41);
        const row = await db.selectFrom('course_features').select('geojson').where('id', '=', f.id).executeTakeFirstOrThrow();
        expect(JSON.parse(row.geojson!).type).toBe('Polygon');
        const stored = (await svc.listByCourse(TEST_COURSE_ID)).find(s => s.id === f.id)!;
        expect(stored.geometry).toEqual(f.geometry);
    });

    test('update re-derives the rings: moving the line moves the road', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const f = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line() });
        const moved = await svc.update(f.id, f.version, { geometry: { ...f.geometry, centerline: line(100).centerline } });
        expect(Math.min(...xs(moved))).toBeCloseTo(X + 98, 1);
        const wider = await svc.update(moved.id, moved.version, { geometry: { ...moved.geometry, centerline: { ...moved.geometry.centerline!, widthM: 8 } } });
        expect(Math.min(...xs(wider))).toBeCloseTo(X + 96, 1);
    });

    test('rejects an unusable centerline', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const bad = (centerline: unknown) => svc.create({
            courseId: TEST_COURSE_ID, type: 'path', geometry: { crs: 'EPSG:3006', rings: [], centerline } as FeatureGeometry,
        });
        await expect(bad({ points: [{ x: X, y: Y }], widthM: 3 })).rejects.toThrow(InvalidFeatureError);
        await expect(bad({ points: [{ x: X, y: Y }, { x: X + 5, y: Y }], widthM: 0 })).rejects.toThrow(InvalidFeatureError);
        await expect(bad({ points: [{ x: X, y: Y }, { x: Number.NaN, y: Y }], widthM: 3 })).rejects.toThrow(InvalidFeatureError);
        await expect(bad({ points: [{ x: X, y: Y }, { x: X + 5, y: Y }], widthM: 3, endCap: { shape: 'rounded', rounding: 2 } })).rejects.toThrow(InvalidFeatureError);
    });

    test('the end shapes are kept on the line and shape the rings', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const centerline = { points: [{ x: X, y: Y }, { x: X + 40, y: Y }], widthM: 4, startCap: { shape: 'rounded' as const, rounding: 0 }, endCap: { shape: 'turning' as const } };
        const f = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: { crs: 'EPSG:3006', rings: [], centerline } });
        expect(f.geometry.centerline).toEqual(centerline);
        expect(Math.min(...xs(f))).toBeCloseTo(X, 3); // straight cut at the first point
        expect(Math.max(...xs(f))).toBeCloseTo(X + 45, 2); // a 10 m turning circle about the last
        const round = await svc.update(f.id, f.version, { geometry: { ...f.geometry, centerline: { points: centerline.points, widthM: 4 } } });
        expect(round.geometry.centerline!.endCap).toBeUndefined();
        expect(Math.max(...xs(round))).toBeCloseTo(X + 42, 2);
    });
});

describe('CourseFeaturesService — road junction fillets', () => {
    const X = 538_000, Y = 6_398_000;
    const line = (pts: Array<[number, number]>, widthM = 4): FeatureGeometry => ({
        crs: 'EPSG:3006', rings: [], centerline: { points: pts.map(([x, y]) => ({ x: X + x, y: Y + y })), widthM },
    });
    const fillets = async (svc: CourseFeaturesService) =>
        (await svc.listByCourse(TEST_COURSE_ID)).filter(f => f.source === 'road-junctions');

    test('a tee grows its kerb fillets, moving the branch off drops them, deleting a road too', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const main = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[-50, 0], [50, 0]]), attributes: { surface: 'asphalt' } });
        expect(await fillets(svc)).toHaveLength(0);
        const branch = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[0, 0], [0, 40]]), attributes: { surface: 'asphalt' } });
        const made = await fillets(svc);
        expect(made).toHaveLength(2);
        expect(made.every(f => f.generated && f.type === 'path')).toBe(true);
        expect(made[0].attributes).toEqual({ surface: 'asphalt' });
        expect(made[0].sourceRef!.split(',').sort()).toEqual([branch.id, main.id].sort());

        const away = await svc.update(branch.id, branch.version, { geometry: line([[0, 20], [0, 60]]) });
        expect(await fillets(svc)).toHaveLength(0);
        const back = await svc.update(away.id, away.version, { geometry: line([[0, 0], [0, 40]]) });
        expect(await fillets(svc)).toHaveLength(2);
        await svc.remove(main.id, main.version);
        expect(await fillets(svc)).toHaveLength(0);
        expect(back.id).toBe(branch.id);
    });

    test('roads created concurrently (the import wizard) all get their fillets', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await Promise.all([
            svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[-100, 0], [100, 0]]) }),
            ...[-80, -40, 0, 40, 80].map(x => svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[x, 0], [x, 40]]) })),
        ]);
        expect(await fillets(svc)).toHaveLength(10);
    });

    test('turning a road\'s kerb rounding off drops its fillets; junk values are rejected', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[-50, 0], [50, 0]]) });
        const branch = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[0, 0], [0, 40]]) });
        expect(await fillets(svc)).toHaveLength(2);
        const off = await svc.update(branch.id, branch.version, { attributes: { surface: 'gravel', kerbFillets: false } });
        expect(await fillets(svc)).toHaveLength(0);
        await svc.update(off.id, off.version, { attributes: { surface: 'gravel' } });
        expect(await fillets(svc)).toHaveLength(2);
        await expect(svc.create({
            courseId: TEST_COURSE_ID, type: 'path', geometry: line([[0, 60], [0, 90]]), attributes: { kerbFillets: 'no' },
        })).rejects.toThrow(InvalidFeatureError);
    });

    test('polygon paths and other types never make fillets', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: line([[-50, 0], [50, 0]]) });
        await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: squareGeometry(X, Y + 10, 5) });
        await svc.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: line([[0, 0], [0, 40]]) });
        expect(await fillets(svc)).toHaveLength(0);
    });
});

// Tree species areas (shared/features/tree-areas.ts): the Unity tree planter uses
// an area's species mix for the survey stems inside it.
describe('CourseFeaturesService — tree_area', () => {
    const areaAttributes = { species: 'oak=9, birch=1', name: 'Oak grove' };

    test('create stores the mix and update round-trips it with ignoreKind', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const area = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'tree_area',
            geometry: squareGeometry(), attributes: areaAttributes,
        });
        expect(area.type).toBe('tree_area');
        expect(area.attributes).toEqual(areaAttributes);

        const updated = await svc.update(area.id, 1, { attributes: { species: 'oak', ignoreKind: true } });
        expect(updated.attributes).toEqual({ species: 'oak', ignoreKind: true });
        expect((await svc.findById(area.id)).attributes).toEqual(updated.attributes);
    });

    test('an area without a usable mix is refused, on create and on update', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const create = (attributes: Record<string, unknown> | undefined) => svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'tree_area', geometry: squareGeometry(), attributes: attributes as never,
        });

        await expect(create(undefined)).rejects.toThrow('needs attributes.species');
        await expect(create({ species: 'oak=0, birch=0' })).rejects.toThrow('above 0');
        await expect(create({ species: 'oak oak' })).rejects.toThrow('<species>[=<weight>]');
        await expect(create({ species: 'oak', ignoreKind: 'yes' })).rejects.toBeInstanceOf(InvalidFeatureError);

        const area = await create(areaAttributes);
        await expect(svc.update(area.id, 1, { attributes: { species: 'oak, oak' } })).rejects.toThrow('named twice');
        // Geometry-only edits leave the attributes alone.
        const moved = await svc.update(area.id, 1, { geometry: squareGeometry(20, 20) });
        expect(moved.attributes).toEqual(areaAttributes);
    });

    test('generated areas carry their mix through the generated route, and a bad one names the feature', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const areaFeature = (properties: Record<string, unknown>) => ({
            type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(0, 0, 5)] },
            properties: { type: 'tree_area', source: 'survey-species', ...properties },
        });

        await svc.replaceGenerated(TEST_COURSE_ID, 'survey-species', collection([areaFeature({ species: 'pine=3, birch' })]));
        const stored = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.type === 'tree_area');
        expect(stored.map((f) => f.attributes)).toEqual([{ species: 'pine=3, birch' }]);

        await expect(svc.replaceGenerated(TEST_COURSE_ID, 'survey-species', collection([areaFeature({ species: '' })])))
            .rejects.toThrow('above 0');
    });

    test('is an overlay in the stack: it lands above vegetation zones and below trees', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const at = async (type: string, attributes?: Record<string, unknown>) => svc.create({
            courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type,
            geometry: squareGeometry(), attributes: attributes as never,
        });

        await at('trees');
        await at('vegetation_zone', { zoneType: 'shrub' });
        await at('tree_area', areaAttributes);

        const stack = (await svc.listByHole(TEST_HOLE_2_ID)).map((f) => f.type);
        expect(stack).toEqual(['vegetation_zone', 'tree_area', 'trees']);
    });
});

// Rock slabs (shared/features/rock-slab.ts): a drawn surface that shaping-global
// turns into a Blender cut-out; marginM and uvM are optional.
describe('CourseFeaturesService — rock_slab', () => {
    test('is a drawable type with no required attributes; margin and tile size round-trip', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);

        const plain = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'rock_slab', geometry: squareGeometry() });
        expect(plain.type).toBe('rock_slab');
        expect(plain.attributes).toBeNull();

        const set = await svc.update(plain.id, plain.version, { attributes: { marginM: 2.5, uvM: 6 } });
        expect(set.attributes).toEqual({ marginM: 2.5, uvM: 6 });
        expect((await svc.findById(plain.id)).attributes).toEqual({ marginM: 2.5, uvM: 6 });

        const edge = await svc.update(plain.id, set.version, { attributes: { marginM: 0 } });
        expect(edge.attributes).toEqual({ marginM: 0 });
        // Geometry-only edits leave the attributes alone.
        const moved = await svc.update(plain.id, edge.version, { geometry: squareGeometry(20, 20) });
        expect(moved.attributes).toEqual({ marginM: 0 });
    });

    test('a margin outside 0..5 m or a tile size that is not above 0 is refused, on create, update and batch create', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const create = (attributes: Record<string, unknown>) => svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'rock_slab', geometry: squareGeometry(), attributes: attributes as never,
        });

        await expect(create({ marginM: -0.1 })).rejects.toThrow(/attributes.marginM must be a number between 0 and 5/);
        await expect(create({ marginM: 5.5 })).rejects.toThrow(InvalidFeatureError);
        await expect(create({ marginM: '1.5' })).rejects.toThrow(/attributes.marginM/);
        await expect(create({ uvM: 0 })).rejects.toThrow(/attributes.uvM must be a number above 0/);
        await expect(create({ uvM: true })).rejects.toThrow(InvalidFeatureError);

        const slab = await create({ marginM: 5, uvM: 0.5 });
        await expect(svc.update(slab.id, slab.version, { attributes: { marginM: 6 } })).rejects.toThrow(/attributes.marginM/);
        await expect(svc.createMany(TEST_COURSE_ID, [{
            holeId: null, type: 'rock_slab', geometry: squareGeometry(40, 40), attributes: { uvM: -1 },
        }])).rejects.toThrow(/attributes.uvM/);
        // Other types don't know the keys: a bunker's `marginM` is just a free attribute.
        const bunker = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: squareGeometry(60, 60), attributes: { marginM: 9 },
        });
        expect(bunker.attributes).toEqual({ marginM: 9 });
    });

    test('lands above the grass surfaces and below bunkers in the stack', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const at = (type: string) => svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type, geometry: squareGeometry() });

        await at('bunker');
        await at('rough');
        await at('rock_slab');

        expect((await svc.listByHole(TEST_HOLE_2_ID)).map((f) => f.type)).toEqual(['rough', 'rock_slab', 'bunker']);
    });
});

describe('CourseFeaturesService — power_line', () => {
    test('is a drawable centerline type: the corridor is derived from the line and it joins no road junctions', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const X = 500000, Y = 6500000;
        const geometry = { crs: 'EPSG:3006' as const, rings: [], centerline: { points: [{ x: X, y: Y }, { x: X + 60, y: Y, corner: true }, { x: X + 120, y: Y + 20 }], widthM: 8 } };

        const line = await svc.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'power_line', geometry });

        expect(line.type).toBe('power_line');
        expect(line.geometry.centerline?.widthM).toBe(8);
        expect(line.geometry.rings.length).toBeGreaterThan(0);
        expect(line.attributes).toBeNull();
        const widened = await svc.update(line.id, line.version, { geometry: { ...line.geometry, centerline: { ...line.geometry.centerline!, widthM: 12 } } });
        expect(widened.geometry.centerline?.widthM).toBe(12);
    });
});

describe('CourseFeaturesService — waterfall styles', () => {
    const X = 500000, Y = 6500000;
    const line = (points: { x: number; y: number }[]) => ({ crs: 'EPSG:3006' as const, rings: [], centerline: { points, widthM: 2 } });

    test('a cascade (its line along the flow) and a fountain are stored with their width and jet height', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const cascade = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'waterfall',
            geometry: line([{ x: X, y: Y }, { x: X + 4, y: Y - 1 }, { x: X + 9, y: Y - 1.5 }]),
            attributes: { style: 'cascade', topM: 104.2, bottomM: 101.9, flowBearingDeg: 100, widthM: 1.2 },
        });
        expect(cascade.attributes).toEqual({ style: 'cascade', topM: 104.2, bottomM: 101.9, flowBearingDeg: 100, widthM: 1.2 });
        const fountain = await svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'waterfall',
            geometry: line([{ x: X + 30, y: Y }, { x: X + 31, y: Y }]), attributes: { style: 'fountain', heightM: 2.5 },
        });
        expect(fountain.attributes).toEqual({ style: 'fountain', heightM: 2.5 });
        const higher = await svc.update(fountain.id, fountain.version, { attributes: { style: 'fountain', heightM: 6 } });
        expect(higher.attributes).toEqual({ style: 'fountain', heightM: 6 });
    });

    test('refuses a cascade width outside 0.2..5 m, a jet height outside 0.2..6 m and an unknown style', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const make = (attributes: Record<string, unknown>) => svc.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'waterfall',
            geometry: line([{ x: X, y: Y }, { x: X + 6, y: Y }]), attributes: attributes as never,
        });
        await expect(make({ style: 'cascade', widthM: 0.1 })).rejects.toThrow(/widthM must be 0.2..5 m/);
        await expect(make({ style: 'cascade', widthM: 8 })).rejects.toThrow(/widthM/);
        await expect(make({ style: 'fountain', heightM: 7 })).rejects.toThrow(/heightM must be 0.2..6 m/);
        await expect(make({ style: 'fountain', heightM: 'tall' })).rejects.toThrow(/heightM/);
        await expect(make({ style: 'geyser' })).rejects.toThrow(/sill, outlet, cascade, fountain/);
        const ok = await make({ style: 'cascade' });
        await expect(svc.update(ok.id, ok.version, { attributes: { style: 'cascade', widthM: 6 } })).rejects.toBeInstanceOf(InvalidFeatureError);
    });
});

describe('raiseAbove (a hidden shape in the SVG check)', () => {
    /** The group's order bottom -> top, of `ids` only (the seed course has shapes of its own). */
    const order = async (svc: CourseFeaturesService, holeId: string | null, ids: string[]) =>
        (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.holeId === holeId && f.layer === null && ids.includes(f.id))
            .sort((a, b) => a.sortOrder - b.sortOrder).map((f) => f.id);
    /** Put `id` at the bottom of its group (the drawer lowered it under everything). */
    const toBottom = async (svc: CourseFeaturesService, holeId: string, id: string) => {
        const all = (await svc.listByCourse(TEST_COURSE_ID)).filter((f) => f.holeId === holeId && f.layer === null)
            .sort((a, b) => a.sortOrder - b.sortOrder).map((f) => f.id).filter((x) => x !== id);
        await svc.reorder(TEST_COURSE_ID, holeId, [id, ...all]);
    };

    test('in its own group: raised to just above the highest shape covering it', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const semi = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'semi_rough', geometry: squareGeometry(0, 0, 10) });
        const fairway = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: squareGeometry(50, 0, 10) });
        const tee = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'tee', geometry: squareGeometry(0, 0, 3) });
        await toBottom(svc, TEST_HOLE_1_ID, tee.id);
        const ids = [tee.id, semi.id, fairway.id];
        expect((await order(svc, TEST_HOLE_1_ID, ids))[0]).toBe(tee.id);

        expect(await svc.raiseAbove(TEST_COURSE_ID, tee.id, [semi.id])).toEqual({ moved: true, holeId: TEST_HOLE_1_ID, layer: null });
        const after = await order(svc, TEST_HOLE_1_ID, ids);
        expect(after.indexOf(tee.id)).toBe(after.indexOf(semi.id) + 1);
        // Already above it: nothing to do.
        expect((await svc.raiseAbove(TEST_COURSE_ID, tee.id, [semi.id])).moved).toBe(false);
    });

    test('covered from a higher group: moved into that group, just above the covering shape; a road never counts', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const tee = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'tee', geometry: squareGeometry(0, 0, 3) });
        const semi = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type: 'semi_rough', geometry: squareGeometry(0, 0, 10) });
        const green = await svc.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_2_ID, type: 'green', geometry: squareGeometry(30, 0, 5) });
        const road = await svc.create({ courseId: TEST_COURSE_ID, type: 'path', geometry: squareGeometry(0, 0, 2) });

        expect(await svc.raiseAbove(TEST_COURSE_ID, tee.id, [semi.id, road.id])).toEqual({ moved: true, holeId: TEST_HOLE_2_ID, layer: null });
        const after = await order(svc, TEST_HOLE_2_ID, [tee.id, semi.id, green.id]);
        expect(after.indexOf(tee.id)).toBe(after.indexOf(semi.id) + 1);
        expect(await order(svc, TEST_HOLE_1_ID, [tee.id])).toEqual([]);
        expect((await svc.raiseAbove(TEST_COURSE_ID, tee.id, [road.id])).moved).toBe(false);
    });
});
