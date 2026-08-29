// Putting & green reading — Phase A physics core
// (docs/feature-putting-green-reading.md §3, §6, §7).
//
// One physics core, three data tiers: green-surface.ts is the contract,
// planeSurface the Tier-3 manual/analytic adapter, dem-surface.ts the
// Tier-2 DEM adapter (Tier-1 LiDAR arrives with iOS Phase E). putt.ts is
// the exact-tier rolling-ball integrator; tour-read.ts the closed form and
// the on-course verbal read.

export {
    type SurfaceSample,
    type GreenSurface,
    planeSurface,
} from './green-surface';
export {
    type DemGrid,
    DEM_DEFAULT_CONFIDENCE,
    demSurface,
} from './dem-surface';
export {
    type PuttReadOptions,
    type PuttRead,
    HOLE_RADIUS_M,
    LIP_OUT_SPEED_MPS,
    captureRadiusM,
    readPutt,
} from './putt';
export {
    type BreakSide,
    type TourRead,
    type TourReadVerbal,
    type UnitSystem,
    STIMP_RELEASE_V0_MPS,
    FRICTION_CONSTANT,
    FEET_TO_METERS,
    INCHES_TO_METERS,
    PACE_METERS,
    TOUR_READ_REFERENCE_STIMP_FT,
    STIMP_BREAK_SCALE_PER_FT,
    stimpToFriction,
    PLAYS_LIKE_FRICTION_CONSTANT,
    stimpToPlaysLikeFriction,
    metersToPaces,
    inchesToMeters,
    stimpBreakScale,
    tourReadAimInchesAtReference,
    tourReadAimInches,
    breakMultiplier,
    playsLikeLength,
    tourRead,
    tourReadFromPaces,
    formatTourRead,
} from './tour-read';
