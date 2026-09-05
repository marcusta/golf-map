import type { Kysely } from 'kysely';

/**
 * Per-feature attributes for generated course features.
 *
 * `attributes_json` holds a flat JSON object (string/number/boolean values,
 * at most 32 keys) or NULL. The pipeline's lidar canopy detector fills it
 * for `trees` features (heightMaxM, heightP90M, heightMeanM, areaM2); other
 * producers may store their own scalars. Hand-drawn features stay NULL, and
 * nothing in the render/lie path reads it.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('course_features')
        .addColumn('attributes_json', 'text')
        .execute();
}
