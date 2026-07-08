import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { SitesService } from './sites.service';
import { AssetsService } from './assets.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

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

test('remove detaches referencing courses + assets, then deletes', async () => {
    const { ctx, svc, db } = await setup();
    const assets = new AssetsService(db, '/tmp/x');
    const site = await svc.create({ name: 'Landeryd' });
    await db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: site.id }).execute();
    await assets.register({ siteId: site.id, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename: 'd.tif' });

    await svc.remove(site.id, 1);

    expect((await ctx.coursesService.get(TEST_COURSE_ID)).siteId).toBeNull();
    const orphaned = await db.selectFrom('course_assets').select(['site_id']).execute();
    expect(orphaned.every((a) => a.site_id === null)).toBe(true);
    await expect(svc.get(site.id)).rejects.toBeInstanceOf(NotFoundError);
});
