import Foundation

/// Smart-caddy rule model — the open–closed extension point that turns the
/// engine's NUMBERS into ranked, explained ADVICE. Faithful Swift port of
/// `shared/strategy/caddy/rule.ts`: a rule is a pure, self-gating function; the
/// evaluator (`CaddyRun.swift`) is fixed and owns all conflict resolution, so
/// no rule ever knows another rule exists. The two MUST stay behaviourally
/// identical: ported tests + TS-generated golden fixtures pin the parity.
///
/// Faithful to the TS shape including `aim?: AimResult` — the recommended
/// aim's priced outcome (mean, CVaR₈₀ tail, per-lie breakdown). The
/// EV/aim engine IS ported (`Aim.swift`); the plan editor supplies the
/// per-leg `AimResult` it already computes for the map overlay, and the
/// aim-reading rules (no-doubles, short-side-guard, specific-target) read it.
/// A context without a clubbed leg leaves `aim` nil, exactly as the TS
/// `buildLegContext` omits it for an unclubbed leg.
///
/// The one remaining deviation:
///  - `distances` / `clubs` are carried verbatim (typed to the Swift
///    `FeatureDistance` / `ClubSpec` mirrors) so the context shape matches.
///
/// Units mirror the whole strategy library: planar meters {x east, y north}
/// (EPSG:3006), compass bearings (0 = north, clockwise). `CaddyContext` is
/// generic over the caller's concrete `ClubSpec` (mirrors the generic
/// `FeatureDistances` port), so the on-course screen passes `ClubRecord`.

/// FORWARD-DECL mirror of the TS `GreenSlopeSummary` (decision D10): the
/// dominant fall line plus a front/back split so a rule can say WHICH half to
/// favour. The pure rule never touches the analysis math — the platform derives
/// this via `summarizeGreenSlope` (GreenSlopeSummaryAdapter.swift) and passes it
/// in.
public struct GreenSlopeSummary: Equatable, Sendable {
    /// Dominant downhill (fall-line) bearing, compass degrees.
    public var fallLineBearingDeg: Double
    /// Dominant fall-line magnitude, percent (rise/run · 100).
    public var fallLinePct: Double
    /// Mean slope of the front half, percent.
    public var frontHalfPct: Double
    /// Mean slope of the back half, percent.
    public var backHalfPct: Double

    public init(fallLineBearingDeg: Double, fallLinePct: Double, frontHalfPct: Double, backHalfPct: Double) {
        self.fallLineBearingDeg = fallLineBearingDeg
        self.fallLinePct = fallLinePct
        self.frontHalfPct = frontHalfPct
        self.backHalfPct = backHalfPct
    }
}

/// Player risk tolerance — a thin wrapper over the single `riskAversion` number
/// (decision D16: one number, 0..1). 0 = pure expected value; 1 = fully weight
/// the tail. Mirror of `rule.ts` `RiskProfile`.
public struct RiskProfile: Equatable, Sendable {
    /// 0..1 weight on the tail term. Default 0 = pure EV.
    public var riskAversion: Double
    public init(riskAversion: Double) { self.riskAversion = riskAversion }
}

/// Which leg of the hole this advice request is for.
public enum CaddyLeg: String, Equatable, Sendable {
    case tee
    case approach
    case layup
    case recovery
}

/// The category of a piece of advice — drives how the UI renders it. Raw values
/// match the TS union member strings.
public enum CaddyAdviceKind: String, Equatable, Sendable {
    case aim
    case club
    case targetHalf = "target-half"
    case layup
    case layBack = "lay-back"
    case warning
}

/// The green being played to, with the reference points rules aim at. Mirror of
/// the TS context `target`.
public struct CaddyGreenTarget<Club: ClubSpec> {
    public var greenPoly: FlatRing
    public var center: Vec2
    public var front: Vec2
    public var back: Vec2
    public var pin: Vec2?

    public init(greenPoly: FlatRing, center: Vec2, front: Vec2, back: Vec2, pin: Vec2? = nil) {
        self.greenPoly = greenPoly
        self.center = center
        self.front = front
        self.back = back
        self.pin = pin
    }
}

/// The hole descriptor a rule may read. Mirror of TS `hole: { par, index }`.
public struct CaddyHole: Equatable, Sendable {
    public var par: Int
    public var index: Int
    public init(par: Int, index: Int) {
        self.par = par
        self.index = index
    }
}

/// Everything a rule may read, pre-computed by the platform. Never raw domain
/// entities. Mirror of `rule.ts` `CaddyContext` (see file header for the two
/// intentional deviations).
public struct CaddyContext<Club: ClubSpec> {
    public var leg: CaddyLeg
    /// Shot origin, planar meters (elevation optional).
    public var origin: StrategyPoint
    /// The green being played to.
    public var target: CaddyGreenTarget<Club>
    /// Measured targets along the shot (◄ FeatureDistances).
    public var distances: [FeatureDistance<Club>]
    /// The recommended aim's priced outcome for this leg (◄ optimizeAim), or
    /// nil when the leg has no club to aim. Read by the aim-based rules.
    public var aim: AimResult?
    /// Green slope summary (◄ summarizeGreenSlope adapter).
    public var greenSlope: GreenSlopeSummary?
    /// Flattened hazard rings for the hole, caller-filtered.
    public var hazards: [FlatRing]
    /// The player's clubs.
    public var clubs: [Club]
    /// Wind: speed m/s, direction FROM in compass degrees. Nil for calm.
    public var wind: FeatureWind?
    public var hole: CaddyHole
    /// Player risk tolerance (D16).
    public var risk: RiskProfile

    public init(
        leg: CaddyLeg,
        origin: StrategyPoint,
        target: CaddyGreenTarget<Club>,
        distances: [FeatureDistance<Club>] = [],
        aim: AimResult? = nil,
        greenSlope: GreenSlopeSummary? = nil,
        hazards: [FlatRing] = [],
        clubs: [Club] = [],
        wind: FeatureWind? = nil,
        hole: CaddyHole,
        risk: RiskProfile
    ) {
        self.leg = leg
        self.origin = origin
        self.target = target
        self.distances = distances
        self.aim = aim
        self.greenSlope = greenSlope
        self.hazards = hazards
        self.clubs = clubs
        self.wind = wind
        self.hole = hole
        self.risk = risk
    }
}

/// One ranked, explained recommendation. `priority` is the base severity of the
/// concern; `confidence` is the rule's own certainty. The evaluator ranks by
/// priority × confidence, risk-weighted where the rule opts in (D12). `vetoes`
/// lists rule ids whose advice THIS advice demotes. Mirror of `rule.ts`
/// `CaddyAdvice`.
public struct CaddyAdvice: Equatable, Sendable {
    /// id of the rule that produced this advice.
    public var ruleId: String
    public var kind: CaddyAdviceKind
    /// Base severity of the concern, ≥ 0.
    public var priority: Double
    /// Rule's own certainty, 0..1.
    public var confidence: Double
    /// The recommendation headline.
    public var headline: String
    /// The one-sentence "why", optional.
    public var detail: String?
    /// Where to draw it on the overlay, planar meters.
    public var anchor: Vec2?
    /// Rule ids whose advice this one overrides (demote/remove).
    public var vetoes: [String]?
    /// Opt-in: scale this advice's priority by the player's riskAversion in
    /// ranking (D12). Safety rules set this; omitted → risk-neutral ranking.
    public var riskWeighted: Bool

    public init(
        ruleId: String,
        kind: CaddyAdviceKind,
        priority: Double,
        confidence: Double,
        headline: String,
        detail: String? = nil,
        anchor: Vec2? = nil,
        vetoes: [String]? = nil,
        riskWeighted: Bool = false
    ) {
        self.ruleId = ruleId
        self.kind = kind
        self.priority = priority
        self.confidence = confidence
        self.headline = headline
        self.detail = detail
        self.anchor = anchor
        self.vetoes = vetoes
        self.riskWeighted = riskWeighted
    }
}

/// A pure, self-gating advice rule. `appliesTo` is a cheap gate; `evaluate` is
/// pure and returns 0..n advice. A rule never inspects other rules — conflict
/// handling is the evaluator's job. Modelled as a value-with-closures (mirrors
/// the TS object literal) so `runCaddy` can take a heterogeneous array of rules.
public struct CaddyRule<Club: ClubSpec> {
    public let id: String
    /// Cheap gate — is this rule relevant to this context at all?
    public let appliesTo: (CaddyContext<Club>) -> Bool
    /// Pure; 0..n advice items. Only called when appliesTo returned true.
    public let evaluate: (CaddyContext<Club>) -> [CaddyAdvice]

    public init(
        id: String,
        appliesTo: @escaping (CaddyContext<Club>) -> Bool,
        evaluate: @escaping (CaddyContext<Club>) -> [CaddyAdvice]
    ) {
        self.id = id
        self.appliesTo = appliesTo
        self.evaluate = evaluate
    }
}
