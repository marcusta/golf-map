// shared/strategy/caddy — the smart-caddy advice layer: a fixed evaluator
// over a growing set of pure, self-gating rules (feature-smart-caddy.md).
// Barrel export; the parent strategy index re-exports these.

export {
    type CaddyLeg,
    type CaddyContext,
    type CaddyAdviceKind,
    type CaddyAdvice,
    type CaddyRule,
    type RiskProfile,
    type FeatureDistance,
    type GreenSlopeSummary,
} from './rule';
export { runCaddy } from './run';
export { exampleLongParRule } from './rules/example-long-par';
export {
    greenSlopeHalfRule,
    MIN_FALL_LINE_PCT,
    FALL_LINE_ALIGN_TOLERANCE_DEG,
    FRONT_CLEAN_WINDOW_M,
} from './rules/green-slope-half';
