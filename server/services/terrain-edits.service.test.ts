import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse } from '../db/seeds/course';
import { SitesService } from './sites.service';
import { TerrainEditsService, InvalidTerrainEditError, type TerrainEditRing } from './terrain-edits.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

const SQUARE: TerrainEditRing = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
];

async function setup() {
    const ctx = await createTestDb(seedCourse);
    const sites = new SitesService(ctx.db);
    const site = await sites.create({ name: 'Landeryd' });
    return { ctx, svc: new TerrainEditsService(ctx.db), db: ctx.db, siteId: site.id };
}

test('create + get + listBySite', async () => {
    const { svc, siteId } = await setup();
    expect(await svc.listBySite(siteId)).toHaveLength(0);

    const edit = await svc.create({
        siteId,
        op: 'plane',
        params: { featherM: 2, flat: true },
        rings: [SQUARE],
    });
    expect(edit.op).toBe('plane');
    expect(edit.params).toEqual({ featherM: 2, flat: true });
    expect(edit.rings).toEqual([SQUARE]);
    expect(edit.enabled).toBe(true);
    expect(edit.version).toBe(1);

    expect((await svc.get(edit.id)).siteId).toBe(siteId);
    expect(await svc.listBySite(siteId)).toHaveLength(1);
});

test('create can start disabled', async () => {
    const { svc, siteId } = await setup();
    const edit = await svc.create({
        siteId,
        op: 'smooth',
        params: { featherM: 1, radiusM: 3 },
        rings: [SQUARE],
        enabled: false,
    });
    expect(edit.enabled).toBe(false);
    expect((await svc.get(edit.id)).enabled).toBe(false);
});

test('listBySite is scoped to the site and ordered by created_at', async () => {
    const { svc, db, siteId } = await setup();
    const other = await new SitesService(db).create({ name: 'Other' });

    const a = await svc.create({ id: 'a', siteId, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });
    const b = await svc.create({ id: 'b', siteId, op: 'smooth', params: { featherM: 2 }, rings: [SQUARE] });
    await svc.create({ id: 'c', siteId: other.id, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });

    const forSite = await svc.listBySite(siteId);
    expect(forSite.map((e) => e.id)).toEqual([a.id, b.id]);
    expect((await svc.listBySite(other.id)).map((e) => e.id)).toEqual(['c']);
});

test('update patches fields, bumps version; stale version conflicts', async () => {
    const { svc, siteId } = await setup();
    const edit = await svc.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });

    const updated = await svc.update(edit.id, 1, {
        op: 'smooth',
        params: { featherM: 1, radiusM: 2 },
        enabled: false,
    });
    expect(updated.version).toBe(2);
    expect(updated.op).toBe('smooth');
    expect(updated.params).toEqual({ featherM: 1, radiusM: 2 });
    expect(updated.enabled).toBe(false);
    expect(updated.rings).toEqual([SQUARE]); // untouched patch fields stay put

    await expect(svc.update(edit.id, 1, { enabled: true })).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove deletes; stale version conflicts', async () => {
    const { svc, siteId } = await setup();
    const edit = await svc.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });

    await expect(svc.remove(edit.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
    await svc.remove(edit.id, 1);
    expect(await svc.listBySite(siteId)).toHaveLength(0);
});

test('get / update / remove on a missing edit throw NotFoundError', async () => {
    const { svc } = await setup();
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.update('nope', 1, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.remove('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
});

test('validation rejects bad op / params / rings', async () => {
    const { svc, siteId } = await setup();
    await expect(
        svc.create({ siteId, op: 'bogus' as any, params: { featherM: 2 }, rings: [SQUARE] }),
    ).rejects.toBeInstanceOf(InvalidTerrainEditError);
    await expect(
        svc.create({ siteId, op: 'plane', params: { featherM: -1 }, rings: [SQUARE] }),
    ).rejects.toBeInstanceOf(InvalidTerrainEditError);
    await expect(
        svc.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]] }),
    ).rejects.toBeInstanceOf(InvalidTerrainEditError);
});

test('deleting the site cascades its terrain edits', async () => {
    const { svc, db, siteId } = await setup();
    await svc.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });
    await new SitesService(db).remove(siteId, 1);
    expect(await svc.listBySite(siteId)).toHaveLength(0);
});
