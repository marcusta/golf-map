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
    par5AttackRule,
    FULL_NUMBER_LAYUP_M,
    LAY_BACK_OF_PINCH_BUFFER_M,
    LAYUP_TARGET_TOLERANCE_M,
} from './rules/par5-attack';
export {
    greenSlopeHalfRule,
    MIN_FALL_LINE_PCT,
    FALL_LINE_ALIGN_TOLERANCE_DEG,
    FRONT_CLEAN_WINDOW_M,
} from './rules/green-slope-half';
export {
    noDoublesRule,
    NO_DOUBLES_VETOES,
    TAIL_GAP_WARN,
    TAIL_GAP_SEVERE,
} from './rules/no-doubles';
export {
    shortSideGuardRule,
    SHORT_SIDE_VETOES,
    SHORT_SIDE_TROUBLE_SHARE,
    SHORT_SIDE_TROUBLE_SEVERE,
} from './rules/short-side-guard';
export {
    takeYourMedicineRule,
    MEDICINE_VETOES,
    ESCAPE_ADVANCE_FRACTION,
    HERO_EXTRA_ADVANCE_M,
} from './rules/take-your-medicine';
export { specificTargetRule } from './rules/specific-target';
export {
    canYouCarryItRule,
    CLUB_UP_MAX_PAST_TARGET_M,
} from './rules/can-you-carry-it';
export {
    overTheTreesRule,
    TREES_BLOCKED_PRIORITY,
    TREES_MARGINAL_PRIORITY,
} from './rules/over-the-trees';
