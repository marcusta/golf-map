import Foundation

/// Side-view (cross-section) elevation series along a polyline path — the
/// tee→green hole route by default, or the measure path while measuring.
///
/// Port of the web profile accumulation (`measure-tool.service.ts`
/// `refreshProfile`), with distance-interval sampling (default one sample
/// every 2 m, clamped per leg) instead of the web's fixed 50 samples per
/// segment. Cumulative distance is measured in EPSG:3006 projected meters —
/// the same length math as `PlaysLike` / `Distance.planarMeters` — so the
/// x-axis agrees with every other number in the app. Lat/lon are interpolated
/// linearly within a leg (sub-centimeter error at golf-hole scale).
public enum ElevationProfile {

    /// One resolved sample along the path.
    public struct Sample: Equatable, Sendable {
        /// Cumulative horizontal distance from the path start (m, EPSG:3006).
        public var distanceMeters: Double
        /// Terrain elevation (m), or nil where coverage is missing (gap).
        public var elevation: Double?

        public init(distanceMeters: Double, elevation: Double?) {
            self.distanceMeters = distanceMeters
            self.elevation = elevation
        }
    }

    /// Default sampling interval along the path (m).
    public static let defaultIntervalMeters = 2.0
    /// Hard per-leg sample cap (keeps a mis-tagged kilometer leg cheap).
    public static let maxSamplesPerLeg = 200

    /// Cumulative EPSG:3006 distance (m) of every path vertex, starting at 0.
    /// Empty for an empty path. These are the marker positions (tee / aims /
    /// green, or measure points A, B, C…) on the profile x-axis.
    public static func vertexDistances(along path: [LatLon]) -> [Double] {
        guard !path.isEmpty else { return [] }
        var distances = [0.0]
        var cumulative = 0.0
        for i in 1..<path.count {
            cumulative += legLengthMeters(path[i - 1], path[i])
            distances.append(cumulative)
        }
        return distances
    }

    /// Sample the terrain along the whole path: `intervalMeters` spacing per
    /// leg (min 2, max `maxSamplesPerLeg` samples per leg), shared vertices
    /// deduplicated (each leg after the first skips its start sample —
    /// mirrors the web accumulation). Fewer than two path points → empty.
    public static func series(
        along path: [LatLon],
        intervalMeters: Double = defaultIntervalMeters,
        maxSamplesPerLeg: Int = maxSamplesPerLeg,
        sampler: @Sendable (LatLon) async -> Double?
    ) async -> [Sample] {
        guard path.count >= 2 else { return [] }
        let interval = max(intervalMeters, 0.1)

        var samples: [Sample] = []
        var cumulative = 0.0
        for i in 1..<path.count {
            let a = path[i - 1]
            let b = path[i]
            let legLength = legLengthMeters(a, b)
            let count = max(2, min(maxSamplesPerLeg, Int((legLength / interval).rounded(.up)) + 1))
            // Skip the first sample of every leg after the first: it is the
            // previous leg's end vertex (dedupe the shared vertex).
            let start = i == 1 ? 0 : 1
            for k in start..<count {
                let t = Double(k) / Double(count - 1)
                let point = LatLon(
                    lat: a.lat + (b.lat - a.lat) * t,
                    lon: a.lon + (b.lon - a.lon) * t
                )
                let elevation = await sampler(point)
                samples.append(
                    Sample(distanceMeters: cumulative + legLength * t, elevation: elevation)
                )
            }
            cumulative += legLength
        }
        return samples
    }

    /// EPSG:3006 planar length of one leg (same math as
    /// `Distance.planarMeters`).
    private static func legLengthMeters(_ a: LatLon, _ b: LatLon) -> Double {
        let pa = Sweref99TM.fromWGS84(a)
        let pb = Sweref99TM.fromWGS84(b)
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Moving-average smoothing for the DRAWN curve only (kills the 0.1 m
    /// terrain-quantization stair-steps). Gaps (nil elevation) stay gaps; the
    /// window shrinks near run edges so endpoints barely move. All printed
    /// NUMBERS (Δs, marker elevations) stay raw — smoothing is presentation
    /// only.
    public static func smoothed(_ samples: [Sample], window: Int = 5) -> [Sample] {
        guard window > 1, samples.count > 2 else { return samples }
        let half = window / 2
        return samples.enumerated().map { index, sample in
            guard sample.elevation != nil else { return sample }
            var sum = 0.0
            var count = 0
            for j in max(0, index - half)...min(samples.count - 1, index + half) {
                guard let e = samples[j].elevation else { continue }
                sum += e
                count += 1
            }
            return Sample(
                distanceMeters: sample.distanceMeters,
                elevation: count > 0 ? sum / Double(count) : nil
            )
        }
    }
}
