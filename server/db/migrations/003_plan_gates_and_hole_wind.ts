import { type Kysely, sql } from 'kysely';

/**
 * Phase 5 kickoff additions:
 * - Per-hole wind override on `game_plan_holes` (nullable; null = inherit
 *   plan-level wind) plus per-hole `notes` for on-course guidance text.
 * - `label` on `plan_shots` (e.g. "layup left of bunker").
 * - New `plan_gates` table: the corridor-ruler stations for a hole. Each
 *   gate is an absolute WGS84 station point with a corridor-axis bearing
 *   (the ruler is its perpendicular) and asymmetric left/right half-widths.
 *   `source` distinguishes manually placed gates from future auto ray-cast
 *   fill, so that upgrade is an UPDATE, not a remodel.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('game_plan_holes')
        .addColumn('wind_speed_mps', 'real')
        .execute();

    await db.schema
        .alterTable('game_plan_holes')
        .addColumn('wind_direction_deg', 'real')
        .execute();

    await db.schema
        .alterTable('game_plan_holes')
        .addColumn('notes', 'text')
        .execute();

    await db.schema
        .alterTable('plan_shots')
        .addColumn('label', 'text')
        .execute();

    await db.schema
        .createTable('plan_gates')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('game_plan_hole_id', 'text', (col) =>
            col.notNull().references('game_plan_holes.id').onDelete('cascade'))
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('direction_deg', 'real', (col) => col.notNull())
        .addColumn('half_width_left_m', 'real', (col) => col.notNull())
        .addColumn('half_width_right_m', 'real', (col) => col.notNull())
        .addColumn('source', 'text', (col) => col.notNull().defaultTo('manual'))
        .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('plan_gates_game_plan_hole_id_index')
        .on('plan_gates')
        .column('game_plan_hole_id')
        .execute();
}
