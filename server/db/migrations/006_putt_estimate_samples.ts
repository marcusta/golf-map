import { type Kysely, sql } from 'kysely';

/**
 * Putt estimate samples (feature-putting-green-reading.md §5.1 training loop).
 * Additive only — one new table, no changes to existing rows.
 *
 * Practice mode's training loop asks the player for their own read (slope %,
 * break side, aim offset, plays-like pace) BEFORE revealing the computed read,
 * then scores the estimate against that read and tracks estimation accuracy
 * over time. Each recorded estimate is one `putt_estimate_samples` row: the
 * putt geometry (distance, stimp), the computed ("actual") ground truth from
 * the same GreenSurface the read used, and the player's estimate, side by side.
 *
 * Slope-% estimation is the skill that stays legal in competition, so the mean
 * |slope error| trend is the headline aggregate — it sits beside strokes-gained
 * putting (T14). The break-side hit rate and mean pace error round it out.
 *
 * `green_id` is a nullable FK: Tier-3 manual reads (no DEM/scan surface, any
 * course on Earth) have no green row to key on. When present it cascades with
 * the green.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .createTable('putt_estimate_samples')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('green_id', 'text', (col) =>
            col.references('greens.id').onDelete('cascade')) // nullable — Tier-3 has no green
        .addColumn('distance_m', 'real', (col) => col.notNull())
        .addColumn('stimp_ft', 'real', (col) => col.notNull())
        // Ground truth (computed read) vs the player's estimate, side by side.
        .addColumn('actual_slope_pct', 'real', (col) => col.notNull())
        .addColumn('estimated_slope_pct', 'real', (col) => col.notNull())
        .addColumn('actual_aim_offset_m', 'real', (col) => col.notNull())
        .addColumn('estimated_aim_offset_m', 'real', (col) => col.notNull())
        .addColumn('actual_plays_like_m', 'real', (col) => col.notNull())
        .addColumn('estimated_plays_like_m', 'real', (col) => col.notNull())
        .addColumn('break_side_actual', 'text', (col) => col.notNull()) // 'left'|'right'|'straight'
        .addColumn('break_side_estimated', 'text', (col) => col.notNull())
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('putt_estimate_samples_green_id_index')
        .on('putt_estimate_samples')
        .column('green_id')
        .execute();

    await db.schema
        .createIndex('putt_estimate_samples_created_at_index')
        .on('putt_estimate_samples')
        .column('created_at')
        .execute();
}
