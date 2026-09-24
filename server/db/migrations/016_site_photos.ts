import { type Kysely, sql } from 'kysely';

/**
 * Reference photos from the course (docs/feature-reference-photos.md §5.1).
 *
 * One row per photo taken in the iOS capture mode. The phone makes the `id`
 * (a UUID), so a repeated create is idempotent. Present in both modes: the VPS
 * receives uploads from the phone, the builder pulls rows and files from the VPS.
 *
 * - Sensor pose (`yaw_deg`, `pitch_deg`, `roll_deg`, `attitude_quat_json`) is
 *   what the phone measured and is never overwritten. Refinement writes the
 *   `refined_*` columns (D-RP5), builder side only.
 * - `x3006`/`y3006` are computed from lat/lon on create (SWEREF 99 TM).
 * - Files live at `data/photos/<site_id>/<id>.heic` (original) and `.jpg`
 *   (preview); the row records hash, size and arrival time of each.
 * - `upload_seq` is the builder pull cursor: assigned `MAX(upload_seq) + 1`
 *   in the same UPDATE that records a file arrival or a metadata edit, so it
 *   increases in commit order. NULL until the original has arrived.
 * - `pulled_at` (VPS side) is set by the builder's acknowledgement;
 *   `original_deleted_at` by the 14-day retention job.
 *
 * `site_id` is a plain text column with no FK: photos are user data and must
 * survive any content change to `sites` (ingest guards against dropping a site
 * that has photos instead).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .createTable('site_photos')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('site_id', 'text', (col) => col.notNull())
        .addColumn('course_id', 'text')
        .addColumn('hole', 'integer')
        .addColumn('captured_at', 'text', (col) => col.notNull())
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('h_acc_m', 'real', (col) => col.notNull())
        .addColumn('gps_alt_m', 'real')
        .addColumn('v_acc_m', 'real')
        .addColumn('x3006', 'real', (col) => col.notNull())
        .addColumn('y3006', 'real', (col) => col.notNull())
        // {"w","x","y","z"} of CMDeviceMotion.attitude.quaternion (.xTrueNorthZVertical).
        .addColumn('attitude_quat_json', 'text')
        .addColumn('yaw_deg', 'real', (col) => col.notNull())
        .addColumn('pitch_deg', 'real', (col) => col.notNull())
        .addColumn('roll_deg', 'real', (col) => col.notNull())
        .addColumn('heading_acc_deg', 'real')
        .addColumn('mag_calibration', 'integer')
        .addColumn('hfov_deg', 'real', (col) => col.notNull())
        .addColumn('vfov_deg', 'real', (col) => col.notNull())
        .addColumn('width', 'integer', (col) => col.notNull())
        .addColumn('height', 'integer', (col) => col.notNull())
        .addColumn('eye_height_m', 'real', (col) => col.notNull().defaultTo(1.5))
        .addColumn('device_model', 'text')
        .addColumn('lens', 'text', (col) => col.notNull().defaultTo('wide'))
        // JSON array of strings.
        .addColumn('tags_json', 'text', (col) => col.notNull().defaultTo('[]'))
        .addColumn('note', 'text')
        // Files.
        .addColumn('original_sha256', 'text')
        .addColumn('original_bytes', 'integer')
        .addColumn('original_uploaded_at', 'text')
        .addColumn('original_deleted_at', 'text')
        .addColumn('preview_sha256', 'text')
        .addColumn('preview_bytes', 'integer')
        .addColumn('preview_uploaded_at', 'text')
        // Builder pull (VPS side).
        .addColumn('upload_seq', 'integer')
        .addColumn('pulled_at', 'text')
        // Refined pose (builder side).
        .addColumn('refined_yaw_deg', 'real')
        .addColumn('refined_pitch_deg', 'real')
        .addColumn('refined_roll_deg', 'real')
        .addColumn('refine_method', 'text', (col) => col.check(sql`refine_method IN ('skyline', 'manual')`))
        .addColumn('refine_residual_deg', 'real')
        .addColumn('refined_at', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema.createIndex('site_photos_site_id_index').on('site_photos').column('site_id').execute();
    await db.schema.createIndex('site_photos_upload_seq_index').on('site_photos').column('upload_seq').execute();
}
