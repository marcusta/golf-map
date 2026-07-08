import { type Kysely, sql } from 'kysely';

/**
 * Green scans / calibration storage (feature-putting-green-reading.md §4.2, §6).
 * Additive only — new tables, no changes to existing rows.
 *
 * The iOS ARKit capture side (Phase E) does not exist yet; this is the
 * storage + read side. A `green_scan` is one captured artifact against a
 * green:
 * - `kind = 'corridor'`   — a LiDAR line-walk pass (the primary Tier-1 read).
 * - `kind = 'spot_level'` — a single phone-flat IMU level reading (~0.1° truth).
 * `payload_json` holds the raw scan/sample geometry; `quality_json` holds the
 * out-and-back residual / agreement stats used to accept or reject the scan.
 *
 * `green_calibration` is the per-green aggregate recomputed on every accepted
 * scan: a confidence score, a sample count, and (later, with the iOS pipeline)
 * a low-frequency bias fit between scan patches and the DEM grid. `bias_json`
 * is nullable because v1 does not fit bias yet — see green-calibration.service.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .createTable('green_scans')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('green_id', 'text', (col) =>
            col.notNull().references('greens.id').onDelete('cascade'))
        .addColumn('kind', 'text', (col) => col.notNull()) // 'corridor' | 'spot_level'
        .addColumn('captured_at', 'text', (col) => col.notNull())
        .addColumn('payload_json', 'text', (col) => col.notNull()) // raw scan / sample data
        .addColumn('quality_json', 'text') // out-and-back residuals etc (nullable)
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('green_scans_green_id_index')
        .on('green_scans')
        .column('green_id')
        .execute();

    await db.schema
        .createTable('green_calibration')
        .addColumn('green_id', 'text', (col) =>
            col.primaryKey().references('greens.id').onDelete('cascade'))
        .addColumn('bias_json', 'text') // low-frequency tilt/offset fit vs DEM (nullable; v1 leaves null)
        .addColumn('confidence', 'real', (col) => col.notNull().defaultTo(0)) // 0..1
        .addColumn('sample_count', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();
}
