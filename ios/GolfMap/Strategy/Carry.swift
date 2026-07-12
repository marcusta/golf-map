import Foundation

/// Along-line hazard front/carry distances + the ray/ring geometry they need
/// — faithful Swift port of `shared/strategy/carry.ts` plus the `FlatRing`,
/// `rayRingIntersections` and `pointInRing` slices of `corridor.ts` / `ray.ts`
/// it depends on. The two MUST stay numerically identical: ported tests +
/// TS-generated golden fixtures (`strategy-goldens.json`) pin the parity.
///
/// Pure planar geometry in projected meters (EPSG:3006-style {x, y}, reusing
/// the putting core's `Vec2`). Bearings are compass degrees (0 = north,
/// clockwise). Callers pre-flatten and pre-filter obstacle rings.

/// A flattened obstacle ring (implicitly closed) with its feature type.
/// Mirror of `corridor.ts` `FlatRing`.
public struct FlatRing: Equatable, Sendable {
    public var points: [Vec2]
    /// Course-feature type, e.g. 'bunker' — informational passthrough.
    public var kind: String

    public init(points: [Vec2], kind: String) {
        self.points = points
        self.kind = kind
    }
}

public struct CarryOverHazard: Equatable, Sendable {
    public var ring: FlatRing
    /// Near-edge distance along the shot line, meters.
    public var frontM: Double
    /// Far-edge distance along the shot line, meters.
    public var carryM: Double
}

private let RAY_EPS = 1e-12
private let RAY_DEDUPE_EPS_M = 1e-9

/// All unique boundary-intersection distances (t >= 0) between a ray and a
/// ring's segments, sorted ascending. Parallel/coincident edges are ignored.
/// Mirror of `ray.ts` `rayRingIntersections`.
public func rayRingIntersections(
    _ origin: Vec2,
    _ dir: Vec2,
    _ points: [Vec2],
    maxDistanceM: Double = .infinity
) -> [Double] {
    var hits: [Double] = []
    let n = points.count

    for i in 0..<n {
        let a = points[i]
        let b = points[(i + 1) % n]
        let sx = b.x - a.x
        let sy = b.y - a.y
        let denom = dir.x * sy - dir.y * sx // dir × s
        if abs(denom) < RAY_EPS { continue } // parallel (or degenerate edge)

        let qx = a.x - origin.x
        let qy = a.y - origin.y
        let t = (qx * sy - qy * sx) / denom // distance along the ray
        let u = (qx * dir.y - qy * dir.x) / denom // position along the edge

        if t >= -RAY_EPS && t <= maxDistanceM + RAY_EPS && u >= -RAY_EPS && u <= 1 + RAY_EPS {
            hits.append(abs(t) < RAY_EPS ? 0 : t)
        }
    }

    hits.sort()

    var unique: [Double] = []
    for hit in hits where unique.isEmpty || abs(hit - unique[unique.count - 1]) > RAY_DEDUPE_EPS_M {
        unique.append(hit)
    }
    return unique
}

/// Point-in-polygon (ray casting) against an implicitly closed ring. Points
/// exactly on an edge may land on either side. Mirror of `corridor.ts`
/// `pointInRing`.
public func pointInRing(_ p: Vec2, _ ring: [Vec2]) -> Bool {
    var inside = false
    let n = ring.count
    var j = n - 1
    for i in 0..<n {
        let a = ring[i]
        let b = ring[j]
        let intersects = (a.y > p.y) != (b.y > p.y)
            && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x
        if intersects { inside.toggle() }
        j = i
    }
    return inside
}

/// Which hazard rings the shot line crosses and where their near/far
/// boundaries are. Mirror of `carry.ts` `hazardsAlongLine`.
public func hazardsAlongLine(
    _ origin: Vec2,
    _ bearingDeg: Double,
    _ obstacles: [FlatRing],
    maxM: Double = .infinity
) -> [CarryOverHazard] {
    let dir = bearingToUnitVector(bearingDeg)
    var out: [CarryOverHazard] = []

    for ring in obstacles {
        let hits = rayRingIntersections(origin, dir, ring.points, maxDistanceM: maxM)
        let originInside = ring.points.count >= 3 && pointInRing(origin, ring.points)

        if originInside {
            if hits.count >= 1 {
                out.append(CarryOverHazard(ring: ring, frontM: 0, carryM: hits[hits.count - 1]))
            }
            continue
        }

        if hits.count >= 2 && hasInteriorInterval(origin, dir, ring.points, hits) {
            out.append(CarryOverHazard(ring: ring, frontM: hits[0], carryM: hits[hits.count - 1]))
        }
    }

    return out
}

private func hasInteriorInterval(_ origin: Vec2, _ dir: Vec2, _ points: [Vec2], _ hits: [Double]) -> Bool {
    if points.count < 3 { return false }

    for i in 0..<(hits.count - 1) {
        let mid = (hits[i] + hits[i + 1]) / 2
        let p = Vec2(x: origin.x + dir.x * mid, y: origin.y + dir.y * mid)
        if pointInRing(p, points) { return true }
    }

    return false
}
