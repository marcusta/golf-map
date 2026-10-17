import type { Kysely } from 'kysely';

/** Drawing scopes reuse hole_id so geometry, ordering, undo and mesh identity
 * have one implementation. They are never playable holes. Numbers >= 100
 * keep OPCD Hole<N> layers stable and avoid the special Hole99 layer. */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('holes').addColumn('drawing_group_name', 'text').execute();
}
