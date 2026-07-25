import { type Kysely } from 'kysely';

/**
 * Per-round green speed (T35 follow-up): iOS captures a stimp reading per
 * round (RoundRecord.stimpFt, GRDB v8) — this adds the matching server
 * column so the value syncs. Nullable: rounds without a reading (all
 * pre-existing rows, and rounds where the player never set one) stay null,
 * and analytics fall back to their default green speed.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('rounds')
        .addColumn('stimp_ft', 'real')
        .execute();
}
