import Foundation

/// Along-line hazard front/carry distances for the on-course distance card
/// (Part A). Pure planar composition over `hazardsAlongLine` (Carry.swift):
/// project the primary shot line (origin → the routed aim or green center),
/// find the hazard rings the line crosses, and expand each into a compact
/// front/carry row — matching the web semantics (decision D5: only hazards the
/// line crosses; near-edge = front, far-edge = carry).
///
/// These are RAW line distances: plays-like / wind adjustments are NOT applied
/// (same as the web). They are straight measured distances, so they are shown
/// even in competition mode (the DMD rule allows distance).
///
/// Units: planar EPSG:3006 meters {x east, y north}; compass bearings.

/// Which side of the shot line a hazard sits on (looking origin → target).
/// `.onLine` = the line crosses the ring (a true carry).
public enum HazardSide: String, Equatable, Sendable {
    case onLine
    case left
    case right
}

/// One hazard near the shot line, as whole-meter front/carry distances.
public struct HazardCarry: Equatable, Identifiable, Sendable {
    /// Display label for the hazard type, e.g. "Bunker", "Water".
    public var label: String
    /// The raw feature type ("bunker", "water", …), for styling.
    public var kind: String
    /// Near-edge distance along the shot line, whole meters.
    public var frontM: Int
    /// Far-edge distance along the shot line, whole meters.
    public var carryM: Int
    /// Which side of the line the hazard is on (`.onLine` when crossed).
    public var side: HazardSide
    /// The ring centroid in projected meters (EPSG:3006) — the point a tap
    /// focuses, so a SIDE hazard rings the actual bunker, not a line point.
    public var centroid: Vec2

    public var id: String { "\(kind)-\(side.rawValue)-\(frontM)-\(carryM)" }

    /// Label with a side prefix for off-line hazards ("R Bunker", "L Water").
    public var displayLabel: String {
        switch side {
        case .onLine: return label
        case .left: return "L \(label)"
        case .right: return "R \(label)"
        }
    }

    public init(
        label: String, kind: String, frontM: Int, carryM: Int,
        side: HazardSide = .onLine, centroid: Vec2 = Vec2(x: 0, y: 0)
    ) {
        self.label = label
        self.kind = kind
        self.frontM = frontM
        self.carryM = carryM
        self.side = side
        self.centroid = centroid
    }
}

public enum HazardCarries {

    /// Feature types shown as carry hazards on the card — the physical /
    /// penalty carries a player reads off the line (subset of the strategy
    /// `DEFAULT_HAZARD_TYPES`; ground types like deep_rough/trees are omitted so
    /// the card stays about true carries).
    public static let displayedTypes: Set<String> = [
        "bunker", "water", "water_creek", "penalty_yellow", "penalty_red",
    ]

    /// Feature types the tap-a-shape readout hit-tests — mirror of shared
    /// `TAPPABLE_RING_TYPES` (every corridor obstacle plus the green itself).
    public static let tappableTypes: Set<String> = [
        "bunker", "water", "water_creek", "outside", "deep_rough", "trees",
        "penalty_yellow", "penalty_red", "oob", "green",
    ]

    /// Human label for a feature type (unknown types Title-Cased as a fallback).
    public static func label(for kind: String) -> String {
        switch kind {
        case "bunker": return "Bunker"
        case "water": return "Water"
        case "water_creek": return "Creek"
        case "penalty_yellow", "penalty_red": return "Penalty"
        default:
            return kind
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Hazard front/carry rows along the line origin → target, sorted by front
    /// distance and capped to the `cap` nearest ahead. Only rings the ray
    /// actually crosses within the target distance are returned (a hazard past
    /// the target is not a carry to reach it). Pure planar — the model converts
    /// WGS84 → EPSG before calling.
    ///
    /// - Parameters:
    ///   - origin: shot origin, EPSG:3006.
    ///   - target: the primary target the card measures to, EPSG:3006.
    ///   - hazards: candidate hazard rings (already flattened / filtered).
    ///   - cap: max rows to return (2–3 nearest). Default 3.
    public static func along(
        origin: Vec2,
        target: Vec2,
        hazards: [FlatRing],
        cap: Int = 3
    ) -> [HazardCarry] {
        guard !hazards.isEmpty else { return [] }
        let dx = target.x - origin.x
        let dy = target.y - origin.y
        let distanceM = hypot(dx, dy)
        guard distanceM > 0 else { return [] }

        let deg = atan2(dx, dy) * 180 / .pi
        let bearingDeg = deg < 0 ? deg + 360 : deg

        let hits = hazardsAlongLine(origin, bearingDeg, hazards, maxM: distanceM)
        return hits
            .sorted {
                $0.frontM != $1.frontM ? $0.frontM < $1.frontM : $0.carryM < $1.carryM
            }
            .prefix(cap)
            .map {
                HazardCarry(
                    label: label(for: $0.ring.kind),
                    kind: $0.ring.kind,
                    frontM: Int($0.frontM.rounded()),
                    carryM: Int($0.carryM.rounded())
                )
            }
    }

    /// Hazard rows NEAR the shot line — the ladder variant. Includes rings the
    /// line crosses (`.onLine`, front/carry = the crossed extent) AND rings
    /// BESIDE the line within `corridorHalfWidthM` (a fairway bunker a little
    /// off-centre; `.left`/`.right`, front/carry = the ring's near/far extent
    /// projected onto the line). Each row carries the ring centroid so a tap
    /// focuses the actual hazard, not a point on the line.
    ///
    /// Distances are along-line projections from the origin. A ring is included
    /// when part of it lies ahead of the origin and no further than the target,
    /// and its nearest point is within the corridor. Sorted nearest-first, capped.
    ///
    /// - Parameters:
    ///   - corridorHalfWidthM: how far off the line still counts (each side).
    ///   - cap: max rows (the rail has room for more than the card's peek).
    public static func nearLine(
        origin: Vec2,
        target: Vec2,
        hazards: [FlatRing],
        corridorHalfWidthM: Double = 35,
        extraAheadM: Double = 0,
        cap: Int = 6
    ) -> [HazardCarry] {
        let dx = target.x - origin.x
        let dy = target.y - origin.y
        let len = hypot(dx, dy)
        guard len > 0, !hazards.isEmpty else { return [] }
        let ux = dx / len, uy = dy / len   // forward unit vector
        let rx = uy, ry = -ux              // right-hand normal (clockwise from forward)
        // How far past the target still counts — greenside bunkers sit around
        // (and just behind) the green centre, so the cutoff runs past it.
        let farM = len + extraAheadM

        var out: [HazardCarry] = []
        for ring in hazards where ring.points.count >= 3 {
            var tMin = Double.infinity, tMax = -Double.infinity
            var sMin = Double.infinity, sMax = -Double.infinity
            var cx = 0.0, cy = 0.0
            for p in ring.points {
                let ex = p.x - origin.x, ey = p.y - origin.y
                let t = ex * ux + ey * uy   // along the line
                let s = ex * rx + ey * ry   // right of the line (signed)
                tMin = min(tMin, t); tMax = max(tMax, t)
                sMin = min(sMin, s); sMax = max(sMax, s)
                cx += p.x; cy += p.y
            }
            // Ahead of the origin and not entirely past the (extended) target.
            guard tMax > 0, tMin <= farM else { continue }
            // Lateral gap to the line (0 when the ring straddles it).
            let straddles = sMin <= 0 && sMax >= 0
            let lateralGap = straddles ? 0 : min(abs(sMin), abs(sMax))
            guard lateralGap <= corridorHalfWidthM else { continue }

            let count = Double(ring.points.count)
            let centroid = Vec2(x: cx / count, y: cy / count)
            let centroidS = (centroid.x - origin.x) * rx + (centroid.y - origin.y) * ry
            let side: HazardSide = straddles ? .onLine : (centroidS >= 0 ? .right : .left)

            out.append(HazardCarry(
                label: label(for: ring.kind),
                kind: ring.kind,
                frontM: Int(max(0, tMin).rounded()),
                carryM: Int(tMax.rounded()),
                side: side,
                centroid: centroid
            ))
        }
        return out
            .sorted { $0.frontM != $1.frontM ? $0.frontM < $1.frontM : $0.carryM < $1.carryM }
            .prefix(cap)
            .map { $0 }
    }

    /// Hazard rows near ANY of several play lines (each a polyline from the ball
    /// through optional aim points to the green) — a dogleg has both a routed
    /// line (round the corner) and a direct line (cutting it), and a hazard in
    /// play on EITHER matters. A ring is measured along the line it sits closest
    /// to: front/carry are its near/far extent along that line from the ball,
    /// `side` is L/R of it, and it's included when that nearest line brings it
    /// within `corridorHalfWidthM` and ahead of the ball (≤ line length +
    /// `extraAheadM`). Each row carries the ring centroid for tap-focus. Sorted
    /// nearest-first, capped.
    public static func nearLines(
        _ lines: [[Vec2]],
        hazards: [FlatRing],
        corridorHalfWidthM: Double = 35,
        extraAheadM: Double = 0,
        cap: Int = 6
    ) -> [HazardCarry] {
        let polylines = lines.filter { $0.count >= 2 }
        guard !polylines.isEmpty, !hazards.isEmpty else { return [] }
        let lengths = polylines.map(polylineLength)

        var out: [HazardCarry] = []
        for ring in hazards where ring.points.count >= 3 {
            let centroid = ringCentroid(ring)
            var bestPerp = Double.infinity
            var chosen: (front: Int, carry: Int, side: HazardSide)?
            for (index, poly) in polylines.enumerated() {
                guard let c = project(centroid, onto: poly) else { continue }
                guard c.perp <= corridorHalfWidthM else { continue }
                var aMin = Double.infinity, aMax = -Double.infinity
                for p in ring.points {
                    if let vp = project(p, onto: poly) {
                        aMin = min(aMin, vp.along); aMax = max(aMax, vp.along)
                    }
                }
                let farM = lengths[index] + extraAheadM
                guard aMax > 0, aMin <= farM else { continue }
                if c.perp < bestPerp {
                    bestPerp = c.perp
                    let side: HazardSide = c.perp < 3 ? .onLine : (c.lateral >= 0 ? .right : .left)
                    chosen = (Int(max(0, aMin).rounded()), Int(aMax.rounded()), side)
                }
            }
            if let chosen {
                out.append(HazardCarry(
                    label: label(for: ring.kind), kind: ring.kind,
                    frontM: chosen.front, carryM: chosen.carry,
                    side: chosen.side, centroid: centroid
                ))
            }
        }
        return out
            .sorted { $0.frontM != $1.frontM ? $0.frontM < $1.frontM : $0.carryM < $1.carryM }
            .prefix(cap)
            .map { $0 }
    }

    /// A tapped ring's chainage window plus the play-line points the two
    /// numbers measure to — mirror of shared `RingLineExtent`. The points
    /// anchor the on-map edge markers/labels; `carry` feeds the banner row.
    public struct RingLineExtent: Equatable, Sendable {
        public var carry: HazardCarry
        /// The play-line point `carry.frontM` measures to (near edge), EPSG:3006.
        public var frontPoint: Vec2
        /// The play-line point `carry.carryM` measures to (far edge), EPSG:3006.
        public var carryPoint: Vec2

        public init(carry: HazardCarry, frontPoint: Vec2, carryPoint: Vec2) {
            self.carry = carry
            self.frontPoint = frontPoint
            self.carryPoint = carryPoint
        }
    }

    /// The chainage window ONE explicitly tapped ring occupies along the
    /// nearest of several play lines — the tap-a-shape readout (mirror of
    /// shared `ringExtentAlongLines`). Same projection math as `nearLines`,
    /// minus the corridor / ahead gating: a tapped shape was chosen
    /// deliberately, so it is never filtered out. Nil for a degenerate ring,
    /// no usable line, or a ring entirely BEHIND every line's start.
    public static func extent(of ring: FlatRing, along lines: [[Vec2]]) -> RingLineExtent? {
        guard ring.points.count >= 3 else { return nil }
        let polylines = lines.filter { $0.count >= 2 }
        guard !polylines.isEmpty else { return nil }

        let centroid = ringCentroid(ring)
        var bestPerp = Double.infinity
        var chosen: RingLineExtent?
        for poly in polylines {
            guard let c = project(centroid, onto: poly), c.perp < bestPerp else { continue }
            var aMin = Double.infinity, aMax = -Double.infinity
            for p in ring.points {
                if let vp = project(p, onto: poly) {
                    aMin = min(aMin, vp.along); aMax = max(aMax, vp.along)
                }
            }
            // Entirely behind this line's start — not measurable along it.
            guard aMax > 0 else { continue }
            bestPerp = c.perp
            let side: HazardSide = c.perp < 3 ? .onLine : (c.lateral >= 0 ? .right : .left)
            let frontM = max(0, aMin)
            chosen = RingLineExtent(
                carry: HazardCarry(
                    label: label(for: ring.kind), kind: ring.kind,
                    frontM: Int(frontM.rounded()), carryM: Int(aMax.rounded()),
                    side: side, centroid: centroid
                ),
                frontPoint: pointAlong(poly, meters: frontM),
                carryPoint: pointAlong(poly, meters: aMax)
            )
        }
        return chosen
    }

    /// The window `ring` occupies along the RAY from `origin` through
    /// `through` (normally the tapped point inside the ring) — the default
    /// tap-a-shape readout, mirror of shared `ringExtentAlongRay`: "if I hit
    /// at that shape, it's front to reach and carry to clear". Edge points
    /// sit ON the ring boundary; an origin standing inside the ring reads
    /// front 0 at the origin. Side is always `.onLine` (the ray points at the
    /// shape, so a left/right tag is meaningless). Nil for a degenerate
    /// ring/ray or a numeric miss.
    public static func extent(
        of ring: FlatRing, fromRay origin: Vec2, through: Vec2
    ) -> RingLineExtent? {
        guard ring.points.count >= 3 else { return nil }
        let dx = through.x - origin.x, dy = through.y - origin.y
        let length = hypot(dx, dy)
        guard length > 1e-9 else { return nil }
        let dir = Vec2(x: dx / length, y: dy / length)

        let hits = rayRingIntersections(origin, dir, ring.points)
        guard let maxHit = hits.max(), let minHit = hits.min() else { return nil }
        let frontM = pointInRing(origin, ring.points) ? 0 : minHit
        return RingLineExtent(
            carry: HazardCarry(
                label: label(for: ring.kind), kind: ring.kind,
                frontM: Int(frontM.rounded()), carryM: Int(maxHit.rounded()),
                side: .onLine, centroid: ringCentroid(ring)
            ),
            frontPoint: Vec2(x: origin.x + dir.x * frontM, y: origin.y + dir.y * frontM),
            carryPoint: Vec2(x: origin.x + dir.x * maxHit, y: origin.y + dir.y * maxHit)
        )
    }

    /// The point `meters` of chainage along a polyline. Chainage past the end
    /// extrapolates along the last segment's direction (a tapped ring can
    /// extend beyond the green) — mirror of shared `pointAlongPolyline`.
    private static func pointAlong(_ poly: [Vec2], meters: Double) -> Vec2 {
        var remaining = meters
        for i in 0..<(poly.count - 1) {
            let a = poly[i], b = poly[i + 1]
            let seg = hypot(b.x - a.x, b.y - a.y)
            if seg == 0 { continue }
            let last = i == poly.count - 2
            if remaining <= seg || last {
                let t = remaining / seg
                return Vec2(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            }
            remaining -= seg
        }
        return poly[0]
    }

    private static func polylineLength(_ poly: [Vec2]) -> Double {
        var total = 0.0
        for i in 0..<(poly.count - 1) {
            total += hypot(poly[i + 1].x - poly[i].x, poly[i + 1].y - poly[i].y)
        }
        return total
    }

    private static func ringCentroid(_ ring: FlatRing) -> Vec2 {
        var cx = 0.0, cy = 0.0
        for p in ring.points { cx += p.x; cy += p.y }
        let n = Double(ring.points.count)
        return Vec2(x: cx / n, y: cy / n)
    }

    /// Project `q` onto a polyline: cumulative `along` distance from the start,
    /// signed `lateral` on the nearest segment (right +), and perpendicular
    /// distance. `along` is unclamped on the nearest segment so points past the
    /// end read as beyond the line.
    private static func project(_ q: Vec2, onto poly: [Vec2]) -> (along: Double, lateral: Double, perp: Double)? {
        guard poly.count >= 2 else { return nil }
        var bestPerp = Double.infinity
        var bestAlong = 0.0, bestLateral = 0.0
        var cumulative = 0.0
        for i in 0..<(poly.count - 1) {
            let a = poly[i], b = poly[i + 1]
            let dx = b.x - a.x, dy = b.y - a.y
            let seg = hypot(dx, dy)
            if seg == 0 { continue }
            let ux = dx / seg, uy = dy / seg
            let ex = q.x - a.x, ey = q.y - a.y
            let proj = ex * ux + ey * uy               // unclamped along this segment
            let clamped = max(0, min(seg, proj))
            let perp = hypot(q.x - (a.x + ux * clamped), q.y - (a.y + uy * clamped))
            if perp < bestPerp {
                bestPerp = perp
                bestAlong = cumulative + proj
                bestLateral = ex * uy + ey * (-ux)     // right-hand normal
            }
            cumulative += seg
        }
        return (bestAlong, bestLateral, bestPerp)
    }
}
