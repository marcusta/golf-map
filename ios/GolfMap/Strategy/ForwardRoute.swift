import Foundation

/// Forward-route aim filter — faithful Swift port of
/// `shared/strategy/forward-route.ts`. Which of a hole's aim points are still
/// AHEAD of an arbitrary origin (browse tap, GPS fix), so the distance line
/// routes origin → remaining aims → green instead of snaking back through
/// corners already passed. Replaces the v1 radial rule ("keep an aim iff it is
/// closer to the green than the origin"), which retained a dogleg corner when
/// the player was past the corner laterally but still radially farther from
/// the green than the aim. The two MUST stay numerically identical: the
/// `forwardRoute` section of the TS-generated golden fixtures
/// (`strategy-goldens.json`) pins the parity.
///
/// Method: route-chainage projection. Project the origin onto the full hole
/// route polyline (tee → aims → green) and take the chainage (meters along
/// the route from its first vertex) of the nearest point. An aim is "passed"
/// when its own chainage is at or behind that projection (+ a small margin);
/// the kept aims are the suffix strictly ahead. Chainage is monotonic over
/// the ordered aim vertices, so the result is always an in-order suffix.
///
/// The route START is open-ended: an origin may legitimately be behind the
/// first vertex (no tee supplied, or standing behind the tee), so the first
/// leg projects with t in (-inf, 1] and yields NEGATIVE chainage there —
/// every aim stays ahead. Interior vertices are real waypoints and keep the
/// closed [0, 1] clamp.
///
/// Units & conventions: points are projected planar meters (EPSG:3006-style
/// {x, y}); elevations are ignored — routing is planar. Pure and
/// deterministic.

/// Chainage (meters along `route` from its first vertex) of the point on
/// `route` nearest to `p`. Routes with fewer than 2 points have no legs and
/// yield 0. Zero-length legs (duplicate vertices) are skipped for projection
/// but contribute their (zero) length to chainage identically. The FIRST
/// non-zero-length leg clamps t to (-inf, 1] — an origin behind the route
/// start projects onto the leg's backward extension and yields negative
/// chainage; all later legs clamp to [0, 1]. Mirror of `forward-route.ts`
/// `projectedRouteChainage`.
public func projectedRouteChainage(route: [StrategyPoint], point p: StrategyPoint) -> Double {
    guard route.count >= 2 else { return 0 }
    var bestDist = Double.infinity
    var bestChainage = 0.0
    var cum = 0.0
    var firstLeg = true
    for i in 0..<(route.count - 1) {
        let a = route[i]
        let b = route[i + 1]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let len2 = dx * dx + dy * dy
        if len2 == 0 { continue } // zero-length leg: nothing to project onto, adds no chainage
        let len = sqrt(len2)
        let tRaw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
        // First leg is open-ended behind the route start (see header): an
        // origin behind it projects to negative chainage instead of pinning
        // to vertex 0. Interior legs clamp to the segment.
        let t = firstLeg ? min(1, tRaw) : min(1, max(0, tRaw))
        firstLeg = false
        let cx = a.x + t * dx
        let cy = a.y + t * dy
        let dist = sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy))
        // `<=`, not `<`: exact ties resolve to the LATER leg. In the interior
        // of a dogleg elbow the origin can be equidistant from both legs;
        // biasing to the later leg deliberately favors "straight at the
        // green" (higher chainage → the corner aim reads as passed).
        if dist <= bestDist {
            bestDist = dist
            bestChainage = cum + t * len
        }
        cum += len
    }
    return bestChainage
}

/// Mirror of `forward-route.ts` `ForwardAimsInput`.
public struct ForwardAimsInput {
    public var origin: StrategyPoint
    /// Tee position — the hole route's first vertex. Optional: without it the
    /// chainage route starts at the first aim.
    public var tee: StrategyPoint?
    /// Hole aim points in tee→green order (override-resolved positions).
    public var aims: [StrategyPoint]
    public var green: StrategyPoint
    /// An aim must be at least this far ahead (chainage) of the origin's
    /// projection to be kept. Default 5 (the TS default).
    public var marginM: Double

    public init(
        origin: StrategyPoint,
        tee: StrategyPoint? = nil,
        aims: [StrategyPoint],
        green: StrategyPoint,
        marginM: Double = 5
    ) {
        self.origin = origin
        self.tee = tee
        self.aims = aims
        self.green = green
        self.marginM = marginM
    }
}

/// Indices into `input.aims` of the aims still ahead of `origin` along the
/// hole's routing — always a contiguous in-order suffix (chainage is
/// monotonic over the ordered aim vertices). Exposed so callers can map the
/// kept positions back to their labeled aim objects. Index-returning
/// companion of `forward-route.ts` `forwardAims` (same filter, same order).
public func forwardAimIndices(_ input: ForwardAimsInput) -> [Int] {
    guard !input.aims.isEmpty else { return [] }
    var chainageRoute: [StrategyPoint] = []
    if let tee = input.tee { chainageRoute.append(tee) }
    chainageRoute.append(contentsOf: input.aims)
    chainageRoute.append(input.green)
    guard chainageRoute.count >= 2 else { return [] }
    let s = projectedRouteChainage(route: chainageRoute, point: input.origin)
    // Cumulative chainage of every route vertex. Zero-length legs add 0 —
    // identical accumulation to projectedRouteChainage's skip.
    var vertexChainage: [Double] = [0]
    var cum = 0.0
    for i in 1..<chainageRoute.count {
        let a = chainageRoute[i - 1]
        let b = chainageRoute[i]
        let dx = b.x - a.x
        let dy = b.y - a.y
        cum += sqrt(dx * dx + dy * dy)
        vertexChainage.append(cum)
    }
    let firstAimVertex = input.tee != nil ? 1 : 0
    return input.aims.indices.filter { vertexChainage[firstAimVertex + $0] > s + input.marginM }
}

/// The aims still ahead of `origin` along the hole's routing (suffix of
/// `input.aims`). Mirror of `forward-route.ts` `forwardAims`.
public func forwardAims(_ input: ForwardAimsInput) -> [StrategyPoint] {
    forwardAimIndices(input).map { input.aims[$0] }
}

/// Full forward play-line: [origin, ...forwardAims(input), green]. Mirror of
/// `forward-route.ts` `forwardRoutePoints`.
public func forwardRoutePoints(_ input: ForwardAimsInput) -> [StrategyPoint] {
    [input.origin] + forwardAims(input) + [input.green]
}

/// Within this planar distance of the green the next shot targets the GREEN,
/// so the drawn line goes straight there: an aim a few meters ahead (still
/// kept by the chainage filter) is not a shot target and only adds a
/// meaningless kink to the line. Mirror of `forward-route.ts`
/// `AIM_ROUTING_THRESHOLD_M`; equals `OnCourseModel.
/// defaultAimRoutingThresholdMeters` (the GPS-mode TO AIM gate) — the two are
/// pinned equal by the goldens parity test.
public let AIM_ROUTING_THRESHOLD_M: Double = 230

/// The drawn play-line policy shared by GPS and browse modes: within
/// `thresholdM` (inclusive) of the green the line is the straight
/// [origin, green] (aims are no longer shot targets — see
/// AIM_ROUTING_THRESHOLD_M); beyond it, the chainage-filtered
/// `forwardRoutePoints`. NOT for the layup spine — layup landing points
/// always follow the full routed line, gate or not (a layup exists precisely
/// because the green is out of reach). Mirror of `forward-route.ts`
/// `gatedForwardRoutePoints` (its optional `thresholdM` input field is this
/// defaulted parameter; iOS lets the user tune it).
public func gatedForwardRoutePoints(
    _ input: ForwardAimsInput,
    thresholdM: Double = AIM_ROUTING_THRESHOLD_M
) -> [StrategyPoint] {
    let dx = input.green.x - input.origin.x
    let dy = input.green.y - input.origin.y
    if sqrt(dx * dx + dy * dy) <= thresholdM { return [input.origin, input.green] }
    return forwardRoutePoints(input)
}
