import Foundation

/// Height-aware tree clearance: does a planned shot fly over the trees it
/// crosses, or into them? Faithful Swift port of
/// `shared/strategy/tree-clearance.ts`; the two MUST stay numerically
/// identical (the TS test cases are ported one-to-one in
/// `TreeClearanceTests`).
///
/// Pure planar geometry + a 1-D flight-height profile. Points are projected
/// meters (`Vec2`, EPSG:3006-style), heights are meters.
///
/// Input contract: tree features are course features of type 'trees'. This
/// module takes a minimal STRUCTURAL input (`TreeFeatureInput`): the flattened
/// outer ring plus the optional `attributes` the server derives from
/// canopy-height rasters (`heightMaxM`, `heightP90M`, `heightMeanM`, `areaM2`).
/// Hand-drawn trees carry no attributes and evaluate as `.unknown`.
///
/// Crossing geometry reuses `hazardsAlongLine` (Carry.swift: ray/ring
/// intersection, origin-inside handling); this module adds the height
/// dimension only.
///
/// Deviation from the TS: the TS functions are generic over the feature type
/// (`F extends TreeFeatureInput`) and callers compare crossings by object
/// identity; Swift uses the concrete value type `TreeFeatureInput` (with an
/// optional `id` for callers that need identity) and value equality.

// MARK: - Input types

/// Canopy-height statistics the server attaches to raster-derived tree
/// features, meters. Mirror of `TreeHeights`. Nil = not provided.
public struct TreeHeights: Equatable, Sendable {
    public var heightMaxM: Double?
    public var heightP90M: Double?
    public var heightMeanM: Double?
    public var areaM2: Double?

    public init(heightMaxM: Double? = nil, heightP90M: Double? = nil, heightMeanM: Double? = nil, areaM2: Double? = nil) {
        self.heightMaxM = heightMaxM
        self.heightP90M = heightP90M
        self.heightMeanM = heightMeanM
        self.areaM2 = areaM2
    }

    /// The tree-height keys read out of a flat feature `attributes` object.
    public init(attributes: [String: FeatureAttributeValue]) {
        self.init(
            heightMaxM: attributes["heightMaxM"]?.doubleValue,
            heightP90M: attributes["heightP90M"]?.doubleValue,
            heightMeanM: attributes["heightMeanM"]?.doubleValue,
            areaM2: attributes["areaM2"]?.doubleValue
        )
    }
}

/// Minimal structural view of a course feature for this module. Callers
/// flatten the feature's outer ring to planar meters and pass `attributes`
/// straight through. Mirror of `TreeFeatureInput`.
public struct TreeFeatureInput: Equatable, Sendable {
    /// Course-feature type; only 'trees' is considered.
    public var type: String
    /// Flattened outer ring, planar meters, implicitly closed.
    public var points: [Vec2]
    /// Server-derived attributes; nil on hand-drawn features.
    public var attributes: [String: FeatureAttributeValue]?
    /// Optional caller identity (feature id) — not read by this module.
    public var id: String?

    public init(type: String, points: [Vec2], attributes: [String: FeatureAttributeValue]? = nil, id: String? = nil) {
        self.type = type
        self.points = points
        self.attributes = attributes
        self.id = id
    }
}

/// Representative tree height for clearance, meters: heightP90M (robust to a
/// single outlier crown), else heightMaxM, else nil (no height data).
/// Non-finite, non-positive or non-numeric values count as missing.
/// Mirror of `treeHeightM`.
public func treeHeightM(_ feature: TreeFeatureInput) -> Double? {
    guard let attrs = feature.attributes else { return nil }
    if let p90 = numberOrNil(attrs["heightP90M"]) { return p90 }
    return numberOrNil(attrs["heightMaxM"])
}

private func numberOrNil(_ v: FeatureAttributeValue?) -> Double? {
    guard case .number(let n)? = v, n.isFinite, n > 0 else { return nil }
    return n
}

// MARK: - Crossings

/// Mirror of `TreeCrossing`.
public struct TreeCrossing: Equatable, Sendable {
    public var feature: TreeFeatureInput
    /// Distance along the line where the shot enters the ring, meters (0 when the origin is inside).
    public var entryM: Double
    /// Distance along the line where the shot leaves the ring, meters.
    public var exitM: Double
    /// `treeHeightM(feature)`; nil for hand-drawn trees.
    public var treeHeightM: Double?
}

/// Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters.
private func bearingDeg(_ a: Vec2, _ b: Vec2) -> Double {
    let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
    return (deg + 360).truncatingRemainder(dividingBy: 360)
}

/// Every 'trees' feature the ray origin→target crosses (the ray is not
/// truncated at the target: trees past the target still register so the
/// caller can flag rollout hazards). Sorted by entry distance. A line that
/// starts inside a ring reports entryM = 0. Mirror of `treeCrossingsAlongLine`.
public func treeCrossingsAlongLine(
    _ origin: Vec2,
    _ target: Vec2,
    _ features: [TreeFeatureInput]
) -> [TreeCrossing] {
    if hypot(target.x - origin.x, target.y - origin.y) <= 0 { return [] }
    let bearing = bearingDeg(origin, target)

    var rings: [FlatRing] = []
    var byRing: [TreeFeatureInput] = [] // parallel to `rings`
    for f in features {
        if f.type != "trees" || f.points.count < 3 { continue }
        rings.append(FlatRing(points: f.points, kind: "trees"))
        byRing.append(f)
    }

    var out: [TreeCrossing] = []
    // `hazardsAlongLine` preserves input order, so hits map back by position.
    var ringIndex = 0
    for hit in hazardsAlongLine(origin, bearing, rings) {
        while ringIndex < rings.count && rings[ringIndex] != hit.ring { ringIndex += 1 }
        let feature = ringIndex < rings.count ? byRing[ringIndex] : byRing[byRing.count - 1]
        out.append(TreeCrossing(feature: feature, entryM: hit.frontM, exitM: hit.carryM, treeHeightM: treeHeightM(feature)))
    }
    // Stable sort by entry (TS Array.prototype.sort is stable).
    out = out.enumerated().sorted {
        $0.element.entryM != $1.element.entryM ? $0.element.entryM < $1.element.entryM : $0.offset < $1.offset
    }.map(\.element)
    return out
}

// MARK: - Flight-height profile

/// Fraction of carry at which the apex sits. Real ball flight is skewed:
/// drag and the lift-driven "climb then drop" put the apex past the midpoint,
/// with the descent steeper than the launch. Launch-monitor summaries
/// (TrackMan tour averages) place the apex at roughly 60-65% of carry for
/// driver through irons; 0.62 is the middle of that band.
public let APEX_CARRY_FRACTION = 0.62

/// One sampled point of a real trajectory: distance along the line and ball height, meters.
public struct TrajectorySample: Equatable, Sendable {
    public var d: Double
    public var h: Double

    public init(d: Double, h: Double) {
        self.d = d
        self.h = h
    }
}

/// Ball height above the origin's ground at `distanceM` along the shot.
///
/// Without `samples`: two half-parabolas joined at the apex
/// (APEX_CARRY_FRACTION · carry, apexM), 0 at d = 0 and d = carry, rising
/// monotonically to the apex and falling monotonically after it. Outside
/// [0, carry] → 0.
///
/// With `samples` (>= 2 points, ascending `d`): linear interpolation between
/// samples; outside the sampled range → 0. Callers with a physics sampler
/// pass its output here and `carryM`/`apexM` are ignored.
/// Mirror of `trajectoryHeightAt`.
public func trajectoryHeightAt(
    _ distanceM: Double,
    carryM: Double,
    apexM: Double,
    samples: [TrajectorySample]? = nil
) -> Double {
    if let samples, samples.count >= 2 { return interpolateSamples(distanceM, samples) }

    if !(carryM > 0) || !(apexM > 0) { return 0 }
    if distanceM <= 0 || distanceM >= carryM { return 0 }

    let apexD = APEX_CARRY_FRACTION * carryM
    if distanceM <= apexD {
        let u = (apexD - distanceM) / apexD
        return apexM * (1 - u * u)
    }
    let u = (distanceM - apexD) / (carryM - apexD)
    return apexM * (1 - u * u)
}

private func interpolateSamples(_ d: Double, _ samples: [TrajectorySample]) -> Double {
    let first = samples[0]
    let last = samples[samples.count - 1]
    if d < first.d || d > last.d { return 0 }
    // Binary search for the bracketing pair.
    var lo = 0
    var hi = samples.count - 1
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1
        if samples[mid].d <= d { lo = mid } else { hi = mid }
    }
    let a = samples[lo]
    let b = samples[hi]
    let span = b.d - a.d
    if span <= 0 { return max(a.h, b.h) }
    let t = (d - a.d) / span
    return a.h + (b.h - a.h) * t
}

// MARK: - Clearance

/// Mirror of `TreeClearanceStatus`.
public enum TreeClearanceStatus: String, Equatable, Sendable {
    case clears
    case blocked
    case marginal
    case unknown

    /// Summary precedence: blocked > marginal > unknown > clears.
    fileprivate var rank: Int {
        switch self {
        case .clears: return 0
        case .unknown: return 1
        case .marginal: return 2
        case .blocked: return 3
        }
    }
}

/// Mirror of `TreeClearanceShot`.
public struct TreeClearanceShot: Equatable, Sendable {
    /// Planned carry, meters.
    public var carryM: Double
    /// Apex height above the origin's ground, meters. Ignored when `samples` is given.
    public var apexM: Double
    /// Optional real trajectory samples (see `trajectoryHeightAt`).
    public var samples: [TrajectorySample]?

    public init(carryM: Double, apexM: Double, samples: [TrajectorySample]? = nil) {
        self.carryM = carryM
        self.apexM = apexM
        self.samples = samples
    }
}

/// Mirror of `TreeClearanceOptions`.
public struct TreeClearanceOptions {
    /// Clearance below which a crossing is `.marginal`, meters. Default 2.
    public var marginM: Double?
    /// Ground elevation at the origin, meters. Default `groundAt(0)` if given, else 0.
    public var originGroundM: Double?
    /// Ground elevation at distance d along the line, meters. Nil for flat ground.
    public var groundAt: ((Double) -> Double)?

    public init(marginM: Double? = nil, originGroundM: Double? = nil, groundAt: ((Double) -> Double)? = nil) {
        self.marginM = marginM
        self.originGroundM = originGroundM
        self.groundAt = groundAt
    }
}

/// Mirror of `TreeClearanceCrossing` (TS extends `TreeCrossing`; Swift embeds it).
public struct TreeClearanceCrossing: Equatable, Sendable {
    public var crossing: TreeCrossing
    /// Worst (lowest) ball-minus-treetop height over the crossing, meters. Nil without height data.
    public var minClearanceM: Double?
    /// Distance along the line where `minClearanceM` occurs, meters. Nil without height data.
    public var worstAtM: Double?
    public var status: TreeClearanceStatus
    /// The carry point lies inside this ring (the existing recovery-lie case).
    public var landsIn: Bool

    public var feature: TreeFeatureInput { crossing.feature }
    public var entryM: Double { crossing.entryM }
    public var exitM: Double { crossing.exitM }
    public var treeHeightM: Double? { crossing.treeHeightM }
}

/// Mirror of `TreeClearanceResult`.
public struct TreeClearanceResult: Equatable, Sendable {
    public struct Summary: Equatable, Sendable {
        /// Precedence: blocked > marginal > unknown > clears. `.clears` when there are no crossings.
        public var status: TreeClearanceStatus
        /// The crossing with the lowest `minClearanceM`; nil when none has height data.
        public var worst: TreeClearanceCrossing?
    }

    /// Crossings the ball is airborne over (entry < carry), sorted by entry.
    public var crossings: [TreeClearanceCrossing]
    /// Tree rings wholly past the carry point (entry >= carry): rollout hazards, not flight obstacles.
    public var beyondCarry: [TreeCrossing]
    public var summary: Summary
}

public let DEFAULT_TREE_MARGIN_M = 2.0

/// Evaluation step along the line, meters.
private let TREE_STEP_M = 1.0

/// Height-aware clearance of every tree ring on the line origin→target for a
/// shot with the given carry and apex. Per crossing the worst point of
/// (ball height − tree top) over [entry, min(exit, carry)] is sampled every
/// 1 m plus both interval ends. With `groundAt`, tree top = ground(d) +
/// treeHeight and ball = originGround + trajectoryHeight; otherwise flat.
/// Mirror of `treeClearance`.
public func treeClearance(
    _ origin: Vec2,
    _ target: Vec2,
    _ features: [TreeFeatureInput],
    _ shot: TreeClearanceShot,
    _ opts: TreeClearanceOptions = TreeClearanceOptions()
) -> TreeClearanceResult {
    let marginM = opts.marginM ?? DEFAULT_TREE_MARGIN_M
    let groundAt = opts.groundAt
    let originGroundM = opts.originGroundM ?? (groundAt.map { $0(0) } ?? 0)
    let ground: (Double) -> Double = { d in groundAt.map { $0(d) } ?? originGroundM }
    let carryM = shot.carryM

    var crossings: [TreeClearanceCrossing] = []
    var beyondCarry: [TreeCrossing] = []

    for crossing in treeCrossingsAlongLine(origin, target, features) {
        if crossing.entryM >= carryM {
            beyondCarry.append(crossing)
            continue
        }

        let landsIn = carryM >= crossing.entryM && carryM <= crossing.exitM

        guard let height = crossing.treeHeightM else {
            crossings.append(TreeClearanceCrossing(
                crossing: crossing, minClearanceM: nil, worstAtM: nil, status: .unknown, landsIn: landsIn
            ))
            continue
        }

        let endM = min(crossing.exitM, carryM)
        var minClearanceM = Double.infinity
        var worstAtM = crossing.entryM
        func evaluate(_ d: Double) {
            let ball = originGroundM + trajectoryHeightAt(d, carryM: carryM, apexM: shot.apexM, samples: shot.samples)
            let top = ground(d) + height
            let c = ball - top
            if c < minClearanceM {
                minClearanceM = c
                worstAtM = d
            }
        }
        var d = crossing.entryM
        while d < endM {
            evaluate(d)
            d += TREE_STEP_M
        }
        evaluate(endM)

        let status: TreeClearanceStatus = minClearanceM < 0 ? .blocked : (minClearanceM < marginM ? .marginal : .clears)
        crossings.append(TreeClearanceCrossing(
            crossing: crossing, minClearanceM: minClearanceM, worstAtM: worstAtM, status: status, landsIn: landsIn
        ))
    }

    var worst: TreeClearanceCrossing?
    var status: TreeClearanceStatus = .clears
    for c in crossings {
        if c.status.rank > status.rank { status = c.status }
        if let m = c.minClearanceM, worst == nil || m < worst!.minClearanceM! { worst = c }
    }

    return TreeClearanceResult(
        crossings: crossings,
        beyondCarry: beyondCarry,
        summary: TreeClearanceResult.Summary(status: status, worst: worst)
    )
}
