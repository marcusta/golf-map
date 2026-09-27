import { sql, type Kysely } from 'kysely';

/**
 * Edit history for course features and terrain edits, so a course can be put
 * back to any earlier moment (the GSPro SVG bisect: which edit broke the OPCD
 * Blender build). Triggers, not service code, so every write path is caught:
 * the editor, reorders, bulk generator replaces, imports and scripts.
 *
 * Each row holds the row's state BEFORE the change, as JSON:
 *   - `update`: content changed (geometry, type, hole, layer, attributes,
 *     provenance) - the whole old row except the derived `geojson`;
 *   - `restack`: only the stacking order moved - just `sort_order`,
 *     `version`, `updated_at` (creating a feature shifts every one above it);
 *   - `delete`: the whole old row except `geojson`.
 * The state at time T is the current row with every history row after T laid
 * over it, newest first; features created after T are left out
 * (FeatureHistoryService.stateAt).
 */
const FEATURE_CONTENT = ['geometry_json', 'type', 'hole_id', 'layer', 'attributes_json', 'generated', 'source', 'source_ref', 'license'];
const FEATURE_COLUMNS = ['id', 'course_id', 'hole_id', 'type', 'geometry_json', 'layer', 'sort_order', 'source', 'generated',
    'source_ref', 'license', 'attributes_json', 'version', 'created_at', 'updated_at'];
const TERRAIN_COLUMNS = ['id', 'site_id', 'op', 'params_json', 'rings_json', 'enabled', 'origin', 'origin_ref', 'version', 'created_at', 'updated_at'];
const TERRAIN_CONTENT = ['op', 'params_json', 'rings_json', 'enabled', 'origin', 'origin_ref'];

const NOW_MS = `strftime('%Y-%m-%d %H:%M:%f', 'now')`;
const jsonOf = (cols: string[]) => `json_object(${cols.map(c => `'${c}', OLD.${c}`).join(', ')})`;
const changed = (cols: string[]) => cols.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');

export async function up(db: Kysely<any>): Promise<void> {
    await sql.raw(`CREATE TABLE course_feature_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        op TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (${NOW_MS}),
        row_json TEXT NOT NULL
    )`).execute(db);
    await sql.raw(`CREATE INDEX course_feature_history_course ON course_feature_history (course_id, changed_at)`).execute(db);
    await sql.raw(`CREATE INDEX course_feature_history_feature ON course_feature_history (feature_id, history_id)`).execute(db);

    await sql.raw(`CREATE TRIGGER course_features_history_update AFTER UPDATE ON course_features
        WHEN ${changed(FEATURE_CONTENT)}
        BEGIN
            INSERT INTO course_feature_history (feature_id, course_id, op, row_json)
            VALUES (OLD.id, OLD.course_id, 'update', ${jsonOf(FEATURE_COLUMNS)});
        END`).execute(db);
    await sql.raw(`CREATE TRIGGER course_features_history_restack AFTER UPDATE OF sort_order ON course_features
        WHEN OLD.sort_order IS NOT NEW.sort_order AND NOT (${changed(FEATURE_CONTENT)})
        BEGIN
            INSERT INTO course_feature_history (feature_id, course_id, op, row_json)
            VALUES (OLD.id, OLD.course_id, 'restack', ${jsonOf(['sort_order', 'version', 'updated_at'])});
        END`).execute(db);
    await sql.raw(`CREATE TRIGGER course_features_history_delete AFTER DELETE ON course_features
        BEGIN
            INSERT INTO course_feature_history (feature_id, course_id, op, row_json)
            VALUES (OLD.id, OLD.course_id, 'delete', ${jsonOf(FEATURE_COLUMNS)});
        END`).execute(db);

    await sql.raw(`CREATE TABLE terrain_edit_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        edit_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        op TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (${NOW_MS}),
        row_json TEXT NOT NULL
    )`).execute(db);
    await sql.raw(`CREATE INDEX terrain_edit_history_site ON terrain_edit_history (site_id, changed_at)`).execute(db);
    await sql.raw(`CREATE TRIGGER terrain_edits_history_update AFTER UPDATE ON terrain_edits
        WHEN ${changed(TERRAIN_CONTENT)}
        BEGIN
            INSERT INTO terrain_edit_history (edit_id, site_id, op, row_json)
            VALUES (OLD.id, OLD.site_id, 'update', ${jsonOf(TERRAIN_COLUMNS)});
        END`).execute(db);
    await sql.raw(`CREATE TRIGGER terrain_edits_history_delete AFTER DELETE ON terrain_edits
        BEGIN
            INSERT INTO terrain_edit_history (edit_id, site_id, op, row_json)
            VALUES (OLD.id, OLD.site_id, 'delete', ${jsonOf(TERRAIN_COLUMNS)});
        END`).execute(db);
}
