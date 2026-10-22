import { sql, type Kysely } from 'kysely';

/**
 * Each tee set's length on each hole, from the club's scorecard
 * (`tee_set_lengths`, ScorecardService): what the tees are placed by
 * (TeePlacementService) and checked against. A length belongs to the set
 * and the hole, not to a tee, so it is there before the tee is placed and
 * stays when the tee moves. Metres, flat, tee -> aim points -> green centre
 * as a card measures it.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.transaction().execute(async (trx) => {
        await trx.schema
            .createTable('tee_set_lengths')
            .ifNotExists()
            .addColumn('tee_set_id', 'text', col => col.notNull().references('course_tee_sets.id').onDelete('cascade'))
            .addColumn('hole_id', 'text', col => col.notNull().references('holes.id').onDelete('cascade'))
            .addColumn('length_m', 'real', col => col.notNull())
            .addColumn('updated_at', 'text', col => col.notNull().defaultTo(sql`(datetime('now'))`))
            .addPrimaryKeyConstraint('tee_set_lengths_pk', ['tee_set_id', 'hole_id'])
            .execute();
        await trx.schema
            .createIndex('tee_set_lengths_hole_id_index')
            .ifNotExists()
            .on('tee_set_lengths')
            .column('hole_id')
            .execute();
    });
}
