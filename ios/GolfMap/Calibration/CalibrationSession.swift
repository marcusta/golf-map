import Foundation
import Observation

/// Drives one calibration *session* — the state machine a "Calibrate" sheet
/// runs on top of the pure primitives (`FixAverager`, `Trilateration.solve`)
/// to produce an `OriginCalibration` (spec §6.2 / §6.3).
///
/// Two mutually exclusive flows, one at a time (`Phase`):
///  - **anchor** ("I am here", §6.2): stand on a mapped point, hold still while
///    a short burst of GPS fixes averages out; the bias is `anchor − meanFix`.
///  - **trilateration** (§6.3): laser 2–3 fixed features from wherever you are;
///    least-squares recovers the 2D position delta.
///
/// The session owns no clock: every fix / shot / solve carries a caller-supplied
/// `Date`, so the whole machine is deterministic and unit-testable (the model
/// layer feeds it live `CLLocation` timestamps in production). All coordinates
/// are planar EPSG:3006 metres (`Vec2` = {x east, y north}); the resulting
/// `solvedNear` is projected back to WGS84 for the decay anchor.
@MainActor
@Observable
final class CalibrationSession {

    /// Which flow, if any, is in progress.
    enum Phase: Equatable, Sendable { case idle, anchor, trilateration }

    /// How trustworthy the tapped anchor point is (spec §6.2 anchor ranking) —
    /// sets the base confidence before capture-quality penalties.
    enum AnchorQuality: Equatable, Sendable {
        /// Surveyed static furniture — sprinkler heads, yardage plates, 150/100
        /// markers. The gold standard.
        case surveyed
        /// Mapped-from-ortho ~1 m class — a distinct bunker corner, path
        /// junction.
        case mapped
        /// Moves or is a concept, not a spot — tee markers, "green centre".
        case weak

        /// Base confidence contributed by the anchor tier (spec §6.2).
        var baseConfidence: Double {
            switch self {
            case .surveyed: return Constants.surveyedBaseConfidence
            case .mapped: return Constants.mappedBaseConfidence
            case .weak: return Constants.weakBaseConfidence
            }
        }
    }

    /// All session tuning in one place — spec §6.2 / §6.3.
    enum Constants {
        // MARK: Anchor tiers (§6.2) — base confidence before capture penalties.

        /// Surveyed furniture (sprinkler/plate/marker): the gold standard.
        static let surveyedBaseConfidence = 0.95
        /// Mapped-from-ortho ~1 m class (bunker corner, path junction).
        static let mappedBaseConfidence = 0.8
        /// Moves or is a concept (tee marker, "green centre").
        static let weakBaseConfidence = 0.6

        // MARK: Anchor capture (§6.2 "hold still 2–3 s").

        /// Fixes to average before the anchor solves — ~2–3 s at 3 Hz washes
        /// out per-fix jitter.
        static let requiredFixes = 8
        /// RMS burst spread (m) above which the capture is treated as jittery.
        static let jitterSpreadM = 2.0
        /// Worst reported horizontal accuracy (m) above which the capture is
        /// treated as poor (canopy multipath baked into the mean).
        static let poorAccuracyM = 10.0
        /// Confidence multiplier applied to a jittery / low-accuracy capture —
        /// the "warn on canopy" seam.
        static let poorCaptureFactor = 0.7

        // MARK: Trilateration fit (§6.3).

        /// Base confidence for a clean laser solve before fit penalties.
        static let trilaterationBaseConfidence = 0.85
        /// RMS residual (m) that would drive the fit factor to its floor:
        /// factor = max(minFitFactor, 1 − rms / rmsResidualScaleM).
        static let rmsResidualScaleM = 3.0
        /// Floor on the residual-fit factor — a bad fit is downgraded, never to
        /// zero (the well-constrained component may still be usable).
        static let minFitFactor = 0.4
        /// Confidence multiplier when the solve reported a weak axis (< ~25°
        /// spread; only one axis constrained).
        static let weakAxisFactor = 0.5
        /// Below this bearing spread (degrees) the sheet hints "need a wider
        /// angle" (spec §6.3 ~25°). Advisory only — the solver still decides
        /// weak-axis handling.
        static let minAngularSpreadDeg = 25.0
    }

    // MARK: - Shared state

    /// Which flow is active.
    private(set) var phase: Phase = .idle

    // MARK: - Anchor state

    private var anchorPlanar: Vec2?
    private var anchorQuality: AnchorQuality = .mapped
    private var averager = FixAverager()
    private var lastFixDate: Date?

    // MARK: - Trilateration state

    private var rawFixPlanar: Vec2?
    private var trilaterationDate: Date?
    /// Shots taken so far in the trilateration flow (the sheet lists them).
    private(set) var shots: [Trilateration.Shot] = []

    init() {}

    // MARK: - Anchor flow (spec §6.2)

    /// Begin the "I am here" flow standing on `anchorPlanar` of the given
    /// `quality`. Resets any prior capture.
    func beginAnchor(at anchorPlanar: Vec2, quality: AnchorQuality) {
        reset()
        phase = .anchor
        self.anchorPlanar = anchorPlanar
        self.anchorQuality = quality
    }

    /// Feed one raw GPS fix (EPSG:3006 metres) into the anchor burst. Ignored
    /// outside the anchor phase.
    func addFix(e: Double, n: Double, horizontalAccuracyM: Double, at: Date) {
        guard phase == .anchor else { return }
        averager.add(e: e, n: n, horizontalAccuracyM: horizontalAccuracyM)
        lastFixDate = at
    }

    /// Progress toward `requiredFixes`, 0…1 — drives the sheet's progress ring.
    var fixProgress: Double {
        min(1, Double(averager.count) / Double(Constants.requiredFixes))
    }

    /// True once the burst is jittery (RMS spread > `jitterSpreadM`) or low
    /// accuracy (worst > `poorAccuracyM`) — the "hold still / step into the
    /// open" warning. False until enough fixes exist to judge.
    var captureQualityWarning: Bool {
        guard let r = averager.result else { return false }
        return r.rmsSpreadM > Constants.jitterSpreadM || r.worstAccuracyM > Constants.poorAccuracyM
    }

    /// The solved anchor calibration, or nil until `requiredFixes` are in.
    ///
    /// Bias = `anchor − meanFix`; `solvedNear` = the anchor (projected to
    /// WGS84); base confidence = the anchor tier, reduced by `poorCaptureFactor`
    /// on a jittery / low-accuracy capture (`captureQualityWarning`).
    var anchorResult: OriginCalibration? {
        guard phase == .anchor,
              let anchor = anchorPlanar,
              averager.count >= Constants.requiredFixes,
              let r = averager.result,
              let solvedAt = lastFixDate
        else { return nil }

        let base = anchorQuality.baseConfidence
            * (captureQualityWarning ? Constants.poorCaptureFactor : 1)

        return OriginCalibration(
            biasE: anchor.x - r.e,
            biasN: anchor.y - r.n,
            solvedAt: solvedAt,
            solvedNear: Sweref99TM.toWGS84(x: anchor.x, y: anchor.y),
            method: .anchor,
            baseConfidence: base
        )
    }

    // MARK: - Trilateration flow (spec §6.3)

    /// Begin the laser-trilateration flow from `rawFixPlanar` (the uncorrected
    /// GPS fix, the solver's seed). Resets any prior shots.
    func beginTrilateration(rawFixPlanar: Vec2, at: Date) {
        reset()
        phase = .trilateration
        self.rawFixPlanar = rawFixPlanar
        trilaterationDate = at
    }

    /// Add a laser shot to a mapped feature. Ignored outside the trilateration
    /// phase.
    func addShot(featurePlanar: Vec2, laserDistanceM: Double) {
        guard phase == .trilateration else { return }
        shots.append(Trilateration.Shot(featurePlanar: featurePlanar, laserDistanceM: laserDistanceM))
    }

    /// Remove a mis-taken shot. Out-of-range indices are ignored.
    func removeShot(at index: Int) {
        guard shots.indices.contains(index) else { return }
        shots.remove(at: index)
    }

    /// The solved calibration + raw solver solution, or nil until ≥ 2 shots
    /// yield a successful `Trilateration.solve`.
    ///
    /// Base confidence = `trilaterationBaseConfidence`, scaled by fit quality
    /// (`max(minFitFactor, 1 − rms / rmsResidualScaleM)`) and halved
    /// (`weakAxisFactor`) when the solve was weak-axis (spec §6.3). `solvedNear`
    /// = the solved true position (projected to WGS84).
    var trilaterationResult: (calibration: OriginCalibration, solution: Trilateration.Solution)? {
        guard phase == .trilateration,
              let rawFix = rawFixPlanar,
              let solvedAt = trilaterationDate,
              shots.count >= 2,
              let solution = Trilateration.solve(rawFixPlanar: rawFix, shots: shots)
        else { return nil }

        let fitFactor = max(Constants.minFitFactor, 1 - solution.rmsResidualM / Constants.rmsResidualScaleM)
        let base = Constants.trilaterationBaseConfidence
            * fitFactor
            * (solution.weakAxis ? Constants.weakAxisFactor : 1)

        let calibration = OriginCalibration(
            biasE: solution.biasE,
            biasN: solution.biasN,
            solvedAt: solvedAt,
            solvedNear: Sweref99TM.toWGS84(x: solution.positionPlanar.x, y: solution.positionPlanar.y),
            method: .trilateration,
            baseConfidence: base
        )
        return (calibration, solution)
    }

    /// Bearing spread (degrees, 0…180) of the current shots as seen from the raw
    /// fix — the smallest arc containing all shot bearings. Below
    /// `minAngularSpreadDeg` the sheet hints "need a wider angle" (spec §6.3).
    /// Nil until there are ≥ 2 shots to compare.
    var angularSpreadDeg: Double? {
        guard let rawFix = rawFixPlanar, shots.count >= 2 else { return nil }

        // Compass bearing raw-fix → feature, 0 = north, clockwise.
        var bearings = shots.map { shot -> Double in
            let dx = shot.featurePlanar.x - rawFix.x
            let dy = shot.featurePlanar.y - rawFix.y
            let deg = atan2(dx, dy) * 180 / .pi
            return deg < 0 ? deg + 360 : deg
        }
        bearings.sort()

        // Smallest arc covering all bearings = 360 − largest circular gap.
        var largestGap = 0.0
        for i in 0..<bearings.count {
            let next = bearings[(i + 1) % bearings.count]
            var gap = next - bearings[i]
            if i == bearings.count - 1 { gap += 360 } // wrap-around gap
            largestGap = max(largestGap, gap)
        }
        return 360 - largestGap
    }

    // MARK: - Shared

    /// Abandon the current flow and clear all captured state.
    func reset() {
        phase = .idle
        anchorPlanar = nil
        anchorQuality = .mapped
        averager = FixAverager()
        lastFixDate = nil
        rawFixPlanar = nil
        trilaterationDate = nil
        shots = []
    }
}
