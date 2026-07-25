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
export {
    type CarryOverHazard,
    hazardsAlongLine,
} from './carry';
export {
    type PointRole,
    type DistanceTarget,
    type FeatureDistance,
    type FeatureDistancesInput,
    featureDistances,
} from './feature-distances';
export {
    type ForwardAimsInput,
    type GatedForwardRouteInput,
    AIM_ROUTING_THRESHOLD_M,
    projectedRouteChainage,
    forwardAims,
    forwardRoutePoints,
    gatedForwardRoutePoints,
} from './forward-route';
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
// Option-chain scoring (feature-plan-shot-options.md O4): the score/risk
// triple for one authored option branch, generalising the par-5 attack
// rule's two-shot chain to depth n. Derived client-side, never persisted.
export {
    type ChainLeg,
    type ChainScoreContext,
    type ChainLegScore,
    type ChainScore,
    scoreOptionChain,
} from './option-chain';
// Whole-hole simulation & score distributions (feature-hole-sim-and-variants.md
// V1/V2/V3/V4). Closeout pmf whose mean is pinned to the Broadie table, and a
// hybrid Monte-Carlo rollout that turns one authored branch into a score
// distribution. Derived, never persisted (O4/V8).
export {
    OVERDISPERSION_BY_LIE,
    strokesDistribution,
    distributionMean,
} from './score-distribution';
export {
    type SimulateChainOptions,
    type SimulateChainResult,
    DEFAULT_SIM_SEED,
    DEFAULT_ROLLOUTS,
    simulateChain,
} from './simulate-chain';
// Variant discovery (feature-hole-sim-and-variants.md V5): the candidate-
// landing graph, topological signatures, and the "distinct ways to play the
// hole" enumerator. Derived, never persisted (O4/V7).
export {
    MAX_VARIANT_NODES,
    MAX_VARIANT_LEGS,
    LATERAL_OFFSET_M,
    LATERAL_MARGIN_M,
    MIN_LATERAL_OFFSET_M,
    SIGNATURE_CORRIDOR_M,
    TOP_VARIANTS,
    type HoleHazard,
    type VariantHoleContext,
    type HazardRelation,
    type HazardEngagement,
    type VariantSignature,
    type GraphNode,
    type GraphEdge,
    type VariantGraph,
    type ScoredVariant,
    buildVariantGraph,
    computeSignature,
    discoverVariants,
} from './variant-graph';
// Smart-caddy advice layer. NOTE: GreenSlopeSummary is still
// FORWARD-DECLARED (see caddy/rule.ts) until the slope adapter (T9) exports
// the canonical type. FeatureDistance is now sourced from feature-distances.ts
// (T4, above) — the caddy's own forward-declared FeatureDistance (rule.ts)
// stays as an internal structural-subset type for CaddyContext but is no
// longer re-exported here to avoid a duplicate export name.
export {
    type CaddyLeg,
    type CaddyContext,
    type CaddyAdviceKind,
    type CaddyAdvice,
    type CaddyRule,
    type RiskProfile,
    type GreenSlopeSummary,
    runCaddy,
    exampleLongParRule,
} from './caddy';
// Strokes-gained analytics (shot-capture doc §5). Pure fold over recorded
// rounds; T14's lane.
export {
    type RecordedShotType,
    type RecordedStroke,
    type DistanceBand,
    type SgCategory,
    type ShotSg,
    type HoleRound,
    type SgBucket,
    type RoundSgSummary,
    distanceBand,
    categorize,
    holeStrokesGained,
    aggregateStrokesGained,
    roundStrokesGained,
} from './strokes-gained-round';
// Putting & green reading — Phase A physics core
// (docs/feature-putting-green-reading.md). See putting/index.ts.
export * from './putting';
