import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    // --- Map build jobs ---
    //
    // Tracks a server-driven run of the golfpipe tile pipeline for a course
    // (fetch DEM/ortho from Lantmäteriet → tile → install → register assets).
    // One row per build; the in-memory runner streams progress into `step`
    // and `log`, and marks a terminal `status` on completion. Persisted so the
    // web UI can poll status and so stale `running` rows survive a restart
    // (reconciled to `failed` on boot).

    await db.schema
        .createTable('map_build_jobs')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending')) // pending|running|succeeded|failed
        .addColumn('step', 'text') // current BUILD_STEPS value, or null
        .addColumn('bbox_json', 'text', (col) => col.notNull()) // JSON {west,south,east,north} WGS84
        .addColumn('log', 'text', (col) => col.notNull().defaultTo(''))
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('map_build_jobs_course_id_index')
        .on('map_build_jobs')
        .column('course_id')
        .execute();
}
