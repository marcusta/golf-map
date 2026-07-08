import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    // --- Sites ---
    //
    // A physical location that OWNS the shared map (ortho tiles, terrain, DEM,
    // tile manifest, future SVG). Several courses at one site share one map;
    // furniture/holes/features/plans stay per-course. A golf club (org) above
    // sites is deferred — `sites` is shaped so a nullable `club_id` drops in later.

    await db.schema
        .createTable('sites')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('notes', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    // Nullable site_id links. Plain text columns (no inline REFERENCES) — SQLite's
    // ALTER TABLE ADD COLUMN … REFERENCES is fragile; integrity is enforced at the
    // service layer (SitesService.remove nulls referencing rows), matching the
    // codebase's other unenforced nullable ids (e.g. game_plans.user_id).
    await db.schema.alterTable('courses').addColumn('site_id', 'text').execute();
    await db.schema.createIndex('courses_site_id_index').on('courses').column('site_id').execute();

    await db.schema.alterTable('course_assets').addColumn('site_id', 'text').execute();
    await db.schema.createIndex('course_assets_site_id_index').on('course_assets').column('site_id').execute();

    await db.schema.alterTable('map_build_jobs').addColumn('site_id', 'text').execute();
    await db.schema.createIndex('map_build_jobs_site_id_index').on('map_build_jobs').column('site_id').execute();

    // --- Backfill: 1:1 site per existing course that has map assets ---
    //
    // site.id == course.id, so every existing on-disk dir (data/tiles/{id},
    // data/sources/{id}) and every course_assets.filename string stays valid with
    // NO file moves. INSERT sites before the UPDATEs; all run in the migrator txn.
    await sql`
        INSERT INTO sites (id, name, version, created_at, updated_at)
        SELECT c.id, c.name, 1, c.created_at, c.updated_at
        FROM courses c
        WHERE EXISTS (SELECT 1 FROM course_assets a WHERE a.course_id = c.id)
    `.execute(db);

    await sql`
        UPDATE courses SET site_id = id
        WHERE EXISTS (SELECT 1 FROM course_assets a WHERE a.course_id = courses.id)
    `.execute(db);

    // course_assets.course_id is non-null today, so this cannot create dangling refs.
    await sql`UPDATE course_assets SET site_id = course_id`.execute(db);

    await sql`UPDATE map_build_jobs SET site_id = course_id WHERE course_id IS NOT NULL`.execute(db);
}
