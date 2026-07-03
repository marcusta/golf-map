import type { Generated } from 'kysely';

export interface Database {
    users: UsersTable;
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
    rounds: RoundsTable;
    shots: ShotsTable;
    course_assets: CourseAssetsTable;
}

// --- Auth ---

export interface UsersTable {
    id: string;
    username: string;
    password_hash: string;
    created_at: Generated<string>;
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
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface HolesTable {
    id: string;
    course_id: string;
    number: number;
    par: number;
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
    type: string; // tee|fairway|green|bunker|semi_rough|rough|deep_rough|water|water_creek|path|outside
    geometry_json: string; // native path/bezier geometry in projected CRS
    geojson: string | null; // derived WGS84 GeoJSON
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
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

export interface PlanShotsTable {
    id: string;
    game_plan_hole_id: string;
    sort_order: number;
    lat: number;
    lon: number;
    elevation: number | null;
    club_id: string | null;
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
    recorded_at: string;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}

// --- Assets ---

export interface CourseAssetsTable {
    id: string;
    course_id: string;
    kind: string; // ortho_cog|dem_cog|svg_source|tile_manifest
    filename: string;
    meta_json: string | null; // bounds/zooms/elevation range
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
}
