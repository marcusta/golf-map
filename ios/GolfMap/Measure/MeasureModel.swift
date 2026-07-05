import Foundation
import Observation

/// Backs the on-course MEASURE tool: an ordered path of tapped points, each
/// carrying its WGS84 position, cached EPSG:3006 easting/northing, and an
/// asynchronously resolved terrain elevation. All stats math delegates to
/// `PlaysLike` (the line-for-line Swift port of the web measure math in
/// `web/src/measure/measure-state.ts`).
///
/// Interaction model, adapted from `measure-tool.service.ts` for touch: every
/// map tap in measure mode places a point (A, B, C, …); explicit Undo / Clear
/// replace the web's double-click-to-end lifecycle (cleaner on a phone).
///
/// Elevation is sampled per point through the injected sampler (bundle
/// terrain pyramid). A stale async result is dropped via the seq token +
/// point-identity check, mirroring measure-tool.service.ts.
@MainActor
@Observable
final class MeasureModel {

    /// One placed point: tap position + cached EPSG:3006 projection +
    /// elevation (nil until sampled, or nil for missing terrain coverage —
    /// elevation-dependent stats degrade to nil, never to a wrong number).
    struct MeasurePoint: Equatable, Sendable {
        var position: LatLon
        /// EPSG:3006 easting (m).
        var e: Double
        /// EPSG:3006 northing (m).
        var n: Double
        var elevation: Double?
    }

    private(set) var points: [MeasurePoint] = []

    /// Terrain elevation sampler (bundle terrain tiles); injected by the
    /// screen, stubbed in tests.
    @ObservationIgnored var elevationSampler: (@Sendable (LatLon) async -> Double?)?
    /// Monotonic token: bumped on `clear()` so in-flight elevation samples
    /// from a previous path can never patch a new one (the per-point identity
    /// check below covers undo/re-place at the same index).
    @ObservationIgnored private var seq = 0

    // MARK: - Actions

    /// Place a point at a tapped coordinate and kick its async elevation
    /// sample.
    func place(_ position: LatLon) {
        let projected = Sweref99TM.fromWGS84(position)
        points.append(
            MeasurePoint(position: position, e: projected.x, n: projected.y, elevation: nil)
        )
        resolveElevation(atIndex: points.count - 1)
    }

    /// Remove the most recent point. An in-flight elevation sample for it is
    /// dropped by the identity check when it lands.
    func undoLast() {
        guard !points.isEmpty else { return }
        points.removeLast()
    }

    /// Wipe the whole path and invalidate all in-flight elevation samples.
    func clear() {
        seq += 1
        points = []
    }

    // MARK: - Derived stats (PlaysLike delegation)

    /// The path in `PlaysLike` terms (EPSG:3006 + optional elevations).
    var playsLikePath: [PlaysLike.Point] {
        points.map { PlaysLike.Point(e: $0.e, n: $0.n, elevation: $0.elevation) }
    }

    /// Per-segment stats (`points.count − 1` entries).
    var segments: [PlaysLike.SegmentStats] {
        PlaysLike.pathSegmentStats(playsLikePath)
    }

    /// Cumulative totals across the path.
    var totals: PlaysLike.PathTotals {
        PlaysLike.pathTotals(segments)
    }

    /// True once there is a measurable path.
    var hasPath: Bool { points.count >= 2 }

    /// WGS84 positions in order (map overlay + profile path source).
    var pathPositions: [LatLon] { points.map(\.position) }

    /// Map overlay state for the measure sources.
    var overlay: MeasureOverlay { MeasureOverlay(points: pathPositions) }

    /// "A→B" style label for segment `index`.
    static func segmentLabel(_ index: Int) -> String {
        "\(MeasureOverlay.pointLabel(index))→\(MeasureOverlay.pointLabel(index + 1))"
    }

    // MARK: - Async elevation

    /// Resolve one point's elevation. Guard against clear()/undo/re-place
    /// between place and resolve: the seq token must match AND the index must
    /// still hold this exact point (same lat/lon) when the sample lands
    /// (mirrors measure-tool.service.ts:227-233).
    private func resolveElevation(atIndex index: Int) {
        guard let sampler = elevationSampler else { return }
        let token = seq
        let position = points[index].position
        Task { [weak self] in
            let elevation = await sampler(position)
            guard let self else { return }
            guard self.seq == token,
                  self.points.indices.contains(index),
                  self.points[index].position == position
            else { return }
            self.points[index].elevation = elevation
        }
    }
}
