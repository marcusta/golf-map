import Foundation

/// Playing-length computation for a hole — Swift port of
/// `web/src/course-detail/hole-length.ts`.
///
/// Each leg is measured in projected EPSG:3006 meters (via `Distance.planarMeters`,
/// i.e. the web `legMeters`) and the total is rounded to whole meters.
public enum HoleLength {

    /// Result of a playing-length computation.
    public struct PlayingLength: Sendable, Equatable {
        /// Whole-meter length along the path, or nil when < 2 points.
        public var meters: Int?
        /// True when the path stops at the last aim point because the hole has
        /// no green center — the figure is an underestimate (panel marks it '~').
        public var approximate: Bool
        public init(meters: Int?, approximate: Bool) {
            self.meters = meters
            self.approximate = approximate
        }
    }

    /// Sum the leg lengths of an ordered path (meters). 0 for < 2 points.
    public static func pathMeters(_ path: [LatLon]) -> Double {
        guard path.count >= 2 else { return 0 }
        var total = 0.0
        for i in 1..<path.count {
            total += Distance.planarMeters(path[i - 1], path[i])
        }
        return total
    }

    /// The WGS84 point `meters` along an ordered path, walking it leg by leg in
    /// projected EPSG:3006 meters (the same metric `pathMeters` sums). This is
    /// the placement inverse of `pathMeters`: a point at distance `d` along the
    /// polyline follows the hole's routing rather than the straight origin→green
    /// line, so a layup on a dogleg lands ON the routed leg, not in the trees.
    ///
    /// Invariants: `meters ≤ 0` returns the first point exactly; `meters` at or
    /// beyond the total length clamps to the last point; zero-length legs are
    /// skipped so a repeated vertex never traps the walk. Nil only for an empty
    /// path. Pure and side-effect-free so layup placement is unit-testable
    /// without a live model.
    public static func pointAlong(_ path: [LatLon], meters: Double) -> LatLon? {
        guard let first = path.first else { return nil }
        guard path.count >= 2, meters > 0 else { return first }
        var remaining = meters
        for i in 1..<path.count {
            let a = path[i - 1]
            let b = path[i]
            let leg = Distance.planarMeters(a, b)
            if leg <= 0 { continue }
            if remaining <= leg {
                let pa = Sweref99TM.fromWGS84(a)
                let pb = Sweref99TM.fromWGS84(b)
                let t = remaining / leg
                return Sweref99TM.toWGS84(x: pa.x + (pb.x - pa.x) * t,
                                         y: pa.y + (pb.y - pa.y) * t)
            }
            remaining -= leg
        }
        return path.last
    }

    /// Playing length for a hole from a given tee: tee → aim points (in order)
    /// → green center. Each leg is measured in projected EPSG:3006 meters and
    /// the total is rounded to whole meters.
    ///
    /// - `tee` nil → length nil (no origin).
    /// - No `greenCenter` → measure tee → aims only and flag `approximate`. If
    ///   there are also no aims, there's a single point → length nil.
    public static func playingLength(
        tee: LatLon?,
        aims: [LatLon],
        greenCenter: LatLon?
    ) -> PlayingLength {
        guard let tee else { return PlayingLength(meters: nil, approximate: false) }
        var path: [LatLon] = [tee]
        path.append(contentsOf: aims)
        let approximate = greenCenter == nil
        if let greenCenter { path.append(greenCenter) }
        guard path.count >= 2 else { return PlayingLength(meters: nil, approximate: approximate) }
        return PlayingLength(meters: Int((pathMeters(path)).rounded()), approximate: approximate)
    }
}
