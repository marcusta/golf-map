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
