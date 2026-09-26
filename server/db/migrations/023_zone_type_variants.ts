import { type Kysely, sql } from 'kysely';

/**
 * Named variants of a vegetation zone type (e.g. Tall rough -> "Lush",
 * "Dry straw"): each its own VSPro item mix. A `vegetation_zone` feature
 * picks one by key in its `zoneVariant` attribute; no variant means the
 * type's own `items_json` (the Default mix).
 *
 * `variants_json` is a JSON array of { key, name, items } where `items` has
 * the same shape as `items_json`. Existing rows get `[]` (no variants).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('course_zone_types')
        .addColumn('variants_json', 'text', (col) => col.notNull().defaultTo(sql`'[]'`))
        .execute();
}
