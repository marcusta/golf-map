import XCTest
@testable import GolfMap

/// Headless view-model tests for the on-course putt read (task D4, doc
/// feature-putting-green-reading §4/§5.1): Tier-2 reads over a synthetic
/// tilted terrain grid (AnalysisGridTests conventions), stimp behavior +
/// persistence, competition-mode gating, the no-grid → Manual fallback, and
/// Tier-3 manual Tour Read parity with the Strategy core.
@MainActor
final class PuttReadModelTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "PuttReadModelTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    /// A synthetic 20 × 20 m sampled grid tilted 2% down toward EAST
    /// (h = −0.02·e): a putt due north breaks right. All cells inside, no
    /// nodata — the same synthetic-sampler spirit as AnalysisGridTests.
    private func tiltedGrid(slopeEastPct: Double = 2) -> SampleGrid {
        let width = 40, height = 40
        let res = 0.5
        let spec = AnalysisGridSpec(
            originE: 0, originN: Double(height) * res,
            resolution: res, width: width, height: height
        )
        var heights = [Double](repeating: 0, count: width * height)
        for row in 0..<height {
            for col in 0..<width {
                let e = (Double(col) + 0.5) * res
                heights[row * width + col] = -slopeEastPct / 100 * e
            }
        }
        return SampleGrid(
            spec: spec,
            heights: heights,
            insideMask: [Bool](repeating: true, count: width * height)
        )
    }

    private func armedModel(grid: SampleGrid?) -> PuttReadModel {
        let model = PuttReadModel(defaults: defaults)
        model.activate(grid: grid, defaultHole: Vec2(x: 10, y: 12))
        return model
    }

    /// 6 m putt due north across the east-tilt: ball (10, 6) → hole (10, 12).
    private let ball = Vec2(x: 10, y: 6)

    // MARK: - Tier 2: surface read on a tilted grid

    func testPlaceBallProducesSoftenedReadWithVerbalAlwaysAlongside() throws {
        let model = armedModel(grid: tiltedGrid())
        XCTAssertEqual(model.display.status, .place, "hole defaulted, ball missing")

        model.placeBall(ball)
        model.computeSurfaceReadNow()
        let display = model.display

        // Terrain-tile confidence (0.45) is below the 0.5 read budget: the
        // read shows but SOFTENED — never a confident read from weak data.
        XCTAssertEqual(display.status, .soft)
        let read = try XCTUnwrap(display.read)
        XCTAssertEqual(read.availability, .ok)
        XCTAssertEqual(read.minConfidence, PuttReadGeometry.TERRAIN_TILE_DEM_CONFIDENCE)
        XCTAssertNotNil(display.message, "softened read carries a warning line")

        // Downhill east + putt north = ball breaks right → aim LEFT (negative).
        XCTAssertLessThan(read.aimOffsetM, 0)
        XCTAssertGreaterThanOrEqual(read.path.count, 2, "break path rendered")

        // Tour Read verbal ALWAYS shown alongside the exact tier (doc §5.1).
        let tour = try XCTUnwrap(display.tour)
        XCTAssertEqual(tour.breakSide, .right, "surface falls right, so the putt breaks right")
        let verbal = try XCTUnwrap(display.verbal)
        XCTAssertTrue(verbal.aim.contains("left"), "verbal names the side to aim on")
        XCTAssertFalse(verbal.pace.isEmpty)

        let profile = try XCTUnwrap(display.profile)
        XCTAssertEqual(profile.distanceM, 6, accuracy: 1e-9)
        XCTAssertEqual(profile.elevationDeltaM, 0, accuracy: 1e-9)
        XCTAssertEqual(profile.stations.count, 1, "6 m is split into two equal sections")
        XCTAssertEqual(profile.stations[0].slopePct, 2, accuracy: 1e-9)
        XCTAssertEqual(model.overlay?.stations.count, 1)
    }

    func testFlatGridReadsStraight() throws {
        let model = armedModel(grid: tiltedGrid(slopeEastPct: 0))
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        let read = try XCTUnwrap(model.display.read)
        XCTAssertEqual(read.aimOffsetM, 0, accuracy: 0.02)
        XCTAssertEqual(model.display.tour?.breakSide, .straight)
    }

    func testStimpChangeRecomputesWithMoreBreakOnFasterGreen() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)

        model.setStimp(8)
        model.computeSurfaceReadNow()
        let slow = try XCTUnwrap(model.display.read)

        model.setStimp(13)
        model.computeSurfaceReadNow()
        let fast = try XCTUnwrap(model.display.read)

        XCTAssertGreaterThan(
            abs(fast.aimOffsetM), abs(slow.aimOffsetM),
            "faster green must break more"
        )
        XCTAssertGreaterThan(
            fast.playsLikeM, slow.playsLikeM,
            "same putt rolls out farther on a faster green"
        )
    }

    func testStimpChangeInvalidatesSettledReadUntilRecompute() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.read)

        model.setStimp(12)
        // Signature diverged — the stale read must fall away, not linger.
        XCTAssertEqual(model.display.status, .pending)
        XCTAssertNil(model.display.read)
    }

    // MARK: - Placement / drag

    func testHandleTapPlacesBallThenHoleTargetAutoReverts() throws {
        let model = armedModel(grid: tiltedGrid())
        XCTAssertEqual(model.hole, Vec2(x: 10, y: 12), "hole defaults to the pin")
        XCTAssertNil(model.ball)

        model.handleTap(ball)
        XCTAssertEqual(model.ball, ball, "tap places the ball")

        model.setPlaceTarget(.hole)
        model.handleTap(Vec2(x: 11, y: 13))
        XCTAssertEqual(model.hole, Vec2(x: 11, y: 13), "hole is re-tappable")
        XCTAssertEqual(model.placeTarget, .ball, "hole placement auto-reverts")
    }

    func testDragUpdatesLiveMarkerWithoutReadThenCommitSettles() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.read)

        model.dragBall(Vec2(x: 9, y: 5))
        XCTAssertEqual(model.ball, Vec2(x: 9, y: 5))
        XCTAssertEqual(model.display.status, .pending, "stale read fell away mid-drag")
        let overlay = try XCTUnwrap(model.overlay)
        XCTAssertTrue(overlay.path.isEmpty, "no path mid-drag")
        XCTAssertEqual(overlay.reference.count, 2, "reference line stays live")

        model.commitDrag()
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.read, "commit recomputes over settled inputs")
    }

    // MARK: - Availability honesty

    func testBallOffGridWithholdsRead() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(Vec2(x: -50, y: -50)) // far outside the grid
        model.computeSurfaceReadNow()
        let display = model.display
        XCTAssertEqual(display.status, .unavailable)
        XCTAssertNil(display.read, "withheld — no numbers at all")
        XCTAssertNil(display.tour)
        XCTAssertNotNil(display.message)
    }

    // MARK: - Training-quiz ground truth (`Display.groundTruth`, doc §5.1)
    //
    // `groundTruth` is the single gate `PuttQuizModel.quizActive(groundTruth:)`
    // checks — non-nil ONLY for a live Surface-tier read (ok or soft), nil
    // everywhere else (place/pending/unavailable/manual/competition). These
    // cases double as the competition-gating proof for the quiz: the model
    // has no separate competition awareness, it just relies on this field.

    func testGroundTruthPresentForSettledSurfaceRead() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        let display = model.display
        XCTAssertEqual(display.status, .soft)
        let truth = try XCTUnwrap(display.groundTruth, "live soft read must expose a ground truth")
        let read = try XCTUnwrap(display.read)
        XCTAssertEqual(truth.aimOffsetM, read.aimOffsetM)
        XCTAssertEqual(truth.playsLikeM, read.playsLikeM)
        XCTAssertEqual(truth.breakSide, display.tour?.breakSide)
    }

    func testGroundTruthNilBeforeBallPlaced() throws {
        let model = armedModel(grid: tiltedGrid())
        XCTAssertEqual(model.display.status, .place)
        XCTAssertNil(model.display.groundTruth)
    }

    func testGroundTruthNilWhilePending() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.groundTruth)

        model.setStimp(12) // invalidates the settled read → .pending
        XCTAssertEqual(model.display.status, .pending)
        XCTAssertNil(model.display.groundTruth, "stale/pending read must not quiz-gate")
    }

    func testGroundTruthNilWhenUnavailable() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(Vec2(x: -50, y: -50))
        model.computeSurfaceReadNow()
        XCTAssertEqual(model.display.status, .unavailable)
        XCTAssertNil(model.display.groundTruth)
    }

    func testGroundTruthNilInManualMode() throws {
        let model = armedModel(grid: nil)
        XCTAssertEqual(model.display.mode, .manual)
        XCTAssertNotNil(model.display.tour, "manual still has a Tour Read...")
        XCTAssertNil(model.display.groundTruth, "...but no independent truth to quiz against")
    }

    func testGroundTruthNilInCompetitionMode() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.groundTruth, "live outside competition")

        model.competitionMode = true
        XCTAssertEqual(model.display.status, .competition)
        XCTAssertNil(model.display.groundTruth, "quiz is advice-adjacent — off in competition")
    }

    // MARK: - Putt signature (`puttSignature`, quiz reset trigger)

    func testPuttSignatureChangesWithBallHoleAndStimp() throws {
        let model = armedModel(grid: tiltedGrid())
        let base = model.puttSignature

        model.placeBall(ball)
        let afterBall = model.puttSignature
        XCTAssertNotEqual(base, afterBall)

        model.setPlaceTarget(.hole)
        model.handleTap(Vec2(x: 11, y: 13))
        let afterHole = model.puttSignature
        XCTAssertNotEqual(afterBall, afterHole)

        model.setStimp(13)
        let afterStimp = model.puttSignature
        XCTAssertNotEqual(afterHole, afterStimp)
    }

    func testPuttSignatureStableAcrossUnrelatedStateChanges() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        let before = model.puttSignature

        // Recomputing the read, or toggling competition mode, must not
        // perturb the putt signature — only ball/hole/stimp do.
        model.computeSurfaceReadNow()
        XCTAssertEqual(model.puttSignature, before)

        model.competitionMode = true
        XCTAssertEqual(model.puttSignature, before)
        model.competitionMode = false
    }

    // MARK: - Competition gating

    func testCompetitionModeWithholdsBothTiers() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.read)

        model.competitionMode = true
        let display = model.display
        XCTAssertEqual(display.status, .competition)
        XCTAssertNil(display.read)
        XCTAssertNil(display.tour)
        XCTAssertNil(display.verbal)
        XCTAssertNotNil(display.message, "one-line reads-off note")
        XCTAssertNil(model.overlay, "no read rendering on the map either")

        // The manual tier is gated too — switching modes must not leak a read.
        model.setMode(.manual)
        XCTAssertEqual(model.display.status, .competition)
        XCTAssertNil(model.display.tour)
    }

    func testCompetitionModeOffRestoresReads() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.competitionMode = true
        XCTAssertEqual(model.display.status, .competition)

        model.competitionMode = false
        model.computeSurfaceReadNow()
        XCTAssertNotNil(model.display.read)
    }

    // MARK: - No grid → Manual fallback

    func testNoGridFallsBackToManualAutomatically() throws {
        let model = armedModel(grid: nil)
        XCTAssertFalse(model.hasSurface)
        XCTAssertEqual(model.mode, .manual, "manual offered automatically")
        let display = model.display
        XCTAssertEqual(display.mode, .manual)
        XCTAssertNotNil(display.tour, "manual read works with no data at all")

        model.setMode(.surface)
        XCTAssertEqual(model.mode, .manual, "surface tier refused without a grid")
    }

    func testGridArrivalSwitchesToSurface() throws {
        let model = armedModel(grid: nil)
        XCTAssertEqual(model.mode, .manual)
        model.installGrid(tiltedGrid())
        XCTAssertEqual(model.mode, .surface)
        XCTAssertTrue(model.hasSurface)
        XCTAssertEqual(model.hole, Vec2(x: 10, y: 12), "markers survive a grid install")
    }

    // MARK: - Tier 3: manual Tour Read parity

    func testManualPacesFormMatchesStrategyCore() throws {
        let model = armedModel(grid: nil)
        model.setManualLengthUnit(.paces)
        model.setManualLength(10)
        model.setManualSlopePct(2)
        model.setManualGradePct(0)
        model.setManualBreakToRight(true)
        model.setStimp(10)

        let expected = tourReadFromPaces(
            10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10, breakToRight: true
        )
        let display = model.display
        XCTAssertEqual(display.status, .ok)
        XCTAssertEqual(display.tour, expected)
        // Tour Read arithmetic: (10 paces × 2 − 1) × 2% = 38 in at stimp 10.
        XCTAssertEqual(display.tour?.aimInches ?? 0, 38, accuracy: 1e-9)
        XCTAssertEqual(display.verbal, formatTourRead(expected, units: .metric))
    }

    func testManualMetersFormMatchesPacesForm() throws {
        let model = armedModel(grid: nil)
        model.setManualLengthUnit(.meters)
        model.setManualLength(10 * PACE_METERS) // exactly 10 paces
        model.setManualSlopePct(2)
        model.setManualGradePct(0)
        model.setManualBreakToRight(false)
        model.setStimp(10)

        let expected = tourReadFromPaces(
            10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10, breakToRight: false
        )
        XCTAssertEqual(model.display.tour!.aimInches, expected.aimInches, accuracy: 1e-9)
        XCTAssertEqual(model.display.tour!.breakSide, .left)
    }

    func testManualGradePercentConvertsToDeltaMeters() throws {
        let model = armedModel(grid: nil)
        model.setManualLengthUnit(.meters)
        model.setManualLength(10)
        model.setManualSlopePct(0)
        model.setManualGradePct(2) // +2% over 10 m = +0.2 m uphill
        model.setStimp(10)

        let expected = tourRead(
            distanceM: 10, gradeDeltaM: 0.2, slopePct: 0, stimpFt: 10, breakToRight: true
        )
        XCTAssertEqual(
            model.display.tour!.playsLikeMeters, expected.playsLikeMeters, accuracy: 1e-9
        )
        XCTAssertGreaterThan(model.display.tour!.playsLikeMeters, 10, "uphill plays longer")
    }

    func testManualCantStopDownhillSurfacesTheMessage() throws {
        let model = armedModel(grid: nil)
        model.setManualLengthUnit(.meters)
        model.setManualLength(5)
        model.setManualSlopePct(0)
        model.setManualGradePct(-8) // steep downhill: Δh/μ ≪ −D at stimp 12
        model.setStimp(12)

        let display = model.display
        XCTAssertEqual(display.tour?.canStop, false)
        XCTAssertEqual(display.status, .soft)
        XCTAssertNotNil(display.message)
        XCTAssertTrue(display.verbal!.pace.contains("lag"), "verbal carries the warning")
    }

    // MARK: - Stimp persistence + clamping

    func testStimpDefaultsTo10AndPersists() throws {
        let model = PuttReadModel(defaults: defaults)
        XCTAssertEqual(model.stimpFt, 10)
        model.setStimp(12)
        let reloaded = PuttReadModel(defaults: defaults)
        XCTAssertEqual(reloaded.stimpFt, 12)
    }

    func testStimpClampsTo4Through16() throws {
        let model = PuttReadModel(defaults: defaults)
        model.setStimp(99)
        XCTAssertEqual(model.stimpFt, 16)
        model.setStimp(1)
        XCTAssertEqual(model.stimpFt, 4)
    }

    // MARK: - Default-stimp seeding (Settings § default stimp)

    /// No persisted value yet — the Settings default is the seed.
    func testDefaultStimpFtSeedsWhenNothingPersisted() throws {
        let model = PuttReadModel(defaults: defaults, defaultStimpFt: 12)
        XCTAssertEqual(model.stimpFt, 12)
    }

    /// The bare `PuttReadModel(defaults:)` call (used throughout the rest of
    /// this file and by `CompetitionModeTests`) must keep seeding 10 — the
    /// new parameter has a default so existing call sites are unaffected.
    func testDefaultStimpFtParameterDefaultsToTen() throws {
        let model = PuttReadModel(defaults: defaults)
        XCTAssertEqual(model.stimpFt, 10)
    }

    /// A persisted last-used stimp always wins over the seed — the seed only
    /// applies to a fresh install / first-ever read.
    func testPersistedStimpWinsOverDifferentSeed() throws {
        let first = PuttReadModel(defaults: defaults, defaultStimpFt: 10)
        first.setStimp(9)
        let second = PuttReadModel(defaults: defaults, defaultStimpFt: 14)
        XCTAssertEqual(second.stimpFt, 9, "persisted last-used value overrides the seed")
    }

    /// The seed itself is clamped to the same 4–16 range as everything else
    /// (defensive — `AppSettings.defaultStimpFt` already clamps on its own
    /// read, but PuttReadModel shouldn't trust a caller blindly).
    func testDefaultStimpFtSeedClampsToValidRange() throws {
        // init() only reads defaults (never writes), so two constructions
        // over the same still-empty suite are independent seed trials.
        let high = PuttReadModel(defaults: defaults, defaultStimpFt: 99)
        XCTAssertEqual(high.stimpFt, 16)

        let low = PuttReadModel(defaults: defaults, defaultStimpFt: 1)
        XCTAssertEqual(low.stimpFt, 4)
    }

    // MARK: - Overlay

    func testOverlayShowsDefaultHoleMarkerBeforeBallPlaced() throws {
        let model = armedModel(grid: tiltedGrid())
        let overlay = try XCTUnwrap(model.overlay)
        XCTAssertNil(overlay.ball)
        XCTAssertNotNil(overlay.hole)
        XCTAssertTrue(overlay.reference.isEmpty)
        XCTAssertTrue(overlay.path.isEmpty)
    }

    func testOverlayCarriesPathAimAndSoftFlagWhenSettled() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        let overlay = try XCTUnwrap(model.overlay)
        XCTAssertNotNil(overlay.ball)
        XCTAssertNotNil(overlay.hole)
        XCTAssertNotNil(overlay.aim)
        XCTAssertGreaterThanOrEqual(overlay.path.count, 2)
        XCTAssertEqual(overlay.reference.count, 2)
        XCTAssertTrue(overlay.soft, "terrain-tile confidence renders softened")
    }

    func testOverlayNilInManualMode() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.setMode(.manual)
        XCTAssertNil(model.overlay)
    }

    // MARK: - E1 seam (Tier-1 scanned surface)

    func testScannedSurfaceOverridesDemAndReadsConfident() throws {
        // DEM says 2% east-tilt; a fresh full-confidence scan says flat.
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertEqual(model.display.status, .soft, "terrain-tile read is softened")

        model.installScannedSurface(PlaneSurface(slopePct: 0, fallLineBearingDeg: 0))
        model.computeSurfaceReadNow()
        let display = model.display
        XCTAssertEqual(display.status, .ok, "confident scan is not softened")
        let read = try XCTUnwrap(display.read)
        XCTAssertEqual(read.minConfidence, 1)
        XCTAssertEqual(read.aimOffsetM, 0, accuracy: 0.02, "scan's flat surface won")

        // Scan cleared → falls back to the DEM tier.
        model.installScannedSurface(nil)
        model.computeSurfaceReadNow()
        XCTAssertEqual(model.display.status, .soft)
        XCTAssertLessThan(try XCTUnwrap(model.display.read).aimOffsetM, 0)
    }

    // MARK: - Per-green calibration (the read side of the scan round-trip)

    /// A well-calibrated green's agreement confidence replaces the conservative
    /// terrain-tile default and lifts the read across the read budget, so it
    /// stops being softened (doc §4.2).
    func testCalibrationConfidenceUnsoftensTheRead() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertEqual(model.display.status, .soft, "uncalibrated terrain-tile read is softened")

        model.applyCalibration(GreenCalibration(
            greenId: "g1", confidence: 0.667, sampleCount: 2, bias: nil
        ))
        model.computeSurfaceReadNow()
        let display = model.display
        XCTAssertEqual(display.status, .ok, "calibration confidence crosses MIN_READ_CONFIDENCE")
        let read = try XCTUnwrap(display.read)
        XCTAssertEqual(read.minConfidence, 0.667, accuracy: 1e-9)
        XCTAssertEqual(model.calibrationNote, "Calibrated · 2 scans")
    }

    /// A calibrated-but-low-confidence green stays softened — the read is still
    /// honest — but the panel still explains it is calibrated.
    func testLowCalibrationConfidenceStillSoftensButShowsNote() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.applyCalibration(GreenCalibration(
            greenId: "g1", confidence: 0.3, sampleCount: 1, bias: nil
        ))
        model.computeSurfaceReadNow()
        XCTAssertEqual(model.display.status, .soft)
        XCTAssertEqual(try XCTUnwrap(model.display.read).minConfidence, 0.3, accuracy: 1e-9)
        XCTAssertEqual(model.calibrationNote, "Calibrated · 1 scan")
    }

    /// The fitted bias corrects the DEM gradient (corrected ∇h = ∇h + tilt) and
    /// changes the read. Over-correcting the grid's 2% east slope flips the
    /// downhill (and the break) to the other side — an unambiguous sign change.
    func testBiasCorrectionShiftsTheRead() throws {
        let model = armedModel(grid: tiltedGrid()) // 2% down east → breaks right
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertLessThan(try XCTUnwrap(model.display.read).aimOffsetM, 0, "breaks right → aim left")
        XCTAssertEqual(model.display.tour?.breakSide, .right)

        // gradX = −0.02; a +0.04 east tilt → corrected gradX = +0.02, so the
        // surface now falls WEST and the ball breaks LEFT (aim right).
        model.applyCalibration(GreenCalibration(
            greenId: "g1", confidence: 0.667, sampleCount: 2,
            bias: GreenBias(tiltE: 0.04, tiltN: 0)
        ))
        model.computeSurfaceReadNow()
        let read = try XCTUnwrap(model.display.read)
        XCTAssertGreaterThan(read.aimOffsetM, 0, "bias flips the break to the other side")
        XCTAssertEqual(model.display.tour?.breakSide, .left)
    }

    /// No calibration (uncalibrated green) is a strict no-op: the read behaves
    /// exactly as the bare terrain tiles do, and no badge is shown.
    func testMissingCalibrationIsANoOp() throws {
        let baseline = armedModel(grid: tiltedGrid())
        baseline.placeBall(ball)
        baseline.computeSurfaceReadNow()
        let baselineRead = try XCTUnwrap(baseline.display.read)

        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.applyCalibration(nil)
        model.computeSurfaceReadNow()
        let read = try XCTUnwrap(model.display.read)

        XCTAssertEqual(read.minConfidence, PuttReadGeometry.TERRAIN_TILE_DEM_CONFIDENCE)
        XCTAssertEqual(model.display.status, .soft)
        XCTAssertEqual(read.aimOffsetM, baselineRead.aimOffsetM, accuracy: 1e-12, "identical to no calibration")
        XCTAssertNil(model.calibrationNote)
    }

    func testCalibrationNoteHiddenInCompetitionMode() throws {
        let model = armedModel(grid: tiltedGrid())
        model.applyCalibration(GreenCalibration(
            greenId: "g1", confidence: 0.667, sampleCount: 3, bias: nil
        ))
        XCTAssertEqual(model.calibrationNote, "Calibrated · 3 scans")

        model.competitionMode = true
        XCTAssertNil(model.calibrationNote, "the whole read section is off in competition")
    }

    /// Calibration is per-green, so re-arming for a new green must clear it —
    /// the screen re-applies the right green's calibration on entry.
    func testActivateClearsCalibration() throws {
        let model = armedModel(grid: tiltedGrid())
        model.applyCalibration(GreenCalibration(
            greenId: "g1", confidence: 0.667, sampleCount: 2, bias: nil
        ))
        XCTAssertNotNil(model.calibrationNote)

        model.activate(grid: tiltedGrid(), defaultHole: Vec2(x: 10, y: 12))
        XCTAssertNil(model.calibrationNote, "re-arming a new green drops the old calibration")
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        XCTAssertEqual(
            try XCTUnwrap(model.display.read).minConfidence,
            PuttReadGeometry.TERRAIN_TILE_DEM_CONFIDENCE
        )
    }

    /// A fresh Tier-1 scan surface overrides the DEM AND its calibration bias —
    /// the scan is ground truth, not something the DEM bias should perturb.
    func testScannedSurfaceIgnoresCalibrationBias() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.applyCalibration(GreenCalibration(
            greenId: "g1", confidence: 0.667, sampleCount: 2,
            bias: GreenBias(tiltE: 0.05, tiltN: 0.05) // large bias the scan must ignore
        ))
        model.installScannedSurface(PlaneSurface(slopePct: 0, fallLineBearingDeg: 0))
        model.computeSurfaceReadNow()
        let read = try XCTUnwrap(model.display.read)
        XCTAssertEqual(read.minConfidence, 1, "scan confidence, not the calibration's")
        XCTAssertEqual(read.aimOffsetM, 0, accuracy: 0.02, "flat scan won; DEM bias not applied")
    }

    func testDeactivateDropsState() throws {
        let model = armedModel(grid: tiltedGrid())
        model.placeBall(ball)
        model.computeSurfaceReadNow()
        model.deactivate()
        XCTAssertNil(model.ball)
        XCTAssertNil(model.hole)
        XCTAssertFalse(model.hasSurface)
        XCTAssertNil(model.overlay)
    }
}
