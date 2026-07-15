import Foundation

/// The green-local 2D frame every pin input resolves through
/// (docs/feature-laser-pin-and-calibration.md §3):
///
///  - **depth axis** — the tee→green-centre bearing (line of play); depth 0 is
///    the green polygon's front-most point along that axis, `depthM` its
///    back-most.
///  - **lateral axis** — perpendicular, positive toward the player's right.
///
/// Built from the lie-map's green ring (EPSG:3006 planar, `Vec2` {x east,
/// y north}). Pure value type; all queries are exact geometry against the
/// polygon — no smoothing.
struct GreenFrame: Equatable, Sendable {
    /// Unit vector along the line of play (front → back).
    let depthAxis: Vec2
    /// Unit vector to the player's right.
    let lateralAxis: Vec2
    /// Green extent along the depth axis, metres (front = 0).
    let depthM: Double

    /// The projection reference: planar = ref + depthAxis·(depth + depthOffset)
    /// + lateralAxis·lateral. `ref` is the tee; `depthOffset` shifts depth 0
    /// onto the polygon's front edge.
    private let ref: Vec2
    private let depthOffset: Double
    /// Outer ring in frame coordinates (depth from front, lateral), closed
    /// implicitly (last→first edge included in traversals).
    private let frameRing: [Vec2]

    /// Lateral lookups exactly on the front/back extreme degenerate to a
    /// single tangent vertex; nudge queries this far inside. Pins are never
    /// authored within 10 cm of the edge, so this is invisible in practice.
    private static let edgeInsetM = 0.1

    /// `nil` when the ring is degenerate or the tee coincides with the green
    /// centre (no line of play).
    init?(outerRing: [Vec2], teePlanar: Vec2, greenCenterPlanar: Vec2) {
        guard outerRing.count >= 3 else { return nil }
        let dx = greenCenterPlanar.x - teePlanar.x
        let dy = greenCenterPlanar.y - teePlanar.y
        let len = (dx * dx + dy * dy).squareRoot()
        guard len > 1 else { return nil }

        let depth = Vec2(x: dx / len, y: dy / len)
        // Facing along `depth`, the player's right is the axis rotated -90°.
        let lateral = Vec2(x: depth.y, y: -depth.x)

        var raw: [Vec2] = []
        raw.reserveCapacity(outerRing.count)
        var minDepth = Double.infinity
        var maxDepth = -Double.infinity
        for v in outerRing {
            let rx = v.x - teePlanar.x
            let ry = v.y - teePlanar.y
            let d = rx * depth.x + ry * depth.y
            let l = rx * lateral.x + ry * lateral.y
            raw.append(Vec2(x: d, y: l))
            minDepth = min(minDepth, d)
            maxDepth = max(maxDepth, d)
        }
        guard maxDepth - minDepth > 0.5 else { return nil }

        self.depthAxis = depth
        self.lateralAxis = lateral
        self.ref = teePlanar
        self.depthOffset = minDepth
        self.depthM = maxDepth - minDepth
        self.frameRing = raw.map { Vec2(x: $0.x - minDepth, y: $0.y) }
    }

    // MARK: - Cross-sections

    /// Lateral extent (left, right) of the polygon at `depth` metres from the
    /// front. The depth line's ring crossings pair up into inside intervals;
    /// this returns the WIDEST one, so a lateral fraction always maps onto the
    /// putting surface — a bi-lobed (kidney) cross-section resolves to its
    /// bigger lobe rather than a span bridging the notch. Pins in the smaller
    /// lobe are placed by dragging in the confirm UI.
    func lateralRange(atDepth depth: Double) -> (left: Double, right: Double)? {
        let d = min(max(depth, Self.edgeInsetM), depthM - Self.edgeInsetM)
        var crossings: [Double] = []
        let n = frameRing.count
        for i in 0..<n {
            let a = frameRing[i]
            let b = frameRing[(i + 1) % n]
            guard (a.x > d) != (b.x > d) else { continue }
            let t = (d - a.x) / (b.x - a.x)
            crossings.append(a.y + t * (b.y - a.y))
        }
        guard crossings.count >= 2 else { return nil }
        crossings.sort()
        // A tangent vertex can yield an odd count; degrade to the full span.
        guard crossings.count % 2 == 0 else {
            return (crossings[0], crossings[crossings.count - 1])
        }
        var best: (left: Double, right: Double) = (crossings[0], crossings[1])
        for i in stride(from: 2, to: crossings.count, by: 2)
        where crossings[i + 1] - crossings[i] > best.right - best.left {
            best = (crossings[i], crossings[i + 1])
        }
        return best
    }

    /// Cross-section width at `depth` (0 when the depth line misses the ring —
    /// cannot happen for depths inside [0, depthM] on a simple ring).
    func width(atDepth depth: Double) -> Double {
        guard let range = lateralRange(atDepth: depth) else { return 0 }
        return range.right - range.left
    }

    // MARK: - Frame → planar

    /// The planar point at `depthM` from the front, `lateralFraction` across
    /// that depth's cross-section (0 = left edge, 1 = right edge). Inputs are
    /// clamped into the green.
    func point(depthM depth: Double, lateralFraction: Double) -> Vec2 {
        let d = min(max(depth, 0), self.depthM)
        let f = min(max(lateralFraction, 0), 1)
        let lateral: Double
        if let range = lateralRange(atDepth: d) {
            lateral = range.left + f * (range.right - range.left)
        } else {
            lateral = 0
        }
        let along = d + depthOffset
        return Vec2(
            x: ref.x + depthAxis.x * along + lateralAxis.x * lateral,
            y: ref.y + depthAxis.y * along + lateralAxis.y * lateral
        )
    }

    // MARK: - Laser depth solve (spec §3.2)

    /// The depth whose frame point (at `lateralFraction`) lies `distanceM`
    /// from `originPlanar`. Distance is monotone in depth for any point the
    /// green is approached from, so bisection suffices. Distances shorter than
    /// front / longer than back clamp to the edge with `clamped = true` — the
    /// confirm UI surfaces that mismatch (it usually means the GPS origin is
    /// off → suggest calibration).
    func laserDepth(
        originPlanar: Vec2,
        distanceM: Double,
        lateralFraction: Double
    ) -> (depthM: Double, clamped: Bool) {
        func dist(_ depth: Double) -> Double {
            let p = point(depthM: depth, lateralFraction: lateralFraction)
            let dx = p.x - originPlanar.x
            let dy = p.y - originPlanar.y
            return (dx * dx + dy * dy).squareRoot()
        }

        let dFront = dist(0)
        let dBack = dist(depthM)
        if distanceM <= dFront { return (0, distanceM < dFront - 0.01) }
        if distanceM >= dBack { return (depthM, distanceM > dBack + 0.01) }

        var lo = 0.0
        var hi = depthM
        // ~1 mm resolution on a 40 m green in ≤ 16 iterations.
        for _ in 0..<32 {
            let mid = (lo + hi) / 2
            if dist(mid) < distanceM { lo = mid } else { hi = mid }
            if hi - lo < 0.001 { break }
        }
        return ((lo + hi) / 2, false)
    }
}
