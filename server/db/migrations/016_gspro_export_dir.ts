import type { Kysely } from 'kysely';

/**
 * Per-course output folder for the GSPro/OPCD SVG export.
 *
 * NULL means "use the server's default" (the OS Downloads folder), so an
 * untouched course needs no row change and the default can move without a
 * data migration. Only ever a directory — the filename is derived from the
 * course name.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('courses')
        .addColumn('gspro_export_dir', 'text')
        .execute();
}
