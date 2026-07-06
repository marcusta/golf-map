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
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import { createServices } from '../services/index';
import type { Database } from '../db/schema';
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

    const ctx = createServices(db, { dataDir: path.join(import.meta.dir, '../../data') });
    await seedUsers(ctx);
    await seedCourse(ctx);
    await seedClubs(ctx);

    // The extra row the unit seeds lack — makes the editor map bootable.
    await ctx.db
        .insertInto('course_assets')
        .values({
            id: `${TEST_COURSE_ID}-tile-manifest`,
            course_id: TEST_COURSE_ID,
            kind: 'tile_manifest',
            filename: 'manifest.json',
            meta_json: tileManifestJson(),
            version: 1,
        })
        .execute();

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
