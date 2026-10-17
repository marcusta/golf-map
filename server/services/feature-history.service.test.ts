import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { sql } from 'kysely';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { CourseFeaturesService } from './course-features.service';
import { FeatureHistoryService, SNAPSHOT_DIR } from './feature-history.service';
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

const BEFORE = '2000-06-01 00:00:00';
const SEED_GREEN = `${TEST_COURSE_ID}-feature-green-1`;

/**
 * A course with a fairway and semi rough on hole 1 and a course-level bunker,
 * all made "long ago" (before BEFORE), then edited now through the real
 * service: the fairway reshaped, the bunker deleted, a new fairway drawn.
 */
async function editedCourse() {
    const ctx = await createTestDb(seedCourse);
    const features = new CourseFeaturesService(ctx.db);
    const fairway = await features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: square(0, 0) });
    const semi = await features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'semi_rough', geometry: square(20, 0) });
    const bunker = await features.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: square(40, 0) });
    // Everything so far happened long ago: the rows and the history the setup's creates wrote (stacking shifts).
    await ctx.db.updateTable('course_features').set({ created_at: '2000-01-01 00:00:00', updated_at: '2000-01-01 00:00:00' })
        .where('course_id', '=', TEST_COURSE_ID).execute();
    await ctx.db.updateTable('course_feature_history').set({ changed_at: '2000-01-01 00:00:00.000' }).execute();

    const reshaped = await features.update(fairway.id, fairway.version, { geometry: square(0, 0, 8) });
    await features.remove(bunker.id, bunker.version);
    const added = await features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'fairway', geometry: square(60, 0) });
    return { ...ctx, features, history: new FeatureHistoryService(ctx.db), fairway, reshaped, semi, bunker, added };
}

test('the state at a past time undoes edits, restores deleted features and drops new ones', async () => {
    const t = await editedCourse();

    const { state, unknown } = await t.history.stateAt(TEST_COURSE_ID, BEFORE);

    expect([...state.keys()].sort()).toEqual([SEED_GREEN, t.fairway.id, t.semi.id, t.bunker.id].sort());
    expect(JSON.parse(String(state.get(t.fairway.id)!.geometry_json))).toEqual(JSON.parse(JSON.stringify(square(0, 0))));
    expect(state.get(t.bunker.id)!.type).toBe('bunker');
    expect(unknown).toEqual([]);
});

test('the changes since then are numbered: added, edited, removed - not the features a new one pushed up', async () => {
    const t = await editedCourse();
    const { state } = await t.history.stateAt(TEST_COURSE_ID, BEFORE);

    const changes = await t.history.changes(TEST_COURSE_ID, state, await t.history.current(TEST_COURSE_ID));

    expect(changes.map(c => [c.n, c.kind, c.id, c.type, c.hole])).toEqual([
        [1, 'added', t.added.id, 'fairway', 1],
        [2, 'edited', t.fairway.id, 'fairway', 1],
        [3, 'removed', t.bunker.id, 'bunker', null],
    ]);
});

test('a reorder is one restack: the feature that moved, not everything it passed', async () => {
    const t = await editedCourse();
    const third = await t.features.create({ courseId: TEST_COURSE_ID, holeId: TEST_HOLE_1_ID, type: 'semi_rough', geometry: square(80, 0) });
    const before = await t.history.current(TEST_COURSE_ID);
    const group = [...before.values()].filter(r => r.hole_id === TEST_HOLE_1_ID)
        .sort((a, b) => a.sort_order - b.sort_order).map(r => r.id);

    // Drag the top feature to the bottom.
    await t.features.reorder(TEST_COURSE_ID, TEST_HOLE_1_ID, [group[group.length - 1], ...group.slice(0, -1)]);
    const changes = await t.history.changes(TEST_COURSE_ID, before, await t.history.current(TEST_COURSE_ID));

    expect(changes.map(c => [c.kind, c.id])).toEqual([['restacked', group[group.length - 1]]]);
    expect(changes[0].detail).toBe(`rank ${group.length} -> 1 of ${group.length}`);
    expect(third.id).toBeTruthy();
});

test('an edit from before the history existed is reported, not silently kept', async () => {
    const t = await editedCourse();
    // A change the triggers never saw: only the timestamp moves (as for rows edited before migration 025).
    await t.db.updateTable('course_features').set({ updated_at: '2001-01-01 00:00:00' }).where('id', '=', t.semi.id).execute();

    const { unknown } = await t.history.stateAt(TEST_COURSE_ID, BEFORE);

    expect(unknown).toEqual([t.semi.id]);
});

test('a variant database holds the chosen mix for the course and leaves everything else as it was', async () => {
    const t = await editedCourse();
    const { state: before } = await t.history.stateAt(TEST_COURSE_ID, BEFORE);
    const now = await t.history.current(TEST_COURSE_ID);
    const others = await t.db.selectFrom('course_features').select(({ fn }) => fn.countAll<number>().as('n'))
        .where('course_id', '!=', TEST_COURSE_ID).executeTakeFirstOrThrow();

    // Only the reshaped fairway applied: the bunker is back, the new fairway is not there.
    const rows = FeatureHistoryService.mix(before, now, new Set([t.fairway.id]));
    const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'bisect-')), 'variant.sqlite');
    await t.history.writeVariantDb(TEST_COURSE_ID, rows, out);

    const copy = new SqliteDatabase(out, { readonly: true });
    const got = copy.query('SELECT id, geometry_json FROM course_features WHERE course_id = ? ORDER BY id').all(TEST_COURSE_ID) as { id: string; geometry_json: string }[];
    const otherCount = (copy.query('SELECT COUNT(*) AS n FROM course_features WHERE course_id != ?').get(TEST_COURSE_ID) as { n: number }).n;
    const triggers = copy.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'course_features_history%'").all();
    copy.close();

    expect(got.map(r => r.id).sort()).toEqual([SEED_GREEN, t.fairway.id, t.semi.id, t.bunker.id].sort());
    expect(got.find(r => r.id === t.fairway.id)!.geometry_json).toBe(String(now.get(t.fairway.id)!.geometry_json));
    expect(otherCount).toBe(Number(others.n));
    expect(triggers).toEqual([]);
    // The app database is untouched.
    expect((await t.history.current(TEST_COURSE_ID)).has(t.added.id)).toBe(true);
});

test('an export snapshot keeps the SVG, its road-surface sidecar and the features, and reads back as the state it was taken from', async () => {
    const t = await editedCourse();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const svg = path.join(dir, 'linkan.svg');
    await writeFile(svg, '<svg/>');
    await writeFile(path.join(dir, 'linkan-paths.json'), '{}');

    const folder = await t.history.snapshot(TEST_COURSE_ID, dir, svg, new Date(2026, 8, 26, 18, 32, 4));
    const listed = await FeatureHistoryService.listSnapshots(dir);
    const state = await FeatureHistoryService.readSnapshot(folder);

    expect(path.relative(dir, folder)).toBe(path.join(SNAPSHOT_DIR, '2026-09-26_18-32-04'));
    expect((await readdir(folder)).sort()).toEqual(['export.json', 'features.json', 'linkan-paths.json', 'linkan.svg']);
    expect(listed.map(s => [s.name, s.features, s.svg, s.build])).toEqual([['2026-09-26_18-32-04', 4, 'linkan.svg', null]]);
    expect(await t.history.changes(TEST_COURSE_ID, state, await t.history.current(TEST_COURSE_ID))).toEqual([]);
});

test('terrain edits keep their earlier versions too', async () => {
    const t = await editedCourse();
    await sql`INSERT INTO sites (id, name, version) VALUES ('s1', 'Site', 1)`.execute(t.db);
    await sql`INSERT INTO terrain_edits (id, site_id, op, params_json, rings_json, enabled, version) VALUES ('e1', 's1', 'plane', '{}', '[]', 1, 1)`.execute(t.db);
    await t.db.updateTable('terrain_edits').set({ params_json: '{"featherM":2}' }).where('id', '=', 'e1').execute();
    await t.db.deleteFrom('terrain_edits').where('id', '=', 'e1').execute();

    const rows = await t.db.selectFrom('terrain_edit_history').select(['op', 'row_json']).orderBy('history_id').execute();

    expect(rows.map(r => [r.op, JSON.parse(r.row_json).params_json])).toEqual([['update', '{}'], ['delete', '{"featherM":2}']]);
});

// --- Counting changes since a moment (the GSPro status board's "changed since") ---

test('changes since a moment are counted per feature type, deletions included', async () => {
    const t = await editedCourse();
    // editedCourse made everything long ago, then (now) reshaped the fairway,
    // deleted the bunker and drew a second fairway.
    const since = '2000-06-01T00:00:00.000Z';

    // With no last run there is nothing to count from.
    expect(await t.history.countChangesSince(TEST_COURSE_ID, null)).toEqual({ count: 0, kinds: [] });
    // Narrowed to the types one target cares about.
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, ['fairway'])).toEqual({ count: 2, kinds: ['fairway'] });
    // The deleted bunker is only in the history, and it still counts.
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, ['bunker'])).toEqual({ count: 1, kinds: ['bunker'] });
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, ['water'])).toEqual({ count: 0, kinds: [] });
    const all = await t.history.countChangesSince(TEST_COURSE_ID, since);
    expect(all.kinds).toContain('bunker');
    expect(all.kinds).toContain('fairway');
    expect(all.count).toBeGreaterThanOrEqual(3);

    // Nothing has changed since this instant.
    expect(await t.history.countChangesSince(TEST_COURSE_ID, new Date(Date.now() + 1000).toISOString()))
        .toEqual({ count: 0, kinds: [] });
});

test('generated features are not counted: the next pipeline run replaces them wholesale', async () => {
    const t = await editedCourse();
    const since = '2000-06-01T00:00:00.000Z';
    const before = await t.history.countChangesSince(TEST_COURSE_ID, since, ['trees']);
    expect(before).toEqual({ count: 0, kinds: [] });

    await t.features.replaceGenerated(TEST_COURSE_ID, 'canopy', {
        type: 'FeatureCollection',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
        features: [{
            type: 'Feature',
            properties: { type: 'trees', source: 'canopy' },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] },
        }],
    });

    expect(await t.db.selectFrom('course_features').select('id').where('generated', '=', 1).execute()).toHaveLength(1);
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, ['trees'])).toEqual({ count: 0, kinds: [] });
});

test('latestStamp moves on a create, an edit and a delete — inside the same second too — but not on a generator run', async () => {
    const t = await editedCourse();
    const features = new CourseFeaturesService(t.db);
    const first = await t.history.latestStamp(TEST_COURSE_ID);
    expect(await t.history.latestStamp(TEST_COURSE_ID)).toBe(first);   // read twice, same stamp

    const drawn = await features.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: square(60, 0) });
    const created = await t.history.latestStamp(TEST_COURSE_ID);
    expect(created).not.toBe(first);

    // An edit and a delete in the same second as the stamp: the history row id catches them.
    const edited = await features.update(drawn.id, drawn.version, { geometry: square(60, 0, 7) });
    const afterEdit = await t.history.latestStamp(TEST_COURSE_ID);
    expect(afterEdit).not.toBe(created);
    await features.remove(edited.id, edited.version);
    expect(await t.history.latestStamp(TEST_COURSE_ID)).not.toBe(afterEdit);

    // Generated rows are pipeline output the next run replaces wholesale: they are not edits.
    const before = await t.history.latestStamp(TEST_COURSE_ID);
    await features.replaceGenerated(TEST_COURSE_ID, 'tall-grass', {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] },
            properties: { type: 'vegetation_zone', source: 'tall-grass', zoneType: 'rough_tall', weight: 1, feather: 1, noise: 0 },
        }],
    });
    expect(await t.history.latestStamp(TEST_COURSE_ID)).toBe(before);
});

test('a generator run that shifts the hand-drawn features above its zones is no edit of theirs', async () => {
    // A planting (`replaceGenerated`) inserts its zones at the bottom of the course-level stack,
    // which pushes every hand-drawn feature there up one. That shift used to move their
    // `updated_at`, so an Update vegetation marked Shapes, Trees, Creeks and Meshes stale on the
    // GSPro board and invalidated every export fingerprint that hashes `latestStamp`.
    const ctx = await createTestDb(seedCourse);
    const features = new CourseFeaturesService(ctx.db);
    const t = { db: ctx.db, history: new FeatureHistoryService(ctx.db) };
    const bunker = await features.create({ courseId: TEST_COURSE_ID, type: 'bunker', geometry: square(100, 0) });
    const water = await features.create({ courseId: TEST_COURSE_ID, type: 'water', geometry: square(140, 0) });
    // Drawn long ago (with the history the creates' own stacking shifts wrote), so only what
    // follows can count as a change since.
    await ctx.db.updateTable('course_features').set({ created_at: '2000-01-01 00:00:00', updated_at: '2000-01-01 00:00:00' })
        .where('course_id', '=', TEST_COURSE_ID).execute();
    await ctx.db.updateTable('course_feature_history').set({ changed_at: '2000-01-01 00:00:00.000' }).execute();
    const since = '2000-06-01T00:00:00.000Z';
    const types = ['bunker', 'water'];
    const stackOf = async () => new Map((await features.listByCourse(TEST_COURSE_ID)).map(f => [f.id, f.sortOrder]));
    const before = await stackOf();
    const stamp = await t.history.latestStamp(TEST_COURSE_ID);
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, types)).toEqual({ count: 0, kinds: [] });

    const zone = (x: number) => ({
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 0]]] },
        properties: { type: 'vegetation_zone', source: 'tall-grass', zoneType: 'rough_tall', weight: 1, feather: 1, noise: 0 },
    });
    await features.replaceGenerated(TEST_COURSE_ID, 'tall-grass', {
        type: 'FeatureCollection', features: [zone(0), zone(20)],
    } as never);

    // The stack really did move (the zones went in under them) — and nothing counts as changed.
    const after = await stackOf();
    expect(after.get(bunker.id)).toBe(before.get(bunker.id)! + 2);
    expect(after.get(water.id)).toBe(before.get(water.id)! + 2);
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, types)).toEqual({ count: 0, kinds: [] });
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since)).toEqual({ count: 0, kinds: [] });
    expect(await t.history.latestStamp(TEST_COURSE_ID)).toBe(stamp);

    // An edit somebody made still counts, and still moves the stamp.
    await features.update(bunker.id, bunker.version, { geometry: square(100, 0, 9) });
    expect(await t.history.countChangesSince(TEST_COURSE_ID, since, types)).toEqual({ count: 1, kinds: ['bunker'] });
    expect(await t.history.latestStamp(TEST_COURSE_ID)).not.toBe(stamp);
});

test('the newest export snapshot is found without parsing every one of them', async () => {
    const t = await editedCourse();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-snap-'));
    expect(await FeatureHistoryService.latestSnapshot(dir)).toBeNull();

    await writeFile(path.join(dir, 'linkan.svg'), '<svg/>');
    await t.history.snapshot(TEST_COURSE_ID, dir, path.join(dir, 'linkan.svg'), new Date('2026-09-26T18:32:04'));
    await t.history.snapshot(TEST_COURSE_ID, dir, path.join(dir, 'linkan.svg'), new Date('2026-09-27T09:00:00'));

    const latest = (await FeatureHistoryService.latestSnapshot(dir))!;
    expect(latest.name).toBe('2026-09-27_09-00-00');
    expect(latest.exportedAt).toBe(new Date('2026-09-27T09:00:00').toISOString());
});

test('export.json records the code and the report, and takes the OPCD build later; last good is the newest ok build', async () => {
    const t = await editedCourse();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-rec-'));
    const svg = path.join(dir, 'linkan.svg');
    await writeFile(svg, '<svg/>');
    const code = { sha: 'abc123', dirty: '0123456789abcdef', dirtyFiles: ['gspro.py'] };
    const first = await t.history.snapshot(TEST_COURSE_ID, dir, svg, new Date('2026-10-17T12:46:25'), { code, report: ['wrote linkan.svg'] });
    const second = await t.history.snapshot(TEST_COURSE_ID, dir, svg, new Date('2026-10-17T13:10:26'));

    const record = (await FeatureHistoryService.readExportRecord(first))!;
    expect(record).toMatchObject({ code, report: ['wrote linkan.svg'], build: null, exportedAt: new Date('2026-10-17T12:46:25').toISOString() });
    expect(FeatureHistoryService.lastGood(await FeatureHistoryService.listSnapshots(dir))).toBeNull();

    const build = (outcome: 'ok' | 'failed', created: string) =>
        ({ opcdCreated: created, job: 'linkan.svg', status: outcome === 'ok' ? 'Processing Complete' : 'Draft', outcome, checkedAt: '2026-10-17T14:00:00.000Z' });
    await FeatureHistoryService.recordBuild(first, build('ok', '2026-10-17 06:46'));
    await FeatureHistoryService.recordBuild(second, build('failed', '2026-10-17 07:10'));

    const snaps = await FeatureHistoryService.listSnapshots(dir);
    expect(snaps.map(s => s.build?.outcome)).toEqual(['ok', 'failed']);
    expect(FeatureHistoryService.lastGood(snaps)!.name).toBe('2026-10-17_12-46-25');
    expect((await FeatureHistoryService.latestSnapshot(dir))!.build!.outcome).toBe('failed');
    // The code and the report survive the build being written.
    expect((await FeatureHistoryService.readExportRecord(first))!.code).toEqual(code);
});

test('a snapshot from before export.json gets one when its build is recorded', async () => {
    const t = await editedCourse();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-old-'));
    await writeFile(path.join(dir, 'linkan.svg'), '<svg/>');
    const folder = await t.history.snapshot(TEST_COURSE_ID, dir, path.join(dir, 'linkan.svg'), new Date('2026-10-15T22:50:19'));
    await rm(path.join(folder, 'export.json'));
    expect(await FeatureHistoryService.readExportRecord(folder)).toBeNull();

    await FeatureHistoryService.recordBuild(folder, { opcdCreated: '2026-10-15 16:52', job: 'linkan.svg', status: 'Draft', outcome: 'failed', checkedAt: '2026-10-17T14:00:00.000Z' });

    expect(await FeatureHistoryService.readExportRecord(folder)).toMatchObject({ code: null, report: [], build: { outcome: 'failed' } });
});

test('the board reads the newest exports and the last good one from export.json alone', async () => {
    const t = await editedCourse();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-builds-'));
    await writeFile(path.join(dir, 'linkan.svg'), '<svg/>');
    const folders: string[] = [];
    for (const hour of [9, 10, 11, 12, 13, 14]) {
        folders.push(await t.history.snapshot(TEST_COURSE_ID, dir, path.join(dir, 'linkan.svg'), new Date(2026, 9, 17, hour, 0, 0)));
    }
    const build = (outcome: 'ok' | 'failed') => ({ opcdCreated: '2026-10-17 03:00', job: 'linkan.svg', status: outcome === 'ok' ? 'Processing Complete' : 'Draft', outcome, checkedAt: '2026-10-17T14:00:00.000Z' });
    await FeatureHistoryService.recordBuild(folders[0], build('ok'));
    await FeatureHistoryService.recordBuild(folders[4], build('failed'));
    await FeatureHistoryService.recordBuild(folders[5], build('failed'));

    const builds = await FeatureHistoryService.exportBuilds(dir);

    expect(builds.map(b => `${b.snapshot} ${b.outcome ?? '-'}${b.lastGood ? ' last-good' : ''}`)).toEqual([
        '2026-10-17_14-00-00 failed', '2026-10-17_13-00-00 failed', '2026-10-17_12-00-00 -', '2026-10-17_11-00-00 -',
        '2026-10-17_09-00-00 ok last-good',
    ]);
    expect(await FeatureHistoryService.exportBuilds(path.join(dir, 'nowhere'))).toEqual([]);
});
