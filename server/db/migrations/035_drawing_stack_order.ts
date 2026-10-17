import type { Kysely } from 'kysely';

/** Explicit order for all playable-hole and drawing-group layers. NULL
 * preserves the legacy hole/gap order until the course first reorders. */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('holes').addColumn('drawing_stack_order', 'integer').execute();
}
