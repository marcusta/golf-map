/**
 * Generated from shared/feature-gates.json. Do not edit by hand.
 * Run: bun run feature-gates:generate
 */

export type FeatureTier = 'T1' | 'T2' | 'T3';

export const FEATURE_GATE_KEYS = ['pinEntry', 'laserCalibration', 'planEditing', 'planOptionsTree', 'decideMode', 'puttRead'] as const;
export type FeatureGateKey = (typeof FEATURE_GATE_KEYS)[number];

export type FeatureGates = Readonly<Record<FeatureGateKey, boolean>>;
export type FeatureGateDefinition = Readonly<{
    enabled: boolean;
    tier: FeatureTier;
}>;

export const FEATURE_GATE_DEFINITIONS = {
    pinEntry: { enabled: false, tier: 'T2' },
    laserCalibration: { enabled: false, tier: 'T2' },
    planEditing: { enabled: false, tier: 'T2' },
    planOptionsTree: { enabled: false, tier: 'T3' },
    decideMode: { enabled: false, tier: 'T3' },
    puttRead: { enabled: false, tier: 'T3' },
} as const satisfies Record<FeatureGateKey, FeatureGateDefinition>;

export const DEFAULT_FEATURE_GATES: FeatureGates = Object.freeze({
    pinEntry: false,
    laserCalibration: false,
    planEditing: false,
    planOptionsTree: false,
    decideMode: false,
    puttRead: false,
});
