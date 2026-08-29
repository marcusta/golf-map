import XCTest
@testable import GolfMap

/// RB3 — the reticle-browse state machine on `OnCourseModel`: the per-frame
/// pan snapshot (computed properties), the debounced settle snapshot, and its
/// browse-mode / competition-mode gating.
@MainActor
final class OnCourseReticleTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "OnCourseReticleTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    /// Single-hole course: default tee (elev 10) roughly 460 m south of a
    /// full green (elev 25). Same geometry as the OnCourseModelTests hole 1.
    private func makeFurniture(aims: [AimPointRecord] = []) -> CourseFurniture {
        let course = CourseRecord(
            id: "course-r", name: "Reticle GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "course-r", number: 1, par: 4, strokeIndex: 7)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0)]
        let greens = [GreenRecord(
            id: "g1", holeId: "h1",
            centerLat: 58.3640, centerLon: 15.7080,
            frontLat: 58.3638, frontLon: 15.7080,
            backLat: 58.3642, backLon: 15.7080,
            elevation: 25
        )]
        let manifest = TileManifestRecord(
            courseId: "course-r", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: aims, manifest: manifest
        )
    }

    /// Browse-mode model with a 4-club bag and an instant settle debounce.
    private func makeModel(aims: [AimPointRecord] = []) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(aims: aims), defaults: defaults)
        model.setGPSEnabled(false)
        model.setClubs(bag())
        model.reticleSettleSleep = {}
        return model
    }

    private func bag() -> [ClubRecord] {
        [
            ClubRecord(id: "pw", name: "PW", carryM: 100, dispersionM: 14, sortOrder: 0),
            ClubRecord(id: "8i", name: "8i", carryM: 135, dispersionM: 18, sortOrder: 1),
            ClubRecord(id: "6i", name: "6i", carryM: 160, dispersionM: 22, sortOrder: 2),
            ClubRecord(id: "dr", name: "Dr", carryM: 220, dispersionM: 40, sortOrder: 3),
        ]
    }

    private let tee = LatLon(lat: 58.3600, lon: 15.7100)
    /// ~138 m up the hole from the tee — 8i (135) falls short, 6i (160) reaches.
    private let aim = LatLon(lat: 58.3612, lon: 15.7094)

    private func awaitSettled(_ model: OnCourseModel) async {
        for _ in 0..<200 where model.reticleSettled == nil {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    // MARK: - Pan snapshot

    func testPanUpdatesTargetDistanceClubAndArc() throws {
        let model = makeModel()
        model.reticleMoved(aim, panning: true)

        XCTAssertEqual(model.reticleTarget, aim)
        XCTAssertTrue(model.reticleIsPanning)
        XCTAssertNil(model.reticleSettled, "no settled snapshot while panning")

        let raw = try XCTUnwrap(model.reticlePanDistanceM)
        XCTAssertEqual(raw, Distance.planarMeters(tee, aim), accuracy: 0.01,
                       "raw planar tee→reticle distance, no elevation/wind")
        // ~138 m: PW (100) and 8i (135) fall short → 6i is the first that reaches.
        XCTAssertEqual(model.reticlePanClub?.name, "6i")

        let arc = try XCTUnwrap(model.reticlePanArc)
        XCTAssertEqual(arc.count, 33, "default 32 segments → 33 points")
        // Every arc point sits at the reticle radius from the origin.
        for point in [arc.first!, arc[arc.count / 2], arc.last!] {
            XCTAssertEqual(Distance.planarMeters(tee, point), raw, accuracy: 0.05)
        }
    }

    func testPanBeyondBagFallsBackToLongestClub() {
        let model = makeModel()
        // Green center is ~460 m out — past every carry → longest club.
        model.reticleMoved(LatLon(lat: 58.3640, lon: 15.7080), panning: true)
        XCTAssertEqual(model.reticlePanClub?.name, "Dr")
    }

    // MARK: - Settle

    func testSettleWaitsForDebounceThenProducesSnapshot() async throws {
        let model = makeModel()
        model.elevationSampler = { _ in 40 } // reticle terrain 30 m above the tee
        // Gated sleep: the settle must not fire until the debounce elapses.
        let (stream, gate) = AsyncStream<Void>.makeStream()
        model.reticleSettleSleep = { for await _ in stream { break } }

        model.reticleMoved(aim, panning: true)
        model.reticleMoved(aim, panning: false)
        XCTAssertFalse(model.reticleIsPanning)
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertNil(model.reticleSettled, "idle alone is not enough — the debounce gates the settle")

        gate.yield()
        await awaitSettled(model)
        let settled = try XCTUnwrap(model.reticleSettled)

        let raw = Distance.planarMeters(tee, aim)
        XCTAssertGreaterThan(Double(settled.playsLikeM), raw, "30 m uphill plays longer than raw")
        XCTAssertNotNil(settled.advisedClub)
        XCTAssertFalse(settled.ellipse.isEmpty, "advised club's dispersion ellipse present")
        XCTAssertEqual(
            settled.remainingToGreenM,
            Int(Distance.planarMeters(aim, LatLon(lat: 58.3640, lon: 15.7080)).rounded())
        )
    }

    func testSettleRepicksClubAtPlaysLikeAndDrawsNeighborArcs() async throws {
        let model = makeModel()
        model.elevationSampler = { _ in 40 }
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)
        let settled = try XCTUnwrap(model.reticleSettled)

        // Raw ~138 m picks 6i on pan; +30 m uphill plays past 6i's 160 → Dr.
        XCTAssertEqual(model.reticlePanClub?.name, "6i")
        XCTAssertEqual(settled.advisedClub, "Dr", "settle re-picks at the plays-like distance")

        // Dr sits at the long end of the bag → single (shorter) neighbor arc.
        XCTAssertEqual(settled.neighborArcs.map(\.clubName), ["6i"])
        let arc = try XCTUnwrap(settled.neighborArcs.first)
        XCTAssertEqual(arc.polyline.count, 33)
        // The neighbor arc sits at 6i's plays-like-adjusted ground carry —
        // shorter than its nominal 160 m (uphill eats carry).
        let radius = Distance.planarMeters(tee, arc.polyline[arc.polyline.count / 2])
        XCTAssertLessThan(radius, 160)
        XCTAssertGreaterThan(radius, 100)
    }

    func testNewPanClearsSettledSnapshotAndCancelsPending() async {
        let model = makeModel()
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)
        XCTAssertNotNil(model.reticleSettled)

        // Pan start drops the settled layer immediately.
        let next = LatLon(lat: 58.3620, lon: 15.7090)
        model.reticleMoved(next, panning: true)
        XCTAssertNil(model.reticleSettled)
        XCTAssertTrue(model.reticleIsPanning)
        XCTAssertEqual(model.reticleTarget, next)

        // A pending settle is cancelled by the next pan: idle then immediately
        // pan again — the first settle must never land.
        model.reticleMoved(next, panning: false)
        model.reticleMoved(aim, panning: true)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(model.reticleSettled, "cancelled settle must not resurface")
    }

    func testCompetitionModeKeepsDistancesSuppressesAdvice() async throws {
        let model = makeModel()
        model.competitionMode = true
        model.elevationSampler = { _ in 40 }

        model.reticleMoved(aim, panning: true)
        XCTAssertNotNil(model.reticlePanDistanceM, "raw distance is legal")
        XCTAssertNil(model.reticlePanClub, "dispersion arcs are advice")
        XCTAssertNil(model.reticlePanArc)

        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)
        let settled = try XCTUnwrap(model.reticleSettled)
        XCTAssertNil(settled.advisedClub)
        XCTAssertTrue(settled.ellipse.isEmpty)
        XCTAssertTrue(settled.neighborArcs.isEmpty)
        XCTAssertNil(settled.windHold)
        // Distances stay — and slope stays withheld: plays-like is the raw line.
        XCTAssertEqual(Double(settled.playsLikeM), Distance.planarMeters(tee, aim), accuracy: 0.51)
        XCTAssertNotNil(settled.remainingToGreenM)
    }

    func testReticleInGPSModeMeasuresFromTheLiveFix() throws {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setClubs(bag())
        model.reticleSettleSleep = {}
        XCTAssertFalse(model.isBrowseMode, "fixture defaults to GPS mode")

        // Before a fix locks the reticle falls back to the tee origin — the
        // screen is useful standing on the tee before GPS locks.
        model.reticleMoved(aim, panning: true)
        let fromTee = try XCTUnwrap(model.reticlePanDistanceM)
        XCTAssertEqual(fromTee, Distance.planarMeters(tee, aim), accuracy: 0.01)

        // With a live fix the reticle measures from the player's feet.
        let fix = LatLon(lat: 58.3606, lon: 15.7097)
        model.updateUserLocation(fix)
        model.reticleMoved(aim, panning: true)
        let fromFix = try XCTUnwrap(model.reticlePanDistanceM)
        XCTAssertEqual(fromFix, Distance.planarMeters(fix, aim), accuracy: 0.01,
                       "GPS mode measures from the live fix, not the tee")
        XCTAssertEqual(model.reticleOverlay?.aimLine, [fix, aim])
    }

    func testGPSDriftPastThresholdResettlesButJitterKeepsTheAnswer() async throws {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setClubs(bag())
        model.reticleSettleSleep = {}
        model.elevationSampler = { _ in 40 }
        let fix = LatLon(lat: 58.3606, lon: 15.7097)
        model.updateUserLocation(fix)
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)
        let settled = try XCTUnwrap(model.reticleSettled)

        // ~1 m jitter: settled answer stays put.
        model.updateUserLocation(LatLon(lat: fix.lat + 0.00001, lon: fix.lon))
        XCTAssertEqual(model.reticleSettled, settled, "sub-threshold jitter keeps the snapshot")

        // ~20 m walk: the stale answer drops and a fresh one lands from the
        // new origin (the aim point is unchanged).
        model.updateUserLocation(LatLon(lat: fix.lat + 0.00018, lon: fix.lon))
        await awaitSettled(model)
        let fresh = try XCTUnwrap(model.reticleSettled)
        XCTAssertNotEqual(fresh.playsLikeM, settled.playsLikeM,
                          "settled snapshot re-measured after walking")
    }

    // MARK: - Map overlay assembly (RB4)

    func testReticleOverlayWhilePanningCarriesLinesOnly() throws {
        let model = makeModel()
        model.reticleMoved(aim, panning: true)

        let overlay = try XCTUnwrap(model.reticleOverlay)
        XCTAssertEqual(overlay.aimLine, [tee, aim])
        XCTAssertEqual(overlay.panArc.count, 33)
        XCTAssertTrue(overlay.ellipse.isEmpty, "settled pieces hidden while panning")
        XCTAssertTrue(overlay.neighborArcs.isEmpty)
        XCTAssertNil(overlay.windHold)

        // Dotted extension: past the aim along the bearing, capped at the
        // longest carry past the aim (Dr 220 − raw ~138 ≈ 82 m < remaining).
        let raw = try XCTUnwrap(model.reticlePanDistanceM)
        XCTAssertEqual(overlay.dottedExtension.first, aim)
        let end = try XCTUnwrap(overlay.dottedExtension.last)
        XCTAssertEqual(Distance.planarMeters(aim, end), 220 - raw, accuracy: 0.05)
        XCTAssertEqual(Distance.planarMeters(tee, end), 220, accuracy: 0.05,
                       "extension end sits at the longest club's carry on the aim bearing")

        // The screen-facing overlay state carries the same group.
        XCTAssertEqual(model.overlays.reticle, overlay)
    }

    func testReticleOverlaySettledCarriesAdviceAndArcEndLabels() async throws {
        let model = makeModel()
        model.elevationSampler = { _ in 40 }
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)

        let overlay = try XCTUnwrap(model.reticleOverlay)
        XCTAssertFalse(overlay.ellipse.isEmpty)
        XCTAssertEqual(overlay.neighborArcs.map(\.label), ["6i"])
        XCTAssertFalse(overlay.panArc.isEmpty, "pan arc persists under the settled layer")

        // The neighbor club is named at its arc's END through the shared
        // ellipse-label pipeline.
        let arcEnd = try XCTUnwrap(overlay.neighborArcs.first?.polyline.last)
        let labels = model.overlays.ellipseLabels
        XCTAssertTrue(labels.contains { $0.text == "6i" && $0.boxed && $0.position == arcEnd })

        // …and the ADVISED club is named on its ellipse the same way (no HUD
        // chip), anchored at the ellipse's right edge like the arc labels.
        let settled = try XCTUnwrap(model.reticleSettled)
        let anchor = try XCTUnwrap(settled.ellipseLabelPosition)
        let ellipseLabel = try XCTUnwrap(overlay.ellipseLabel)
        XCTAssertEqual(ellipseLabel.text, "Dr")
        XCTAssertTrue(ellipseLabel.boxed)
        XCTAssertEqual(ellipseLabel.position, anchor)
        XCTAssertTrue(labels.contains { $0.text == "Dr" && $0.boxed && $0.position == anchor })

        // Right of the aim line — the same side the arc labels sit on, so all
        // three club names read in spatial order.
        let o = Sweref99TM.fromWGS84(tee)
        let bearing = Distance.bearingDegrees(tee, try XCTUnwrap(model.reticleTarget))
        let along = bearingToUnitVector(bearing)
        let right = Vec2(x: along.y, y: -along.x)
        let lateral = { (p: LatLon) -> Double in
            let s = Sweref99TM.fromWGS84(p)
            return (s.x - o.x) * right.x + (s.y - o.y) * right.y
        }
        XCTAssertGreaterThan(lateral(anchor), 0)
        XCTAssertGreaterThan(lateral(arcEnd), 0)
        // No point of the ellipse sits farther right than the label anchor.
        for point in settled.ellipse {
            XCTAssertLessThanOrEqual(lateral(point), lateral(anchor) + 1e-6)
        }
    }

    func testCompetitionModeDrawsNoClubLabels() async throws {
        let model = makeModel()
        model.competitionMode = true
        model.elevationSampler = { _ in 40 }
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)

        XCTAssertNil(model.reticleSettled?.ellipseLabelPosition)
        XCTAssertNil(model.reticleOverlay?.ellipseLabel)
        XCTAssertTrue(model.overlays.ellipseLabels.isEmpty, "advice labels are advice")
    }

    // MARK: - Line suppression while the reticle is active

    func testReticleSuppressesRouteAndTappedPointDistanceLines() {
        let model = makeModel()
        // Browse mode without a reticle target: the forward route still draws.
        XCTAssertFalse(model.overlays.distanceLine.isEmpty, "browse forward route draws")

        // …as does the tapped-point line.
        let tap = LatLon(lat: 58.3618, lon: 15.7092)
        model.inspectBrowsePoint(tap)
        XCTAssertEqual(model.overlays.distanceLine, [tee, tap])

        // With the reticle active the aim line owns the screen: neither the
        // tapped-point line nor the forward route is emitted.
        model.reticleMoved(aim, panning: true)
        XCTAssertNotNil(model.overlays.reticle)
        XCTAssertTrue(model.overlays.distanceLine.isEmpty,
                      "reticle aim line is the only line")
        XCTAssertTrue(model.overlays(showRouteLabels: true).routeLegLabels.isEmpty,
                      "no line → no leg labels")
        XCTAssertEqual(model.browseTarget, tap, "the inspected point itself survives")
    }

    func testReticleSuppressesTappedShapeLineButKeepsItsInspection() throws {
        let model = makeModel()
        let bunker = LatLon(lat: 58.3620, lon: 15.7090)
        model.setSurfaces([surfaceBox(bunker, "bunker")])
        XCTAssertTrue(model.inspectTappedFeature(bunker), "the tap hit the bunker")
        XCTAssertFalse(model.overlays.distanceLine.isEmpty, "shape line draws without a reticle")

        model.reticleMoved(aim, panning: true)
        XCTAssertTrue(model.overlays.distanceLine.isEmpty)
        // Inspection itself is untouched: the ring wash and both edge figures stay.
        let feature = try XCTUnwrap(model.overlays.inspectedFeature)
        XCTAssertFalse(feature.ring.isEmpty)
        let carry = try XCTUnwrap(model.inspectedFeature?.carry)
        let labels = model.overlays.ellipseLabels.map(\.text)
        XCTAssertTrue(labels.contains("\(carry.frontM)"))
        XCTAssertTrue(labels.contains("\(carry.carryM)"))
    }

    func testReticleSuppressesSelectedTargetEllipseLabelAndWindHold() throws {
        let model = makeModel()
        // Inspecting a point selects it: the legacy advice ellipse + its
        // "<club> · <carry>" label draw.
        let tap = LatLon(lat: 58.3618, lon: 15.7092)
        model.inspectBrowsePoint(tap)
        XCTAssertNotNil(model.overlays.selectedEllipse, "advice ellipse draws without a reticle")
        let labelText = try XCTUnwrap(model.selectedTargetEllipseLabel?.text)
        XCTAssertTrue(model.overlays.ellipseLabels.contains { $0.text == labelText })

        // With the reticle active its labeled ellipse is the only club answer:
        // the legacy ellipse, its label and the wind hold all yield — a second
        // club label is the round-1 confusion again.
        model.reticleMoved(aim, panning: true)
        XCTAssertNil(model.overlays.selectedEllipse)
        XCTAssertNil(model.overlays.selectedWindHold)
        XCTAssertFalse(model.overlays.ellipseLabels.contains { $0.text == labelText })
        XCTAssertNotNil(model.selectedTargetEllipse,
                        "the selection itself survives — only its drawing yields")
    }

    func testReticleHidesCourseRouteAndPlan() throws {
        let model = makeModel(aims: [aimRecord])
        model.setPlan(makePlan())
        XCTAssertNotEqual(model.overlays.courseRoute, .empty, "route draws without a reticle")
        XCTAssertNotNil(model.overlays.plan, "plan draws without a reticle")

        // The reticle aim line owns the screen: the dashed tee→aim→green route
        // and the violet plan geometry both stand down entirely.
        model.reticleMoved(aim, panning: true)
        XCTAssertNotNil(model.overlays.reticle)
        XCTAssertEqual(model.overlays.courseRoute, .empty)
        XCTAssertNil(model.overlays.plan)
    }

    func testPlannerKeepsPlanVisibleAlongsideReticle() throws {
        let model = makeModel(aims: [aimRecord])
        model.setPlan(makePlan())
        model.enterTool(.plan)
        model.reticleMoved(aim, panning: true)

        // In the planner the reticle is the placement cursor AND the violet
        // plan stays up for editing; the authored route still stands down.
        XCTAssertNotNil(model.overlays.reticle, "the reticle stays live in the planner")
        XCTAssertNotNil(model.overlays.plan, "plan geometry stays visible in the planner")
        XCTAssertEqual(model.overlays.courseRoute, .empty)
    }

    func testPlannerReticleMeasuresFromTheLegStart() throws {
        let model = makeModel()
        model.setPlan(makePlan()) // one planned point up the hole
        model.enterTool(.plan)
        model.reticleMoved(aim, panning: true)

        // The placement leg starts at the LAST plan point, not the hole
        // origin: line, distance and club advice describe the next shot.
        let planPoint = LatLon(lat: 58.3618, lon: 15.7090)
        let overlay = try XCTUnwrap(model.overlays.reticle)
        XCTAssertEqual(overlay.aimLine.first, planPoint)
        let raw = try XCTUnwrap(model.reticlePanDistanceM)
        XCTAssertEqual(raw, Distance.planarMeters(planPoint, aim), accuracy: 0.01)
    }

    // MARK: - Ladder focus (aim visuals for the focused rung)

    /// Aim point ~170 m up the hole — its ladder rung is "aim-0".
    private var aimRecord: AimPointRecord {
        AimPointRecord(id: "a1", holeId: "h1", sortOrder: 0, lat: 58.3615, lon: 15.7092)
    }

    private func makePlan() -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-r", courseId: "course-r",
                                     windSpeedMps: nil, windDirectionDeg: nil),
                holes: [GamePlanHoleRecord(id: "ph1", gamePlanId: "plan-r", holeNumber: 1, teeId: "t1")],
                shots: [PlanShotRecord(id: "s1", gamePlanHoleId: "ph1", sortOrder: 0,
                                       lat: 58.3618, lon: 15.7090, clubId: "dr")],
                gates: []
            ),
            clubs: bag()
        )
    }

    func testLadderFocusShowsDottedLineEllipseAndAdvice() throws {
        let model = makeModel(aims: [aimRecord])
        let row = try XCTUnwrap(model.ladderRows.first { $0.id == "aim-0" })
        let position = try XCTUnwrap(row.position)
        model.inspectBrowseLadder(row)

        // The focused rung owns the aim: a dotted origin→target line plus the
        // recommended club's ellipse + label — no reticle line/arc alongside.
        let overlay = try XCTUnwrap(model.overlays.reticle)
        XCTAssertEqual(overlay.dottedExtension, [tee, position])
        XCTAssertTrue(overlay.aimLine.isEmpty)
        XCTAssertTrue(overlay.panArc.isEmpty)
        XCTAssertTrue(overlay.neighborArcs.isEmpty)
        XCTAssertFalse(overlay.ellipse.isEmpty, "advised club's dispersion ellipse")
        XCTAssertNotNil(overlay.ellipseLabel)

        // The banner names the same club, and the route/plan stay hidden.
        XCTAssertNotNil(model.selectedTargetAdvice?.club)
        XCTAssertEqual(model.overlays.courseRoute, .empty)
    }

    func testLadderFocusSurvivesCenteringAnimationReleasesOnUserPan() throws {
        let model = makeModel(aims: [aimRecord])
        let row = try XCTUnwrap(model.ladderRows.first { $0.id == "aim-0" })
        model.inspectBrowseLadder(row)

        // The focus animation reports through `reticleMoved` — pans before the
        // camera goes idle must NOT release the fresh focus.
        model.reticleMoved(aim, panning: true)
        XCTAssertEqual(model.focusedLadderId, "aim-0")
        XCTAssertNotNil(model.overlays.reticle?.ellipseLabel, "focus visuals hold")

        // Camera idle: focus still holds (the user has not taken the map back).
        model.reticleMoved(aim, panning: false)
        XCTAssertEqual(model.focusedLadderId, "aim-0")

        // First pan AFTER idle is the user: focus releases, the reticle's own
        // aim line takes over.
        let next = LatLon(lat: 58.3620, lon: 15.7090)
        model.reticleMoved(next, panning: true)
        XCTAssertNil(model.focusedLadderId)
        let overlay = try XCTUnwrap(model.overlays.reticle)
        XCTAssertEqual(overlay.aimLine, [tee, next])
        XCTAssertTrue(overlay.dottedExtension.first != tee || overlay.dottedExtension.isEmpty,
                      "the focused dotted origin line is gone")
    }

    // MARK: - Browse-mode tap: no point inspects, tap works the card

    func testBrowseOpenMapTapNeverInspectsAPoint() {
        let model = makeModel()
        let open = LatLon(lat: 58.3618, lon: 15.7092)
        XCTAssertFalse(model.handleDistanceTap(open),
                       "falls through so the screen toggles the distance card")
        XCTAssertNil(model.browseTarget, "no tapped dot next to the reticle")
        XCTAssertNil(model.overlays.highlight)
    }

    func testBrowseTapStillInspectsShapesThenDismisses() {
        let model = makeModel()
        let bunker = LatLon(lat: 58.3620, lon: 15.7090)
        model.setSurfaces([surfaceBox(bunker, "bunker")])
        XCTAssertTrue(model.handleDistanceTap(bunker), "shape inspect is kept")
        XCTAssertNotNil(model.inspectedFeature)

        // Second tap inside the same shape: browse has no aim-point
        // conversion (the reticle is the aim) — it dismisses instead.
        XCTAssertTrue(model.handleDistanceTap(bunker), "dismisses the inspection")
        XCTAssertNil(model.inspectedFeature)
        XCTAssertNil(model.browseTarget)

        let open = LatLon(lat: 58.3618, lon: 15.7092)
        XCTAssertFalse(model.handleDistanceTap(open), "nothing up → card toggle")
    }

    func testGPSReticleSuppressesTheForwardRouteLine() {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setClubs(bag())
        let fix = LatLon(lat: 58.3605, lon: 15.7098)
        model.updateUserLocation(fix)
        XCTAssertFalse(model.overlays.distanceLine.isEmpty, "GPS forward route draws")

        // Reticle engages in GPS mode too (round 3); while it is up, the aim
        // line replaces the forward route.
        model.reticleMoved(aim, panning: true)
        XCTAssertNotNil(model.overlays.reticle)
        XCTAssertTrue(model.overlays.distanceLine.isEmpty)
        XCTAssertEqual(model.overlays.reticle?.aimLine, [fix, aim])
    }

    func testReticleOverlayNilBeforeFirstMove() {
        let gps = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        gps.setClubs(bag())
        XCTAssertNil(gps.reticleOverlay, "no reticle target yet (GPS mode)")
        XCTAssertNil(gps.overlays.reticle)

        let browse = makeModel()
        XCTAssertNil(browse.reticleOverlay, "no reticle target yet (browse mode)")
    }

    func testBrowseOriginMovesTheReticleOrigin() throws {
        let model = makeModel()
        let origin = LatLon(lat: 58.3615, lon: 15.7092)
        model.setBrowseOrigin(origin)
        let target = LatLon(lat: 58.3625, lon: 15.7088)
        model.reticleMoved(target, panning: true)
        let raw = try XCTUnwrap(model.reticlePanDistanceM)
        XCTAssertEqual(raw, Distance.planarMeters(origin, target), accuracy: 0.01,
                       "distance measured from the browse origin, not the tee")
    }

    func testBrowseOriginChangeDropsStaleSettledSnapshotAndResettles() async throws {
        let model = makeModel()
        model.elevationSampler = { _ in 40 }
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)
        let stale = try XCTUnwrap(model.reticleSettled)

        // "From here" moves the origin under an engaged reticle: the aim is
        // re-SET to the new origin's default (D-HF1) — never inherited — and
        // the stale settled answer must not linger.
        let origin = LatLon(lat: 58.3615, lon: 15.7092)
        model.setBrowseOrigin(origin)
        XCTAssertNotEqual(model.reticleTarget, aim, "aim re-defaults from the new origin")
        await awaitSettled(model)
        let fresh = try XCTUnwrap(model.reticleSettled)
        XCTAssertNotEqual(fresh.playsLikeM, stale.playsLikeM,
                          "settled snapshot re-measured from the new origin")

        // Origin ON the aim: the default resolver takes over — the green is
        // now within the longest carry, so the aim snaps to the green center
        // (never a zero-length line) and a fresh settle lands there.
        model.setBrowseOrigin(model.reticleTarget!)
        XCTAssertNil(model.reticleSettled, "stale snapshot dropped immediately")
        await awaitSettled(model)
        let target = try XCTUnwrap(model.reticleTarget)
        XCTAssertEqual(target.lat, 58.3640, accuracy: 1e-6)
        XCTAssertEqual(target.lon, 15.7080, accuracy: 1e-6)
        XCTAssertNotNil(model.reticleSettled, "fresh settle lands at the default aim")
    }

    func testResetBrowseOriginDropsStaleSettledSnapshotAndResettles() async throws {
        let model = makeModel()
        model.elevationSampler = { _ in 40 }
        let origin = LatLon(lat: 58.3615, lon: 15.7092)
        model.setBrowseOrigin(origin)
        model.reticleMoved(aim, panning: false)
        await awaitSettled(model)
        let fromOrigin = try XCTUnwrap(model.reticleSettled)

        // "From tee" (reset) moves the origin back — same D-HF1 rule as
        // "From here": the aim re-defaults from the tee and the settled
        // answer re-measures there.
        model.resetBrowseOrigin()
        XCTAssertNil(model.browseOrigin)
        XCTAssertNotEqual(model.reticleTarget, aim, "aim re-defaults from the tee")
        await awaitSettled(model)
        let fromTee = try XCTUnwrap(model.reticleSettled)
        XCTAssertNotEqual(fromTee.playsLikeM, fromOrigin.playsLikeM,
                          "settled snapshot re-measured from the tee")
    }

    // MARK: - Default aim on hole/origin change (D-HF1 + D-HF2, slice 1)

    /// Two-hole course: hole 1 = the fixture hole; hole 2 = a short par 3
    /// (~189 m, within the Dr 220 carry even uphill) north of it.
    private func makeTwoHoleModel() -> OnCourseModel {
        let course = CourseRecord(
            id: "course-r", name: "Reticle GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-r", number: 1, par: 4, strokeIndex: 7),
            HoleRecord(id: "h2", courseId: "course-r", number: 2, par: 3, strokeIndex: 15),
        ]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2", holeId: "h2", name: "default", lat: 58.3640, lon: 15.7100, elevation: 10, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: 58.3640, centerLon: 15.7080,
                frontLat: 58.3638, frontLon: 15.7080,
                backLat: 58.3642, backLon: 15.7080,
                elevation: 25
            ),
            GreenRecord(
                id: "g2", holeId: "h2",
                centerLat: 58.3657, centerLon: 15.7100,
                frontLat: 58.3655, frontLon: 15.7100,
                backLat: 58.3659, backLon: 15.7100,
                elevation: 25
            ),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-r", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let furniture = CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
        let model = OnCourseModel(furniture: furniture, defaults: defaults)
        model.setGPSEnabled(false)
        model.setClubs(bag())
        model.reticleSettleSleep = {}
        return model
    }

    func testHoleChangeResetsAnEngagedAimToTheNewHoleDefault() throws {
        let model = makeTwoHoleModel()
        model.reticleMoved(aim, panning: true) // parked aim on hole 1

        model.goToHole(number: 2)

        // The aim is SET in world coordinates from the resolver — never
        // inherited from the previous hole. Hole 2 is a short par 3 within
        // the longest carry → the default is its green center (D-HF1 rule 2).
        let target = try XCTUnwrap(model.reticleTarget)
        XCTAssertNotEqual(target, aim, "aim state does not survive hole change")
        XCTAssertEqual(target.lat, 58.3657, accuracy: 1e-6)
        XCTAssertEqual(target.lon, 15.7100, accuracy: 1e-6)
        XCTAssertEqual(model.reticleTarget, model.defaultAimTarget,
                       "the parked aim is exactly the resolver's answer")
    }

    func testHoleChangeEngagesADisengagedReticleGatedUntilSettle() {
        let model = makeTwoHoleModel()
        XCTAssertNil(model.reticleOverlay)

        model.goToHole(number: 2)

        // D-HF3/D-HF4 (slice 2): hole entry ENGAGES the reticle at the
        // world-coordinate default aim, and nothing reticle-shaped draws
        // until the entry camera settles. The pending reticle already owns
        // the lines: the forward route, authored route and plan never flash
        // during the flight — the hole opens straight into the reticle.
        XCTAssertEqual(model.reticleTarget, model.defaultAimTarget)
        XCTAssertTrue(model.reticleAwaitingEntrySettle)
        XCTAssertNil(model.reticleOverlay, "reticle overlays hidden while the camera flies")
        XCTAssertTrue(model.overlays.distanceLine.isEmpty,
                      "no forward-route flash during the entry flight")
        XCTAssertEqual(model.overlays.courseRoute, .empty,
                       "no authored-route flash during the entry flight")
        XCTAssertNil(model.overlays.plan, "no plan flash during the entry flight")
    }

    func testFirstGPSFixResetsAnEngagedAimToTheDefault() {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setClubs(bag())
        model.reticleSettleSleep = {}
        // Pre-fix the reticle measures from the tee; park an aim there.
        model.reticleMoved(aim, panning: true)
        XCTAssertEqual(model.reticleTarget, aim)

        // The first adopted fix moves the origin under the aim: the aim is
        // re-SET from the resolver at the new origin, not inherited.
        model.updateUserLocation(LatLon(lat: 58.3606, lon: 15.7097))
        XCTAssertNotEqual(model.reticleTarget, aim, "aim re-defaults on GPS adoption")
        XCTAssertEqual(model.reticleTarget, model.defaultAimTarget)
    }

    // MARK: - Hole-entry framing (D-HF3 + D-HF4, slice 2)

    func testEntryAnimationFramesNeverMoveTheAim() {
        let model = makeTwoHoleModel()
        model.goToHole(number: 2)
        let worldAim = model.reticleTarget

        // Camera-animation frames arrive as panning reports with mid-flight
        // anchor unprojections — the screenshot bug class. Ignored entirely.
        model.reticleMoved(LatLon(lat: 58.3500, lon: 15.7000), panning: true)
        model.reticleMoved(LatLon(lat: 58.3620, lon: 15.7150), panning: true)

        XCTAssertEqual(model.reticleTarget, worldAim, "aim stays the world default")
        XCTAssertFalse(model.reticleIsPanning)
        XCTAssertTrue(model.reticleAwaitingEntrySettle)
        XCTAssertNil(model.reticleOverlay)
    }

    func testFirstSettleRendersFromTheWorldDefaultAim() async throws {
        let model = makeTwoHoleModel()
        model.goToHole(number: 2)
        let worldAim = try XCTUnwrap(model.defaultAimTarget)

        // The camera lands: the idle report's anchor unprojection is CLOSE to
        // but not exactly the aim (zoom clamps legitimately leave the aim
        // off-anchor) — the settle must use the world aim, not the report.
        model.reticleMoved(LatLon(lat: 58.3655, lon: 15.7097), panning: false)
        await awaitSettled(model)

        XCTAssertEqual(model.reticleTarget, worldAim,
                       "settled from the world default aim, not the screen anchor")
        XCTAssertFalse(model.reticleAwaitingEntrySettle)
        XCTAssertNotNil(model.reticleSettled)
        let overlay = try XCTUnwrap(model.reticleOverlay, "overlays render at first settle")
        XCTAssertEqual(overlay.aimLine.last, worldAim)
    }

    func testUserPanAfterSettleResumesScreenAnchorDerivation() async throws {
        let model = makeTwoHoleModel()
        model.goToHole(number: 2)
        model.reticleMoved(LatLon(lat: 58.3657, lon: 15.7100), panning: false)
        await awaitSettled(model)

        // First user pan after the entry settle: the reticle follows the
        // screen anchor again.
        let panned = LatLon(lat: 58.3650, lon: 15.7090)
        model.reticleMoved(panned, panning: true)
        XCTAssertEqual(model.reticleTarget, panned)
        XCTAssertTrue(model.reticleIsPanning)
        XCTAssertNil(model.reticleSettled, "pan-start drops the settled layer")
    }

    func testUserPanAfterCameraLandsButBeforeSettleLiftsTheGate() {
        let model = makeTwoHoleModel()
        model.goToHole(number: 2)

        // The camera reported idle, the 200 ms settle is pending — a user
        // grab in that window takes over immediately (the pending settle is
        // stale and must not land).
        model.reticleMoved(LatLon(lat: 58.3657, lon: 15.7100), panning: false)
        let panned = LatLon(lat: 58.3648, lon: 15.7088)
        model.reticleMoved(panned, panning: true)

        XCTAssertFalse(model.reticleAwaitingEntrySettle)
        XCTAssertEqual(model.reticleTarget, panned)
        XCTAssertNil(model.reticleSettled)
    }

    func testSameHoleReselectReissuesTheEntryCamera() async throws {
        let model = makeTwoHoleModel()
        model.goToHole(number: 2)
        let firstToken = try XCTUnwrap(model.cameraCommand).token
        model.reticleMoved(LatLon(lat: 58.3657, lon: 15.7100), panning: false)
        await awaitSettled(model)

        // Park the aim somewhere else, then re-select hole 2.
        model.reticleMoved(LatLon(lat: 58.3650, lon: 15.7090), panning: true)
        model.goToHole(number: 2)

        let reissued = try XCTUnwrap(model.cameraCommand)
        XCTAssertEqual(reissued.token, firstToken + 1, "token bump re-applies the frame")
        XCTAssertEqual(model.reticleTarget, model.defaultAimTarget)
        XCTAssertTrue(model.reticleAwaitingEntrySettle)
        XCTAssertNil(model.reticleOverlay)
    }

    func testHoleEntryCameraIsSolvedNotFitted() throws {
        let model = makeTwoHoleModel()
        model.mapViewportSize = CGSize(width: 390, height: 844)
        model.distanceCameraInsets = MapEdgeInsets(top: 60, left: 8, bottom: 260, right: 8)

        model.goToHole(number: 2)

        let command = try XCTUnwrap(model.cameraCommand)
        guard case .center(let center, let zoom) = command.target else {
            return XCTFail("hole entry issues a solved .center command, got \(command.target)")
        }

        // Parity with the pure solver at the model's own inputs: origin =
        // hole 2 tee, aim = green 2 center, dispersion = the advised club's
        // half-width at the raw distance.
        let tee2 = LatLon(lat: 58.3640, lon: 15.7100)
        let aim2 = try XCTUnwrap(model.defaultAimTarget)
        let rawM = Distance.planarMeters(tee2, aim2)
        let club = try XCTUnwrap(BrowseReticle.panClub(clubs: bag(), distanceM: rawM))
        let expected = try XCTUnwrap(AnchoredCameraSolve.solve(AnchoredCameraSolve.Input(
            origin: tee2,
            aim: aim2,
            viewportWidth: 390,
            viewportHeight: 844,
            insets: MapEdgeInsets(top: 60, left: 8, bottom: 260, right: 8),
            aimAnchorYFraction: Double(CourseMapView.Coordinator.reticleAnchorYFraction),
            minZoom: OnCourseModel.holeEntryMinZoom,
            maxZoom: OnCourseModel.holeEntryMaxZoom,
            dispersionHalfWidthM: BrowseReticle.lateralHalfWidthM(club: club, atDistanceM: rawM)
        )))
        XCTAssertEqual(center.lat, expected.center.lat, accuracy: 1e-9)
        XCTAssertEqual(center.lon, expected.center.lon, accuracy: 1e-9)
        XCTAssertEqual(zoom, expected.zoom, accuracy: 1e-9)
        XCTAssertEqual(command.bearing, expected.bearing, accuracy: 1e-9)
        // Hole 2 runs due (true) north — first-shot-up ≈ grid north, off by
        // the SWEREF meridian convergence at lon 15.71 (~0.6° here).
        let northError = min(command.bearing, 360 - command.bearing)
        XCTAssertEqual(northError, 0, accuracy: 1.5)
    }

    // MARK: - First hole on course open (D-HF5 slice-3 gap fix)

    func testFirstHoleFramesOnceTheViewportIsMeasured() throws {
        let model = makeTwoHoleModel()
        // Pre-layout: no viewport, so the entry solve stands down and the
        // reticle is still down (nothing to inherit — slice 1).
        XCTAssertNil(model.reticleTarget)
        guard case .bounds = try XCTUnwrap(model.cameraCommand).target else {
            return XCTFail("pre-layout still uses the hole-bounds fit")
        }

        // First measured layout: hole ONE never passes through
        // `holeDidChange`, so this is what routes it through the same entry
        // path — solved camera + engaged default aim, gated until settle.
        model.mapViewportSize = CGSize(width: 390, height: 844)

        XCTAssertEqual(model.reticleTarget, model.defaultAimTarget,
                       "hole one enters with the D-HF1 default aim engaged")
        XCTAssertTrue(model.reticleAwaitingEntrySettle)
        XCTAssertNil(model.reticleOverlay, "overlays stay hidden until settle")
        XCTAssertEqual(model.holeEntrySolveOrigin, model.origin)
        let command = try XCTUnwrap(model.cameraCommand)
        guard case .center = command.target else {
            return XCTFail("expected the anchored solve, got \(command.target)")
        }
    }

    func testFirstHoleFramingRunsOnceAndNeverReframesOnResize() throws {
        let model = makeTwoHoleModel()
        model.mapViewportSize = CGSize(width: 390, height: 844)
        let token = try XCTUnwrap(model.cameraCommand).token

        // Let the entry camera land, grab the map, then let the viewport
        // re-measure (rotation / chrome relayout): the catch-up is a ONE-shot,
        // so nothing re-frames and the user's aim survives.
        model.reticleMoved(LatLon(lat: 58.3615, lon: 15.7092), panning: false)
        let parked = LatLon(lat: 58.3610, lon: 15.7095)
        model.reticleMoved(parked, panning: true)
        model.mapViewportSize = CGSize(width: 390, height: 800)

        XCTAssertEqual(model.reticleTarget, parked, "no re-entry framing on resize")
        XCTAssertEqual(model.cameraCommand?.token, token, "no new camera command")
    }

    func testHoleEntryCameraFallsBackToHoleFitWithoutViewport() throws {
        let model = makeTwoHoleModel()
        // No measured viewport yet (pre-layout): the solve stands down.
        model.goToHole(number: 2)
        let command = try XCTUnwrap(model.cameraCommand)
        guard case .bounds = command.target else {
            return XCTFail("expected the hole-bounds fit fallback, got \(command.target)")
        }
    }

    func testOriginChangeDuringEntryFlightRestartsFramingKeepsGate() {
        let model = makeTwoHoleModel()
        model.mapViewportSize = CGSize(width: 390, height: 844)
        model.goToHole(number: 2)
        XCTAssertTrue(model.reticleAwaitingEntrySettle)

        // "From here" mid-flight (an origin change): the solve re-freezes
        // from the new origin and the settle gate stays up.
        let newOrigin = LatLon(lat: 58.3645, lon: 15.7100)
        model.setBrowseOrigin(newOrigin)

        XCTAssertTrue(model.reticleAwaitingEntrySettle)
        XCTAssertEqual(model.holeEntrySolveOrigin, newOrigin)
        XCTAssertEqual(model.reticleTarget, model.defaultAimTarget)
        XCTAssertNil(model.reticleOverlay)
    }

    // MARK: - Screen glue (RB5)

    private let green = LatLon(lat: 58.3640, lon: 15.7080)

    func testReticleRemainingToGreenIsRawAimToGreen() throws {
        let model = makeModel()
        model.reticleMoved(aim, panning: true)
        let remaining = try XCTUnwrap(model.reticleRemainingToGreenM)
        XCTAssertEqual(
            Double(remaining), Distance.planarMeters(aim, green), accuracy: 0.51,
            "pan-state remaining is the raw planar aim→green-center distance"
        )
    }

    func testReticleRemainingToGreenNilWithoutTarget() {
        XCTAssertNil(makeModel().reticleRemainingToGreenM, "no reticle target yet")
    }

    func testAddReticlePlanTargetAppendsShotAtAimAndShowsPlan() throws {
        let model = makeModel()
        model.setPlanVisible(false)
        model.reticleMoved(aim, panning: true)

        model.addReticlePlanTarget()

        let shot = try XCTUnwrap(model.planEditShots.last, "a plan point was appended")
        XCTAssertEqual(shot.position, aim)
        // ~138 m raw leg → the closest-carry auto club, same as placePlanShot.
        XCTAssertEqual(shot.clubName, "8i")
        XCTAssertTrue(model.planVisible, "the new point must be visible immediately")
    }

    func testAddReticlePlanTargetNoOpsWithoutTarget() {
        let model = makeModel()
        model.addReticlePlanTarget()
        XCTAssertTrue(model.planEditShots.isEmpty, "no reticle target yet")

        // GPS mode adds at the aim point too (the chip shows in both modes).
        let gps = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        gps.setClubs(bag())
        gps.reticleMoved(aim, panning: true)
        gps.addReticlePlanTarget()
        XCTAssertEqual(gps.planEditShots.last?.position, aim)
    }

    func testAddPlanShotAtReticleRequiresPlannerTool() {
        let model = makeModel()
        model.reticleMoved(aim, panning: true)
        model.addPlanShotAtReticle()
        XCTAssertTrue(model.planEditShots.isEmpty, "not in the plan tool")
    }

    func testAddPlanShotAtReticleAppendsAtAimAndRebasesTheLeg() throws {
        let model = makeModel()
        model.enterTool(.plan)
        model.reticleMoved(aim, panning: true)

        model.addPlanShotAtReticle()

        let shot = try XCTUnwrap(model.planEditShots.last, "a plan point was appended")
        XCTAssertEqual(shot.position, aim)
        // The reticle origin moves onto the point just placed — the aim line
        // now describes the NEXT leg.
        let overlay = try XCTUnwrap(model.overlays.reticle)
        XCTAssertEqual(overlay.aimLine.first, aim)
    }

    func testToggleReticleDistanceModeFlipsAndPersists() {
        let model = makeModel()
        XCTAssertFalse(model.reticleShowsActual, "plays-like is the default")

        model.toggleReticleDistanceMode()
        XCTAssertTrue(model.reticleShowsActual)

        // A fresh model on the same defaults inherits the choice.
        XCTAssertTrue(makeModel().reticleShowsActual, "preference persists")
        model.toggleReticleDistanceMode()
        XCTAssertFalse(makeModel().reticleShowsActual)
    }

    // MARK: - No snap-to on settle

    private let greenCenter = LatLon(lat: 58.3640, lon: 15.7080)

    func testSettleNeverCapturesANearbyRung() async throws {
        let model = makeModel()
        // ~10 m north of the green center — well inside what the old 24 pt
        // magnetic radius would have captured. The aim must stay put.
        let near = LatLon(lat: 58.36409, lon: 15.7080)
        model.reticleMoved(near, panning: false, metersPerPoint: 1.0)
        await awaitSettled(model)

        XCTAssertEqual(model.reticleTarget, near, "the aim stays exactly where the pan stopped")
        XCTAssertNotEqual(model.reticleTarget, greenCenter)
        XCTAssertEqual(
            model.reticleSettled?.remainingToGreenM,
            Int(Distance.planarMeters(near, greenCenter).rounded()),
            "the settled snapshot measures the actual stop point"
        )
    }

    private func surfaceBox(_ center: LatLon, _ kind: String) -> FlatRing {
        let c = Sweref99TM.fromWGS84(center)
        return FlatRing(points: [
            Vec2(x: c.x - 5, y: c.y - 5), Vec2(x: c.x + 5, y: c.y - 5),
            Vec2(x: c.x + 5, y: c.y + 5), Vec2(x: c.x - 5, y: c.y + 5),
        ], kind: kind)
    }

    // MARK: - Camera (RB6)

    func testCameraCommandCarriesTeeGreenBearingAndHoleFitInsets() throws {
        let model = makeModel()
        let command = try XCTUnwrap(model.cameraCommand)
        XCTAssertEqual(
            command.bearing, Distance.bearingDegrees(tee, greenCenter), accuracy: 1e-9,
            "hole fit points tee→green up"
        )
        XCTAssertEqual(command.padding, OnCourseModel.holeFitPadding)
        XCTAssertEqual(command.insets, .zero, "no insets before the screen measures the map")

        model.holeFitInsets = MapEdgeInsets(top: 140)
        XCTAssertEqual(model.cameraCommand?.insets, MapEdgeInsets(top: 140))
    }

    func testReticleFitInsetsPlaceGreenAtAnchor() {
        let insets = CourseMapView.Coordinator.reticleFitInsets(mapHeight: 800, padding: 70)
        // Content top = padding + inset.top = 0.30 × height → the anchor line.
        XCTAssertEqual(insets.top, 800 * 0.30 - 70, accuracy: 1e-9)
        XCTAssertEqual(insets.bottom, 0)
        XCTAssertEqual(insets.left, 0)
        XCTAssertEqual(insets.right, 0)
        XCTAssertEqual(
            CourseMapView.Coordinator.reticleFitInsets(mapHeight: 100, padding: 70).top, 0,
            "never negative on tiny viewports"
        )
    }
}
