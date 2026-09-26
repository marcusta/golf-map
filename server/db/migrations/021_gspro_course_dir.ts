import type { Kysely } from 'kysely';

/**
 * Per-course GSPro course folder (`<GSPro>/Core/GSP/Courses/<scene>`): where
 * the GreenKeeper course file (`<scene>.GKD`) export writes, next to the
 * scene the course was built into. NULL until the operator sets it — unlike
 * the export folder there is no sensible default, since the scene folder is
 * named when the course is first built in Unity.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('courses')
        .addColumn('gspro_course_dir', 'text')
        .execute();
}
