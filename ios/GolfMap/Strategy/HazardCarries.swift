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
