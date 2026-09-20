import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse } from '../db/seeds/course';
import { SitesService } from './sites.service';
import { TerrainEditsService, InvalidTerrainEditError, parseEditsGeojson, type TerrainEditRing } from './terrain-edits.service';
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
