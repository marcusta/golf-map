import type { Kysely } from 'kysely';

/**
 * Per-course GSPro course details (name, location, designer, description,
 * keywords, ratings — `GsproCourseMeta` as JSON): what the GreenKeeper
 * `.GKD` export writes into the file's header, and what "Read from the .GKD"
 * stores from a file edited in GreenKeeper. NULL until either happens; the
 * export then leaves the header of the `.GKD` already there alone.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('courses')
        .addColumn('gspro_meta_json', 'text')
        .execute();
}
