import type { Kysely } from 'kysely';

/**
 * What the course is called in OPCD's cloud course builder — the `Course Name`
 * of its row in the builder's "Course Workflow" list, which is the only handle
 * the SVG build has on it. It is not our course name (Vreta is `Vreta` here
 * and `Vreta Kloster golfklubb` there), and there is no address to store
 * instead: the builder is a ZK web UI that navigates in JavaScript, so every
 * page is reached by clicking the words a human reads.
 *
 * NULL until the operator sets it, and `bun run opcd:build` then says which
 * names the list offers (`--opcd-name` overrides it for one run).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('courses')
        .addColumn('opcd_course_name', 'text')
        .execute();
}
