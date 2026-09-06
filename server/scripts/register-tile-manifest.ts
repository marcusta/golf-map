/** Run from server/: bun scripts/register-tile-manifest.ts <course-or-site-id> [--db ../data/app.sqlite] [--data-dir ../data] */
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from '../db/schema';
import { AssetsService } from '../services/assets.service';

export function parseArgs(argv: string[]): { id: string; dbPath: string; dataDir: string } {
    let dbPath = '../data/app.sqlite', dataDir = '../data';
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--db' || arg === '--data-dir') {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
            if (arg === '--db') dbPath = value;
            else dataDir = value;
        } else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
        else positional.push(arg);
    }
    if (positional.length !== 1) throw new Error('Usage: bun scripts/register-tile-manifest.ts <course-or-site-id> [--db ../data/app.sqlite] [--data-dir ../data]');
    return { id: positional[0], dbPath, dataDir };
}

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        const db = createDb<Database>(args.dbPath);
        try {
            await runMigrations(db, path.join(import.meta.dir, '../db/migrations'));
            const assets = await new AssetsService(db, args.dataDir).registerInstalledTileManifest(args.id);
            for (const asset of assets) console.log(`Registered tile manifest ${asset.id}, version ${asset.version}`);
        } finally {
            await db.destroy();
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
