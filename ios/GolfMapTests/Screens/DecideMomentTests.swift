import XCTest
@testable import GolfMap

/// Decide moment (round loop R4, task T33): off-plan choice assembly (engine
/// candidates + caddy ranking/vetoes), the score/risk triple, the working
/// target a tapped choice sets, and its capture-prefill / map wiring. Golden
/// hole = the T31 synthetic course grown a bag, a surface stack, and a
/// mid-line bunker.
@MainActor
final class DecideMomentTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "DecideMomentTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Golden hole fixture

    /// Hole 1: default tee → one planned landing (Driver) → green, due-ish
    /// north; the off-plan ball sits ~167 m south of the green, ~80 m from
    /// the planned landing (beyond the Driver divergence radius of 30 m).
    private let tee = LatLon(lat: 58.3600, lon: 15.7100)
    private let landing = LatLon(lat: 58.3620, lon: 15.7090)
    private let greenCenter = LatLon(lat: 58.3640, lon: 15.7080)
    private let offPlanBall = LatLon(lat: 58.3625, lon: 15.7080)
    /// The safe-line sibling's landing (option-tree fixture, T37): ~106 m
    /// from the off-plan ball and ~97 m short of the green — the authored
    /// option SURVIVES the divergence position, while the primary "Attack"
    /// root (~230 m from the green) is behind the ball and does not.
    private let safeOptionLanding = LatLon(lat: 58.3633, lon: 15.7090)

    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Testville GC", status: "published",
            revision: 2, downloadedRevision: 2, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 7),
            HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3, strokeIndex: 15),
        ]
        let tees = [
            TeeRecord(id: "t1d", holeId: "h1", name: "default", lat: tee.lat, lon: tee.lon, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2d", holeId: "h2", name: "default", lat: 58.3660, lon: 15.7060, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: greenCenter.lat, centerLon: greenCenter.lon,
                frontLat: 58.3638, frontLon: 15.7080,
                backLat: 58.3642, backLon: 15.7080,
                elevation: 25
            ),
            GreenRecord(id: "g2", holeId: "h2", centerLat: 58.3670, centerLon: 15.7050),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
    }

    private func makePlan(clubs: [ClubRecord]) -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-1", courseId: "course-1"),
                holes: [GamePlanHoleRecord(
                    id: "ph1", gamePlanId: "plan-1", holeNumber: 1, notes: nil
                )],
                shots: [PlanShotRecord(
                    id: "ps1", gamePlanHoleId: "ph1", sortOrder: 0,
                    lat: landing.lat, lon: landing.lon,
                    clubId: "c-drv", label: "Layup"
                )],
                gates: []
            ),
            clubs: clubs
        )
    }

    /// Option-tree variant (T37): the primary "Attack" root plus a "Safe
    /// line" sibling whose landing survives from `offPlanBall`, plus a
    /// single-child continuation under it — a continuation is plan-leg
    /// content, NOT a decision-point option, so it must never enter decide.
    private func makeOptionPlan(clubs: [ClubRecord], safeClubId: String) -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-1", courseId: "course-1"),
                holes: [GamePlanHoleRecord(
                    id: "ph1", gamePlanId: "plan-1", holeNumber: 1, notes: nil
                )],
                shots: [
                    PlanShotRecord(
                        id: "ps1", gamePlanHoleId: "ph1", sortOrder: 0,
                        lat: landing.lat, lon: landing.lon,
                        clubId: "c-drv", label: "Attack"
                    ),
                    PlanShotRecord(
                        id: "ps-safe", gamePlanHoleId: "ph1", sortOrder: 1,
                        lat: safeOptionLanding.lat, lon: safeOptionLanding.lon,
                        clubId: safeClubId, label: "Safe line"
                    ),
                    PlanShotRecord(
                        id: "ps-safe-next", gamePlanHoleId: "ph1", sortOrder: 0,
                        parentShotId: "ps-safe",
                        lat: 58.3636, lon: 15.7085,
                        clubId: "c-sw", label: "Chip zone"
                    ),
                ],
                gates: []
            ),
            clubs: clubs
        )
    }

    private func makeBag() -> [ClubRecord] {
        [
            ClubRecord(id: "c-drv", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0),
            ClubRecord(id: "c-5i", name: "5i", carryM: 175, dispersionM: 38, sortOrder: 1),
            ClubRecord(id: "c-9i", name: "9i", carryM: 127, dispersionM: 30, sortOrder: 2),
            ClubRecord(id: "c-pw", name: "PW", carryM: 115, dispersionM: 27, sortOrder: 3),
            ClubRecord(id: "c-lw", name: "LW", carryM: 90, dispersionM: 20, sortOrder: 4),
            ClubRecord(id: "c-sw", name: "SW", carryM: 70, dispersionM: 16, sortOrder: 5),
        ]
    }

    private func box(around ll: LatLon, half: Double, kind: String) -> FlatRing {
        let c = Sweref99TM.fromWGS84(ll)
        return FlatRing(points: [
            Vec2(x: c.x - half, y: c.y - half), Vec2(x: c.x + half, y: c.y - half),
            Vec2(x: c.x + half, y: c.y + half), Vec2(x: c.x - half, y: c.y + half),
        ], kind: kind)
    }

    /// A bunker pinching the ball → green line ~90–100 m ahead of the ball.
    private var midLineBunker: FlatRing {
        box(around: LatLon(lat: 58.36335, lon: 15.7080), half: 6, kind: "bunker")
    }

    /// Model on the golden hole with the ball off-plan (mode = decide):
    /// green ring installed, mid-line bunker, optional jail (trees) around
    /// the ball. `optionPlan` swaps in the T37 option tree and drops the
    /// bunker/hazards, so the engine yields go + layup-full and the option
    /// list never overflows the R4 cap of 3.
    private func makeDecideModel(
        jail: Bool = false, optionPlan: Bool = false, safeClubId: String = "c-pw"
    ) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        let bag = makeBag()
        model.setClubs(bag)
        model.setPlan(
            optionPlan
                ? makeOptionPlan(clubs: bag, safeClubId: safeClubId)
                : makePlan(clubs: bag)
        )
        var surfaces = [box(around: greenCenter, half: 20, kind: "green")]
        if jail {
            surfaces.insert(box(around: offPlanBall, half: 20, kind: "trees"), at: 0)
        }
        if !optionPlan {
            surfaces.append(midLineBunker)
            model.setHazards([midLineBunker], holeIds: ["h1"])
        }
        model.setSurfaces(surfaces)
        model.setActiveRound(strokes: [
            OnCourseModel.RoundStroke(holeNumber: 1, position: tee),
            OnCourseModel.RoundStroke(holeNumber: 1, position: offPlanBall),
        ])
        return model
    }

    // MARK: - R4: ranked choices from the actual ball

    func testOffPlanPositionYieldsSaneRankedChoices() throws {
        let model = makeDecideModel()
        XCTAssertEqual(model.roundCardMode, .decide, "fixture sanity: ball is off-plan")
        let content = try XCTUnwrap(model.decideContent)
        XCTAssertFalse(content.choices.isEmpty)
        XCTAssertLessThanOrEqual(content.choices.count, 3, "max 3 choices (R4)")

        let remaining = Distance.planarMeters(offPlanBall, greenCenter)
        for choice in content.choices {
            XCTAssertGreaterThan(choice.distanceM, 0)
            XCTAssertLessThanOrEqual(Double(choice.distanceM), remaining + 1)
            XCTAssertGreaterThan(
                choice.probableScore, 2,
                "2 strokes taken + at least the shot itself"
            )
            XCTAssertTrue((0...1).contains(choice.penaltyShare))
            XCTAssertNotNil(choice.clubName)
        }
        // No safety veto fires on this benign fixture → pure EV order.
        let scores = content.choices.map(\.probableScore)
        XCTAssertEqual(scores, scores.sorted(), "ranked by probable score")
    }

    func testChoicesCoverTheParFiveTrioShape() throws {
        let model = makeDecideModel()
        let content = try XCTUnwrap(model.decideContent)
        let kinds = Set(content.choices.map(\.kind))
        // GO: 5i (max carry 183.75) reaches the ~167 m green.
        let go = try XCTUnwrap(content.choices.first { $0.kind == .go })
        XCTAssertEqual(go.clubName, "5i")
        XCTAssertEqual(go.target, greenCenter, "go targets the green centre")
        XCTAssertTrue(go.headline.hasPrefix("Go — "))
        // At least one safe alternative alongside GO.
        XCTAssertTrue(
            kinds.contains(.layupFull) || kinds.contains(.layBack),
            "a lay-up alternative ranks alongside go, got \(kinds)"
        )
    }

    func testTripleSpeaksTheSharedFormat() throws {
        let model = makeDecideModel()
        let choice = try XCTUnwrap(model.decideContent?.choices.first)
        XCTAssertEqual(
            choice.triple,
            ScoreRiskFormat.triple(
                probableScore: choice.probableScore,
                penaltyShare: choice.penaltyShare,
                tailScore: choice.tailScore
            ),
            "choices speak through THE shared formatter (option chips reuse it)"
        )
        XCTAssertTrue(choice.triple.hasPrefix("prob. "))
        XCTAssertTrue(choice.triple.contains("% pen"))
    }

    func testPenaltyStrokesRaiseTheProbableScoreBaseline() throws {
        let model = makeDecideModel()
        let base = try XCTUnwrap(model.decideContent?.choices.first)
        model.setActiveRound(strokes: [
            OnCourseModel.RoundStroke(holeNumber: 1, position: tee, penaltyStrokes: 1),
            OnCourseModel.RoundStroke(holeNumber: 1, position: offPlanBall),
        ])
        let penalised = try XCTUnwrap(model.decideContent?.choices.first)
        XCTAssertEqual(
            penalised.probableScore, base.probableScore + 1, accuracy: 1e-9,
            "a penalty stroke on the hole shifts the probable score by exactly 1"
        )
    }

    // MARK: - Caddy veto: jail promotes the punch-out

    func testRecoveryLiePromotesThePunchOutAndDemotesGo() throws {
        let model = makeDecideModel(jail: true)
        XCTAssertEqual(model.playingState?.lie, .recovery, "fixture sanity: ball in the trees")
        let content = try XCTUnwrap(model.decideContent)
        XCTAssertEqual(
            content.choices.first?.kind, .punchOut,
            "take-your-medicine puts the escape first"
        )
        if let goIndex = content.choices.firstIndex(where: { $0.kind == .go }) {
            XCTAssertEqual(
                goIndex, content.choices.count - 1,
                "the vetoed aggressive line ranks last"
            )
        }
        XCTAssertNotNil(content.caddyHeadline, "the caddy names why")
    }

    // MARK: - Authored options in decide (R4 merge — T37)

    func testAuthoredSafeLineBranchAppearsPricedAndRanked() throws {
        let model = makeDecideModel(optionPlan: true)
        XCTAssertEqual(model.roundCardMode, .decide, "fixture sanity: ball is off-plan")
        let content = try XCTUnwrap(model.decideContent)
        XCTAssertLessThanOrEqual(content.choices.count, 3, "the option obeys the R4 cap")

        let options = content.choices.filter { $0.kind == .option }
        XCTAssertEqual(
            options.count, 1,
            "only the SURVIVING safe-line sibling: the behind-the-ball Attack root "
                + "and the single-child continuation must not enter, got \(content.choices.map(\.id))"
        )
        let option = try XCTUnwrap(options.first)
        XCTAssertEqual(option.id, "option-ps-safe")
        XCTAssertEqual(option.clubName, "PW", "the authored club still fits from here")
        XCTAssertTrue(
            option.headline.hasPrefix("Safe line PW → "),
            "authored label + club + remaining-in vocabulary, got \(option.headline)"
        )
        XCTAssertEqual(option.target, safeOptionLanding, "the option's OWN landing point")
        XCTAssertEqual(
            option.distanceM,
            Int(Distance.planarMeters(offPlanBall, safeOptionLanding).rounded())
        )
        // Priced like every other choice: baseline strokes + EV, share in
        // range, the shared triple formatter.
        XCTAssertGreaterThan(option.probableScore, 2)
        XCTAssertTrue((0...1).contains(option.penaltyShare))
        XCTAssertTrue(option.triple.hasPrefix("prob. "))
        // Ranked alongside the engine candidates, not pinned to the top.
        XCTAssertTrue(content.choices.contains { $0.kind == .go }, "engine go still present")
    }

    func testAuthoredOptionReclubsWhenTheAuthoredCarryNoLongerFits() throws {
        // The plan's Driver was authored for the TEE origin; from the
        // diverged ball ~106 m out it cannot fit, so the option re-clubs to
        // the closest club that does (PW 115).
        let model = makeDecideModel(optionPlan: true, safeClubId: "c-drv")
        let option = try XCTUnwrap(
            model.decideContent?.choices.first { $0.kind == .option }
        )
        XCTAssertEqual(option.id, "option-ps-safe")
        XCTAssertEqual(option.clubName, "PW")
    }

    func testTappedAuthoredOptionLandingBecomesTheWorkingTarget() throws {
        let model = makeDecideModel(optionPlan: true)
        let option = try XCTUnwrap(
            model.decideContent?.choices.first { $0.kind == .option }
        )
        model.selectDecideChoice(option)
        let wt = try XCTUnwrap(model.workingTarget)
        XCTAssertEqual(wt.position, safeOptionLanding, "the authored landing, not a green-line projection")
        XCTAssertEqual(wt.clubName, option.clubName)
        // Capture prefill reads it FIRST, exactly like an engine choice.
        XCTAssertEqual(
            ShotCaptureDefaults.defaultTarget(
                workingTarget: model.workingTarget?.position,
                position: offPlanBall,
                activePin: nil,
                planLandings: [landing],
                greenCenter: greenCenter
            ),
            safeOptionLanding
        )
    }

    // MARK: - DecideKey covers adjust-mode overrides (T37 finding 4)

    func testMovedGreenCentreOverrideInvalidatesTheDecideMemo() throws {
        let model = makeDecideModel()
        _ = try XCTUnwrap(model.decideContent)
        XCTAssertEqual(model.decideBuildCount, 1)

        // ~145 m out — still 5i-reachable, so GO survives and must re-target.
        let movedGreen = LatLon(lat: 58.3638, lon: 15.7078)
        model.setHandleOverride(id: OnCourseModel.greenHandleID, to: movedGreen)
        let after = try XCTUnwrap(model.decideContent)
        XCTAssertEqual(
            model.decideBuildCount, 2,
            "a moved green centre changes the DecideKey and rebuilds exactly once"
        )
        let go = try XCTUnwrap(after.choices.first { $0.kind == .go })
        XCTAssertEqual(go.target, movedGreen, "go re-targets the moved green centre")
        _ = model.decideContent
        XCTAssertEqual(model.decideBuildCount, 2, "and the memo holds again afterwards")
    }

    // MARK: - Working target (tap → distance line, club, capture prefill)

    func testTapChoiceSetsTheWorkingTargetSurfaces() throws {
        let model = makeDecideModel()
        let choice = try XCTUnwrap(model.decideContent?.choices.first)
        model.selectDecideChoice(choice)

        let wt = try XCTUnwrap(model.workingTarget)
        XCTAssertEqual(wt.position, choice.target)
        XCTAssertEqual(wt.clubName, choice.clubName)

        // Distance line: origin straight to the committed landing.
        let origin = try XCTUnwrap(model.origin)
        XCTAssertEqual(model.overlays.distanceLine, [origin, choice.target])

        // Banner advice: the choice's headline + ITS club (not re-derived).
        let advice = try XCTUnwrap(model.selectedTargetAdvice)
        XCTAssertEqual(advice.title, choice.headline)
        XCTAssertEqual(advice.club, choice.clubName)
        XCTAssertNotNil(model.selectedTargetEllipse, "ghost pattern draws for the choice")

        // Capture prefill reads the working target FIRST (before pin / plan /
        // green — T34 formalises the rest of the order).
        let prefill = ShotCaptureDefaults.defaultTarget(
            workingTarget: model.workingTarget?.position,
            position: offPlanBall,
            activePin: nil,
            planLandings: [landing],
            greenCenter: greenCenter
        )
        XCTAssertEqual(prefill, choice.target)
    }

    func testDefaultTargetWithoutWorkingTargetIsUnchanged() {
        // The T31/shot-capture behaviour is byte-identical when no working
        // target is set (default parameter).
        XCTAssertEqual(
            ShotCaptureDefaults.defaultTarget(
                position: offPlanBall, activePin: nil,
                planLandings: [], greenCenter: greenCenter
            ),
            greenCenter
        )
    }

    func testTapAgainTogglesTheWorkingTargetOff() throws {
        let model = makeDecideModel()
        let choice = try XCTUnwrap(model.decideContent?.choices.first)
        model.selectDecideChoice(choice)
        XCTAssertNotNil(model.workingTarget)
        model.selectDecideChoice(choice)
        XCTAssertNil(model.workingTarget)
    }

    func testCaptureConsumesTheWorkingTarget() throws {
        let model = makeDecideModel()
        let choice = try XCTUnwrap(model.decideContent?.choices.first)
        model.selectDecideChoice(choice)
        model.setActiveRound(strokes: [
            OnCourseModel.RoundStroke(holeNumber: 1, position: tee),
            OnCourseModel.RoundStroke(holeNumber: 1, position: offPlanBall),
            OnCourseModel.RoundStroke(holeNumber: 1, position: choice.target),
        ])
        XCTAssertNil(model.workingTarget, "a capture re-derives the moment (R4)")
    }

    func testHoleChangeClearsTheWorkingTarget() throws {
        let model = makeDecideModel()
        let choice = try XCTUnwrap(model.decideContent?.choices.first)
        model.selectDecideChoice(choice)
        model.goToHole(number: 2)
        XCTAssertNil(model.workingTarget, "working target is per-hole transient state")
    }

    // MARK: - Gating + cadence

    func testCompetitionModeWithholdsTheChoices() {
        let model = makeDecideModel()
        model.competitionMode = true
        XCTAssertEqual(model.roundCardMode, .decide, "the mode machine is legal scaffolding")
        XCTAssertNil(model.decideContent, "EV/club choices are advice — gated like planCaddyAdvice")
    }

    func testNoActiveRoundExposesNoDecideSurface() {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setClubs(makeBag())
        XCTAssertNil(model.decideContent)
        XCTAssertNil(model.workingTarget)
    }

    func testDecideContentMemoisesAcrossRenderReads() throws {
        let model = makeDecideModel()
        _ = model.decideContent
        _ = model.decideContent
        _ = model.decideContent?.choices.first?.triple
        XCTAssertEqual(model.decideBuildCount, 1, "one aim-sweep pass across a render fan-out")

        model.setActiveRound(strokes: [
            OnCourseModel.RoundStroke(holeNumber: 1, position: tee),
            OnCourseModel.RoundStroke(holeNumber: 1, position: offPlanBall),
            OnCourseModel.RoundStroke(holeNumber: 1, position: LatLon(lat: 58.3630, lon: 15.7090)),
        ])
        _ = model.decideContent
        _ = model.decideContent
        XCTAssertLessThanOrEqual(model.decideBuildCount, 2, "a capture invalidates exactly once")
    }

    // MARK: - The shared triple formatter

    func testScoreRiskFormatVocabulary() {
        XCTAssertEqual(
            ScoreRiskFormat.triple(probableScore: 4.1, penaltyShare: 0.01, tailScore: nil),
            "prob. 4.1 · 1% pen"
        )
        XCTAssertEqual(
            ScoreRiskFormat.triple(probableScore: 3.9, penaltyShare: 0.18, tailScore: 5.6),
            "prob. 3.9 · 18% pen, blow-up 5.6"
        )
        XCTAssertEqual(ScoreRiskFormat.penaltyPct(0.004), 0)
        XCTAssertEqual(ScoreRiskFormat.penaltyPct(1), 100)
    }
}
