import type { Generated } from 'kysely';

export interface Database {
    cleanup_areas: { site_id: string; version: number; areas_json: string };
    users: UsersTable;
    sites: SitesTable;
    courses: CoursesTable;
    holes: HolesTable;
    tees: TeesTable;
    course_tee_sets: CourseTeeSetsTable;
    greens: GreensTable;
    pins: PinsTable;
    aim_points: AimPointsTable;
    course_features: CourseFeaturesTable;
    hazards: HazardsTable;
    clubs: ClubsTable;
    game_plans: GamePlansTable;
    game_plan_holes: GamePlanHolesTable;
    plan_shots: PlanShotsTable;
    plan_gates: PlanGatesTable;
    rounds: RoundsTable;
    shots: ShotsTable;
    course_assets: CourseAssetsTable;
    green_scans: GreenScansTable;
    green_calibration: GreenCalibrationTable;
    putt_estimate_samples: PuttEstimateSamplesTable;
    map_build_jobs: MapBuildJobsTable;
    terrain_edits: TerrainEditsTable;
    course_zone_types: CourseZoneTypesTable;
    tapscore_published_scores: TapscorePublishedScoresTable;
    site_photos: SitePhotosTable;
    course_feature_history: CourseFeatureHistoryTable;
    terrain_edit_history: TerrainEditHistoryTable;
}

// --- Auth ---

export interface UsersTable {
    id: string;
    username: string;
    password_hash: string;
    created_at: Generated<string>;
}

// --- Sites (physical location owning the shared map) ---

export interface SitesTable {
    id: string;
    name: string;
    notes: string | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Courses ---

export interface CoursesTable {
    id: string;
    name: string;
    status: string; // 'draft' | 'published'
    revision: number;
    crs: string; // e.g. 'EPSG:3006'
    georeference_json: string | null; // affine transform: projected CRS <-> course-local space
    home_lat: number | null; // WGS84, for course list sorting/map centering
    home_lon: number | null;
    notes: string | null;
    site_id: string | null; // the site whose map this course uses (null = no map yet)
    gspro_export_dir: string | null; // GSPro SVG export folder; null = the server default (Downloads)
    gspro_course_dir: string | null; // GSPro course (scene) folder the GreenKeeper .GKD export writes into; null = not set
    gspro_meta_json: string | null; // GSPro course details (GsproCourseMeta) the .GKD export writes; null = leave the file's own
    opcd_course_name: string | null; // what the course is called in OPCD's cloud builder (its Course Workflow row); null = not set
    next_feature_no: Generated<number>; // the next course_features.feature_no (migration 026 triggers keep it)
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface HolesTable {
    id: string;
    course_id: string;
    number: number;
    par: number;
    drawing_group_name: Generated<string | null>;
    drawing_group_after: Generated<number | null>;
    drawing_group_order: Generated<number | null>;
    drawing_stack_order: Generated<number | null>;
    stroke_index: number | null; // handicap/SI 1–18 (nullable — blank allowed)
    notes: string | null;
    saved_region_json: string | null; // v1 per-hole map region (nullable)
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface TeesTable {
    id: string;
    hole_id: string;
    tee_set_id: string | null; // the course tee set it belongs to (migration 029); null until adopted by TeeSetsService
    name: string; // e.g. 'yellow' — the set's name, kept in step by TeeSetsService
    color: string | null; // the set's colour, likewise
    gspro_only: Generated<number>; // 1 = the set's `gspro_only`, likewise: a tee the course guide leaves out
    lat: number;
    lon: number;
    elevation: number | null;
    sort_order: number;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

/** A course's tee set: what "Yellow" is for the whole course (migration 029). */
export interface CourseTeeSetsTable {
    id: string;
    course_id: string;
    name: string;
    color: string | null;
    sort_order: number;
    rating_men: number | null; // course rating, men
    slope_men: number | null;
    rating_women: number | null;
    slope_women: number | null;
    gspro_rating: string; // 'men' | 'women': which of the two ratings the .GKD export writes for the set
    gspro_tee: string | null; // the GreenKeeper tee type the set is exported as (GKD_TEE_TYPES); null = not in GSPro
    gspro_only: Generated<number>; // 1 = exists for GSPro alone (a Junior or Par3 set); out of the course guide
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface GreensTable {
    id: string;
    hole_id: string;
    boundary_json: string | null; // geometry comes later (Bezier/polygon)
    center_lat: number;
    center_lon: number;
    front_lat: number | null;
    front_lon: number | null;
    back_lat: number | null;
    back_lon: number | null;
    elevation: number | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface PinsTable {
    id: string;
    green_id: string;
    name: string;
    lat: number;
    lon: number;
    difficulty: string | null;
    active: number; // bool as 0/1
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface AimPointsTable {
    id: string;
    hole_id: string;
    sort_order: number;
    lat: number;
    lon: number;
    elevation: number | null;
    label: string | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface CourseFeaturesTable {
    id: string;
    course_id: string;
    hole_id: string | null;
    type: string; // see CourseFeaturesService.FEATURE_TYPES
    geometry_json: string; // native path/bezier geometry in projected CRS
    geojson: string | null; // derived WGS84 GeoJSON
    layer: string | null; // 'roughs' = the Roughs group under every hole (hole_id is then NULL); null = hole / course-level (D28)
    sort_order: number; // per-group (course_id, hole_id, layer) stack z-order; higher = on top (D23)
    source: string | null; // import provenance: producer id (e.g. 'osm'), null = hand-drawn (T49)
    generated: Generated<number>; // 1 = written by the pipeline bulk-replace route (read-only in the editor), 0 = hand-drawn or imported
    source_ref: string | null; // source-local ref (e.g. 'way/123456')
    license: string | null; // license short name (e.g. 'ODbL') — any ODbL feature makes the course's map data ODbL
    attributes_json: string | null; // flat JSON object of scalar per-feature attributes (e.g. lidar tree heights), null = none
    feature_no: Generated<number | null>; // per-course number, never reused, shown in hex (the GSPro shape name); null = generated (migration 026)
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface HazardsTable {
    id: string;
    hole_id: string;
    kind: string; // bunker|water_red|water_yellow
    front_lat: number | null;
    front_lon: number | null;
    back_lat: number | null;
    back_lon: number | null;
    elevation: number | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Clubs & game plans ---

export interface ClubsTable {
    id: string;
    user_id: string | null; // single-user era: nullable ok
    name: string;
    carry_m: number;
    dispersion_m: number;
    sort_order: number;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface GamePlansTable {
    id: string;
    course_id: string;
    user_id: string | null;
    wind_speed_mps: number | null;
    wind_direction_deg: number | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface GamePlanHolesTable {
    id: string;
    game_plan_id: string;
    hole_number: number;
    tee_id: string | null;
    preferred_club_id: string | null;
    planned_direction_deg: number | null;
    wind_speed_mps: number | null; // per-hole override; null = inherit plan wind
    wind_direction_deg: number | null;
    notes: string | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface PlanShotsTable {
    id: string;
    game_plan_hole_id: string;
    parent_shot_id: string | null; // sibling group; null = tee-root options
    sort_order: number;
    lat: number;
    lon: number;
    elevation: number | null;
    club_id: string | null;
    label: string | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface PlanGatesTable {
    id: string;
    game_plan_hole_id: string;
    lat: number; // absolute WGS84 station point
    lon: number;
    direction_deg: number; // corridor-axis bearing; the ruler is its perpendicular
    half_width_left_m: number;
    half_width_right_m: number;
    source: string; // 'manual' | 'computed'
    sort_order: number;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Rounds & shots (follow-up) ---

export interface RoundsTable {
    id: string;
    course_id: string;
    user_id: string | null;
    started_at: string;
    ended_at: string | null;
    notes: string | null;
    game_plan_id: string | null;
    wind_speed_mps: number | null;
    wind_direction_deg: number | null;
    stimp_ft: number | null;
    // T60 Tapscore bridge: optional link to a Tapscore friendly round.
    tapscore_round_token: string | null;
    ball_id: string | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

/**
 * T60 bridge publish state, one row per (round, hole). See migration 014 —
 * embeds a monotonic `version` in the Tapscore `client_event_id` so per-hole
 * score changes propagate through Tapscore's insert-once idempotency.
 */
export interface TapscorePublishedScoresTable {
    round_id: string;
    hole_number: number;
    version: number;
    strokes: number | null;
    event_type: string;
    synced: number;
}

export interface ShotsTable {
    id: string;
    round_id: string;
    hole_number: number;
    sort_order: number;
    lat: number;
    lon: number;
    club_id: string | null;
    lie: string | null;
    shot_type: string;
    target_lat: number | null;
    target_lon: number | null;
    penalty_strokes: number;
    recorded_at: string;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Green scans & calibration (putting green reading §4.2) ---

export interface GreenScansTable {
    id: string;
    green_id: string;
    kind: string; // 'corridor' | 'spot_level'
    captured_at: string;
    payload_json: string; // raw scan / sample data
    quality_json: string | null; // out-and-back residuals etc
    created_at: Generated<string>;
}

export interface GreenCalibrationTable {
    green_id: string; // pk, fk → greens
    bias_json: string | null; // low-frequency bias fit vs DEM (nullable; v1 leaves null)
    confidence: number; // 0..1
    sample_count: number;
    updated_at: Generated<string>;
}

// --- Putt estimate samples (training loop §5.1) ---

export interface PuttEstimateSamplesTable {
    id: string;
    green_id: string | null; // fk → greens (nullable: Tier-3 manual reads have no green)
    distance_m: number;
    stimp_ft: number;
    actual_slope_pct: number;
    estimated_slope_pct: number;
    actual_aim_offset_m: number;
    estimated_aim_offset_m: number;
    actual_plays_like_m: number;
    estimated_plays_like_m: number;
    break_side_actual: string; // 'left' | 'right' | 'straight'
    break_side_estimated: string;
    created_at: Generated<string>;
}

// --- Assets ---

export interface CourseAssetsTable {
    id: string;
    course_id: string;
    site_id: string | null; // map assets resolve by site (shared across a site's courses)
    kind: string; // ortho_cog|dem_cog|svg_source|tile_manifest
    filename: string;
    meta_json: string | null; // bounds/zooms/elevation range
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Map build jobs (server-driven golfpipe tile pipeline runs) ---

export interface MapBuildJobsTable {
    id: string;
    course_id: string;
    site_id: string | null; // the site (map) this build targets
    kind: Generated<string>; // 'build' (full pipeline) | 're-terrain' (fast edit replay, T56)
    status: string; // pending|running|succeeded|failed
    step: string | null; // current BUILD_STEPS value, or null
    bbox_json: string; // JSON {west,south,east,north} WGS84
    log: string;
    error: string | null;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Terrain edits (smooth/flatten the DEM; replayed as vector edits at build) ---

export interface TerrainEditsTable {
    id: string;
    site_id: string; // the site (map) this edit belongs to — site owns the map (D-TE1)
    op: string; // 'plane' | 'smooth' (D-TE3)
    params_json: string; // JSON { featherM, radiusM?, flat? }
    rings_json: string; // JSON straight-segment rings in the DEM CRS (EPSG:3006)
    enabled: number; // bool as 0/1
    origin: string | null; // generator that wrote the row ('building-pads'); NULL = hand-drawn
    origin_ref: string | null; // what it was generated for (a building id); replaced/kept by this on regeneration
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Edit history (migration 025, written by triggers; FeatureHistoryService reads it) ---

/** A course feature's state before one change: `update`/`delete` hold the old row (no `geojson`), `restack` only `sort_order`/`version`/`updated_at`. */
export interface CourseFeatureHistoryTable {
    history_id: Generated<number>;
    feature_id: string;
    course_id: string;
    op: 'update' | 'restack' | 'delete';
    changed_at: Generated<string>; // UTC 'YYYY-MM-DD HH:MM:SS.SSS'
    row_json: string;
}

/** A terrain edit's state before an update or delete (the old row as JSON). */
export interface TerrainEditHistoryTable {
    history_id: Generated<number>;
    edit_id: string;
    site_id: string;
    op: 'update' | 'delete';
    changed_at: Generated<string>;
    row_json: string;
}

// --- Course zone types (the legend `vegetation_zone` features point at) ---

export interface CourseZoneTypesTable {
    id: string;
    course_id: string;
    key: string; // [a-z0-9_]+, unique per course — what a feature's `zoneType` attribute names
    name: string; // display name
    color: string; // '#rrggbb', editor tint
    texture_index: number; // VSPro mask texture index, >= 0
    channel: number; // RGBA channel 0..3 of that texture (unique per course+texture)
    sort_order: number;
    items_json: string; // JSON [{ item, minDensity, maxDensity }] — VSPro item bindings (D-VZ9), the Default mix
    variants_json: Generated<string>; // JSON [{ key, name, items }] — named item mixes a zone picks by `zoneVariant` (migration 022)
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Reference photos (docs/feature-reference-photos.md §5.1) ---

export interface SitePhotosTable {
    id: string; // made on the phone
    site_id: string; // no FK: photos are user data and outlive content changes
    course_id: string | null;
    hole: number | null;
    captured_at: string;
    lat: number;
    lon: number;
    h_acc_m: number;
    gps_alt_m: number | null;
    v_acc_m: number | null;
    x3006: number;
    y3006: number;
    attitude_quat_json: string | null; // {"w","x","y","z"}
    yaw_deg: number;
    pitch_deg: number;
    roll_deg: number;
    heading_acc_deg: number | null;
    mag_calibration: number | null;
    hfov_deg: number;
    vfov_deg: number;
    width: number;
    height: number;
    eye_height_m: number;
    device_model: string | null;
    lens: string;
    tags_json: string; // JSON string[]
    note: string | null;
    original_sha256: string | null;
    original_bytes: number | null;
    original_uploaded_at: string | null;
    original_deleted_at: string | null;
    preview_sha256: string | null;
    preview_bytes: number | null;
    preview_uploaded_at: string | null;
    upload_seq: number | null; // builder pull cursor, VPS side
    pulled_at: string | null;
    refined_yaw_deg: number | null;
    refined_pitch_deg: number | null;
    refined_roll_deg: number | null;
    refine_method: string | null; // 'skyline' | 'manual'
    refine_residual_deg: number | null;
    refined_at: string | null;
    edited_at: string | null; // tags/note/hole edited on this box; the pull keeps them
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}
