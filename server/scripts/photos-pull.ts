/**
 * Photo pull CLI (builder side, docs/feature-reference-photos.md §5.3): copies
 * reference photos the phone uploaded to the serve-mode VPS into this
 * builder's database and `data/photos/`. See `services/photos-pull.ts`.
 *
 * Usage (cwd = server/):
 *   bun run photos-pull [--reset]
 *
 * `--reset` starts from cursor 0 (re-lists every photo; files already present
 * with the same hash are not downloaded again).
 *
 * Env (same as `bun run publish`):
 *   PUBLISH_URL    base URL of the serve-mode VPS
 *   PUBLISH_TOKEN  bearer token, set identically on both boxes
 *   DB_PATH / DATA_DIR  as for the server (defaults ../data/…)
 */
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from '@basics/core/server/config';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from '../db/schema';
import { PhotosService } from '../services/photos.service';
import { formatReport, pullConfigFromEnv, pullPhotos } from '../services/photos-pull';

async function main(): Promise<void> {
    const reset = Bun.argv.slice(2).includes('--reset');
    const env = pullConfigFromEnv();
    if (!env) throw new Error('Set PUBLISH_URL and PUBLISH_TOKEN to pull photos.');
    const dataDir = process.env.DATA_DIR ?? path.dirname(config.dbPath);

    mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = createDb<Database>(config.dbPath);
    await runMigrations(db, path.join(import.meta.dir, '../db/migrations'));
    try {
        const report = await pullPhotos({ photos: new PhotosService({ db, dataDir }), ...env }, { reset });
        console.log(formatReport(report));
    } finally {
        await db.destroy();
    }
}

if (import.meta.main) {
    await main();
}
