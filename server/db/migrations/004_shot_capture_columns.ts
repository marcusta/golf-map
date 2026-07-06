import type { Kysely } from 'kysely';

/**
 * Shot-capture schema extension (feature-shot-capture.md §3). Additive only —
 * existing rows stay valid via defaults.
 *
 * - `rounds.game_plan_id` links a round to the plan it played against
 *   (plan-vs-actual review); nullable, no FK enforcement in v1 (plans and
 *   rounds are independent tables and a plan may be deleted while old rounds
 *   remain).
 * - `rounds.wind_speed_mps` / `wind_direction_deg` capture a round-level wind
 *   snapshot (per-hole overrides are a future extension per the doc).
 * - `shots.shot_type` gates dispersion fitting (only 'full' swings enter it);
 *   defaults to 'full' so existing rows remain valid.
 * - `shots.target_lat` / `target_lon` record the intended target at address,
 *   needed to rotate landings into the intended-line frame for fitting.
 * - `shots.penalty_strokes` is the stroke-and-distance/OB/water penalty
 *   attached to that stroke (recording convention: a shot row = one stroke;
 *   penalties are a column, not additional rows).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('rounds')
        .addColumn('game_plan_id', 'text')
        .execute();

    await db.schema
        .alterTable('rounds')
        .addColumn('wind_speed_mps', 'real')
        .execute();

    await db.schema
        .alterTable('rounds')
        .addColumn('wind_direction_deg', 'real')
        .execute();

    await db.schema
        .alterTable('shots')
        .addColumn('shot_type', 'text', (col) => col.notNull().defaultTo('full'))
        .execute();

    await db.schema
        .alterTable('shots')
        .addColumn('target_lat', 'real')
        .execute();

    await db.schema
        .alterTable('shots')
        .addColumn('target_lon', 'real')
        .execute();

    await db.schema
        .alterTable('shots')
        .addColumn('penalty_strokes', 'integer', (col) => col.notNull().defaultTo(0))
        .execute();
}
