import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { SitesService } from './sites.service';
import { AssetsService } from './assets.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

async function setup() {
    const ctx = await createTestDb(seedCourse);
    return { ctx, svc: new SitesService(ctx.db), db: ctx.db };
}

test('create + get + list', async () => {
    const { svc } = await setup();
    expect(await svc.list()).toHaveLength(0);

    const site = await svc.create({ name: 'Landeryd', notes: 'main site' });
    expect(site.name).toBe('Landeryd');
    expect(site.version).toBe(1);
    expect((await svc.get(site.id)).notes).toBe('main site');
    expect(await svc.list()).toHaveLength(1);
});

test('create with an explicit id (used by the 1:1 migration backfill)', async () => {
    const { svc } = await setup();
    const site = await svc.create({ id: 'fixed-id', name: 'X' });
    expect(site.id).toBe('fixed-id');
});

test('update bumps version; stale version conflicts', async () => {
    const { svc } = await setup();
    const site = await svc.create({ name: 'Vesterby' });
    const updated = await svc.update(site.id, 1, { notes: 'second site' });
    expect(updated.version).toBe(2);
    expect(updated.notes).toBe('second site');
    await expect(svc.update(site.id, 1, { name: 'x' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('get / update / remove on a missing site throw NotFoundError', async () => {
    const { svc } = await setup();
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.update('nope', 1, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.remove('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
});

test('listCoursesForSite returns the site’s courses', async () => {
    const { svc, db } = await setup();
    const site = await svc.create({ name: 'Landeryd' });
    await db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: site.id }).execute();

    const courses = await svc.listCoursesForSite(site.id);
    expect(courses.map((c) => c.id)).toEqual([TEST_COURSE_ID]);
});

test('remove refuses while courses are attached', async () => {
    const { ctx, svc, db } = await setup();
    const site = await svc.create({ name: 'Landeryd' });
    await db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: site.id }).execute();

    await expect(svc.remove(site.id, 1)).rejects.toBeInstanceOf(ConflictError);

    expect((await ctx.coursesService.get(TEST_COURSE_ID)).siteId).toBe(site.id);
    expect((await svc.get(site.id)).name).toBe('Landeryd');
});

test('remove detaches referencing assets, then deletes', async () => {
    const { svc, db } = await setup();
    const assets = new AssetsService(db, '/tmp/x');
    const site = await svc.create({ name: 'Landeryd' });
    await assets.register({ siteId: site.id, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename: 'd.tif' });

    await svc.remove(site.id, 1);

    const orphaned = await db.selectFrom('course_assets').select(['site_id']).execute();
    expect(orphaned.every((a) => a.site_id === null)).toBe(true);
    await expect(svc.get(site.id)).rejects.toBeInstanceOf(NotFoundError);
});

test('overview lists each site with its courses and last successful build area', async () => {
    const { svc, db } = await setup();
    const shared = await svc.create({ name: 'Ekerum Resort' });
    const empty = await svc.create({ name: 'Vesterby' });
    await db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: shared.id }).execute();

    const job = (id: string, status: string, kind: string, west: number, at: string) => ({
        id, course_id: TEST_COURSE_ID, site_id: shared.id, status, kind, step: null, log: '', error: null,
        bbox_json: JSON.stringify({ west, south: 56.77, east: 16.58, north: 56.79 }), updated_at: at,
    });
    await db.insertInto('map_build_jobs').values([
        job('old', 'succeeded', 'build', 16.50, '2026-09-01 10:00:00'),
        job('new', 'succeeded', 'build', 16.55, '2026-09-18 15:47:39'),
        job('failed', 'failed', 'build', 16.60, '2026-09-19 08:00:00'),
        job('trees', 'succeeded', 'trees', 16.70, '2026-09-19 09:00:00'),
    ]).execute();

    const overview = await svc.overview();
    expect(overview.map((s) => s.name)).toEqual(['Ekerum Resort', 'Vesterby']);

    const [ekerum, vesterby] = overview;
    expect(ekerum.courses.map((c) => c.id)).toEqual([TEST_COURSE_ID]);
    expect(ekerum.mapBounds).toEqual({ west: 16.55, south: 56.77, east: 16.58, north: 56.79 });
    expect(ekerum.mapBuiltAt).toBe('2026-09-18 15:47:39');

    expect(vesterby.id).toBe(empty.id);
    expect(vesterby.courses).toEqual([]);
    expect(vesterby.mapBounds).toBeNull();
    expect(vesterby.mapBuiltAt).toBeNull();
});
