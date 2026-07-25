import type { Generated } from 'kysely';

export interface Database {
    users: UsersTable;
    sites: SitesTable;
    courses: CoursesTable;
    holes: HolesTable;
    tees: TeesTable;
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
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface HolesTable {
    id: string;
    course_id: string;
    number: number;
    par: number;
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
    name: string; // e.g. 'yellow'
    color: string | null;
    lat: number;
    lon: number;
    elevation: number | null;
    sort_order: number;
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
    sort_order: number; // per-group (course_id, hole_id) stack z-order; higher = on top (D23)
    source: string | null; // import provenance: producer id (e.g. 'osm'), null = hand-drawn (T49)
    source_ref: string | null; // source-local ref (e.g. 'way/123456')
    license: string | null; // license short name (e.g. 'ODbL') — any ODbL feature makes the course's map data ODbL
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
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}
