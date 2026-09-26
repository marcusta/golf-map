import type { Kysely } from 'kysely';

/**
 * Generated terrain edits. `origin` names the generator that wrote the row
 * (`building-pads`: the flat pad under each building footprint) and
 * `origin_ref` the thing it was generated for (the building id), so a
 * regeneration replaces exactly its own previous rows — carrying each
 * building's enabled/disabled choice across by `origin_ref` — and never
 * touches a hand-drawn edit (NULL origin). Generated edits replay before
 * hand-drawn ones, so a manual edit wins where they overlap.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('terrain_edits')
        .addColumn('origin', 'text')
        .execute();
    await db.schema
        .alterTable('terrain_edits')
        .addColumn('origin_ref', 'text')
        .execute();
}
