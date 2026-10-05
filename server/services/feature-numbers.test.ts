// Migration 026: course_features.feature_no, the per-course number that names
// a feature's GSPro shape and mesh (hole_2_1a -> Spline_hole_2_1a_Bunker_-_Mesh).
import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { CourseFeaturesService } from './course-features.service';
import type { FeatureGeometry } from './geo';

function square(cx = 0, cy = 0, half = 5): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{ points: [
            { x: cx - half, y: cy - half }, { x: cx + half, y: cy - half },
            { x: cx + half, y: cy + half }, { x: cx - half, y: cy + half },
        ] }],
    };
}

function bunker(svc: CourseFeaturesService, courseId = TEST_COURSE_ID) {
    return svc.create({ courseId, holeId: courseId === TEST_COURSE_ID ? TEST_HOLE_1_ID : null, type: 'bunker', geometry: square() });
}

function canopy(cx: number) {
    const ring = [[cx, 0], [cx + 4, 0], [cx + 4, 4], [cx, 4], [cx, 0]];
    return {
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
        properties: { type: 'trees', source: 'lidar-canopy' },
    };
}

describe('feature numbers', () => {
    test('each new feature gets the course\'s next number, in order', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const seeded = await svc.findById(`${TEST_COURSE_ID}-feature-green-1`);
        expect(seeded.no).toBe(1);

        const a = await bunker(svc);
        const b = await bunker(svc);
        expect([a.no, b.no]).toEqual([2, 3]);
        expect((await svc.findById(b.id)).no).toBe(3);
    });

    test('numbers are per course', async () => {
        const { db } = await createTestDb(seedCourse);
        await db.insertInto('courses').values({ id: 'other', name: 'Other', status: 'draft', revision: 1, crs: 'EPSG:3006', version: 1 } as any).execute();
        const svc = new CourseFeaturesService(db);

        expect((await bunker(svc, 'other')).no).toBe(1);
        expect((await bunker(svc)).no).toBe(2);
        expect((await bunker(svc, 'other')).no).toBe(2);
    });

    test('a deleted feature\'s number is never handed out again', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const a = await bunker(svc);
        const b = await bunker(svc);
        await svc.remove(b.id, b.version);

        const c = await bunker(svc);
        expect(c.no).toBe(b.no! + 1);
        expect(a.no).toBe(2);
    });

    test('the history keeps the number, so a restored feature can come back under it', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        const a = await bunker(svc);
        await svc.remove(a.id, a.version);

        const kept = await db.selectFrom('course_feature_history').select('row_json').where('feature_id', '=', a.id).where('op', '=', 'delete').executeTakeFirstOrThrow();
        expect(JSON.parse(kept.row_json).feature_no).toBe(a.no);
    });

    test('generated features get no number and use none up', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', { type: 'FeatureCollection', features: [canopy(0), canopy(10)] } as any);
        await svc.replaceGenerated(TEST_COURSE_ID, 'lidar-canopy', { type: 'FeatureCollection', features: [canopy(0), canopy(10)] } as any);

        const trees = (await svc.listByCourse(TEST_COURSE_ID)).filter(f => f.generated);
        expect(trees.length).toBe(2);
        expect(trees.every(f => f.no === null)).toBe(true);
        expect((await bunker(svc)).no).toBe(2);
    });

    test('a feature written with its number keeps it and moves the counter past it', async () => {
        const { db } = await createTestDb(seedCourse);
        const svc = new CourseFeaturesService(db);
        await db.insertInto('course_features').values({
            id: 'restored', course_id: TEST_COURSE_ID, hole_id: TEST_HOLE_1_ID, type: 'bunker',
            geometry_json: JSON.stringify(square()), geojson: null, sort_order: 5, version: 1, feature_no: 40,
        }).execute();

        expect((await svc.findById('restored')).no).toBe(40);
        expect((await bunker(svc)).no).toBe(41);
    });
});
