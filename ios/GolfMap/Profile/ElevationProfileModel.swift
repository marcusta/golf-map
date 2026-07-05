import Foundation
import Observation

/// Backs the elevation-profile sheet: holds the sampled series + labelled
/// vertex markers (Tee / aims / Green, or measure points A, B, C…) for the
/// current path, re-sampling asynchronously (seq-guarded — a stale batch
/// never lands) whenever the screen pushes a new path.
///
/// The profile is NOT a map tool: the sheet is non-modal and openable over
/// any mode; the screen decides which path to feed (measure path while
/// measuring, else the hole route).
@MainActor
@Observable
final class ElevationProfileModel {

    /// A labelled path vertex on the profile x-axis. `elevation` is the RAW
    /// terrain sample at the vertex (never smoothed) — this is where the
    /// user-facing Δ numbers come from.
    struct Marker: Equatable, Sendable {
        var label: String
        var distanceMeters: Double
        var elevation: Double?
    }

    /// Sampled series along the current path (2 m interval, raw values).
    private(set) var samples: [ElevationProfile.Sample] = []
    /// Labelled vertices (distances known synchronously; elevations patch in
    /// when the series lands).
    private(set) var markers: [Marker] = []
    /// True while a sample batch is in flight.
    private(set) var isLoading = false
    /// The path the current series belongs to (change detection / titling).
    private(set) var path: [LatLon] = []

    /// Terrain elevation sampler; injected by the screen, stubbed in tests.
    @ObservationIgnored var elevationSampler: (@Sendable (LatLon) async -> Double?)?
    /// Monotonic token so a superseded sample batch is dropped.
    @ObservationIgnored private var seq = 0

    /// Re-target the profile at a new path. `labels` must parallel `path`
    /// (extras are ignored). Distances resolve synchronously; the series +
    /// marker elevations land asynchronously.
    func update(path: [LatLon], labels: [String]) {
        seq += 1
        let token = seq
        self.path = path

        let distances = ElevationProfile.vertexDistances(along: path)
        markers = zip(labels, distances).map {
            Marker(label: $0, distanceMeters: $1, elevation: nil)
        }

        guard path.count >= 2, let sampler = elevationSampler else {
            samples = []
            isLoading = false
            return
        }
        isLoading = true
        Task { [weak self] in
            let series = await ElevationProfile.series(along: path, sampler: sampler)
            guard let self, self.seq == token else { return }
            self.samples = series
            // Vertex markers coincide with per-leg endpoint samples (t = 0/1),
            // so the nearest sample IS the vertex — raw, not smoothed.
            self.markers = self.markers.map { marker in
                var patched = marker
                patched.elevation = series.min {
                    abs($0.distanceMeters - marker.distanceMeters)
                        < abs($1.distanceMeters - marker.distanceMeters)
                }?.elevation
                return patched
            }
            self.isLoading = false
            #if DEBUG
            self.writeDebugSummary()
            #endif
        }
    }

    /// Drop everything (screen closed the sheet and left the context).
    func clear() {
        seq += 1
        samples = []
        markers = []
        path = []
        isLoading = false
    }

    // MARK: - Derived numbers (all RAW, never smoothed)

    /// Total elevation change end-to-end (last vertex − first vertex), e.g.
    /// green − tee. Nil until both endpoint samples exist.
    var totalDelta: Double? {
        guard let first = markers.first?.elevation, let last = markers.last?.elevation
        else { return nil }
        return last - first
    }

    /// Per-leg elevation deltas between consecutive markers ("Tee→Aim 1" …).
    var legDeltas: [(label: String, delta: Double?)] {
        guard markers.count >= 2 else { return [] }
        return (1..<markers.count).map { i in
            let delta: Double?
            if let a = markers[i - 1].elevation, let b = markers[i].elevation {
                delta = b - a
            } else {
                delta = nil
            }
            return ("\(markers[i - 1].label)→\(markers[i].label)", delta)
        }
    }

    /// Raw min/max over the sampled elevations (axis labels, exaggeration).
    var elevationRange: (min: Double, max: Double)? {
        let values = samples.compactMap(\.elevation)
        guard let min = values.min(), let max = values.max() else { return nil }
        return (min, max)
    }

    /// Total path length (m) — the last sample's cumulative distance.
    var totalDistance: Double {
        samples.last?.distanceMeters ?? markers.last?.distanceMeters ?? 0
    }

    #if DEBUG
    /// Live-verify hook (same family as GreenAnalysisModel's): dumps the
    /// resolved profile to tmp so a headless run can check the numbers.
    private func writeDebugSummary() {
        let summary: [String: Any] = [
            "sampleCount": samples.count,
            "totalDistance": totalDistance,
            "elevationMin": elevationRange?.min ?? NSNull() as Any,
            "elevationMax": elevationRange?.max ?? NSNull() as Any,
            "totalDelta": totalDelta ?? NSNull() as Any,
            "markers": markers.map {
                [
                    "label": $0.label,
                    "distance": $0.distanceMeters,
                    "elevation": $0.elevation ?? NSNull() as Any,
                ]
            },
        ]
        let url = FileManager.default.temporaryDirectory
            .appending(path: "elevation-profile-debug.json")
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) {
            try? data.write(to: url)
            print("ELEVATION-PROFILE \(String(data: data, encoding: .utf8) ?? "")")
        }
    }
    #endif
}
