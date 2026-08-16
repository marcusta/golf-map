import Foundation

/// Default aim-target resolution for hole entry — D-HF1 (default aim) +
/// D-HF2 (fairway-snap ring walk) of `docs/feature-hole-select-framing.md`.
///
/// Pure planar geometry in projected meters (EPSG:3006-style {x east,
/// y north}, the strategy layer's `Vec2`); no UI, no model access — every
/// input is injected so the golden tests can pin the behavior with an
/// identity plays-like closure. `OnCourseModel` wires the real inputs
/// (origin chain, green center, fairway surfaces, bag, plays-like).
///
/// Resolution order (D-HF1):
///  1. Plan exists → the plan's current-leg landing point (`planLanding`).
///  2. Curated furniture aim points (`aimPoints`, ahead-of-origin, in hole
///     order) → the farthest one whose plays-like is within the longest
///     club's carry; when every aim point is beyond carry, the point at
///     longest-club carry along the origin → FIRST-aim-point bearing. A
///     curated aim point beats the ring walk whenever present.
///  3. No aim points → green center, clamped to the longest club: aim at the
///     green when plays-like(origin → green center) ≤ longest-club carry.
///  4. Otherwise the D-HF2 ring walk; if no ring ever hits fairway, the
///     point at longest-club carry along the origin → green-center bearing.
///
/// Ring walk (D-HF2): walk distance rings origin-outward starting at the
/// longest club's plays-like carry, stepping DOWN in `ringStepM` steps. At
/// each ring, intersect the circle with the fairway polygons (restricted to
/// the half-plane toward the green — aiming backwards is never a default);
/// merge the arc segments, drop those narrower than the advised club's
/// lateral dispersion at that distance, and pick the segment whose midpoint
/// is closest to the origin → green-center line. The segment MIDPOINT is the
/// aim ("middle of the fairway" laterally). First passing ring wins.
///
/// Deliberately corridor-dumb (see the design note): it may aim over trees.
/// Tree-awareness comes from preferring the plan target (rule 1).
public enum DefaultAim {

    public struct Input {
        /// Shot origin (GPS fix / browse origin / active tee), planar meters.
        public var origin: Vec2
        /// Green center, planar meters.
        public var greenCenter: Vec2
        /// Fairway polygon rings for the hole (implicitly closed), planar
        /// meters. Degenerate rings (< 3 points) are ignored.
        public var fairways: [[Vec2]]
        /// Curated per-hole aim points still AHEAD of the origin, in hole
        /// (tee → green) order, planar meters. When non-empty they replace
        /// the green clamp and the ring walk (rule 2).
        public var aimPoints: [Vec2]
        /// The plan's current-leg landing point, when a plan exists (green
        /// center for the last leg). Non-nil short-circuits everything else.
        public var planLanding: Vec2?
        /// Longest-club plays-like carry, meters. ≤ 0 (empty bag) disables
        /// the clamp — the default is then the green center.
        public var longestCarryM: Double
        /// Ring-walk step, meters (D-HF2: ~5).
        public var ringStepM: Double
        /// Lateral dispersion (FULL width, not a semi-axis — the v1 gotcha)
        /// of the advised club at a plays-like distance. The ring-walk width
        /// gate: an arc segment narrower than this is not a target.
        public var lateralDispersionM: (Double) -> Double
        /// Plays-like distance origin → point. Called with `greenCenter`
        /// (the clamp + the ground-per-plays-like scale along the green
        /// line) and with each aim point (rule 2's reachability); tests
        /// inject the identity (raw planar distance).
        public var playsLikeM: (Vec2) -> Double

        public init(
            origin: Vec2,
            greenCenter: Vec2,
            fairways: [[Vec2]],
            aimPoints: [Vec2] = [],
            planLanding: Vec2? = nil,
            longestCarryM: Double,
            ringStepM: Double = 5,
            lateralDispersionM: @escaping (Double) -> Double,
            playsLikeM: @escaping (Vec2) -> Double
        ) {
            self.origin = origin
            self.greenCenter = greenCenter
            self.fairways = fairways
            self.aimPoints = aimPoints
            self.planLanding = planLanding
            self.longestCarryM = longestCarryM
            self.ringStepM = ringStepM
            self.lateralDispersionM = lateralDispersionM
            self.playsLikeM = playsLikeM
        }
    }

    /// The default aim point, world (planar) coordinates. Total: always
    /// returns a point (degenerate inputs fall back to the green center).
    public static func resolve(_ input: Input) -> Vec2 {
        // 1. The plan already picked a corridor-aware target.
        if let planLanding = input.planLanding { return planLanding }

        let o = input.origin
        let g = input.greenCenter
        let rawGreenM = hypot(g.x - o.x, g.y - o.y)
        // No bag → no clamp; origin on the green → nothing to walk.
        guard input.longestCarryM > 0, rawGreenM > 1e-9 else { return g }

        // 2. Curated furniture aim points beat everything but the plan: the
        // FARTHEST one that still plays within the longest club's carry. All
        // beyond carry → longest carry along the origin → first-aim bearing
        // (the curated direction, not the green chord — the dogleg case).
        if let firstAim = input.aimPoints.first {
            var best: Vec2?
            var bestPlaysM = -Double.infinity
            for p in input.aimPoints {
                let playsM = input.playsLikeM(p)
                if playsM <= input.longestCarryM, playsM > bestPlaysM {
                    bestPlaysM = playsM
                    best = p
                }
            }
            if let best { return best }
            let rawAimM = hypot(firstAim.x - o.x, firstAim.y - o.y)
            if rawAimM > 1e-9 {
                let playsAimM = input.playsLikeM(firstAim)
                let scale = playsAimM > 0 ? rawAimM / playsAimM : 1
                return pointAt(
                    origin: o,
                    bearingRad: atan2(firstAim.x - o.x, firstAim.y - o.y),
                    radiusM: input.longestCarryM * scale
                )
            }
        }

        // 3. Green center, clamped on PLAYS-LIKE distance (D-HF1 rule 3:
        // clamping on horizontal would default the aim into the slope).
        let playsLikeGreenM = input.playsLikeM(g)
        if playsLikeGreenM <= input.longestCarryM { return g }

        // Ground meters per plays-like meter along the green line — the ring
        // radii are ground distances chosen so each ring PLAYS like its
        // walked distance (same scale `settleReticle` uses for its arcs).
        let groundPerPlaysLike = playsLikeGreenM > 0 ? rawGreenM / playsLikeGreenM : 1
        let bearingGreenRad = atan2(g.x - o.x, g.y - o.y) // compass radians

        // 4. D-HF2 ring walk, stepping DOWN from the longest carry.
        let step = max(input.ringStepM, 0.5)
        var walkedM = input.longestCarryM
        while walkedM > step {
            let radiusM = walkedM * groundPerPlaysLike
            if let mid = fairwayArcMidpoint(
                origin: o,
                bearingGreenRad: bearingGreenRad,
                radiusM: radiusM,
                fairways: input.fairways,
                minArcWidthM: input.lateralDispersionM(walkedM)
            ) {
                return mid
            }
            walkedM -= step
        }

        // No ring ever hit fairway (forced carry / data gap): the point at
        // longest-club carry along the origin → green-center bearing.
        return pointAt(
            origin: o,
            bearingRad: bearingGreenRad,
            radiusM: input.longestCarryM * groundPerPlaysLike
        )
    }

    // MARK: - Ring / fairway intersection

    /// Midpoint of the best fairway arc segment on the circle of `radiusM`
    /// around `origin`, or nil when no segment at least `minArcWidthM` wide
    /// exists. Only the half-circle toward the green (±90° off the green
    /// bearing) is considered. "Best" = midpoint closest to the origin →
    /// green-center line (smallest |angular offset| — monotone with the
    /// lateral distance inside the sector).
    static func fairwayArcMidpoint(
        origin: Vec2,
        bearingGreenRad: Double,
        radiusM: Double,
        fairways: [[Vec2]],
        minArcWidthM: Double
    ) -> Vec2? {
        guard radiusM > 0 else { return nil }
        let sector = Double.pi / 2
        let rings = fairways.filter { $0.count >= 3 }
        guard !rings.isEmpty else { return nil }

        // Boundary offsets off the green bearing where the circle crosses a
        // fairway edge, plus the sector limits. Between consecutive
        // boundaries the circle is entirely inside or outside the fairway.
        var boundaries: [Double] = [-sector, sector]
        for ring in rings {
            let n = ring.count
            for i in 0..<n {
                let a = ring[i]
                let b = ring[(i + 1) % n]
                appendCircleEdgeCrossings(
                    origin: origin, radiusM: radiusM, a: a, b: b,
                    bearingGreenRad: bearingGreenRad, sector: sector,
                    into: &boundaries
                )
            }
        }
        boundaries.sort()

        // Classify each gap by its midpoint, merging contiguous inside runs
        // into segments (shared vertices / tangent edges would otherwise
        // split one true segment and fail the width gate spuriously).
        struct Segment { var lo: Double; var hi: Double }
        var segments: [Segment] = []
        var current: Segment?
        for i in 0..<(boundaries.count - 1) {
            let lo = boundaries[i]
            let hi = boundaries[i + 1]
            guard hi - lo > 1e-9 else { continue }
            let probe = pointAt(
                origin: origin, bearingRad: bearingGreenRad + (lo + hi) / 2, radiusM: radiusM
            )
            let inside = rings.contains { pointInRing(probe, $0) }
            if inside {
                if var seg = current, lo - seg.hi < 1e-9 {
                    seg.hi = hi
                    current = seg
                } else {
                    if let seg = current { segments.append(seg) }
                    current = Segment(lo: lo, hi: hi)
                }
            } else if let seg = current {
                segments.append(seg)
                current = nil
            }
        }
        if let seg = current { segments.append(seg) }

        var best: Vec2?
        var bestAbsOffset = Double.infinity
        for seg in segments {
            let arcWidthM = radiusM * (seg.hi - seg.lo)
            guard arcWidthM >= minArcWidthM else { continue }
            let mid = (seg.lo + seg.hi) / 2
            if abs(mid) < bestAbsOffset {
                bestAbsOffset = abs(mid)
                best = pointAt(origin: origin, bearingRad: bearingGreenRad + mid, radiusM: radiusM)
            }
        }
        return best
    }

    /// Circle ∩ edge [a, b]: appends the angular offsets (off the green
    /// bearing, within ±`sector`) of the crossing points to `boundaries`.
    private static func appendCircleEdgeCrossings(
        origin: Vec2,
        radiusM: Double,
        a: Vec2,
        b: Vec2,
        bearingGreenRad: Double,
        sector: Double,
        into boundaries: inout [Double]
    ) {
        let dx = b.x - a.x
        let dy = b.y - a.y
        let fx = a.x - origin.x
        let fy = a.y - origin.y
        let qa = dx * dx + dy * dy
        guard qa > 0 else { return } // degenerate edge
        let qb = 2 * (fx * dx + fy * dy)
        let qc = fx * fx + fy * fy - radiusM * radiusM
        let disc = qb * qb - 4 * qa * qc
        guard disc >= 0 else { return }
        let sq = disc.squareRoot()
        for t in [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)] where t >= 0 && t <= 1 {
            let px = a.x + t * dx
            let py = a.y + t * dy
            let offset = wrappedAngle(atan2(px - origin.x, py - origin.y) - bearingGreenRad)
            if abs(offset) <= sector { boundaries.append(offset) }
        }
    }

    /// Point on the circle around `origin` at a compass bearing (radians).
    private static func pointAt(origin: Vec2, bearingRad: Double, radiusM: Double) -> Vec2 {
        Vec2(
            x: origin.x + radiusM * sin(bearingRad),
            y: origin.y + radiusM * cos(bearingRad)
        )
    }

    /// Normalizes an angle to (−π, π].
    private static func wrappedAngle(_ angle: Double) -> Double {
        var a = angle.truncatingRemainder(dividingBy: 2 * .pi)
        if a <= -.pi { a += 2 * .pi }
        if a > .pi { a -= 2 * .pi }
        return a
    }
}
