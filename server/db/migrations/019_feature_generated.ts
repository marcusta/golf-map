import type { Kysely } from 'kysely';

/**
 * Split "generated" from "provenance" on course features.
 *
 * `source` (011) records WHERE a feature came from — including features the
 * GeoJSON import wizard creates from fetch-osm / fetch-hydro / fetch-roads
 * output, which are ordinary hand-drawn-equivalent shapes the user is meant
 * to reshape, re-hole and reorder. Read-only-ness belongs to features
 * written by the pipeline's bulk-replace route
 * (`PUT /features/generated?source=`), which owns the whole set and would
 * discard manual edits on its next run.
 *
 * `generated` is that flag: 1 only for rows `replaceGenerated` inserted.
 * Backfilled for the one producer that used the route before this column
 * existed (`lidar-canopy`); every other provenance-stamped row is an import
 * and becomes editable.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('course_features')
        .addColumn('generated', 'integer', col => col.notNull().defaultTo(0))
        .execute();
    await db
        .updateTable('course_features')
        .set({ generated: 1 })
        .where('source', '=', 'lidar-canopy')
        .execute();
}
