import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs';
import { createTestDb as createRawDb } from '@basics/core/server/testing';
import type { Kysely } from 'kysely';
import { createServices } from '../services/index';
import type { Database } from '../db/schema';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { buildBundle, packBundle } from '../scripts/publish';
import { IngestService, IngestBlockedError } from './ingest.service';

const migrationFolder = path.join(import.meta.dir, '../db/migrations');
const SITE_ID = 'site-1';

function tmp(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `golf-${prefix}-`));
}

/** A fresh migrated DB (no fixed dataDir), for either the builder or VPS side. */
async function freshDb(): Promise<Kysely<Database>> {
    return createRawDb<Database>(migrationFolder);
}

/**
 * Seeds the builder side: a site, the standard 2-hole course wired to it, a
 * dem_cog asset, and a synthetic tile tree (ortho z14/z19/z20 + a non-numeric
 * collection subdir, plus terrain/hillshade) with a manifest.
 */
async function seedBuilder(db: Kysely<Database>, dataDir: string): Promise<void> {
    await db.insertInto('sites').values({ id: SITE_ID, name: 'Linkan', version: 1 }).execute();
    await seedCourse({ db } as never);
    await db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();

    // Synthetic tiles under dataDir/tiles/<site>.
    const tilesRoot = path.join(dataDir, 'tiles', SITE_ID);
    const writeTile = (rel: string) => {
        const p = path.join(tilesRoot, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, 'x');
    };
    writeTile('ortho/14/1/1.jpg');
    writeTile('ortho/19/1/1.jpg');
    writeTile('ortho/20/1/1.jpg'); // above the cap — must be excluded
    writeTile('ortho/vintage-2023/19/1/1.jpg'); // collection subdir — must be skipped
    writeTile('terrain/14/1/1.png');
    writeTile('hillshade/14/1/1.png');
    writeFileSync(
        path.join(tilesRoot, 'manifest.json'),
        JSON.stringify({
            layers: {
                ortho: { minzoom: 14, maxzoom: 20 },
                terrain: { minzoom: 14, maxzoom: 14 },
                hillshade: { minzoom: 14, maxzoom: 14 },
            },
        }),
    );

    // dem_cog asset + file.
    const demDir = path.join(dataDir, 'dem', SITE_ID);
    mkdirSync(demDir, { recursive: true });
    writeFileSync(path.join(demDir, 'dem-analysis.tif'), 'DEMDATA');
    await db
        .insertInto('course_assets')
        .values({
            id: 'asset-dem',
            course_id: TEST_COURSE_ID,
            site_id: SITE_ID,
            kind: 'dem_cog',
            filename: `dem/${SITE_ID}/dem-analysis.tif`,
            meta_json: null,
            version: 1,
        })
        .execute();
}

/** Builds + packs a bundle from the builder DB, returns the tar.zst path. */
async function makeBundle(db: Kysely<Database>, dataDir: string, orthoMaxzoom?: number): Promise<string> {
    const outDir = tmp('stage');
    const { stagingDir } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir, orthoMaxzoom });
    const bundlePath = path.join(outDir, `${SITE_ID}.tar.zst`);
    await packBundle(stagingDir, bundlePath);
    return bundlePath;
}

describe('ingest (serve-mode publish apply)', () => {
    test('first publish installs content, tiles (z20 excluded), symlink, DEM, assets, seed pins', async () => {
        const builderDb = await freshDb();
        const builderData = tmp('builder');
        await seedBuilder(builderDb, builderData);
        const bundlePath = await makeBundle(builderDb, builderData);

        // --- VPS side ---
        const vpsDb = await freshDb();
        const vpsData = tmp('vps');
        const ingest = new IngestService({ db: vpsDb, dataDir: vpsData });
        const report = await ingest.ingestArchive(bundlePath);

        // Content applied.
        expect(report.upserted.sites).toBe(1);
        expect(report.upserted.courses).toBe(1);
        expect(report.upserted.holes).toBe(2);
        expect(report.upserted.greens).toBe(2);
        expect(report.upserted.tees).toBe(4);
        expect(Object.values(report.deleted).every((n) => n === 0)).toBe(true);

        const course = await vpsDb.selectFrom('courses').selectAll().where('id', '=', TEST_COURSE_ID).executeTakeFirst();
        expect(course?.site_id).toBe(SITE_ID);
        const holeCount = await vpsDb.selectFrom('holes').select('id').execute();
        expect(holeCount.length).toBe(2);

        // Tiles installed; z20 excluded; z14/z19 present; collection subdir gone.
        const liveTiles = path.join(vpsData, 'tiles', SITE_ID);
        expect(existsSync(path.join(liveTiles, 'ortho/14/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(liveTiles, 'ortho/19/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(liveTiles, 'ortho/20/1/1.jpg'))).toBe(false);
        expect(existsSync(path.join(liveTiles, 'ortho/vintage-2023'))).toBe(false);
        expect(existsSync(path.join(liveTiles, 'terrain/14/1/1.png'))).toBe(true);

        // Manifest capped.
        const manifest = JSON.parse(await Bun.file(path.join(liveTiles, 'manifest.json')).text());
        expect(manifest.layers.ortho.maxzoom).toBe(19);

        // courseId → siteId symlink (course-1 differs from site-1).
        const link = path.join(vpsData, 'tiles', TEST_COURSE_ID);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(SITE_ID);
        expect(report.symlinks).toContain(TEST_COURSE_ID);

        // DEM installed.
        expect(report.demInstalled).toBe(true);
        expect(existsSync(path.join(vpsData, 'dem', SITE_ID, 'dem-analysis.tif'))).toBe(true);

        // Assets rewritten to published artifacts.
        const assets = await vpsDb.selectFrom('course_assets').selectAll().where('site_id', '=', SITE_ID).execute();
        const kinds = assets.map((a) => a.kind).sort();
        expect(kinds).toEqual(['dem_cog', 'tile_manifest']);
        expect(report.assetsRewritten).toBe(2);

        // Seed pins applied on the empty VPS.
        const pins = await vpsDb.selectFrom('pins').select('id').execute();
        expect(pins.length).toBe(4); // 2 pins per green * 2 greens
    });

    test('tile count includes all layers', async () => {
        const builderDb = await freshDb();
        const builderData = tmp('builder');
        await seedBuilder(builderDb, builderData);
        const bundlePath = await makeBundle(builderDb, builderData);
        const vpsDb = await freshDb();
        const vpsData = tmp('vps');
        const report = await new IngestService({ db: vpsDb, dataDir: vpsData }).ingestArchive(bundlePath);
        // ortho z14 + z19 (z20 excluded) + terrain z14 + hillshade z14.
        expect(report.tilesInstalled).toBe(4);
    });

    test('double publish is idempotent and does not re-seed pins', async () => {
        const builderDb = await freshDb();
        const builderData = tmp('builder');
        await seedBuilder(builderDb, builderData);

        const vpsDb = await freshDb();
        const vpsData = tmp('vps');
        const ingest = new IngestService({ db: vpsDb, dataDir: vpsData });

        await ingest.ingestArchive(await makeBundle(builderDb, builderData));

        // A user re-places a pin on the VPS between publishes (user data).
        await vpsDb.deleteFrom('pins').execute();
        await vpsDb
            .insertInto('pins')
            .values({ id: 'user-pin', green_id: 'green-1', name: 'User Pin', lat: 58.4, lon: 15.56, difficulty: 'easy', active: 1, version: 1 })
            .execute();

        const report2 = await ingest.ingestArchive(await makeBundle(builderDb, builderData));

        // Content re-upserted, nothing deleted.
        expect(report2.upserted.courses).toBe(1);
        expect(Object.values(report2.deleted).every((n) => n === 0)).toBe(true);

        // Pins were NOT re-seeded — the user's single pin survives untouched.
        const pins = await vpsDb.selectFrom('pins').select('id').execute();
        expect(pins.map((p) => p.id)).toEqual(['user-pin']);
    });

    test('deleting a course that has user rounds is blocked with a 409 report', async () => {
        // Builder publishes site-1 with course-1 only.
        const builderDb = await freshDb();
        const builderData = tmp('builder');
        await seedBuilder(builderDb, builderData);
        const bundlePath = await makeBundle(builderDb, builderData);

        // VPS already hosts site-1 with a DIFFERENT course that has a round.
        const vpsDb = await freshDb();
        const vpsData = tmp('vps');
        await vpsDb.insertInto('sites').values({ id: SITE_ID, name: 'Linkan', version: 1 }).execute();
        await vpsDb
            .insertInto('courses')
            .values({ id: 'course-old', name: 'Old', status: 'published', revision: 1, crs: 'EPSG:3006', georeference_json: null, home_lat: null, home_lon: null, notes: null, site_id: SITE_ID, version: 1 })
            .execute();
        await vpsDb
            .insertInto('rounds')
            .values({ id: 'round-1', course_id: 'course-old', user_id: null, started_at: new Date().toISOString(), ended_at: null, notes: null, game_plan_id: null, wind_speed_mps: null, wind_direction_deg: null, stimp_ft: null, version: 1 })
            .execute();

        const ingest = new IngestService({ db: vpsDb, dataDir: vpsData });

        let err: unknown;
        try {
            await ingest.ingestArchive(bundlePath);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(IngestBlockedError);
        const blockers = (err as IngestBlockedError).detail.blockers;
        expect(blockers.some((b) => b.table === 'courses' && b.id === 'course-old' && b.referencedBy === 'rounds.course_id')).toBe(true);

        // Abort was clean: course-old + its round survive, no tiles swapped in.
        expect((await vpsDb.selectFrom('rounds').select('id').execute()).length).toBe(1);
        expect((await vpsDb.selectFrom('courses').select('id').where('id', '=', 'course-old').execute()).length).toBe(1);
        expect(existsSync(path.join(vpsData, 'tiles', SITE_ID))).toBe(false);
    });
});
