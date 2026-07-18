import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    // --- Map-build job kind (T56) ---
    //
    // 'build' = the full lidar→ortho→tiles pipeline; 're-terrain' = the fast
    // terrain-edit replay job (export enabled terrain_edits → apply-dem-edits
    // → tile-terrain/tile-hillshade → partial install) that reuses the same
    // job row + progress-polling plumbing. Existing rows are full builds.
    await db.schema
        .alterTable('map_build_jobs')
        .addColumn('kind', 'text', (col) => col.notNull().defaultTo('build'))
        .execute();
}
