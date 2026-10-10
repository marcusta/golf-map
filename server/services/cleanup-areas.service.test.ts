import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CleanupAreasService } from './cleanup-areas.service';
import type { CleanupArea } from '../../shared/cleanup-areas';
import { cleanupAreasTestApp } from '../testing/cleanup-areas';

const box = (id: string, kind: CleanupArea['kind'], x: number, y: number, size: number): CleanupArea => ({
    id, name: id, kind, ring: [[x,y], [x+size,y], [x+size,y+size], [x,y+size], [x,y]],
});

test('cleanup boundaries persist per site, protect holes, export effective geometry and reject stale saves', async () => {
    const { db } = await createTestDb(seedCourse);
    try {
        await db.insertInto('sites').values({ id: 'cleanup-site', name: 'Cleanup', notes: null, version: 1 }).execute();
        await db.updateTable('courses').set({ site_id: 'cleanup-site' }).where('id', '=', TEST_COURSE_ID).execute();
        const svc = new CleanupAreasService(db);
        expect((await svc.get(TEST_COURSE_ID)).areas).toEqual([]);
        const areas = [box('keep', 'exclude', 15.2, 58.2, 0.1), box('clean', 'include', 15, 58, 1)];
        const saved = await svc.save(TEST_COURSE_ID, 0, areas);
        expect(saved.version).toBe(1);
        expect(await new CleanupAreasService(db).get(TEST_COURSE_ID)).toEqual(saved);
        const course = await db.selectFrom('courses').selectAll().where('id', '=', TEST_COURSE_ID).executeTakeFirstOrThrow();
        await db.insertInto('courses').values({ ...course, id: 'same-site', name: 'Same photo' }).execute();
        expect(await svc.get('same-site')).toEqual(saved);
        await db.insertInto('sites').values({ id: 'other-site', name: 'Other', notes: null, version: 1 }).execute();
        await db.insertInto('courses').values({ ...course, id: 'other-course', name: 'Other photo', site_id: 'other-site' }).execute();
        expect((await svc.get('other-course')).areas).toEqual([]);
        const exported = await svc.export(TEST_COURSE_ID);
        expect(exported.features[0].geometry.coordinates).toHaveLength(1);
        expect(exported.features[0].geometry.coordinates[0]).toHaveLength(2); // exclusion is a hole
        await expect(svc.save(TEST_COURSE_ID, 0, [])).rejects.toThrow();
        await svc.save(TEST_COURSE_ID, 1, [areas[0]]);
        expect((await svc.export(TEST_COURSE_ID)).features).toEqual([]); // no implicit whole-site cleanup
        await expect(svc.save(TEST_COURSE_ID, 1, areas)).rejects.toThrow();
        await expect(svc.save(TEST_COURSE_ID, 2, [{ ...areas[1], ring: [[15,58], [16,59], [15,59], [16,58], [15,58]] }])).rejects.toThrow(/cross/);
        await expect(svc.save(TEST_COURSE_ID, 2, [areas[0], areas[0]])).rejects.toThrow(/unique/);
        expect((await svc.get(TEST_COURSE_ID)).version).toBe(2);
        const http = cleanupAreasTestApp(svc);
        const invalid = await http.request('/api/cleanup-areas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            courseId: TEST_COURSE_ID, version: 2, areas: [{ ...areas[1], ring: [[15,58], [16,59], [15,59], [16,58], [15,58]] }],
        }) });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: expect.stringMatching(/cross/) });
        const features = await db.selectFrom('course_features').selectAll().execute();
        expect(features.some(f => f.type === 'cleanup')).toBe(false);
        await expect(svc.get('missing')).rejects.toThrow(/not found/);
    } finally { await db.destroy(); }
});
