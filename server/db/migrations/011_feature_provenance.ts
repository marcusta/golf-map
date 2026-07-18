import type { Kysely } from 'kysely';

/**
 * T49 — durable feature provenance. Imported course features (fetch-osm,
 * fetch-water, detect-trees drafts) record where they came from so licensing
 * obligations survive past the import GeoJSON:
 *
 * - `source`      — producer id, e.g. `osm`, `lantmateriet-marktacke`.
 * - `source_ref`  — source-local id, e.g. `way/123456` for OSM.
 * - `license`     — license short name, e.g. `ODbL`. A course containing any
 *                   `ODbL` feature is ODbL for its map data (course-level
 *                   posture is derived, never stored) and must carry
 *                   "© OpenStreetMap contributors" attribution.
 *
 * All nullable: hand-drawn features carry no provenance.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('course_features')
        .addColumn('source', 'text')
        .execute();
    await db.schema
        .alterTable('course_features')
        .addColumn('source_ref', 'text')
        .execute();
    await db.schema
        .alterTable('course_features')
        .addColumn('license', 'text')
        .execute();
}
