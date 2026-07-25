// sig-infra deploy migration entrypoint (T66).
//
// Reuses the SAME Kysely migrator the server runs on boot (createApp ->
// runMigrations over server/db/migrations), so the pre-deploy migration step
// is identical to what production applies at startup. Kysely's Migrator tracks
// applied migrations in the kysely_migration table, so re-running is
// idempotent.
//
// DB_PATH is set by the sig-infra tooling: during a `deploy --db` it points at
// a VACUUM INTO snapshot of the live DB (service stopped), and during a local
// rehearsal (`db_migrate_test`) at deploy-tmp/db.sqlite. Falls back to the
// runtime default so `bun run db:migrate` also works by hand.
//
// cwd on the server is /srv/golf-map (the repo root), which is why the default
// is ./data/app.sqlite and the migration folder is resolved from import.meta.dir.
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from '../server/db/schema';

const dbPath = process.env.DB_PATH || './data/app.sqlite';
const migrationFolder = path.join(import.meta.dir, '../server/db/migrations');

console.log(`Running migrations on ${dbPath}...`);

const db = createDb<Database>(dbPath);

try {
    await runMigrations(db, migrationFolder);
    console.log('✅ Migrations completed');
    await db.destroy();
    process.exit(0);
} catch (e) {
    console.error('❌ Migration failed:', e);
    await db.destroy();
    process.exit(1);
}
