import type { Kysely } from 'kysely';

/**
 * D28: `course_features.layer` — the Roughs group.
 *
 * A feature's stack group was `(course_id, hole_id|null)`. `layer = 'roughs'`
 * (always with `hole_id` NULL) names a third group that composes BELOW every
 * hole, while the course-level group (`hole_id` NULL, `layer` NULL) moves to
 * the top. NULL for everything that exists: nothing is moved into the new
 * group here — that is a by-hand decision in the editor.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('course_features').addColumn('layer', 'text').execute();
}
