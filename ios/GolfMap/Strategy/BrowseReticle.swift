import Foundation

/// Reticle-browse math (RB1) — pure, UI-free helpers behind the pan-to-aim
/// interaction (docs/feature-reticle-browse.md). Everything here is O(clubs)
/// or O(segments) and safe to call once per camera-change frame.
///
/// Units & conventions match the Strategy layer: planar meters ({x east,
/// y north}, `Vec2` from Putting/GreenSurface.swift), compass bearings
/// (0 = north, clockwise). Club dispersion values are FULL widths (extents),
/// not semi-axes — the v1 gotcha preserved by Club.swift / Ellipse.swift.
public enum BrowseReticle {

    /// Pan club: the club shown while the camera is moving — the first club
    /// (ascending carry) whose carry reaches the raw from→aim distance, i.e.
    /// `clubAdvice`'s `front` slot; past the longest club's carry, the
    /// longest club. Nil only for an empty bag.
    public static func panClub<T: ClubSpec>(clubs: [T], distanceM: Double) -> T? {
        if let front = clubAdvice(clubs, distanceM).front { return front }
        var longest: T?
        for club in clubs where longest == nil || club.carryM > longest!.carryM { longest = club }
        return longest
    }

    /// Closest shorter / closest longer club by carry relative to `around`
    /// (strictly shorter / strictly longer). Nil at the bag ends. Ties keep
    /// the earlier club in the list (scan order, matching `closestClub`).
    public static func neighborClubs<T: ClubSpec>(
        clubs: [T], around: T
    ) -> (shorter: T?, longer: T?) {
        var shorter: T?
        var longer: T?
        for club in clubs {
            if club.carryM < around.carryM, shorter == nil || club.carryM > shorter!.carryM {
                shorter = club
            }
            if club.carryM > around.carryM, longer == nil || club.carryM < longer!.carryM {
                longer = club
            }
        }
        return (shorter, longer)
    }

    /// Lateral (cross-line) dispersion half-width of a club at a given
    /// distance, meters. At the club's nominal carry this is exactly the
    /// ellipse's minor semi-axis (`dispersionM / 2` — full extent halved,
    /// same as `dispersionEllipse`); at other distances the half-width scales
    /// linearly with distance (the dispersion cone opens from the origin), so
    /// an arc drawn short of the carry is proportionally narrower. Guards a
    /// degenerate carry ≤ 0 by returning the unscaled semi-axis.
    public static func lateralHalfWidthM<T: ClubSpec>(club: T, atDistanceM distanceM: Double) -> Double {
        let semiLateral = club.dispersionM / 2
        guard club.carryM > 0 else { return semiLateral }
        return semiLateral * max(distanceM, 0) / club.carryM
    }

    /// Planar arc polyline: an OPEN polyline of `segments + 1` points on the
    /// circle of `radiusM` around `origin`, centered on `bearingDeg`,
    /// subtending the chord that spans ±`halfWidthM` laterally — half-angle
    /// = asin(halfWidth / radius), clamped to a semicircle when the half
    /// width meets or exceeds the radius. Degenerate radius ≤ 0 yields the
    /// origin repeated. Left end first (bearing − halfAngle).
    public static func arcPolyline(
        origin: Vec2,
        bearingDeg: Double,
        radiusM: Double,
        halfWidthM: Double,
        segments: Int = 32
    ) -> [Vec2] {
        let count = max(segments, 1)
        guard radiusM > 0 else { return Array(repeating: origin, count: count + 1) }
        let ratio = min(max(abs(halfWidthM) / radiusM, 0), 1)
        let halfAngleDeg = asin(ratio) * 180 / Double.pi
        var out: [Vec2] = []
        out.reserveCapacity(count + 1)
        for i in 0...count {
            let t = Double(i) / Double(count) // 0 = left end, 1 = right end
            let bearing = bearingDeg + (2 * t - 1) * halfAngleDeg
            let dir = bearingToUnitVector(bearing)
            out.append(Vec2(x: origin.x + radiusM * dir.x, y: origin.y + radiusM * dir.y))
        }
        return out
    }

    /// The ring point farthest to the RIGHT of the shot line (looking down
    /// `bearingDeg`) — the label anchor for the advised club's dispersion
    /// ellipse. `arcPolyline` ends at its right edge, so anchoring the ellipse
    /// label here puts all three settled club names on the same side of the
    /// aim line, reading in spatial order. Nil for an empty ring.
    public static func rightmostPoint(ring: [Vec2], bearingDeg: Double) -> Vec2? {
        guard !ring.isEmpty else { return nil }
        // Right-hand normal of the bearing direction (x east, y north).
        let dir = bearingToUnitVector(bearingDeg)
        let rx = dir.y, ry = -dir.x
        var best = ring[0]
        var bestDot = best.x * rx + best.y * ry
        for point in ring.dropFirst() {
            let dot = point.x * rx + point.y * ry
            if dot > bestDot {
                bestDot = dot
                best = point
            }
        }
        return best
    }
}
