/**
 * E2E database seeder — builds an ISOLATED, freshly-migrated sqlite for the
 * smoke suite so tests are deterministic and never touch dev data/app.sqlite.
 *
 * Reuses the SAME seed functions the server unit tests use (users + course +
 * clubs) via createDb + runMigrations, then inserts ONE extra row the unit
 * seeds don't: a `tile_manifest` course asset. Without it TilesetService.
 * hasTiles stays false, the editor map never inits, MapService.ready never
 * flips true — and the toolbar/planner map chrome (gated on `ready`) never
 * renders. The manifest only needs valid bounds/zoom/generatedAt; the tile
 * BYTES 404 (no pyramid on disk), which MapLibre tolerates — the style has no
 * glyphs/sprites, so `map.on('load')` still fires and the map reaches ready.
 *
 * Lives in server/ (not e2e/) because @basics/core is a workspace `file:` dep
 * resolvable only from server/web node_modules — Bun resolves from the file's
 * directory. The e2e global-setup spawns this as `bun db/seed-e2e.ts <path>`
 * with cwd=server. Run standalone: `bun db/seed-e2e.ts <db-path>` (cwd server).
 */
import { sql } from 'kysely';
import { writeArrayBuffer } from 'geotiff';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import { createServices } from '../services/index';
import type { Database } from '../db/schema';
import type { FeatureGeometry } from '../services/geo';
import { seedUsers, TEST_USER_ID } from './seeds/users';
import { seedCourse, TEST_COURSE_ID } from './seeds/course';
import { seedClubs } from './seeds/clubs';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Seeded course home coords (server/db/seeds/course.ts). Manifest bounds hug this. */
const HOME_LAT = 58.4015;
const HOME_LON = 15.5658;

/**
 * A minimal-but-valid tile manifest (see web tileset.service parseTileManifest).
 * Bounds are a small box around the seeded course home so MapLibre's initial
 * fitBounds lands sensibly; tile bytes themselves are never fetched to disk.
 */
function tileManifestJson(): string {
    return JSON.stringify({
        bounds: {
            west: HOME_LON - 0.01,
            south: HOME_LAT - 0.01,
            east: HOME_LON + 0.01,
            north: HOME_LAT + 0.01,
        },
        layers: {
            ortho: { minzoom: 12, maxzoom: 20 },
            terrain: { minzoom: 12, maxzoom: 17 },
        },
        elevation: { min: 70, max: 90 },
        generatedAt: '2026-07-06T00:00:00Z',
        attribution: 'e2e',
    });
}

// ─── Putt-read green surface (feature-putting-green-reading §5.1) ──────────
//
// The putt-read E2E flow (e2e/tests/06-putt-read.spec.ts) needs a REAL green
// surface: PuttReadService.activate fetches the analysis sampleGrid for the
// hole's green FEATURE, whose geometry defines the EPSG:3006 frame the read
// samples in. The unit seed (server/db/seeds/course.ts) gives hole 1 a
// PLACEHOLDER green feature at (0,0)–(10,10) — kilometres from where the
// hole's furniture (green centre / active pin) projects in EPSG:3006, so the
// ball/hole markers would always land off the sampled surface (an
// `unavailable` read). Two extra steps fix that WITHOUT touching the shared
// unit seed (server unit tests assert the placeholder square):
//
//  1. Rewrite hole 1's green feature geometry to a real ~50 m square centred
//     on the projected green (so the pin/centre-derived default hole and a
//     clicked ball both fall inside the polygon → inside-mask = 1).
//  2. Register a synthetic `dem_cog` GeoTIFF covering that square + surrounds
//     with a gentle tilted plane, so the sampled surface yields a genuine
//     (non-flat) read that responds to break + stimp.
//
// The numbers below are the projection of hole 1's furniture into EPSG:3006
// (wgs84ToSweref99tm of green-1 centre/pin — see e2e/tests/fixtures.ts
// PUTT_* constants, kept in sync by hand). A tilted plane (not flat) means
// the read has a real break so the spec can assert non-empty verbal/aim.

/** Hole-1 green feature id inserted by seedCourse (server/db/seeds/course.ts). */
const GREEN_1_FEATURE_ID = `${TEST_COURSE_ID}-feature-green-1`;

/** EPSG:3006 centre of hole 1's green square (projection of the furniture). */
const GREEN_E = 532959;
const GREEN_N = 6473711;
/** Half-size of the green polygon (m) — a 50 m square, roomy for the markers. */
const GREEN_HALF_M = 25;

/** Synthetic DEM extent (EPSG:3006) — covers the green square + surrounds so
 *  sampleGrid's buffered window (≤ 50 m) never runs off the raster. */
const DEM_E0 = GREEN_E - 60; // west edge (easting)
const DEM_N0 = GREEN_N + 60; // north edge (northing)
const DEM_PX = 0.5; // native cell size, m
const DEM_W = 240; // 120 m across
const DEM_H = 240; // 120 m down
const DEM_BASE = 76; // baseline height (m, RH2000-ish)
const DEM_GX = 0.03; // +3 %: rises to the east
const DEM_GY = 0.015; // +1.5 %: rises to the south
const DEM_NODATA = -9999;

/** A tilted plane so the read has a genuine break (not a straight flat putt). */
function demPlaneHeight(e: number, n: number): number {
    return DEM_BASE + DEM_GX * (e - DEM_E0) + DEM_GY * (DEM_N0 - n);
}

/** Real green polygon (EPSG:3006 straight-segment square) for the putt read. */
function greenFeatureGeometry(): FeatureGeometry {
    const minE = GREEN_E - GREEN_HALF_M;
    const minN = GREEN_N - GREEN_HALF_M;
    const maxE = GREEN_E + GREEN_HALF_M;
    const maxN = GREEN_N + GREEN_HALF_M;
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: minE, y: minN },
                { x: maxE, y: minN },
                { x: maxE, y: maxN },
                { x: minE, y: maxN },
            ],
        }],
    };
}

/**
 * Write the synthetic DEM GeoTIFF under `dataDir/dem/` (same layout the real
 * pipeline uses) and return its dataDir-relative path for asset registration.
 * Mirrors the analysis service's own test fixture (analysis.service.test.ts).
 */
function writeDemFixture(dataDir: string): string {
    const relPath = path.join('dem', 'e2e-green-1-dem.tif');
    const absPath = path.join(dataDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    const pixels = new Float32Array(DEM_W * DEM_H);
    for (let row = 0; row < DEM_H; row++) {
        const n = DEM_N0 - (row + 0.5) * DEM_PX;
        for (let col = 0; col < DEM_W; col++) {
            const e = DEM_E0 + (col + 0.5) * DEM_PX;
            pixels[row * DEM_W + col] = demPlaneHeight(e, n);
        }
    }
    const metadata = {
        height: DEM_H,
        width: DEM_W,
        ModelPixelScale: [DEM_PX, DEM_PX, 0],
        ModelTiepoint: [0, 0, 0, DEM_E0, DEM_N0, 0],
        ProjectedCSTypeGeoKey: 3006,
        GDAL_NODATA: `${DEM_NODATA} `,
        SampleFormat: [3],
        BitsPerSample: [32],
    };
    const buffer = writeArrayBuffer(pixels as never, metadata as never);
    fs.writeFileSync(absPath, Buffer.from(buffer as ArrayBuffer));
    return relPath;
}

export async function seedE2eDatabase(dbPath: string): Promise<{ courseId: string }> {
    // Fresh file every run — delete any stale sqlite + WAL/SHM siblings.
    for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = createDb<Database>(dbPath);
    const migrationFolder = path.join(import.meta.dir, 'migrations');
    await runMigrations(db, migrationFolder);

    const dataDir = path.join(import.meta.dir, '../../data');
    const ctx = createServices(db, { dataDir });
    await seedUsers(ctx);
    await seedCourse(ctx);
    await seedClubs(ctx);

    // The map is site-scoped: give the course a 1:1 site (id == course id, so
    // on-disk tile paths are unchanged) and key its map assets by that site.
    await ctx.db.insertInto('sites').values({ id: TEST_COURSE_ID, name: 'E2E Site', version: 1 }).execute();
    await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: TEST_COURSE_ID }).execute();

    // The extra row the unit seeds lack — makes the editor map bootable.
    await ctx.db
        .insertInto('course_assets')
        .values({
            id: `${TEST_COURSE_ID}-tile-manifest`,
            course_id: TEST_COURSE_ID,
            site_id: TEST_COURSE_ID,
            kind: 'tile_manifest',
            filename: 'manifest.json',
            meta_json: tileManifestJson(),
            version: 1,
        })
        .execute();

    // Putt-read surface: give hole 1's green feature a real EPSG:3006 polygon
    // (aligned with its furniture) + a synthetic DEM, so the putt-read flow
    // has a genuine green surface to read from. See the block comment above.
    await ctx.db
        .updateTable('course_features')
        .set({ geometry_json: JSON.stringify(greenFeatureGeometry()) })
        .where('id', '=', GREEN_1_FEATURE_ID)
        .execute();
    const demFilename = writeDemFixture(dataDir);
    await ctx.assetsService.register({
        siteId: TEST_COURSE_ID,
        courseId: TEST_COURSE_ID,
        kind: 'dem_cog',
        filename: demFilename,
    });

    // Fold the WAL back into the main db file, then close and physically drop
    // the -wal/-shm sidecars so the server opens a clean, self-contained file
    // (a stale/zero-byte WAL left by a closed connection can trip a "disk I/O
    // error" when the server re-opens this exact path).
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);
    await db.destroy();
    for (const suffix of ['-wal', '-shm']) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p);
    }
    return { courseId: TEST_COURSE_ID };
}

// Allow standalone invocation for manual inspection / debugging.
if (import.meta.main) {
    const dbPath = process.argv[2] ?? path.join(import.meta.dir, '../../data/e2e.sqlite');
    const { courseId } = await seedE2eDatabase(dbPath);
    // eslint-disable-next-line no-console
    console.log(`seeded ${dbPath} — user=${TEST_USER_ID} course=${courseId}`);
}
