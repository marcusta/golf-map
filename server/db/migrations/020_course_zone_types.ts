import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    // --- Course zone types (vegetation zones, docs/feature-vegetation-zones.md §5) ---
    //
    // The course's table of lower-vegetation zone types. A `vegetation_zone`
    // course feature names one of these by `key` in its `attributes_json`;
    // the table alone assigns a zone type to a VSPro texture mask channel
    // (`texture_index` + `channel`, four channels per texture) and carries the
    // item bindings the Unity importer wires into the vegetation package
    // (D-VZ9). Polygons stay the source of truth; this is the per-course
    // legend they are rasterized against.
    //
    // `items_json` is a JSON array of { item, minDensity, maxDensity } — the
    // vegetation item's name in the VSPro package and the density range its
    // texture-mask density rule maps the sampled channel value onto.

    await db.schema
        .createTable('course_zone_types')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('key', 'text', (col) => col.notNull()) // [a-z0-9_]+, unique per course
        .addColumn('name', 'text', (col) => col.notNull()) // display name in the editor
        .addColumn('color', 'text', (col) => col.notNull()) // '#rrggbb', editor tint
        .addColumn('texture_index', 'integer', (col) => col.notNull()) // mask texture, >= 0
        .addColumn('channel', 'integer', (col) => col.notNull()) // RGBA channel 0..3
        .addColumn('sort_order', 'integer', (col) => col.notNull())
        .addColumn('items_json', 'text', (col) => col.notNull().defaultTo(sql`'[]'`))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    // One row per key per course …
    await db.schema
        .createIndex('course_zone_types_course_key_unique')
        .on('course_zone_types')
        .columns(['course_id', 'key'])
        .unique()
        .execute();

    // … and one zone type per mask channel: two types sharing a channel would
    // rasterize on top of each other with no way to tell them apart in VSPro.
    await db.schema
        .createIndex('course_zone_types_course_channel_unique')
        .on('course_zone_types')
        .columns(['course_id', 'texture_index', 'channel'])
        .unique()
        .execute();
}
