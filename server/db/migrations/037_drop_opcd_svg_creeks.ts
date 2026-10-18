import { sql, type Kysely } from 'kysely';

/**
 * Drop `courses.opcd_svg_creeks` where 036 added it before it became a no-op
 * (see 036): creeks narrower than a metre are now left out of the GSPro SVG
 * by the exporter itself, every course alike.
 */
export async function up(db: Kysely<any>): Promise<void> {
    const columns = await sql<{ name: string }>`PRAGMA table_info(courses)`.execute(db);
    if (columns.rows.some(c => c.name === 'opcd_svg_creeks')) {
        await sql`ALTER TABLE courses DROP COLUMN opcd_svg_creeks`.execute(db);
    }
}
