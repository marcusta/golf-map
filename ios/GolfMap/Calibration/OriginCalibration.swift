import Foundation

/// A solved GPS bias: ADD (biasE, biasN) in EPSG:3006 metres to a raw fix to
/// get the corrected position. See spec §6.
///
/// The bias captures the slow common-mode component of GPS error (§2), so it
/// is reusable across the whole course for a few minutes. Effective confidence
/// therefore starts at a base (anchor quality / trilateration fit) and decays
/// with age and with distance from where it was solved (`confidence(now:...)`).
/// Below a floor, or once invalidated, the correction is DROPPED — never scaled
/// (spec §6.4: a stale correction that *looks* authoritative is worse than raw
/// GPS, so it is dropped, not degraded).
///
/// Pure value type with no CoreLocation dependency: the model layer feeds it
/// plain EPSG:3006 metres and `Date`s.
struct OriginCalibration: Equatable, Sendable {
    /// How the bias was obtained (weights `baseConfidence` upstream).
    enum Method: String, Sendable {
        /// "I am here" on a mapped point — one action solves full 2D (§6.2).
        case anchor
        /// Least-squares over 2–3 laser shots at fixed features (§6.3).
        case trilateration
        /// Silent refresh from an opportunistic in-tolerance residual (§6.4).
        case residualRefresh
    }

    /// EPSG:3006 easting correction, metres, added to a raw fix.
    var biasE: Double
    /// EPSG:3006 northing correction, metres, added to a raw fix.
    var biasN: Double
    /// When the bias was solved (or last confirmed by a residual refresh).
    var solvedAt: Date
    /// Where the calibration was taken — the anchor for the distance decay.
    var solvedNear: LatLon
    /// How the bias was obtained.
    var method: Method
    /// Base confidence at solve time (anchor quality / trilateration fit),
    /// 0…1. Effective confidence decays from this — see `confidence(now:...)`.
    var baseConfidence: Double
    /// True once a large residual or GPS discontinuity invalidated it.
    var stale: Bool = false

    /// All decay / gate tuning in one place — spec §6.4 (open question 2:
    /// tune against real rounds).
    enum Tuning {
        // MARK: Age decay (multiplicative factor 0…1)

        /// Full trust at or below this age (minutes) — factor 1.
        static let ageFullTrustMinutes: Double = 5
        /// Confidence reaches 0 at this age (minutes); linear between the two.
        static let ageZeroTrustMinutes: Double = 15

        // MARK: Distance decay (multiplicative factor)

        /// Full trust within this planar distance (metres) of `solvedNear`.
        static let distanceFullTrustM: Double = 100
        /// Distance (metres) at which the factor bottoms out at `distanceFloorFactor`.
        static let distanceHalfTrustM: Double = 500
        /// The floor factor beyond `distanceHalfTrustM` — the bias is
        /// course-wide, so distance is only a mild penalty (never below 0.5).
        static let distanceFloorFactor: Double = 0.5

        // MARK: Confidence floor

        /// Below this effective confidence the correction MUST NOT be applied
        /// (`appliedBias` returns nil) — raw GPS with a "uncalibrated" badge.
        static let confidenceFloor: Double = 0.3

        // MARK: Residual gate (metres of |laser − corrected-map distance|)

        /// At or below this residual the calibration is confirmed and refreshed.
        static let confirmResidualM: Double = 2.0
        /// At or above this residual the calibration is marked stale.
        static let rejectResidualM: Double = 4.0
        /// A confirming residual restores `baseConfidence` to AT LEAST this
        /// (never lowers an already-higher base): an in-tolerance fixed-feature
        /// check is strong fresh evidence the bias is still good.
        static let refreshedBaseConfidence: Double = 0.8
    }

    /// Effective confidence at `now`, at planar distance `distanceFromSolveM`
    /// from where it was solved. Stale → 0.
    func confidence(now: Date, distanceFromSolveM: Double) -> Double {
        guard !stale else { return 0 }
        let base = min(max(baseConfidence, 0), 1)
        return base
            * Self.ageFactor(ageMinutes: now.timeIntervalSince(solvedAt) / 60)
            * Self.distanceFactor(distanceM: distanceFromSolveM)
    }

    /// The bias to apply, or nil when confidence < floor or stale. Callers MUST
    /// drop the correction on nil, never scale it (spec: dropped, not degraded).
    func appliedBias(now: Date, distanceFromSolveM: Double) -> (e: Double, n: Double)? {
        guard confidence(now: now, distanceFromSolveM: distanceFromSolveM) >= Tuning.confidenceFloor
        else { return nil }
        return (biasE, biasN)
    }

    /// The outcome of feeding one fixed-feature residual through the gate.
    enum ResidualOutcome: Equatable, Sendable { case confirmed, inconclusive, rejected }

    /// Residual gate (spec §6.4): feed |laser − corrected-map distance| for any
    /// FIXED-feature laser shot. ≤ confirm → returns `.confirmed` and the caller
    /// stores the returned refreshed calibration (solvedAt = now, method =
    /// `.residualRefresh`, baseConfidence restored to at least
    /// `Tuning.refreshedBaseConfidence`); ≥ reject → `.rejected` with
    /// `stale = true`. Between → `.inconclusive`, no change.
    ///
    /// An already-stale calibration is terminal for the gate: it produces no
    /// bias (`appliedBias` is nil), so the "corrected-map distance" is not
    /// actually corrected and the residual validates nothing — returns
    /// `.inconclusive`, unchanged. Recover by re-solving via anchor or
    /// trilateration.
    func registeringResidual(_ residualM: Double, now: Date) -> (OriginCalibration, ResidualOutcome) {
        guard !stale else { return (self, .inconclusive) }
        let r = abs(residualM)
        if r <= Tuning.confirmResidualM {
            var refreshed = self
            refreshed.solvedAt = now
            refreshed.method = .residualRefresh
            refreshed.baseConfidence = max(baseConfidence, Tuning.refreshedBaseConfidence)
            refreshed.stale = false
            return (refreshed, .confirmed)
        } else if r >= Tuning.rejectResidualM {
            var rejected = self
            rejected.stale = true
            return (rejected, .rejected)
        } else {
            return (self, .inconclusive)
        }
    }

    // MARK: - Decay factors (pure, static)

    /// Age factor: 1 up to `ageFullTrustMinutes`, linear to 0 at
    /// `ageZeroTrustMinutes`, clamped to [0, 1]. Ages before the solve (a
    /// negative interval) are treated as full trust.
    static func ageFactor(ageMinutes: Double) -> Double {
        let full = Tuning.ageFullTrustMinutes
        let zero = Tuning.ageZeroTrustMinutes
        if ageMinutes <= full { return 1 }
        if ageMinutes >= zero { return 0 }
        return (zero - ageMinutes) / (zero - full)
    }

    /// Distance factor: 1 within `distanceFullTrustM`, linear down to
    /// `distanceFloorFactor` at `distanceHalfTrustM`, flat at the floor beyond.
    static func distanceFactor(distanceM: Double) -> Double {
        let near = Tuning.distanceFullTrustM
        let far = Tuning.distanceHalfTrustM
        let floor = Tuning.distanceFloorFactor
        if distanceM <= near { return 1 }
        if distanceM >= far { return floor }
        return 1 - (1 - floor) * (distanceM - near) / (far - near)
    }
}

/// Averages a short burst of planar fixes (spec §6.2 "hold still 2–3 s") and
/// reports spread so the caller can warn on jittery captures.
///
/// The mean is the anchor-diff / trilateration seed; `rmsSpreadM` washes out
/// jitter and `worstAccuracyM` surfaces a bad-fix burst (canopy multipath),
/// either of which should downgrade the resulting calibration's confidence.
struct FixAverager: Sendable {
    private var eastings: [Double] = []
    private var northings: [Double] = []
    private var worstAccuracy: Double = 0

    /// Add one raw planar fix (EPSG:3006 metres) with its reported horizontal
    /// accuracy (metres).
    mutating func add(e: Double, n: Double, horizontalAccuracyM: Double) {
        eastings.append(e)
        northings.append(n)
        worstAccuracy = max(worstAccuracy, horizontalAccuracyM)
    }

    /// Number of fixes accumulated so far.
    var count: Int { eastings.count }

    /// Mean position + RMS spread around it; nil until `count >= 3`.
    ///
    /// `rmsSpreadM` is the root-mean-square planar distance of the fixes from
    /// their mean; `worstAccuracyM` is the largest reported horizontal accuracy
    /// seen.
    var result: (e: Double, n: Double, rmsSpreadM: Double, worstAccuracyM: Double)? {
        guard count >= 3 else { return nil }
        let n = Double(count)
        let meanE = eastings.reduce(0, +) / n
        let meanN = northings.reduce(0, +) / n
        var sumSq = 0.0
        for i in 0..<eastings.count {
            let de = eastings[i] - meanE
            let dn = northings[i] - meanN
            sumSq += de * de + dn * dn
        }
        let rms = (sumSq / n).squareRoot()
        return (meanE, meanN, rms, worstAccuracy)
    }
}
