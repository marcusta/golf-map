import type { Kysely } from 'kysely';

/** Ordering among drawing groups in the same gap between playable holes. */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('holes').addColumn('drawing_group_order', 'integer').execute();
}
