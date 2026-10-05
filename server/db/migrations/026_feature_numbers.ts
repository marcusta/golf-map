import { sql, type Kysely } from 'kysely';

/**
 * A short, stable number per course feature (`course_features.feature_no`),
 * shown in hex: the GSPro SVG names a shape `hole_<hole>_<no in hex>`, OPCD
 * carries that into the mesh name (`Spline_hole_2_1a_Bunker_-_Mesh`) and Unity
 * keys saved edits to it, so it must never change and never be handed out
 * again. A per-course counter (`courses.next_feature_no`) that only goes up:
 * no clashes by construction, and 3 hex digits cover 4095 shapes.
 *
 * Only hand-drawn and imported features are numbered (`generated = 0`): the
 * pipeline's bulk replaces delete and re-insert thousands of rows (canopy
 * trees, vegetation zones) on every run and would burn through the counter.
 *
 * Triggers, like the edit history (025), so every write path is covered:
 *   - a feature inserted without a number gets the next one;
 *   - one written with a number (a restore, a publish ingest) keeps it and
 *     moves the counter past it.
 * The history triggers now keep `feature_no` in the old row too, so a
 * restored feature comes back under its old number.
 *
 * Existing features are numbered per course, oldest first (created_at, id).
 * No unique index: a publish ingest upserts row by row, and a served copy
 * numbered from an older bundle could hold a number mid-ingest that the new
 * bundle gives another feature. The counter is what keeps numbers unique.
 */
const FEATURE_CONTENT = ['geometry_json', 'type', 'hole_id', 'layer', 'attributes_json', 'generated', 'source', 'source_ref', 'license'];
const FEATURE_COLUMNS = ['id', 'course_id', 'hole_id', 'type', 'geometry_json', 'layer', 'sort_order', 'source', 'generated',
    'source_ref', 'license', 'attributes_json', 'version', 'created_at', 'updated_at', 'feature_no'];

const jsonOf = (cols: string[]) => `json_object(${cols.map(c => `'${c}', OLD.${c}`).join(', ')})`;
const changed = (cols: string[]) => cols.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');

async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
    return rows.some(r => r.name === column);
}

export async function up(db: Kysely<any>): Promise<void> {
    // One transaction: Kysely runs SQLite migrations without one, and a first
    // version of this migration, failing on the dev server after its ALTERs,
    // left the two columns behind. Every step can also meet a database in
    // that state.
    await db.transaction().execute(async (trx) => {
        if (!await hasColumn(trx, 'courses', 'next_feature_no')) {
            await trx.schema.alterTable('courses').addColumn('next_feature_no', 'integer', col => col.notNull().defaultTo(1)).execute();
        }
        if (!await hasColumn(trx, 'course_features', 'feature_no')) {
            await trx.schema.alterTable('course_features').addColumn('feature_no', 'integer').execute();
        }

        await sql.raw(`UPDATE course_features SET feature_no = numbered.n
            FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY course_id ORDER BY created_at, id) AS n
                  FROM course_features WHERE generated = 0) AS numbered
            WHERE numbered.id = course_features.id`).execute(trx);
        await sql.raw(`UPDATE courses SET next_feature_no =
            COALESCE((SELECT MAX(feature_no) FROM course_features WHERE course_id = courses.id), 0) + 1`).execute(trx);

        // Counter first, then the number: setting feature_no fires the "set"
        // trigger below, which then finds the counter already past it.
        await sql.raw(`CREATE TRIGGER IF NOT EXISTS course_features_number AFTER INSERT ON course_features
            WHEN NEW.feature_no IS NULL AND NEW.generated = 0
            BEGIN
                UPDATE courses SET next_feature_no = next_feature_no + 1 WHERE id = NEW.course_id;
                UPDATE course_features SET feature_no = (SELECT next_feature_no - 1 FROM courses WHERE id = NEW.course_id)
                    WHERE id = NEW.id;
            END`).execute(trx);
        await sql.raw(`CREATE TRIGGER IF NOT EXISTS course_features_number_kept AFTER INSERT ON course_features
            WHEN NEW.feature_no IS NOT NULL
            BEGIN
                UPDATE courses SET next_feature_no = MAX(next_feature_no, NEW.feature_no + 1) WHERE id = NEW.course_id;
            END`).execute(trx);
        await sql.raw(`CREATE TRIGGER IF NOT EXISTS course_features_number_set AFTER UPDATE OF feature_no ON course_features
            WHEN NEW.feature_no IS NOT NULL
            BEGIN
                UPDATE courses SET next_feature_no = MAX(next_feature_no, NEW.feature_no + 1) WHERE id = NEW.course_id;
            END`).execute(trx);

        // 025's history triggers, now with feature_no in the kept row.
        await sql.raw(`DROP TRIGGER IF EXISTS course_features_history_update`).execute(trx);
        await sql.raw(`DROP TRIGGER IF EXISTS course_features_history_delete`).execute(trx);
        await sql.raw(`CREATE TRIGGER course_features_history_update AFTER UPDATE ON course_features
            WHEN ${changed(FEATURE_CONTENT)}
            BEGIN
                INSERT INTO course_feature_history (feature_id, course_id, op, row_json)
                VALUES (OLD.id, OLD.course_id, 'update', ${jsonOf(FEATURE_COLUMNS)});
            END`).execute(trx);
        await sql.raw(`CREATE TRIGGER course_features_history_delete AFTER DELETE ON course_features
            BEGIN
                INSERT INTO course_feature_history (feature_id, course_id, op, row_json)
                VALUES (OLD.id, OLD.course_id, 'delete', ${jsonOf(FEATURE_COLUMNS)});
            END`).execute(trx);
    });
}
