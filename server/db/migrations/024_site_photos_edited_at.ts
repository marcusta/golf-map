import type { Kysely } from 'kysely';

/**
 * `site_photos.edited_at`: when tags, note or hole were last edited on this
 * box (the web photo browser, or the phone on the VPS). The builder pull keeps
 * a locally edited row's tags, note and hole instead of overwriting them with
 * the VPS copy (docs/feature-reference-photos.md §5.3). NULL = never edited here.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('site_photos').addColumn('edited_at', 'text').execute();
}
