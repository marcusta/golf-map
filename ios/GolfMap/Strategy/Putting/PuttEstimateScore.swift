import Foundation

/// Putt-read training quiz scoring — faithful Swift port of
/// `web/src/planner/putt-estimate-score.ts`. The two MUST stay numerically
/// identical (same weights, same zero-credit thresholds, same rounding);
/// parity pinned by TS-computed golden cases in `PuttEstimateScoreTests`.
///
/// The player estimates four things about a live green read before it's
/// revealed — slope %, break side, aim offset, plays-like distance — and
/// this scores the estimate against the computed ground truth. `BreakSide`
/// is shared with `TourRead.swift` (identical `left`/`right`/`straight`
/// vocabulary already used for the tour-read aim side).

/// The player's guesses, entered via the quiz form.
public struct PuttEstimate: Equatable, Sendable {
    public var slopePct: Double
    public var breakSide: BreakSide
    public var aimOffsetM: Double
    public var playsLikeM: Double

    public init(slopePct: Double, breakSide: BreakSide, aimOffsetM: Double, playsLikeM: Double) {
        self.slopePct = slopePct
        self.breakSide = breakSide
        self.aimOffsetM = aimOffsetM
        self.playsLikeM = playsLikeM
    }
}

/// The computed read the estimate is scored against — same shape as
/// `PuttEstimate`, sourced from `PuttReadModel`'s Surface-tier read once
/// revealed.
public struct PuttGroundTruth: Equatable, Sendable {
    public var slopePct: Double
    public var breakSide: BreakSide
    public var aimOffsetM: Double
    public var playsLikeM: Double

    public init(slopePct: Double, breakSide: BreakSide, aimOffsetM: Double, playsLikeM: Double) {
        self.slopePct = slopePct
        self.breakSide = breakSide
        self.aimOffsetM = aimOffsetM
        self.playsLikeM = playsLikeM
    }
}

/// Per-component error + overall 0–100 score.
public struct PuttEstimateScoreResult: Equatable, Sendable {
    public var slopeErrorPct: Double
    public var breakSideCorrect: Bool
    public var aimErrorM: Double
    public var paceErrorM: Double
    public var score: Int
}

/// Error magnitude at which slope-% credit reaches zero.
public let SLOPE_ERROR_ZERO_PCT: Double = 2
/// Error magnitude at which plays-like-distance credit reaches zero.
public let PACE_ERROR_ZERO_M: Double = 3
/// Error magnitude at which aim-offset credit reaches zero.
public let AIM_ERROR_ZERO_M: Double = 0.6

/// Blend weights — slope weighted highest (it drives everything else),
/// break/aim/pace share the rest evenly.
public enum PuttEstimateScoreWeights {
    public static let slope: Double = 0.4
    public static let breakSide: Double = 0.2
    public static let aim: Double = 0.2
    public static let pace: Double = 0.2
}

/// Linear credit taper: full credit at zero error, none at/beyond `zeroAt`.
private func credit(_ error: Double, zeroAt: Double) -> Double {
    max(0, 1 - error / zeroAt)
}

/// Scores an estimate against the ground truth. `score` is always
/// nonnegative (each `credit()` term is clamped ≥ 0), so standard
/// `.rounded()` (round-half-away-from-zero) matches JS `Math.round` exactly
/// here — no `jsRound` needed.
public func scoreEstimate(_ estimate: PuttEstimate, truth: PuttGroundTruth) -> PuttEstimateScoreResult {
    let slopeErrorPct = abs(estimate.slopePct - truth.slopePct)
    let breakSideCorrect = estimate.breakSide == truth.breakSide
    let aimErrorM = abs(estimate.aimOffsetM - truth.aimOffsetM)
    let paceErrorM = abs(estimate.playsLikeM - truth.playsLikeM)
    let blend =
        PuttEstimateScoreWeights.slope * credit(slopeErrorPct, zeroAt: SLOPE_ERROR_ZERO_PCT) +
        PuttEstimateScoreWeights.breakSide * (breakSideCorrect ? 1 : 0) +
        PuttEstimateScoreWeights.aim * credit(aimErrorM, zeroAt: AIM_ERROR_ZERO_M) +
        PuttEstimateScoreWeights.pace * credit(paceErrorM, zeroAt: PACE_ERROR_ZERO_M)
    return PuttEstimateScoreResult(
        slopeErrorPct: slopeErrorPct,
        breakSideCorrect: breakSideCorrect,
        aimErrorM: aimErrorM,
        paceErrorM: paceErrorM,
        score: Int((blend * 100).rounded())
    )
}
