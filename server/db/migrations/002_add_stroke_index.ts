import type { Kysely } from 'kysely';

/**
 * Add a nullable `stroke_index` (handicap/SI, 1–18) to holes. Nullable
 * because existing v1 imports don't carry it and the hole-info panel allows
 * a blank SI.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('holes')
        .addColumn('stroke_index', 'integer')
        .execute();
}
