import XCTest
@testable import GolfMap

/// Headless state-machine coverage for `PuttQuizModel` — the putt-read
/// training quiz (doc §5.1, ported from the web's inline quiz slice in
/// `PlannerPanelComponent`). The scoring math itself is covered separately
/// (`PuttEstimateScoreTests`, golden-value parity against
/// `web/src/planner/putt-estimate-score.ts`); this exercises the surrounding
/// state machine: gating (`quizActive`), reveal (`submit`/`skip`), and reset
/// on putt-signature change (`notePuttSignature`).
@MainActor
final class PuttQuizModelTests: XCTestCase {

    private func freshModel(suiteName: String) -> PuttQuizModel {
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return PuttQuizModel(defaults: defaults)
    }

    private let truth = PuttGroundTruth(
        slopePct: 3, breakSide: .right, aimOffsetM: 0.3, playsLikeM: 5.2
    )

    private func fakeClient() -> GolfAPIClient {
        // Unreachable host: `submit`'s fire-and-forget POST fails silently
        // (the documented v1 contract) without touching the network.
        GolfAPIClient(baseURL: URL(string: "http://localhost:1")!)
    }

    // MARK: - Gating (`quizActive`)

    func testQuizInactiveByDefault_toggleOff() {
        let model = freshModel(suiteName: "quiz.inactiveByDefault")
        XCTAssertFalse(model.enabled, "default OFF per task brief")
        XCTAssertFalse(model.quizActive(groundTruth: truth))
    }

    func testQuizActiveOnceEnabledWithLiveGroundTruth() {
        let model = freshModel(suiteName: "quiz.activeWhenEnabled")
        model.enabled = true
        XCTAssertTrue(model.quizActive(groundTruth: truth))
    }

    func testQuizInactiveWithoutGroundTruth() {
        // This is the mechanism competition mode (and every other
        // no-live-read state — pending/place/unavailable/manual) rides on:
        // `Display.groundTruth` is nil there, so the quiz can never engage,
        // with no separate competition-awareness needed in this model.
        let model = freshModel(suiteName: "quiz.inactiveNoGroundTruth")
        model.enabled = true
        XCTAssertFalse(model.quizActive(groundTruth: nil))
    }

    func testQuizInactiveAfterReveal() {
        let model = freshModel(suiteName: "quiz.inactiveAfterReveal")
        model.enabled = true
        XCTAssertTrue(model.quizActive(groundTruth: truth))
        model.skip()
        XCTAssertTrue(model.revealed)
        XCTAssertFalse(model.quizActive(groundTruth: truth), "read shown once revealed, not re-hidden")
    }

    // MARK: - Reveal (`submit` / `skip`)

    func testSubmitScoresAgainstTruthAndReveals() {
        let model = freshModel(suiteName: "quiz.submitScores")
        model.enabled = true
        model.setSlopePct(3)
        model.setBreakSide(.right)
        model.setAimOffsetCm(30)
        model.setPlaysLikeM(5.2)

        model.submit(
            truth: truth, greenId: "green-1", distanceM: 5.2, stimpFt: 10, client: fakeClient()
        )

        XCTAssertTrue(model.revealed)
        let result = try! XCTUnwrap(model.lastResult)
        XCTAssertEqual(result.score, 100, "estimate matches truth exactly")
        XCTAssertEqual(result.slopeErrorPct, 0)
        XCTAssertTrue(result.breakSideCorrect)
        XCTAssertEqual(result.aimErrorM, 0, accuracy: 1e-9)
        XCTAssertEqual(result.paceErrorM, 0, accuracy: 1e-9)
    }

    func testSubmitConvertsAimOffsetCmToMetersForScoring() {
        let model = freshModel(suiteName: "quiz.submitConvertsUnits")
        model.enabled = true
        // 60 cm off vs a 30 cm truth = 0.3 m error, matching the `.aimErrorM`
        // scoring input directly (proves the /100 conversion at submit time).
        model.setAimOffsetCm(60)
        model.setBreakSide(.right)
        model.setSlopePct(3)
        model.setPlaysLikeM(5.2)

        model.submit(
            truth: truth, greenId: nil, distanceM: 5.2, stimpFt: 10, client: fakeClient()
        )

        let result = try! XCTUnwrap(model.lastResult)
        XCTAssertEqual(result.aimErrorM, 0.3, accuracy: 1e-9)
    }

    func testSkipRevealsWithoutScoring() {
        let model = freshModel(suiteName: "quiz.skipNoScore")
        model.enabled = true
        model.setSlopePct(3)

        model.skip()

        XCTAssertTrue(model.revealed)
        XCTAssertNil(model.lastResult, "skip never scores")
    }

    func testSubmitWithNilTruthRevealsWithoutScoring() {
        // Defensive fallback mirroring the web's `submitEstimate` — the UI
        // never calls this with a nil truth in practice (Reveal is only
        // shown while `quizActive` is true), but the model stays safe if it
        // does.
        let model = freshModel(suiteName: "quiz.submitNilTruth")
        model.enabled = true

        model.submit(truth: nil, greenId: nil, distanceM: 5, stimpFt: 10, client: fakeClient())

        XCTAssertTrue(model.revealed)
        XCTAssertNil(model.lastResult)
    }

    // MARK: - Reset on putt-signature change (`notePuttSignature`)

    func testSignatureChangeResetsRevealAndScoreButNotFormFields() {
        let model = freshModel(suiteName: "quiz.signatureResetsReveal")
        model.enabled = true
        model.setSlopePct(3)
        model.setBreakSide(.right)
        model.setAimOffsetCm(30)
        model.setPlaysLikeM(5.2)
        model.notePuttSignature("ball1|hole1|10.0")
        model.submit(truth: truth, greenId: nil, distanceM: 5.2, stimpFt: 10, client: fakeClient())
        XCTAssertTrue(model.revealed)
        XCTAssertNotNil(model.lastResult)

        model.notePuttSignature("ball2|hole1|10.0")

        XCTAssertFalse(model.revealed, "new putt re-hides the read")
        XCTAssertNil(model.lastResult, "stale score falls away")
        // Form fields are NOT cleared — the last guess is a reasonable
        // starting point for the next putt (matches the web exactly).
        XCTAssertEqual(model.slopePct, 3)
        XCTAssertEqual(model.breakSide, .right)
        XCTAssertEqual(model.aimOffsetCm, 30)
        XCTAssertEqual(model.playsLikeM, 5.2)
    }

    func testRepeatedSignatureIsANoOp() {
        let model = freshModel(suiteName: "quiz.repeatedSignatureNoOp")
        model.enabled = true
        model.notePuttSignature("ball1|hole1|10.0")
        model.submit(truth: truth, greenId: nil, distanceM: 5.2, stimpFt: 10, client: fakeClient())
        XCTAssertTrue(model.revealed)

        model.notePuttSignature("ball1|hole1|10.0")

        XCTAssertTrue(model.revealed, "same signature must not re-hide an already-revealed read")
        XCTAssertNotNil(model.lastResult)
    }

    func testFirstSignatureNoteIsANoOpWhenNothingRevealedYet() {
        let model = freshModel(suiteName: "quiz.firstSignatureNoop")
        model.notePuttSignature("ball1|hole1|10.0")
        XCTAssertFalse(model.revealed)
        XCTAssertNil(model.lastResult)
    }

    // MARK: - Persistence

    func testEnabledTogglePersistsAcrossInstancesViaSharedDefaults() {
        let suiteName = "quiz.persistence"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let first = PuttQuizModel(defaults: defaults)
        XCTAssertFalse(first.enabled)
        first.enabled = true

        let second = PuttQuizModel(defaults: defaults)
        XCTAssertTrue(second.enabled, "toggle persisted like other per-feature settings")

        defaults.removePersistentDomain(forName: suiteName)
    }
}
