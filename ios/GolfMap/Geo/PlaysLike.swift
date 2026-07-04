import Foundation

/// Plays-like (simple) + per-segment measurement stats — Swift port of the pure
/// math in `web/src/measure/measure-state.ts` (`segmentStats`,
/// `pathSegmentStats`, `pathTotals`).
///
/// Distances are computed in projected SWEREF 99 TM meters (EPSG:3006): callers
/// hand in EPSG:3006 easting/northing (`e`/`n`), so horizontal distance is
/// straight Euclidean math — correct at course scale and consistent with the
/// rest of the app.
///
/// `playsLikeSimple` is the preliminary caddie rule (horizontal + elevationΔ):
/// uphill adds distance, downhill subtracts. The full ballistics model is
/// Phase 5 — not implemented here.
public enum PlaysLike {

    /// One placed measurement point in EPSG:3006 meters, plus optional elevation.
    public struct Point: Sendable, Equatable {
        /// EPSG:3006 easting (meters).
        public var e: Double
        /// EPSG:3006 northing (meters).
        public var n: Double
        /// Meters (RH2000), or nil when terrain coverage is missing.
        public var elevation: Double?
        public init(e: Double, n: Double, elevation: Double?) {
            self.e = e
            self.n = n
            self.elevation = elevation
        }
    }

    /// Stats for one A→B segment. Horizontal/straight-line are always defined
    /// (pure planar geometry); elevation-dependent fields are nil when either
    /// endpoint lacks an elevation sample.
    public struct SegmentStats: Sendable, Equatable {
        /// Planar ground distance in meters (EPSG:3006 Euclidean).
        public var horizontal: Double
        /// Signed elevation delta B−A in meters (nil if either sample missing).
        public var elevationDelta: Double?
        /// True 3D line-of-sight distance in meters (nil if elevation missing).
        public var straightLine: Double?
        /// Slope angle in degrees (nil if elevation missing).
        public var slopeDeg: Double?
        /// Slope as a percentage (rise/run × 100; nil if elevation missing).
        public var slopePct: Double?
        /// "Plays-like (simple)": horizontal + elevationΔ (nil if elevation missing).
        public var playsLikeSimple: Double?
    }

    /// Totals across the whole path. Elevation totals sum only measurable segments.
    public struct PathTotals: Sendable, Equatable {
        public var horizontal: Double
        public var elevationDelta: Double?
        public var straightLine: Double?
        public var slopeDeg: Double?
        public var slopePct: Double?
        public var playsLikeSimple: Double?
        /// Number of segments contributing to the elevation-dependent totals.
        public var measuredSegments: Int
        /// Total segment count (path.count − 1).
        public var totalSegments: Int
    }

    /// Segment stats between two points in EPSG:3006 meters. Elevation-dependent
    /// fields degrade to nil when either endpoint has no elevation.
    public static func segmentStats(_ a: Point, _ b: Point) -> SegmentStats {
        let de = b.e - a.e
        let dn = b.n - a.n
        let horizontal = (de * de + dn * dn).squareRoot()

        guard let ea = a.elevation, let eb = b.elevation else {
            return SegmentStats(
                horizontal: horizontal,
                elevationDelta: nil,
                straightLine: nil,
                slopeDeg: nil,
                slopePct: nil,
                playsLikeSimple: nil
            )
        }

        let elevationDelta = eb - ea
        let straightLine = (horizontal * horizontal + elevationDelta * elevationDelta).squareRoot()
        let slopeDeg = atan2(abs(elevationDelta), horizontal) * 180 / .pi
        let slopePct = horizontal > 0 ? (abs(elevationDelta) / horizontal) * 100 : 0
        let playsLikeSimple = horizontal + elevationDelta

        return SegmentStats(
            horizontal: horizontal,
            elevationDelta: elevationDelta,
            straightLine: straightLine,
            slopeDeg: slopeDeg,
            slopePct: slopePct,
            playsLikeSimple: playsLikeSimple
        )
    }

    /// Per-segment stats for a whole path (path.count − 1 entries).
    public static func pathSegmentStats(_ path: [Point]) -> [SegmentStats] {
        guard path.count >= 2 else { return [] }
        var out: [SegmentStats] = []
        for i in 1..<path.count {
            out.append(segmentStats(path[i - 1], path[i]))
        }
        return out
    }

    /// Cumulative totals across the path. Horizontal sums every segment;
    /// elevation-dependent totals sum only segments where both endpoints have
    /// elevation. Straight-line total is the sum of per-segment 3D chords (a
    /// draped-path length), NOT the end-to-end chord. Slope is the aggregate
    /// secant slope of the summed rise over the measured run.
    public static func pathTotals(_ segments: [SegmentStats]) -> PathTotals {
        var horizontal = 0.0
        var elevationDelta = 0.0
        var straightLine = 0.0
        var playsLikeSimple = 0.0
        var measuredSegments = 0

        for seg in segments {
            horizontal += seg.horizontal
            if let d = seg.elevationDelta {
                elevationDelta += d
                straightLine += seg.straightLine!
                playsLikeSimple += seg.playsLikeSimple!
                measuredSegments += 1
            }
        }

        let hasElevation = measuredSegments > 0
        var measuredRun = 0.0
        for seg in segments where seg.elevationDelta != nil {
            measuredRun += seg.horizontal
        }

        let slopeDeg: Double? = hasElevation
            ? atan2(abs(elevationDelta), measuredRun == 0 ? 1 : measuredRun) * 180 / .pi
            : nil
        let slopePct: Double?
        if hasElevation && measuredRun > 0 {
            slopePct = (abs(elevationDelta) / measuredRun) * 100
        } else if hasElevation {
            slopePct = 0
        } else {
            slopePct = nil
        }

        return PathTotals(
            horizontal: horizontal,
            elevationDelta: hasElevation ? elevationDelta : nil,
            straightLine: hasElevation ? straightLine : nil,
            slopeDeg: slopeDeg,
            slopePct: slopePct,
            playsLikeSimple: hasElevation ? playsLikeSimple : nil,
            measuredSegments: measuredSegments,
            totalSegments: segments.count
        )
    }
}
