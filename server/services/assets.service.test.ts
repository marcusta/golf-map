import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from './assets.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

const DATA_DIR = '/tmp/golf-map-test-data';

async function setup() {
    const ctx = await createTestDb(seedCourse);
    const svc = new AssetsService(ctx.db, DATA_DIR);
    return { svc, db: ctx.db };
}

test('listByCourse returns empty array with no assets', async () => {
    const { svc } = await setup();
    const assets = await svc.listByCourse(TEST_COURSE_ID);
    expect(assets).toHaveLength(0);
});

test('register creates an asset record', async () => {
    const { svc } = await setup();
    const asset = await svc.register({
        siteId: TEST_COURSE_ID,
        courseId: TEST_COURSE_ID,
        kind: 'ortho_cog',
        filename: 'ortho.tif',
    });
    expect(asset.courseId).toBe(TEST_COURSE_ID);
    expect(asset.kind).toBe('ortho_cog');
    expect(asset.filename).toBe('ortho.tif');
    expect(asset.metaJson).toBeNull();
    expect(asset.version).toBe(1);
});

test('register stores metaJson when provided', async () => {
    const { svc } = await setup();
    const meta = JSON.stringify({ bounds: [0, 0, 1, 1], minZoom: 14, maxZoom: 20 });
    const asset = await svc.register({
        siteId: TEST_COURSE_ID,
        courseId: TEST_COURSE_ID,
        kind: 'tile_manifest',
        filename: 'manifest.json',
        metaJson: meta,
    });
    expect(asset.metaJson).toBe(meta);
});

test('listByCourse returns assets for that course only', async () => {
    const { svc, db } = await setup();

    // A second real course, so its assets are FK-valid but distinct from TEST_COURSE_ID.
    const otherCourseId = 'other-course';
    await db
        .insertInto('courses')
        .values({
            id: otherCourseId,
            name: 'Other Course',
            status: 'draft',
            revision: 1,
            crs: 'EPSG:3006',
            georeference_json: null,
            home_lat: null,
            home_lon: null,
            notes: null,
            version: 1,
        })
        .execute();

    await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'ortho_cog', filename: 'a.tif' });
    await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename: 'b.tif' });
    await svc.register({ siteId: otherCourseId, courseId: otherCourseId, kind: 'ortho_cog', filename: 'c.tif' });

    const assets = await svc.listByCourse(TEST_COURSE_ID);
    expect(assets).toHaveLength(2);

    const other = await svc.listByCourse(otherCourseId);
    expect(other).toHaveLength(1);
});

test('get returns a single asset', async () => {
    const { svc } = await setup();
    const created = await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'svg_source', filename: 'course.svg' });
    const found = await svc.get(created.id);
    expect(found).toEqual(created);
});

test('get throws NotFoundError for missing asset', async () => {
    const { svc } = await setup();
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundError);
});

test('update changes metaJson and bumps version', async () => {
    const { svc } = await setup();
    const created = await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename: 'dem.tif' });
    const updated = await svc.update(created.id, 1, { metaJson: '{"elevationRange":[10,50]}' });
    expect(updated.metaJson).toBe('{"elevationRange":[10,50]}');
    expect(updated.version).toBe(2);
});

test('update throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const created = await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename: 'dem.tif' });
    await expect(svc.update(created.id, 99, { metaJson: '{}' })).rejects.toBeInstanceOf(VersionConflictError);
});

test('update throws NotFoundError for missing asset', async () => {
    const { svc } = await setup();
    await expect(svc.update('nope', 1, { metaJson: '{}' })).rejects.toBeInstanceOf(NotFoundError);
});

test('remove deletes the asset', async () => {
    const { svc } = await setup();
    const created = await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'ortho_cog', filename: 'ortho.tif' });
    await svc.remove(created.id, 1);
    await expect(svc.get(created.id)).rejects.toBeInstanceOf(NotFoundError);
});

test('remove throws VersionConflictError on stale version', async () => {
    const { svc } = await setup();
    const created = await svc.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'ortho_cog', filename: 'ortho.tif' });
    await expect(svc.remove(created.id, 99)).rejects.toBeInstanceOf(VersionConflictError);
});

test('remove throws NotFoundError for missing asset', async () => {
    const { svc } = await setup();
    await expect(svc.remove('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
});

// --- resolveTilePath sanitization ---

test('resolveTilePath returns expected path for ortho layer', async () => {
    const { svc } = await setup();
    const p = svc.resolveTilePath(TEST_COURSE_ID, 'ortho', 14, 100, 200);
    expect(p).toBe(`${DATA_DIR}/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg`);
});

test('resolveTilePath returns expected path for terrain layer', async () => {
    const { svc } = await setup();
    const p = svc.resolveTilePath(TEST_COURSE_ID, 'terrain', 14, 100, 200);
    expect(p).toBe(`${DATA_DIR}/tiles/${TEST_COURSE_ID}/terrain/14/100/200.png`);
});

test('resolveTilePath resolves the lidar layers (canopy, canopy-color, surface) as png', async () => {
    const { svc } = await setup();
    for (const layer of ['canopy', 'canopy-color', 'surface'] as const) {
        expect(svc.resolveTilePath(TEST_COURSE_ID, layer, 14, 100, 200))
            .toBe(`${DATA_DIR}/tiles/${TEST_COURSE_ID}/${layer}/14/100/200.png`);
        expect(svc.resolveTilePathCandidates(TEST_COURSE_ID, layer, 14, 100, 200))
            .toEqual([`${DATA_DIR}/tiles/${TEST_COURSE_ID}/${layer}/14/100/200.png`]);
        expect(svc.resolveTileLayerDir(TEST_COURSE_ID, layer))
            .toBe(`${DATA_DIR}/tiles/${TEST_COURSE_ID}/${layer}`);
        // Vintage collections are an ortho-only concept.
        expect(() => svc.resolveTilePathCandidates(TEST_COURSE_ID, layer, 14, 100, 200, 'orto-l2-2023')).toThrow();
    }
});

test('resolveTilePath rejects path traversal in courseId', async () => {
    const { svc } = await setup();
    expect(() => svc.resolveTilePath('../../etc', 'ortho', 1, 1, 1)).toThrow();
    expect(() => svc.resolveTilePath('..', 'ortho', 1, 1, 1)).toThrow();
    expect(() => svc.resolveTilePath('foo/bar', 'ortho', 1, 1, 1)).toThrow();
    expect(() => svc.resolveTilePath('foo/../../bar', 'ortho', 1, 1, 1)).toThrow();
});

test('resolveTilePath rejects invalid layer', async () => {
    const { svc } = await setup();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'bogus' as never, 1, 1, 1)).toThrow();
});

test('resolveTilePath rejects non-integer z/x/y', async () => {
    const { svc } = await setup();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', 1.5, 1, 1)).toThrow();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', 1, 1.5, 1)).toThrow();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', 1, 1, 1.5)).toThrow();
});

test('resolveTilePath rejects negative z/x/y', async () => {
    const { svc } = await setup();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', -1, 1, 1)).toThrow();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', 1, -1, 1)).toThrow();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', 1, 1, -1)).toThrow();
});

test('resolveTilePath rejects NaN coordinates', async () => {
    const { svc } = await setup();
    expect(() => svc.resolveTilePath(TEST_COURSE_ID, 'ortho', Number.NaN, 1, 1)).toThrow();
});

// Real installed files and migrated SQLite, no HTTP or credential access.
test('register installed manifest resolves course/site, validates stems and preserves other assets', async () => {
    const { mkdtemp, mkdir, writeFile, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const scratch = await mkdtemp(`${tmpdir()}/golf-map-manifest-`);
    const { db } = await setup();
    try {
        const svc = new AssetsService(db, scratch);
        const siteId = 'shared-site';
        await db.insertInto('sites').values({id:siteId,name:'Shared',notes:null,version:1}).execute();
        await db.updateTable('courses').set({site_id:siteId}).where('id','=',TEST_COURSE_ID).execute();
        const directory = `${scratch}/tiles/${siteId}`;
        await mkdir(directory, {recursive:true});
        const manifest = {
            bounds:{west:15,south:58,east:16,north:59},
            layers:{ortho:{minzoom:14,maxzoom:20},terrain:{minzoom:12,maxzoom:17}},
            generatedAt:'2026-09-05T12:00:00Z',
            assets:{'tree-stems':{path:'tree-stems.json',format:'tree-stems-v1',count:1}},
        };
        const stems = {version:1,crs:'EPSG:3006',fields:['x','y','heightM','crownRadiusM','groundM'],trees:[[540000,6460000,12,3,80]]};
        await writeFile(`${directory}/manifest.json`,JSON.stringify(manifest));
        await writeFile(`${directory}/tree-stems.json`,JSON.stringify(stems));
        const other = await svc.register({siteId,courseId:TEST_COURSE_ID,kind:'ortho_cog',filename:'original.tif',metaJson:'{"keep":true}'});
        const [created] = await svc.registerInstalledTileManifest(TEST_COURSE_ID);
        expect(created.siteId).toBe(siteId);
        expect(created.filename).toBe(`tiles/${siteId}/manifest.json`);
        expect(created.version).toBe(1);
        expect(JSON.parse(created.metaJson!)).toEqual(manifest);
        // Direct site registration resolves its owning course when no asset exists.
        const freshSite = 'fresh-site';
        await db.insertInto('sites').values({id:freshSite,name:'Fresh',notes:null,version:1}).execute();
        await db.insertInto('courses').values({id:'fresh-course',site_id:freshSite,name:'Fresh course',status:'draft',revision:1,crs:'EPSG:3006',georeference_json:null,home_lat:null,home_lon:null,notes:null,version:1}).execute();
        await mkdir(`${scratch}/tiles/${freshSite}`, {recursive:true});
        await writeFile(`${scratch}/tiles/${freshSite}/manifest.json`,JSON.stringify(manifest));
        await writeFile(`${scratch}/tiles/${freshSite}/tree-stems.json`,JSON.stringify(stems));
        const [fresh] = await svc.registerInstalledTileManifest(freshSite);
        expect(fresh.siteId).toBe(freshSite);
        expect(fresh.courseId).toBe('fresh-course');
        expect(fresh.filename).toBe(`tiles/${freshSite}/manifest.json`);
        expect(fresh.version).toBe(1);
        // A version-2 asset (kind column) registers under the same tree-stems-v1 descriptor.
        const stemsV2 = {version:2,crs:'EPSG:3006',fields:[...stems.fields,'kind'],trees:[[540000,6460000,12,3,80,1]]};
        await writeFile(`${directory}/tree-stems.json`,JSON.stringify(stemsV2));
        const [updated] = await svc.registerInstalledTileManifest(siteId);
        expect(updated.id).toBe(created.id);
        expect(updated.version).toBe(2);
        await writeFile(`${directory}/tree-stems.json`,JSON.stringify({...stemsV2, trees:[[540000,6460000,12,3,80,7]]}));
        await expect(svc.registerInstalledTileManifest(siteId)).rejects.toThrow('Invalid tree stem');
        await writeFile(`${directory}/tree-stems.json`,JSON.stringify(stems));
        expect(await svc.get(other.id)).toEqual(other);
        manifest.assets['tree-stems'].count = 2;
        await writeFile(`${directory}/manifest.json`,JSON.stringify(manifest));
        await expect(svc.registerInstalledTileManifest(siteId)).rejects.toThrow('count differs');
        expect(await svc.get(created.id)).toEqual(updated);
        manifest.assets['tree-stems'].count = 1;
        manifest.assets['tree-stems'].path = '../tree-stems.json';
        await writeFile(`${directory}/manifest.json`,JSON.stringify(manifest));
        await expect(svc.registerInstalledTileManifest(siteId)).rejects.toThrow('descriptor');
        await expect(svc.registerInstalledTileManifest('../escape')).rejects.toThrow('Invalid');
        await expect(svc.registerInstalledTileManifest('missing')).rejects.toBeInstanceOf(NotFoundError);
        await rm(`${directory}/manifest.json`);
        await writeFile(`${scratch}/outside.json`,JSON.stringify(manifest));
        await symlink(`${scratch}/outside.json`,`${directory}/manifest.json`);
        await expect(svc.registerInstalledTileManifest(siteId)).rejects.toThrow('escapes');
    } finally {
        await db.destroy();
        await rm(scratch,{recursive:true,force:true});
    }
});
