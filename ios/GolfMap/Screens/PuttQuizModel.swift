import Foundation
import Observation

/// Headless putt-read training-quiz state machine (doc §5.1) — port of the
/// quiz slice inline in the web's `PlannerPanelComponent`
/// (`web/src/planner/planner-panel.component.ts`, "Training quiz" section),
/// pulled into its own model on iOS so it stays headless/XCTest-able like
/// the other on-course view-models (`CaddyAdviceModel`, `GreenAnalysisModel`).
///
/// Deliberately does NOT hold a reference to `PuttReadModel` — like
/// `CaddyAdviceModel`, it is fed explicit inputs (`quizActive(groundTruth:)`,
/// `submit(truth:...)`) by the screen/view layer, so it is testable without a
/// live read.
///
/// The player estimates the read (slope %, break side, aim offset, plays-like
/// distance) BEFORE it's revealed; submitting scores the guess
/// (`PuttEstimateScore.swift`, ported 1:1 from
/// `web/src/planner/putt-estimate-score.ts`) and reveals the real read
/// alongside the score. Estimate fields do NOT reset when the putt changes —
/// only `revealed`/`lastResult` do (matches the web exactly: the last guess
/// is a reasonable starting point for the next putt).
@MainActor
@Observable
final class PuttQuizModel {

    // MARK: - Persisted toggle

    @ObservationIgnored private let defaults: UserDefaults
    private static let enabledKey = "putt.quizEnabled"

    /// Quiz on/off, persisted like the other per-feature toggles
    /// (`PuttReadModel.stimpFt`/`overlayMode`'s own-key pattern). Default
    /// OFF — the task brief pins this to off-by-default on iOS (the web
    /// equivalent, `trainingMode`, also loads to OFF: `loadTrainingMode()`
    /// returns `false` when nothing is persisted yet, despite a stale
    /// "default ON" comment in that file).
    var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            defaults.set(enabled, forKey: Self.enabledKey)
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.enabled = (defaults.object(forKey: Self.enabledKey) as? Bool) ?? false
    }

    // MARK: - Estimate form

    /// Cross-slope estimate, % (unsigned) — mirrors the web form's "Slope %".
    private(set) var slopePct: Double = 0
    private(set) var breakSide: BreakSide = .straight
    /// Aim offset in CENTIMETERS — the web form's unit ("Aim cm"); converted
    /// to meters at scoring/submit time (`PuttEstimate.aimOffsetM`), same
    /// `/100` conversion the web does inline in its submit handler.
    private(set) var aimOffsetCm: Double = 0
    /// Plays-like distance estimate, meters — mirrors "Plays m".
    private(set) var playsLikeM: Double = 0

    func setSlopePct(_ v: Double) { slopePct = max(0, v) }
    func setBreakSide(_ v: BreakSide) { breakSide = v }
    func setAimOffsetCm(_ v: Double) { aimOffsetCm = v }
    func setPlaysLikeM(_ v: Double) { playsLikeM = max(0, v) }

    // MARK: - Reveal state

    private(set) var revealed = false
    private(set) var lastResult: PuttEstimateScoreResult?

    @ObservationIgnored private var lastSig: String?

    /// Feed `PuttReadModel.puttSignature` here on every view update (a cheap
    /// string compare) — resets `revealed`/`lastResult` exactly once when the
    /// putt changes (ball/hole reposition or stimp change), matching the
    /// web's `puttSig` effect (`bindPuttSection`). A no-op once the signature
    /// has already been noted, so it's safe to call from a SwiftUI body.
    func notePuttSignature(_ sig: String) {
        guard sig != lastSig else { return }
        lastSig = sig
        if revealed { revealed = false }
        if lastResult != nil { lastResult = nil }
    }

    /// Whether the quiz should currently be gating the read display — mirrors
    /// the web `quizActive` Computed (`trainingMode && !revealed && (status
    /// === 'ok' || status === 'soft')`). Pass `PuttReadModel.display.groundTruth`:
    /// it is non-nil ONLY for a live Surface-tier read that is neither
    /// softened-to-nothing (unavailable/pending/place/noSurface all yield
    /// nil) nor in competition mode (`Display.groundTruth` is nil on that
    /// branch too) — so this one check satisfies every gating requirement.
    func quizActive(groundTruth: PuttGroundTruth?) -> Bool {
        enabled && !revealed && groundTruth != nil
    }

    // MARK: - Submit / skip

    /// Score the current form against `truth`, reveal, and fire-and-forget a
    /// POST of the scored sample. Mirrors `submitEstimate` (web) including
    /// its "nothing to score" fallback when `truth` is nil (reveal only, no
    /// score) — defensive: the Reveal button is only shown while
    /// `quizActive` is true, which already implies a non-nil ground truth,
    /// but a caller can't race a display refresh between button-tap and
    /// this call on `@MainActor`, so this fallback is effectively dead code,
    /// kept only for parity with the web's defensive check.
    ///
    /// LIMITATION (v1, matches task brief): no offline queue. A failed POST
    /// (offline, server error, timeout) is silently dropped — the scored
    /// reveal always happens locally regardless of network state; only the
    /// training-history sample itself is lost. `PuttEstimateService.record`
    /// on the web has the identical soft-fail contract ("a lost training
    /// sample must never break the reveal").
    func submit(
        truth: PuttGroundTruth?,
        greenId: String?,
        distanceM: Double,
        stimpFt: Double,
        client: GolfAPIClient
    ) {
        guard let truth else {
            revealed = true
            return
        }
        let estimate = PuttEstimate(
            slopePct: slopePct, breakSide: breakSide,
            aimOffsetM: aimOffsetCm / 100, playsLikeM: playsLikeM
        )
        let result = scoreEstimate(estimate, truth: truth)
        lastResult = result
        revealed = true

        Task {
            _ = try? await client.recordPuttEstimateSample(
                greenId: greenId,
                distanceM: distanceM,
                stimpFt: stimpFt,
                actualSlopePct: truth.slopePct,
                estimatedSlopePct: estimate.slopePct,
                actualAimOffsetM: truth.aimOffsetM,
                estimatedAimOffsetM: estimate.aimOffsetM,
                actualPlaysLikeM: truth.playsLikeM,
                estimatedPlaysLikeM: estimate.playsLikeM,
                breakSideActual: truth.breakSide.rawValue,
                breakSideEstimated: estimate.breakSide.rawValue
            )
        }
    }

    /// Reveal without scoring/recording. Mirrors the web's skip handler
    /// exactly (`lastScore.set(null); revealed.set(true)`).
    func skip() {
        lastResult = nil
        revealed = true
    }
}
