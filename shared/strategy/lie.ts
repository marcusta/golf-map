// Course FeatureType → strokes-gained Lie mapping (DECADE plan §4.1,
// decision register D1). String-keyed on purpose: shared/strategy stays
// zero-dep, so it cannot import the web feature palette — callers pass the
// feature-type string straight through (same contract as FlatRing.kind).
//
// Landed-on-a-tee counts as fairway (short mown); path counts as fairway
// (cart-path relief onto adjacent lie); deep_rough and trees count as
// recovery for the current single-lie model, though they represent different
// domain concepts: deep_rough is low vegetation, trees are vertical
// obstruction. Water, rules areas, OOB, and outside are penalty. Unknown
// types fall back to rough (safe middle: never free, never a penalty).

/** Strokes-gained lie taxonomy (expected-strokes.ts baseline rows). */
export type Lie = 'tee' | 'fairway' | 'rough' | 'sand' | 'recovery' | 'green' | 'penalty';

const FEATURE_TO_LIE: Record<string, Lie> = {
    tee: 'fairway',
    fairway: 'fairway',
    green: 'green',
    semi_rough: 'rough',
    rough: 'rough',
    deep_rough: 'recovery',
    trees: 'recovery',
    bunker: 'sand',
    water: 'penalty',
    water_creek: 'penalty',
    penalty_yellow: 'penalty',
    penalty_red: 'penalty',
    oob: 'penalty',
    outside: 'penalty',
    path: 'fairway',
};

/**
 * Lie for a course-feature type string ('bunker' → 'sand', …). Unknown
 * types → 'rough'. Note this maps LANDING surfaces — the 'tee' Lie (the
 * teeing baseline row) is selected by callers for shot 1, never produced
 * by this mapping.
 */
export function lieFromFeatureType(featureType: string): Lie {
    return FEATURE_TO_LIE[featureType] ?? 'rough';
}
