import Foundation

/// Course FeatureType → strokes-gained Lie mapping — faithful Swift port of
/// `shared/strategy/lie.ts`. The two MUST stay numerically identical: ported
/// tests + TS-generated golden fixtures (`strategy-goldens.json`) pin the
/// parity.
///
/// String-keyed on purpose (same contract as `FlatRing.kind`): callers pass
/// the feature-type string straight through. Unknown types fall back to rough
/// (safe middle: never free, never a penalty).

/// Strokes-gained lie taxonomy (expected-strokes baseline rows). Mirror of
/// `lie.ts` `Lie`.
public enum Lie: String, CaseIterable, Codable, Sendable {
    case tee
    case fairway
    case rough
    case sand
    case recovery
    case green
    case penalty
}

private let FEATURE_TO_LIE: [String: Lie] = [
    "tee": .fairway,
    "fairway": .fairway,
    "green": .green,
    "semi_rough": .rough,
    "rough": .rough,
    "deep_rough": .recovery,
    "trees": .recovery,
    "bunker": .sand,
    "water": .penalty,
    "water_creek": .penalty,
    "penalty_yellow": .penalty,
    "penalty_red": .penalty,
    "oob": .penalty,
    "outside": .penalty,
    "path": .fairway,
]

/// Lie for a course-feature type string ('bunker' → .sand, …). Unknown types
/// → .rough. Mirror of `lie.ts` `lieFromFeatureType`.
public func lieFromFeatureType(_ featureType: String) -> Lie {
    FEATURE_TO_LIE[featureType] ?? .rough
}
