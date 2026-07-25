// sig-infra deploy DB validation entrypoint (T66).
//
// Runs AFTER db:migrate against the same DB (DB_PATH points at the deploy
// snapshot). Verifies the DB opens and every application table the server
// expects (server/db/schema.ts) is present. Exit 1 on any miss so the sig-infra
// tooling aborts the deploy and restores the pre-migration database.
//
// NOTE: only the app DB (app.sqlite) is validated here. sessions.sqlite and
// obs.sqlite are separate framework-owned DBs created at boot, and DATA_DIR's
// tiles/dem trees are published artifacts, not deploy state.
import { Database } from 'bun:sqlite';

const dbPath = process.env.DB_PATH || './data/app.sqlite';

// Keep in sync with the Database interface in server/db/schema.ts.
const REQUIRED_TABLES = [
    'users',
    'sites',
    'courses',
    'holes',
    'tees',
    'greens',
    'pins',
    'aim_points',
    'course_features',
    'hazards',
    'clubs',
    'game_plans',
    'game_plan_holes',
    'plan_shots',
    'plan_gates',
    'rounds',
    'shots',
    'course_assets',
    'green_scans',
    'green_calibration',
    'putt_estimate_samples',
    'map_build_jobs',
    'terrain_edits',
    'tapscore_published_scores',
];

console.log(`Validating DB at ${dbPath}...`);

const db = new Database(dbPath);

try {
    // 1. DB opens and is queryable.
    db.query('SELECT 1').get();

    // 2. All required application tables exist.
    const rows = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
    const present = new Set(rows.map((r) => r.name));

    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
        console.error(`❌ Missing required tables: ${missing.join(', ')}`);
        db.close();
        process.exit(1);
    }

    console.log(`✅ DB healthy — all ${REQUIRED_TABLES.length} required tables present`);
    db.close();
    process.exit(0);
} catch (e) {
    console.error('❌ Health check failed:', e);
    db.close();
    process.exit(1);
}
