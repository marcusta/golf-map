import { sql, type Kysely } from 'kysely';

/**
 * A course's tee sets (`course_tee_sets`): what "Yellow" is for the whole
 * course — its name, colour, and the men's and women's course rating and
 * slope — where until now a set only existed as the hole tees that happened
 * to share a name. `gspro_rating` says which of the two ratings GSPro shows
 * for the set (a GKD holds one per set).
 *
 * A hole's tee points at its set (`tees.tee_set_id`) and still carries the
 * set's name and colour itself, kept in step by `TeeSetsService`, so every
 * reader of `tees` (the planner, iOS, `gspro.py`, a published bundle) is
 * untouched. No foreign key on it for the same reason: a bundle ingested on
 * the serve box brings tees without their sets.
 *
 * Existing tees are grouped into sets per course by name, each set taking
 * the colour most of its tees have, in the order the tees sort.
 */
async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
    return rows.some(r => r.name === column);
}

export async function up(db: Kysely<any>): Promise<void> {
    await db.transaction().execute(async (trx) => {
        await trx.schema
            .createTable('course_tee_sets')
            .ifNotExists()
            .addColumn('id', 'text', col => col.primaryKey())
            .addColumn('course_id', 'text', col => col.notNull().references('courses.id').onDelete('cascade'))
            .addColumn('name', 'text', col => col.notNull())
            .addColumn('color', 'text')
            .addColumn('sort_order', 'integer', col => col.notNull().defaultTo(0))
            .addColumn('rating_men', 'real')
            .addColumn('slope_men', 'integer')
            .addColumn('rating_women', 'real')
            .addColumn('slope_women', 'integer')
            .addColumn('gspro_rating', 'text', col => col.notNull().defaultTo('men'))
            .addColumn('version', 'integer', col => col.notNull().defaultTo(1))
            .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`(datetime('now'))`))
            .addColumn('updated_at', 'text', col => col.notNull().defaultTo(sql`(datetime('now'))`))
            .execute();
        await trx.schema
            .createIndex('course_tee_sets_course_id_name_unique')
            .ifNotExists()
            .on('course_tee_sets')
            .columns(['course_id', 'name'])
            .unique()
            .execute();
        if (!await hasColumn(trx, 'tees', 'tee_set_id')) {
            await trx.schema.alterTable('tees').addColumn('tee_set_id', 'text').execute();
        }

        await sql.raw(`INSERT INTO course_tee_sets (id, course_id, name, color, sort_order)
            SELECT lower(hex(randomblob(16))), h.course_id, t.name,
                   (SELECT t2.color FROM tees t2 JOIN holes h2 ON h2.id = t2.hole_id
                     WHERE h2.course_id = h.course_id AND t2.name = t.name AND t2.color IS NOT NULL
                     GROUP BY t2.color ORDER BY COUNT(*) DESC, t2.color LIMIT 1),
                   ROW_NUMBER() OVER (PARTITION BY h.course_id ORDER BY MIN(t.sort_order), t.name) - 1
              FROM tees t JOIN holes h ON h.id = t.hole_id
             WHERE t.tee_set_id IS NULL
             GROUP BY h.course_id, t.name`).execute(trx);
        await sql.raw(`UPDATE tees SET tee_set_id =
            (SELECT s.id FROM course_tee_sets s JOIN holes h ON h.course_id = s.course_id
              WHERE h.id = tees.hole_id AND s.name = tees.name)
            WHERE tee_set_id IS NULL`).execute(trx);
    });
}
