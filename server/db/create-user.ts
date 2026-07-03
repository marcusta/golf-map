/**
 * Provisioning CLI: creates a user in the app database.
 *
 * Usage:
 *   bun run create-user <username> <password>
 *
 * Connects directly to config.dbPath (same DB main.ts uses) via createDb +
 * runMigrations, so it's safe to run before or after the server has started.
 */
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from '@basics/core/server/config';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from './schema';
import { UserService } from '../services/user.service';

async function main() {
    const [username, password] = Bun.argv.slice(2);

    if (!username || !password) {
        console.error('Usage: bun run create-user <username> <password>');
        process.exit(1);
    }

    mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = createDb<Database>(config.dbPath);
    await runMigrations(db, path.join(import.meta.dir, 'migrations'));

    const userService = new UserService(db);

    try {
        const user = await userService.register(username, password);
        console.log(`Created user: ${user.username} (id: ${user.id})`);
    } finally {
        await db.destroy();
    }
}

await main();
