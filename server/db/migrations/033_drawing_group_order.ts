import type { Kysely } from 'kysely';

/** NULL keeps a drawing group above all playable holes; 0 puts it directly
 * above Roughs, N puts it above hole N. Mesh identity stays in number. */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('holes').addColumn('drawing_group_after', 'integer').execute();
}
