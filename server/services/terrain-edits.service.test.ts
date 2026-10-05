import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { mount } from '@basics/core/server/mount';
import { createTerrainEditsApi } from '../api/terrain-edits.api';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { SitesService } from './sites.service';
import {
    TerrainEditsService, InvalidTerrainEditError, InvalidRecipeEditError, RECIPE_ORIGIN, isDemEdit, parseEditsGeojson, type TerrainEditRing,
} from './terrain-edits.service';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

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

// --- Generated edits (building pads): replaceByOrigin + the D-TE5 import ---

const PAD = (dx: number): TerrainEditRing => [
    { x: 100 + dx, y: 100 }, { x: 110 + dx, y: 100 }, { x: 110 + dx, y: 108 }, { x: 100 + dx, y: 108 },
];

test('replaceByOrigin swaps one origin\'s generation, leaves hand-drawn and other origins alone', async () => {
    const { svc, siteId } = await setup();
    const manual = await svc.create({ siteId, op: 'smooth', params: { featherM: 1, radiusM: 2 }, rings: [SQUARE] });
    const other = await svc.replaceByOrigin(siteId, 'other-gen', [
        { op: 'plane', params: { featherM: 2 }, rings: [PAD(50)], originRef: 'x' },
    ]);
    const first = await svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(0)], originRef: 'osm:way/1' },
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(20)], originRef: 'osm:way/2' },
    ]);
    expect(first).toHaveLength(2);
    expect(first.map(e => e.origin)).toEqual(['building-pads', 'building-pads']);
    expect(first.map(e => e.originRef)).toEqual(['osm:way/1', 'osm:way/2']);
    expect(await svc.listBySite(siteId)).toHaveLength(4);

    const second = await svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(20)], originRef: 'osm:way/2' },
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(40)], originRef: 'osm:way/3' },
    ]);
    const all = await svc.listBySite(siteId);
    expect(all).toHaveLength(4);
    const ids = new Set(all.map(e => e.id));
    expect(ids.has(manual.id) && ids.has(other[0]!.id)).toBe(true);
    expect(first.some(e => ids.has(e.id))).toBe(false);
    expect(second.every(e => ids.has(e.id))).toBe(true);
    expect(all.filter(e => e.origin === 'building-pads').map(e => e.originRef)).toEqual(['osm:way/2', 'osm:way/3']);
});

test('replaceByOrigin keeps a building the user disabled disabled, by originRef', async () => {
    const { svc, siteId } = await setup();
    const [a, b] = await svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(0)], originRef: 'osm:way/1' },
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(20)], originRef: 'osm:way/2' },
    ]);
    await svc.update(a!.id, 1, { enabled: false });
    const again = await svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 3, flat: true }, rings: [PAD(1)], originRef: 'osm:way/1' },
        { op: 'plane', params: { featherM: 3, flat: true }, rings: [PAD(21)], originRef: 'osm:way/2' },
    ]);
    expect(again.map(e => [e.originRef, e.enabled])).toEqual([['osm:way/1', false], ['osm:way/2', true]]);
    expect(again[1]!.id).not.toBe(b!.id);
});

test('generated edits list (and so apply) before every hand-drawn edit', async () => {
    const { svc, siteId } = await setup();
    const manual = await svc.create({ siteId, op: 'smooth', params: { featherM: 1, radiusM: 2 }, rings: [SQUARE] });
    const [pad] = await svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(0)], originRef: 'osm:way/1' },
    ]);
    const order = (await svc.listBySite(siteId)).map(e => e.id);
    expect(order).toEqual([pad!.id, manual.id]);
    expect(pad!.createdAt < manual.createdAt).toBe(true);
    expect(await svc.replaceByOrigin(siteId, 'building-pads', [])).toEqual([]);
    expect((await svc.listBySite(siteId)).map(e => e.id)).toEqual([manual.id]);
});

test('replaceByOrigin validates every input before touching the table', async () => {
    const { svc, siteId } = await setup();
    await svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 4, flat: true }, rings: [PAD(0)], originRef: 'osm:way/1' },
    ]);
    await expect(svc.replaceByOrigin(siteId, 'building-pads', [
        { op: 'plane', params: { featherM: 4 }, rings: [PAD(0)], originRef: 'ok' },
        { op: 'plane', params: { featherM: -1 }, rings: [PAD(0)], originRef: 'bad' },
    ])).rejects.toBeInstanceOf(InvalidTerrainEditError);
    await expect(svc.replaceByOrigin(siteId, '', [])).rejects.toBeInstanceOf(InvalidTerrainEditError);
    expect((await svc.listBySite(siteId)).map(e => e.originRef)).toEqual(['osm:way/1']);
});

test('parseEditsGeojson reads the pipeline handoff into DEM-CRS rings and reports bad features', () => {
    // A ~10 × 8 m pad near Linköping in WGS84, closed ring as GeoJSON has it.
    const doc = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { op: 'plane', featherM: 4, flat: true, origin: 'building-pads', originRef: 'osm:way/7' },
                geometry: { type: 'Polygon', coordinates: [[
                    [15.55, 58.40], [15.55017, 58.40], [15.55017, 58.40007], [15.55, 58.40007], [15.55, 58.40],
                ]] },
            },
            { type: 'Feature', properties: { op: 'smooth', featherM: 1, radiusM: 3 }, geometry: { type: 'Polygon', coordinates: [[
                [15.56, 58.41], [15.5601, 58.41], [15.5601, 58.4101], [15.56, 58.41],
            ]] } },
            { type: 'Feature', properties: { op: 'bogus' }, geometry: { type: 'Polygon', coordinates: [[[15.5, 58.4], [15.6, 58.4], [15.6, 58.5], [15.5, 58.4]]] } },
            { type: 'Feature', properties: { op: 'plane' }, geometry: { type: 'LineString', coordinates: [[15.5, 58.4], [15.6, 58.4]] } },
            { type: 'Feature', properties: { op: 'plane', featherM: 2 }, geometry: { type: 'Polygon', coordinates: [[[15.5, 58.4], [15.6, 58.4], [15.5, 58.4]]] } },
        ],
    };
    const { edits, skipped } = parseEditsGeojson(doc);
    expect(edits).toHaveLength(2);
    const [pad, smooth] = edits;
    expect(pad!.op).toBe('plane');
    expect(pad!.params).toEqual({ featherM: 4, flat: true });
    expect(pad!.originRef).toBe('osm:way/7');
    expect(pad!.rings[0]).toHaveLength(4); // the closing point is dropped
    for (const p of pad!.rings[0]!) {
        expect(p.x).toBeGreaterThan(500_000);
        expect(p.x).toBeLessThan(600_000);
        expect(p.y).toBeGreaterThan(6_470_000);
        expect(p.y).toBeLessThan(6_480_000);
    }
    const w = Math.hypot(pad!.rings[0]![1]!.x - pad!.rings[0]![0]!.x, pad!.rings[0]![1]!.y - pad!.rings[0]![0]!.y);
    expect(w).toBeGreaterThan(8);
    expect(w).toBeLessThan(12);
    expect(smooth!.params).toEqual({ featherM: 1, radiusM: 3 });
    expect(smooth!.originRef).toBeNull();
    expect(skipped).toEqual([
        'feature 2: unknown op "bogus"',
        'feature 3: geometry is not a Polygon',
        'feature 4: Each ring must have at least 3 points',
    ]);
    expect(() => parseEditsGeojson({ type: 'Feature' })).toThrow(InvalidTerrainEditError);
});

test('parseEditsGeojson reads corridor centerlines into the DEM CRS and requires them', () => {
    const ring = [[15.55, 58.40], [15.552, 58.40], [15.552, 58.4001], [15.55, 58.4001], [15.55, 58.40]];
    const { edits, skipped } = parseEditsGeojson({
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { op: 'corridor', featherM: 2, smoothM: 25, widthM: 5, originRef: 'osm:way/1',
                    centerline: [[15.55, 58.40005], [15.552, 58.40005]] },
                geometry: { type: 'Polygon', coordinates: [ring] },
            },
            { type: 'Feature', properties: { op: 'corridor', featherM: 2 }, geometry: { type: 'Polygon', coordinates: [ring] } },
            { type: 'Feature', properties: { op: 'corridor', featherM: 2, centerline: [[15.55, 58.4]] }, geometry: { type: 'Polygon', coordinates: [ring] } },
        ],
    });
    expect(edits).toHaveLength(1);
    const [c] = edits;
    expect(c!.op).toBe('corridor');
    expect(c!.params.smoothM).toBe(25);
    expect(c!.params.widthM).toBe(5);
    expect(c!.params.centerline).toHaveLength(2);
    const [a, b] = c!.params.centerline!;
    expect(a!.x).toBeGreaterThan(500_000);
    expect(Math.hypot(b!.x - a!.x, b!.y - a!.y)).toBeGreaterThan(100); // ~117 m of 0.002° lon here
    expect(skipped).toEqual([
        'feature 1: A corridor edit needs a centerline',
        'feature 2: centerline must have at least 2 points with finite x/y',
    ]);
});

test('a corridor edit round-trips through create and the D-TE5 export', async () => {
    const { svc, siteId } = await setup();
    const { terrainEditsGeojson } = await import('./map-build.service');
    const edit = await svc.create({
        siteId, op: 'corridor',
        params: { featherM: 2, smoothM: 25, widthM: 5, centerline: [{ x: 533000, y: 6475000 }, { x: 533100, y: 6475000 }] },
        rings: [[{ x: 532995, y: 6474995 }, { x: 533105, y: 6474995 }, { x: 533105, y: 6475005 }, { x: 532995, y: 6475005 }]],
        origin: 'road-grades', originRef: 'osm:way/1',
    });
    expect(edit.params.centerline).toHaveLength(2);
    await expect(svc.create({ siteId, op: 'corridor', params: { featherM: 2 }, rings: [SQUARE] }))
        .rejects.toBeInstanceOf(InvalidTerrainEditError);

    const [feature] = terrainEditsGeojson([edit]).features as any[];
    expect(feature.properties.op).toBe('corridor');
    expect(feature.properties.smoothM).toBe(25);
    expect(feature.properties.widthM).toBe(5);
    expect(feature.properties.centerline).toHaveLength(2);
    const [lon, lat] = feature.properties.centerline[0];
    expect(lon).toBeGreaterThan(15); expect(lon).toBeLessThan(16);
    expect(lat).toBeGreaterThan(58); expect(lat).toBeLessThan(59);
    // And the pipeline-side parser reads it back to within a centimetre.
    const back = parseEditsGeojson(terrainEditsGeojson([edit])).edits[0]!;
    expect(Math.abs(back.params.centerline![0]!.x - 533000)).toBeLessThan(0.01);
    expect(Math.abs(back.params.centerline![1]!.y - 6475000)).toBeLessThan(0.01);
});

test('a dig edit validates its profile and round-trips through the D-TE5 export', async () => {
    const { svc, siteId } = await setup();
    const { terrainEditsGeojson } = await import('./map-build.service');
    const params = {
        featherM: 0, depthM: 0.45, bankSlopeDeg: 18, faceSlopeDeg: 40, faceBearingDeg: 90,
        reference: 'plane' as const, rimM: 2.5, variation: 0.25, seed: 42,
    };
    const edit = await svc.create({ siteId, op: 'dig', params, rings: [SQUARE], origin: 'bunker-digs', originRef: 'feature:b1' });
    expect(edit.params).toEqual(params);

    const bad: Array<Record<string, unknown>> = [
        { featherM: 0 },                                         // no depth
        { featherM: 0, depthM: 1, bankSlopeDeg: 90 },
        { featherM: 0, depthM: 1, faceSlopeDeg: 40 },            // face without bearing
        { featherM: 0, depthM: 1, shelfDepthM: 1 },              // shelf as deep as the floor
        { featherM: 0, depthM: 1, reference: 'sea' },
        { featherM: 0, depthM: 1, variation: 2 },
        { featherM: 0, depthM: 1, seed: 1.5 },
    ];
    for (const p of bad) {
        await expect(svc.create({ siteId, op: 'dig', params: p as any, rings: [SQUARE] })).rejects.toBeInstanceOf(InvalidTerrainEditError);
    }

    const [feature] = terrainEditsGeojson([edit]).features as any[];
    expect(feature.properties).toMatchObject({ op: 'dig', featherM: 0, depthM: 0.45, bankSlopeDeg: 18, faceSlopeDeg: 40, faceBearingDeg: 90, reference: 'plane', rimM: 2.5, variation: 0.25, seed: 42 });
    expect(feature.properties.shelfM).toBeUndefined();
    expect(parseEditsGeojson(terrainEditsGeojson([edit])).edits[0]!.params).toEqual(params);
});

test('generated edits replay in the generators\' fixed order (roads last), each in file order, before hand-drawn ones', async () => {
    const { svc, siteId } = await setup();
    const input = (ref: string) => ({ op: 'plane' as const, params: { featherM: 2 }, rings: [SQUARE], originRef: ref });
    await svc.create({ siteId, op: 'smooth', params: { featherM: 2 }, rings: [SQUARE] });            // hand-drawn, first in time
    // Generated in the "wrong" order, and with overlapping indexes.
    await svc.replaceByOrigin(siteId, 'road-grades', [input('lot'), input('road')]);
    await svc.replaceByOrigin(siteId, 'creek-digs', [input('creek')]);
    await svc.replaceByOrigin(siteId, 'building-pads', [input('pad1'), input('pad2'), input('pad3')]);
    await svc.replaceByOrigin(siteId, 'bunker-digs', [input('bunker')]);
    await svc.replaceByOrigin(siteId, 'water-digs', [input('pond')]);
    const order = (await svc.listBySite(siteId)).map(e => e.originRef ?? 'hand-drawn');
    expect(order).toEqual(['pad1', 'pad2', 'pad3', 'pond', 'bunker', 'creek', 'lot', 'road', 'hand-drawn']);
});

test('a Unity sculpt layer replays after every other edit, hand-drawn ones included, and goes out with its raster path', async () => {
    const { svc, siteId } = await setup();
    const { terrainEditsGeojson } = await import('./map-build.service');
    const sculpt = { op: 'delta' as const, params: { featherM: 0, raster: 'inner-sculpt.tif', changedM2: 120, maxRaiseM: 0.3, maxLowerM: -0.2 }, rings: [SQUARE], originRef: 'inner' };
    await svc.replaceByOrigin(siteId, 'unity-sculpt-inner', [sculpt]);
    await svc.replaceByOrigin(siteId, 'road-grades', [{ op: 'plane', params: { featherM: 2 }, rings: [SQUARE], originRef: 'lot' }]);
    await svc.create({ siteId, op: 'smooth', params: { featherM: 2 }, rings: [SQUARE] });   // hand-drawn, after the capture
    const edits = await svc.listBySite(siteId);
    expect(edits.map(e => e.origin ?? 'hand-drawn')).toEqual(['road-grades', 'hand-drawn', 'unity-sculpt-inner']);

    const [feature] = terrainEditsGeojson([edits[2]!], { sculptDir: '/data/sources/s1/terrain-sculpt' }).features as any[];
    expect(feature.properties.op).toBe('delta');
    expect(feature.properties.raster.split(path.sep).join('/')).toBe('/data/sources/s1/terrain-sculpt/inner-sculpt.tif');

    for (const raster of [undefined, '../../etc/passwd', 'inner.tif']) {
        await expect(svc.create({ siteId, op: 'delta', params: { featherM: 0, raster } as any, rings: [SQUARE] }))
            .rejects.toBeInstanceOf(InvalidTerrainEditError);
    }
});


// --- Recipe edits (a course feature's Blender shaping recipe, blender/SHAPING-PLAN.md) ---

const rectRing = (x0: number, y0: number, w: number, h: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
    { x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
] }] });

// Params as a composite recipe declares them (SHAPING-PLAN.md, "Composite and parameterised recipes"); test data only.
const LIBRARY = [
    { id: 'conway', name: 'Conway bunker', file: 'cesimgolf-Conway_Bunker_Standard.json', author: 'cesimgolf', surfaces: ['bunker'], default: true,
        params: [
            { id: 'depth', label: 'Depth', unit: 'm', min: 0.2, max: 1.2, step: 0.05, default: 0.45,
                maps: [{ step: 'bunkerstudio.shape', field: 'depth', mode: 'set' }] },
            { id: 'lipHeight', label: 'Lip height', unit: '×', min: 0.5, max: 2, step: 0.1, default: 1,
                maps: [{ step: 'bunkereditlip', field: 'bunker_lip_depth', mode: 'scale' }] },
        ] },
    { id: 'pond', name: 'Pond', file: 'golfmap-pond.json', author: 'golfmap', surfaces: ['lake', 'creek'] },
];

/** A site with the seeded course on it, a bunker, a pond and a green, and a recipe library. */
async function recipeSetup(library: unknown = LIBRARY) {
    const { ctx, db, siteId } = await setup();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'recipes-'));
    const recipeLibrary = path.join(dir, 'library.json');
    if (library !== null) await writeFile(recipeLibrary, JSON.stringify(library));
    await db.updateTable('courses').set({ site_id: siteId }).where('id', '=', TEST_COURSE_ID).execute();
    const features = ctx.courseFeaturesService;
    const bunker = await features.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: rectRing(0, 0, 10, 10) });
    const pond = await features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: rectRing(50, 0, 30, 20) });
    const green = await features.create({ courseId: TEST_COURSE_ID, type: 'green', geometry: rectRing(100, 0, 30, 20) });
    return { db, siteId, svc: new TerrainEditsService(db, { recipeLibrary }), bunker, pond, green };
}

test('a recipe edit is one feature\'s library recipe: origin feature, no rings, featherM 0, history kept', async () => {
    const { db, siteId, svc, bunker } = await recipeSetup();
    const edit = await svc.create({ siteId, op: 'recipe', params: { recipe: 'conway', overrides: { depth: 0.6, seed: 7 } }, featureId: bunker.id });
    expect(edit.op).toBe('recipe');
    expect(edit.params).toEqual({ featherM: 0, recipe: 'conway', overrides: { depth: 0.6, seed: 7 } });
    expect(edit.rings).toEqual([]);
    expect(edit.origin).toBe(RECIPE_ORIGIN);
    expect(edit.originRef).toBe(`feature:${bunker.id}`);
    expect((await svc.recipeOf(siteId, bunker.id))?.id).toBe(edit.id);

    const updated = await svc.update(edit.id, 1, { params: { recipe: 'none' } });
    expect(updated.params).toEqual({ featherM: 0, recipe: 'none' });
    const off = await svc.update(edit.id, 2, { enabled: false });
    expect(off.enabled).toBe(false);
    await svc.remove(edit.id, 3);
    const history = await db.selectFrom('terrain_edit_history').select('op').where('edit_id', '=', edit.id).orderBy('history_id').execute();
    expect(history.map(h => h.op)).toEqual(['update', 'update', 'delete']);
});

test('one recipe edit per feature: a second is a 409 naming the first', async () => {
    const { siteId, svc, bunker } = await recipeSetup();
    const first = await svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: bunker.id });
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'none' }, featureId: bunker.id }))
        .rejects.toThrow(new RegExp(`already has a recipe edit \\(${first.id}\\)`));
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'none' }, featureId: bunker.id })).rejects.toBeInstanceOf(ConflictError);
});

test('a recipe must be in the library and made for the feature\'s surface', async () => {
    const { siteId, svc, bunker, pond, green } = await recipeSetup();
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'gone' }, featureId: bunker.id })).rejects.toThrow(/Unknown recipe 'gone'/);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: pond.id })).rejects.toThrow(/is for bunker, not lake/);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: green.id })).rejects.toThrow(/green feature takes no shaping recipe/);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' } })).rejects.toThrow(/needs featureId/);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: bunker.id, rings: [SQUARE] })).rejects.toThrow(/no rings/);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway', depthM: 1 }, featureId: bunker.id })).rejects.toThrow(/only recipe and overrides/);
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'conway', overrides: [1] as any }, featureId: bunker.id })).rejects.toThrow(/overrides must be an object/);
    const pondRecipe = await svc.create({ siteId, op: 'recipe', params: { recipe: 'pond' }, featureId: pond.id });
    await expect(svc.update(pondRecipe.id, 1, { params: { recipe: 'conway' } })).rejects.toThrow(/not lake/);
    await expect(svc.update(pondRecipe.id, 1, { op: 'plane' })).rejects.toThrow(/cannot become or stop being a recipe/);
    const plane = await svc.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });
    await expect(svc.update(plane.id, 1, { op: 'recipe' })).rejects.toThrow(/cannot become or stop being a recipe/);
    await expect(svc.create({ siteId, op: 'plane', params: {}, rings: [SQUARE] })).rejects.toThrow(/featherM/);
});

test("overrides set the recipe's declared params within their ranges, and the seed", async () => {
    const { siteId, svc, bunker, pond } = await recipeSetup();
    const edit = await svc.create({ siteId, op: 'recipe', params: { recipe: 'conway', overrides: { depth: 1.2, lipHeight: 0.5, seed: 28 } }, featureId: bunker.id });
    expect(edit.params.overrides).toEqual({ depth: 1.2, lipHeight: 0.5, seed: 28 });
    const refused = async (overrides: Record<string, unknown>, recipe = 'conway') =>
        svc.update(edit.id, 1, { params: { recipe, overrides } }).then(() => 'saved', e => (e instanceof InvalidRecipeEditError ? e.message : `other: ${e}`));
    expect(await refused({ rings: 3 })).toMatch(/Recipe 'conway' has no param 'rings' \(overrides takes depth, lipHeight, seed\)/);
    expect(await refused({ depth: 1.25 })).toMatch(/overrides.depth must be within 0.2..1.2 \(got 1.25\)/);
    expect(await refused({ lipHeight: 0.4 })).toMatch(/within 0.5..2/);
    expect(await refused({ depth: '0.5' })).toMatch(/overrides.depth must be a number/);
    expect(await refused({ depth: null })).toMatch(/must be a number/);
    expect(await refused({ seed: 1.5 })).toMatch(/overrides.seed must be an integer/);
    expect(await refused({ seed: '3' })).toMatch(/seed must be an integer/);
    // A recipe without params (and no recipe at all) takes only the seed.
    expect(await refused({ depth: 0.5 }, 'none')).toMatch(/Recipe 'none' has no param 'depth' \(overrides takes seed\)/);
    expect((await svc.update(edit.id, 1, { params: { recipe: 'none', overrides: { seed: 3 } } })).params).toEqual({ featherM: 0, recipe: 'none', overrides: { seed: 3 } });
    await expect(svc.create({ siteId, op: 'recipe', params: { recipe: 'pond', overrides: { depth: 0.5 } }, featureId: pond.id }))
        .rejects.toThrow(/Recipe 'pond' has no param 'depth'/);
    // Empty overrides are not stored.
    expect((await svc.update(edit.id, 2, { params: { recipe: 'conway', overrides: {} } })).params).toEqual({ featherM: 0, recipe: 'conway' });
});

test('without a library (not built yet) any plain recipe id is taken', async () => {
    const { siteId, svc, bunker } = await recipeSetup(null);
    const edit = await svc.create({ siteId, op: 'recipe', params: { recipe: 'cesimgolf-conway', overrides: { depth: 5, seed: 2 } }, featureId: bunker.id });
    expect(edit.params).toEqual({ featherM: 0, recipe: 'cesimgolf-conway', overrides: { depth: 5, seed: 2 } });
    await expect(svc.update(edit.id, 1, { params: { recipe: 'cesimgolf-conway', overrides: { depth: 'deep' } } })).rejects.toThrow(/must be a number/);
    await expect(svc.update(edit.id, 1, { params: { recipe: '../x y' } })).rejects.toThrow(/recipe library id/);
});

test('recipe edits are course-scoped: only a feature of a course on the edit\'s site', async () => {
    const { db, svc, bunker } = await recipeSetup();
    const other = await new SitesService(db).create({ name: 'Elsewhere' });
    await expect(svc.create({ siteId: other.id, op: 'recipe', params: { recipe: 'conway' }, featureId: bunker.id }))
        .rejects.toThrow(/is not on a course of site/);
});

test('recipe edits are not DEM edits: the DEM replays leave them out, generations cannot touch them', async () => {
    const { siteId, svc, bunker } = await recipeSetup();
    const recipe = await svc.create({ siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: bunker.id });
    const plane = await svc.create({ siteId, op: 'plane', params: { featherM: 2 }, rings: [SQUARE] });
    await svc.create({ siteId, op: 'smooth', params: { featherM: 2, radiusM: 3 }, rings: [SQUARE], enabled: false });
    expect(isDemEdit(recipe)).toBe(false);
    expect((await svc.listDemEdits(siteId)).map(e => e.id)).toEqual([plane.id]);
    expect((await svc.listBySite(siteId)).map(e => e.id)).toContain(recipe.id);
    await expect(svc.replaceByOrigin(siteId, RECIPE_ORIGIN, [])).rejects.toBeInstanceOf(InvalidTerrainEditError);
    await expect(svc.replaceByOrigin(siteId, 'x', [{ op: 'recipe', params: { featherM: 0, recipe: 'conway' }, rings: [SQUARE] }]))
        .rejects.toThrow(/one per feature/);
    const parsed = parseEditsGeojson({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { op: 'recipe' },
        geometry: { type: 'Polygon', coordinates: [[[15, 58], [15.001, 58], [15.001, 58.001], [15, 58]]] } }] });
    expect(parsed.edits).toHaveLength(0);
    expect((await svc.get(recipe.id)).enabled).toBe(true);
});

test('the API answers a refused recipe edit with 400 (other terrain-edit errors are unchanged)', async () => {
    const { siteId, svc, bunker, green } = await recipeSetup();
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('user', { id: 'user-1', username: 'tester' });
        await next();
    });
    mount(app, '/api', createTerrainEditsApi(svc));
    const post = (route: string, body: unknown) => app.request(`/api/terrain-edits/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const unknown = await post('create', { siteId, op: 'recipe', params: { recipe: 'gone' }, featureId: bunker.id });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error: string }).error).toMatch(/Unknown recipe 'gone'/);
    expect((await post('create', { siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: green.id })).status).toBe(400);

    const ok = await post('create', { siteId, op: 'recipe', params: { recipe: 'conway' }, featureId: bunker.id });
    expect(ok.status).toBe(200);
    const edit = await ok.json() as { id: string; op: string };
    expect(edit.op).toBe('recipe');
    expect((await post('update', { id: edit.id, version: 1, params: { recipe: 'conway', overrides: [] } })).status).toBe(400);
    const outOfRange = await post('update', { id: edit.id, version: 1, params: { recipe: 'conway', overrides: { depth: 3 } } });
    expect(outOfRange.status).toBe(400);
    expect((await outOfRange.json() as { error: string }).error).toMatch(/overrides.depth must be within/);
    expect((await post('update', { id: edit.id, version: 1, params: { recipe: 'conway', overrides: { lipRaggedness: 1 } } })).status).toBe(400);
    expect((await post('update', { id: edit.id, version: 1, params: { recipe: 'conway', overrides: { depth: 0.8, seed: 4 } } })).status).toBe(200);
    expect((await post('create', { siteId, op: 'recipe', params: { recipe: 'none' }, featureId: bunker.id })).status).toBe(409);
    expect((await post('create', { siteId, op: 'plane', params: {}, rings: [SQUARE] })).status).toBe(500);
});
