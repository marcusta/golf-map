// shared/strategy — the single reference implementation of the golf
// strategy math. Pure TypeScript, zero framework/runtime deps (no
// MapLibre, no @basics/core, no DOM): web consumes it directly and the
// iOS Swift port mirrors it function-for-function.
//
// Conventions (all modules): distances in meters; planar coordinates in
// projected meters (EPSG:3006-style {x, y}, +x east, +y north); bearings
// compass degrees from north, clockwise; wind speed m/s canonical, wind
// direction = where the wind comes FROM. Formulas are exact ports of the
// v1 iOS app (see per-module headers for file references) plus the
// ROADMAP-decided Phase-5 extensions (crosswind drift, corridor width).

export { MPS_TO_MPH, mpsToMph, mphToMps } from './units';
export {
    type ClubSpec,
    type ClubAdvice,
    lengthDispersionM,
    minCarryM,
    maxCarryM,
    minDispersionM,
    maxDispersionM,
    closestClub,
    clubAdvice,
    suggestClubForHole,
} from './club';
export {
    type WindComponents,
    windComponents,
    windEffect,
    adjustedCarryM,
    playsAsM,
    crosswindDriftM,
} from './wind';
export {
    type Vec2,
    type DispersionEllipseOptions,
    type DispersionEllipse,
    bearingToUnitVector,
    dispersionEllipse,
    GREEN_RING_RADII_M,
    GREEN_RING_PAR5_EXTRA_M,
    TEE_RING_RADII_M,
    greenRingRadiiM,
    ringPolygon,
} from './ellipse';
export {
    type StrategyPoint,
    type SegmentStats,
    type PathTotals,
    segmentStats,
    pathSegmentStats,
    pathTotals,
} from './plays-like';
export {
    type FlatRing,
    type CorridorWidthOptions,
    type CorridorWidth,
    DEFAULT_HAZARD_TYPES,
    corridorWidth,
    pointInRing,
} from './corridor';
export { type Lie, lieFromFeatureType } from './lie';
export {
    EXPECTED_STROKES_ANCHORS_M,
    HOLED_DISTANCE_M,
    shotsToHoleOut,
    strokesGained,
} from './expected-strokes';
export {
    type AimOptions,
    type AimCandidate,
    type AimResult,
    defaultSweepDeg,
    optimizeAim,
    standardNormalPairs,
} from './aim';
