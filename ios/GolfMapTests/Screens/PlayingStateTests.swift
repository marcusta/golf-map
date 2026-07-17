import XCTest
@testable import GolfMap

/// PlayingState + card context machine (round loop R1–R3, task T31):
/// capture-driven advancement, currentLeg matching against the planned line,
/// the divergence rule, and the card-mode switch the screen renders.
@MainActor
final class PlayingStateTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "PlayingStateTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    /// Hole 1's geometry: default tee → one planned landing → green.
    private let tee = LatLon(lat: 58.3600, lon: 15.7100)
    private let landing = LatLon(lat: 58.3620, lon: 15.7090)
    private let greenCenter = LatLon(lat: 58.3640, lon: 15.7080)

    /// 2-hole synthetic course; hole 1 carries a full green + elevations,
    /// hole 2 exists to prove per-hole re-derivation (and gets no plan).
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

    /// One planned landing (Driver, "Layup") + one gate near it, hole 1 only.
    /// Assembled through the exact `CoursePlan.make` pipeline the cache uses.
    private func makePlan(clubs: [ClubRecord]) -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-1", courseId: "course-1"),
                holes: [GamePlanHoleRecord(
                    id: "ph1", gamePlanId: "plan-1", holeNumber: 1,
                    notes: "Favor the left half off the tee"
                )],
                shots: [PlanShotRecord(
                    id: "ps1", gamePlanHoleId: "ph1", sortOrder: 0,
                    lat: landing.lat, lon: landing.lon,
                    clubId: "c-drv", label: "Layup"
                )],
                gates: [PlanGateRecord(
                    id: "pg1", gamePlanHoleId: "ph1", sortOrder: 0,
                    lat: landing.lat, lon: landing.lon,
                    directionDeg: 340, halfWidthLeftM: 15, halfWidthRightM: 20,
                    source: "manual"
                )]
            ),
            clubs: clubs
        )
    }

    private func makeBag(driverDispersionM: Double = 40) -> [ClubRecord] {
        [ClubRecord(id: "c-drv", name: "Driver", carryM: 230, dispersionM: driverDispersionM, sortOrder: 0)]
    }

    /// Model with the plan installed and a Driver bag (dispersion 40 →
    /// divergence radius max(1.5 × 20, 25) = 30 m at the planned landing).
    private func makeModel(driverDispersionM: Double = 40) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        let bag = makeBag(driverDispersionM: driverDispersionM)
        model.setClubs(bag)
        model.setPlan(makePlan(clubs: bag))
        return model
    }

    private func stroke(_ position: LatLon, hole: Int = 1) -> OnCourseModel.RoundStroke {
        OnCourseModel.RoundStroke(holeNumber: hole, position: position)
    }

    // MARK: - R1: derivation + capture-driven advancement

    func testRoundWithNoStrokesIsOnTheTee() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [])
        let state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.holeNumber, 1)
        XCTAssertEqual(state.strokeIndex, 0)
        XCTAssertNil(state.ballPosition)
        XCTAssertEqual(state.lie, .tee, "stroke 0 lies as tee (R1)")
        XCTAssertEqual(state.activeLine.map(\.id), ["ps1"])
        XCTAssertNil(state.currentLeg)
        XCTAssertEqual(model.roundCardMode, .teePreview)
    }

    func testCaptureAdvancesStrokeIndexAndBallPosition() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee)])
        var state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.strokeIndex, 1)
        XCTAssertEqual(state.ballPosition, tee)

        let nearLanding = LatLon(lat: 58.36205, lon: 15.70905)
        model.setActiveRound(strokes: [stroke(tee), stroke(nearLanding)])
        state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.strokeIndex, 2)
        XCTAssertEqual(state.ballPosition, nearLanding)
    }

    func testGPSNeverMovesThePlayingState() throws {
        // Capture-driven first, GPS-assisted second (R1): a fix update must
        // not change the derived state at all.
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee)])
        let before = try XCTUnwrap(model.playingState)
        model.updateUserLocation(LatLon(lat: 58.3625, lon: 15.7088))
        XCTAssertEqual(model.playingState, before)
    }

    // MARK: - R3: leg matching + divergence

    func testCaptureNearPlannedLandingMatchesTheLeg() throws {
        let model = makeModel()
        let nearLanding = LatLon(lat: 58.36205, lon: 15.70905)
        XCTAssertLessThan(
            Distance.planarMeters(nearLanding, landing), 25,
            "fixture sanity: the capture point sits inside the divergence floor"
        )
        model.setActiveRound(strokes: [stroke(tee), stroke(nearLanding)])
        let state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.currentLeg, 0)
        XCTAssertEqual(
            model.roundCardMode, .plan(legIndex: 2),
            "the leg AFTER the matched landing is your shot (R1)"
        )
    }

    func testCaptureBeyondDivergenceRadiusFlipsToDecide() throws {
        let model = makeModel()
        let wayOff = LatLon(lat: 58.3620, lon: 15.7060)
        XCTAssertGreaterThan(
            Distance.planarMeters(wayOff, landing), 60,
            "fixture sanity: clearly beyond any radius in play"
        )
        model.setActiveRound(strokes: [stroke(tee), stroke(wayOff)])
        let state = try XCTUnwrap(model.playingState)
        XCTAssertNil(state.currentLeg)
        XCTAssertEqual(model.roundCardMode, .decide)
    }

    func testDivergenceRadiusScalesWithThePlannedClubDispersion() throws {
        // ~40 m from the planned landing: outside Driver@40 (radius 30) but
        // inside Driver@80 (radius 60) — 1.5 × dispersion semi-axis, floored
        // at 25 m (R3), keyed to the club that flies the ball to the landing.
        let ball = LatLon(lat: landing.lat + 0.00036, lon: landing.lon)
        let d = Distance.planarMeters(ball, landing)
        XCTAssertTrue((31...59).contains(Int(d)), "fixture sanity: \(d) m between the two radii")

        let tight = makeModel(driverDispersionM: 40)
        tight.setActiveRound(strokes: [stroke(tee), stroke(ball)])
        XCTAssertEqual(tight.roundCardMode, .decide)

        let loose = makeModel(driverDispersionM: 80)
        loose.setActiveRound(strokes: [stroke(tee), stroke(ball)])
        XCTAssertEqual(loose.roundCardMode, .plan(legIndex: 2))
    }

    func testDivergenceFloorAppliesWithoutAPlannedClub() {
        XCTAssertEqual(OnCourseModel.Divergence.radiusM(for: nil), 25)
        let wedge = ClubRecord(id: "c-w", name: "LW", carryM: 80, dispersionM: 10, sortOrder: 0)
        XCTAssertEqual(OnCourseModel.Divergence.radiusM(for: wedge), 25, "floor wins over 7.5 m")
        let driver = ClubRecord(id: "c-d", name: "Driver", carryM: 230, dispersionM: 60, sortOrder: 0)
        XCTAssertEqual(OnCourseModel.Divergence.radiusM(for: driver), 45)
    }

    func testStrokeIndexPastPlannedShotCountFlipsToDecide() throws {
        // 1 landing + the approach = 2 planned strokes; a 3rd capture has
        // passed the plan (R3) even when it matches a landing.
        let model = makeModel()
        let nearLanding = LatLon(lat: 58.36205, lon: 15.70905)
        model.setActiveRound(strokes: [stroke(tee), stroke(nearLanding), stroke(nearLanding)])
        let state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.strokeIndex, 3)
        XCTAssertEqual(model.roundCardMode, .decide)
    }

    func testTeeCaptureKeepsTheTeePreview() throws {
        // The tee shot is captured AT the tee — the ball is exactly where the
        // plan starts, so the nearest-landing distance must not read as
        // divergence; the tee strip (leg 1) stays up.
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee)])
        let state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.strokeIndex, 1)
        XCTAssertNil(state.currentLeg)
        XCTAssertEqual(model.roundCardMode, .teePreview)
    }

    // MARK: - Lie classification

    func testLieClassifiesBallAgainstSurfacesAndDefaultsToRough() throws {
        let model = makeModel()
        let ball = LatLon(lat: 58.36205, lon: 15.70905)
        model.setActiveRound(strokes: [stroke(tee), stroke(ball)])
        XCTAssertEqual(try XCTUnwrap(model.playingState).lie, .rough, "no surface map → rough")

        let c = Sweref99TM.fromWGS84(ball)
        model.setSurfaces([FlatRing(points: [
            Vec2(x: c.x - 20, y: c.y - 20), Vec2(x: c.x + 20, y: c.y - 20),
            Vec2(x: c.x + 20, y: c.y + 20), Vec2(x: c.x - 20, y: c.y + 20),
        ], kind: "fairway")])
        XCTAssertEqual(try XCTUnwrap(model.playingState).lie, .fairway)
    }

    // MARK: - Hole navigation + no-plan holes

    func testHoleChangeRederivesForTheNewHole() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee), stroke(LatLon(lat: 58.36205, lon: 15.70905))])
        XCTAssertEqual(try XCTUnwrap(model.playingState).strokeIndex, 2)

        model.goToHole(number: 2)
        let state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.holeNumber, 2)
        XCTAssertEqual(state.strokeIndex, 0, "hole 2 has no captures yet")
        XCTAssertNil(state.ballPosition)
        XCTAssertTrue(state.activeLine.isEmpty, "hole 2 has no plan")
        XCTAssertNil(model.roundCardMode, "no planned line → today's card, unchanged")

        model.goToHole(number: 1)
        XCTAssertEqual(try XCTUnwrap(model.playingState).strokeIndex, 2)
    }

    func testClearingTheRoundClearsEverything() {
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee)])
        XCTAssertNotNil(model.playingState)
        model.setActiveRound(strokes: nil)
        XCTAssertNil(model.playingState)
        XCTAssertNil(model.roundCardMode)
        XCTAssertNil(model.teePreviewStrip)
    }

    // MARK: - Memoisation (no per-frame recompute)

    func testPlayingStateMemoisesAcrossRenderReads() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee)])
        _ = model.playingState
        _ = model.roundCardMode
        _ = model.teePreviewStrip
        _ = model.playingState
        XCTAssertEqual(model.playingStateBuildCount, 1, "one build across a render fan-out")

        model.setActiveRound(strokes: [stroke(tee), stroke(LatLon(lat: 58.36205, lon: 15.70905))])
        _ = model.playingState
        _ = model.roundCardMode
        XCTAssertEqual(model.playingStateBuildCount, 2, "a capture invalidates exactly once")
    }

    // MARK: - Card content (R2)

    func testTeePreviewStripCarriesThePlanSummary() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [])
        let strip = try XCTUnwrap(model.teePreviewStrip)
        XCTAssertEqual(strip.teeClubName, "Driver")
        XCTAssertNil(strip.suggestedClubName, "a planned club needs no fallback")
        XCTAssertEqual(strip.aimLabel, "Layup")
        let expected = Int(Distance.planarMeters(tee, landing).rounded())
        XCTAssertEqual(strip.firstLegMeters, expected)
        XCTAssertEqual(strip.notes, "Favor the left half off the tee")
        XCTAssertNil(strip.hazardLabel, "no hazards installed")
    }

    func testTeePreviewHazardIsTheFarthestCarryBeforeTheLanding() throws {
        // Two bunkers on the line: one at the player's feet, one mid-leg. The
        // strip must name the mid-leg one — the farthest carry the tee shot
        // still has to clear — not the nearest ring.
        let model = makeModel()
        func box(around ll: LatLon) -> FlatRing {
            let c = Sweref99TM.fromWGS84(ll)
            return FlatRing(points: [
                Vec2(x: c.x - 5, y: c.y - 5), Vec2(x: c.x + 5, y: c.y - 5),
                Vec2(x: c.x + 5, y: c.y + 5), Vec2(x: c.x - 5, y: c.y + 5),
            ], kind: "bunker")
        }
        let atTheTee = box(around: LatLon(lat: 58.3601, lon: 15.70995))
        let midLeg = box(around: LatLon(lat: 58.3615, lon: 15.7092))
        model.setHazards([atTheTee, midLeg], holeIds: ["h1", "h1"])
        model.setActiveRound(strokes: [])

        let strip = try XCTUnwrap(model.teePreviewStrip)
        let carry = try XCTUnwrap(strip.hazardCarryM)
        XCTAssertGreaterThan(carry, 100, "the mid-leg bunker wins, not the one at your feet")
    }

    func testRoundLegCardCarriesTheApproachLeg() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee), stroke(LatLon(lat: 58.36205, lon: 15.70905))])
        XCTAssertEqual(model.roundCardMode, .plan(legIndex: 2))
        let card = try XCTUnwrap(model.roundLegCard(legIndex: 2))
        XCTAssertEqual(card.legIndex, 2)
        XCTAssertEqual(card.legCount, 2)
        XCTAssertTrue(card.toGreen, "leg 2 of a 1-landing plan is the approach")
        XCTAssertNil(card.clubName, "the approach leg has no shot entity")
        XCTAssertEqual(card.gateWidthM, 35, "15 + 20 gate at the leg")
        XCTAssertEqual(card.notes, "Favor the left half off the tee")
        // Distances measure from the model origin (browse tee, no GPS fix).
        let expected = Int(Distance.planarMeters(tee, greenCenter).rounded())
        XCTAssertEqual(card.distanceM, expected)
        XCTAssertNotNil(card.playsAsM, "tee + green elevations are stored → plays-as computes")
        XCTAssertEqual(card.landing, greenCenter)
    }

    func testRoundLegCardOutOfRangeIsNil() {
        let model = makeModel()
        XCTAssertNil(model.roundLegCard(legIndex: 0))
        XCTAssertNil(model.roundLegCard(legIndex: 3), "1 landing → 2 legs")
    }
}
