import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    // --- Auth ---

    await db.schema
        .createTable('users')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('username', 'text', (col) => col.notNull().unique())
        .addColumn('password_hash', 'text', (col) => col.notNull())
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`),
        )
        .execute();

    // --- Courses ---

    await db.schema
        .createTable('courses')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull().defaultTo('draft'))
        .addColumn('revision', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('crs', 'text', (col) => col.notNull().defaultTo('EPSG:3006'))
        .addColumn('georeference_json', 'text')
        .addColumn('home_lat', 'real')
        .addColumn('home_lon', 'real')
        .addColumn('notes', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createTable('holes')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('number', 'integer', (col) => col.notNull())
        .addColumn('par', 'integer', (col) => col.notNull())
        .addColumn('notes', 'text')
        .addColumn('saved_region_json', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('holes_course_id_index')
        .on('holes')
        .column('course_id')
        .execute();

    await db.schema
        .createIndex('holes_course_id_number_unique')
        .on('holes')
        .columns(['course_id', 'number'])
        .unique()
        .execute();

    // --- Tees ---

    await db.schema
        .createTable('tees')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('hole_id', 'text', (col) =>
            col.notNull().references('holes.id').onDelete('cascade'))
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('color', 'text')
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('elevation', 'real')
        .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('tees_hole_id_index')
        .on('tees')
        .column('hole_id')
        .execute();

    await db.schema
        .createIndex('tees_hole_id_name_unique')
        .on('tees')
        .columns(['hole_id', 'name'])
        .unique()
        .execute();

    // --- Greens ---

    await db.schema
        .createTable('greens')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('hole_id', 'text', (col) =>
            col.notNull().references('holes.id').onDelete('cascade'))
        .addColumn('boundary_json', 'text')
        .addColumn('center_lat', 'real', (col) => col.notNull())
        .addColumn('center_lon', 'real', (col) => col.notNull())
        .addColumn('front_lat', 'real')
        .addColumn('front_lon', 'real')
        .addColumn('back_lat', 'real')
        .addColumn('back_lon', 'real')
        .addColumn('elevation', 'real')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('greens_hole_id_index')
        .on('greens')
        .column('hole_id')
        .execute();

    // --- Pins ---

    await db.schema
        .createTable('pins')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('green_id', 'text', (col) =>
            col.notNull().references('greens.id').onDelete('cascade'))
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('difficulty', 'text')
        .addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('pins_green_id_index')
        .on('pins')
        .column('green_id')
        .execute();

    // --- Aim points ---

    await db.schema
        .createTable('aim_points')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('hole_id', 'text', (col) =>
            col.notNull().references('holes.id').onDelete('cascade'))
        .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('elevation', 'real')
        .addColumn('label', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('aim_points_hole_id_index')
        .on('aim_points')
        .column('hole_id')
        .execute();

    // --- Course features (native geometry + derived GeoJSON) ---

    await db.schema
        .createTable('course_features')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('hole_id', 'text', (col) =>
            col.references('holes.id').onDelete('cascade'))
        .addColumn('type', 'text', (col) => col.notNull())
        .addColumn('geometry_json', 'text', (col) => col.notNull())
        .addColumn('geojson', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('course_features_course_id_index')
        .on('course_features')
        .column('course_id')
        .execute();

    await db.schema
        .createIndex('course_features_hole_id_index')
        .on('course_features')
        .column('hole_id')
        .execute();

    // --- Hazards (v1 point-based; polygon features replace these later) ---

    await db.schema
        .createTable('hazards')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('hole_id', 'text', (col) =>
            col.notNull().references('holes.id').onDelete('cascade'))
        .addColumn('kind', 'text', (col) => col.notNull())
        .addColumn('front_lat', 'real')
        .addColumn('front_lon', 'real')
        .addColumn('back_lat', 'real')
        .addColumn('back_lon', 'real')
        .addColumn('elevation', 'real')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('hazards_hole_id_index')
        .on('hazards')
        .column('hole_id')
        .execute();

    // --- Clubs ---

    await db.schema
        .createTable('clubs')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('user_id', 'text', (col) =>
            col.references('users.id').onDelete('cascade'))
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('carry_m', 'real', (col) => col.notNull())
        .addColumn('dispersion_m', 'real', (col) => col.notNull())
        .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('clubs_user_id_index')
        .on('clubs')
        .column('user_id')
        .execute();

    // --- Game plans ---

    await db.schema
        .createTable('game_plans')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('user_id', 'text', (col) =>
            col.references('users.id').onDelete('cascade'))
        .addColumn('wind_speed_mps', 'real')
        .addColumn('wind_direction_deg', 'real')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('game_plans_course_id_index')
        .on('game_plans')
        .column('course_id')
        .execute();

    // Note: SQLite treats NULLs as distinct in unique indexes, so this only
    // enforces one plan per (course, user) when user_id is non-null. Multiple
    // NULL-user plans per course are technically allowed until multi-user
    // auth lands — acceptable per spec.
    await db.schema
        .createIndex('game_plans_course_id_user_id_unique')
        .on('game_plans')
        .columns(['course_id', 'user_id'])
        .unique()
        .execute();

    await db.schema
        .createTable('game_plan_holes')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('game_plan_id', 'text', (col) =>
            col.notNull().references('game_plans.id').onDelete('cascade'))
        .addColumn('hole_number', 'integer', (col) => col.notNull())
        .addColumn('tee_id', 'text', (col) =>
            col.references('tees.id').onDelete('set null'))
        .addColumn('preferred_club_id', 'text', (col) =>
            col.references('clubs.id').onDelete('set null'))
        .addColumn('planned_direction_deg', 'real')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('game_plan_holes_game_plan_id_index')
        .on('game_plan_holes')
        .column('game_plan_id')
        .execute();

    await db.schema
        .createIndex('game_plan_holes_tee_id_index')
        .on('game_plan_holes')
        .column('tee_id')
        .execute();

    await db.schema
        .createIndex('game_plan_holes_preferred_club_id_index')
        .on('game_plan_holes')
        .column('preferred_club_id')
        .execute();

    await db.schema
        .createTable('plan_shots')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('game_plan_hole_id', 'text', (col) =>
            col.notNull().references('game_plan_holes.id').onDelete('cascade'))
        .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('elevation', 'real')
        .addColumn('club_id', 'text', (col) =>
            col.references('clubs.id').onDelete('set null'))
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('plan_shots_game_plan_hole_id_index')
        .on('plan_shots')
        .column('game_plan_hole_id')
        .execute();

    await db.schema
        .createIndex('plan_shots_club_id_index')
        .on('plan_shots')
        .column('club_id')
        .execute();

    // --- Rounds & shots (follow-up) ---

    await db.schema
        .createTable('rounds')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('user_id', 'text', (col) =>
            col.references('users.id').onDelete('cascade'))
        .addColumn('started_at', 'text', (col) => col.notNull())
        .addColumn('ended_at', 'text')
        .addColumn('notes', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('rounds_course_id_index')
        .on('rounds')
        .column('course_id')
        .execute();

    await db.schema
        .createIndex('rounds_user_id_index')
        .on('rounds')
        .column('user_id')
        .execute();

    await db.schema
        .createTable('shots')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('round_id', 'text', (col) =>
            col.notNull().references('rounds.id').onDelete('cascade'))
        .addColumn('hole_number', 'integer', (col) => col.notNull())
        .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('lat', 'real', (col) => col.notNull())
        .addColumn('lon', 'real', (col) => col.notNull())
        .addColumn('club_id', 'text', (col) =>
            col.references('clubs.id').onDelete('set null'))
        .addColumn('lie', 'text')
        .addColumn('recorded_at', 'text', (col) => col.notNull())
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('shots_round_id_index')
        .on('shots')
        .column('round_id')
        .execute();

    await db.schema
        .createIndex('shots_club_id_index')
        .on('shots')
        .column('club_id')
        .execute();

    // --- Course assets ---

    await db.schema
        .createTable('course_assets')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('course_id', 'text', (col) =>
            col.notNull().references('courses.id').onDelete('cascade'))
        .addColumn('kind', 'text', (col) => col.notNull())
        .addColumn('filename', 'text', (col) => col.notNull())
        .addColumn('meta_json', 'text')
        .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('updated_at', 'text', (col) =>
            col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex('course_assets_course_id_index')
        .on('course_assets')
        .column('course_id')
        .execute();
}
