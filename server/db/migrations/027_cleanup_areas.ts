import type { Kysely } from 'kysely';

// Cleanup boundaries belong to the shared photo's site, not course features.
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.createTable('cleanup_areas')
        .addColumn('site_id', 'text', c => c.primaryKey().references('sites.id').onDelete('cascade'))
        .addColumn('version', 'integer', c => c.notNull())
        .addColumn('areas_json', 'text', c => c.notNull())
        .execute();
}
