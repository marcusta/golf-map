import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    // --- Terrain edits (smooth/flatten the height map) ---
    //
    // Vector edits replayed onto the DEM at build time (never raster
    // mutations) so they survive lidar refetches/rebuilds, diff cleanly, and
    // are undoable. Site-scoped (D-TE1 — the site owns the map). Two ops in v1
    // (D-TE3): `plane` (least-squares plane fit, optional dead-flat) and
    // `smooth` (circular median filter). `params_json` carries { featherM,
    // radiusM?, flat? }; `rings_json` holds straight-segment rings in the DEM
    // CRS (EPSG:3006), mirroring course_features geometry storage. Edits apply
    // in created_at order (D-TE4).

    await db.schema
        .createTable('terrain_edits')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('site_id', 'text', (col) =>
            col.notNull().references('sites.id').onDelete('cascade'))
        .addColumn('op', 'text', (col) => col.notNull()) // 'plane' | 'smooth'
        .addColumn('params_json', 'text', (col) => col.notNull()) // { featherM, radiusM?, flat? }
        .addColumn('rings_json', 'text', (col) => col.notNull()) // EPSG:3006 straight-segment rings
        .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(1)) // bool 0/1
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('terrain_edits_site_id_index')
        .on('terrain_edits')
        .column('site_id')
        .execute();
}
