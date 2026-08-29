import XCTest
@testable import GolfMap

/// `OnCourseModel`'s planner-tool editing: the drag cadence (cheap geometry per
/// frame, aim-enrichment only on release), auto-club on placement, and removal.
/// The persistence sink is a spy `PlanEditWriter` — the DB/sync path is covered
/// by `GamePlanEditStoreTests` / `PlanSyncTests`.
@MainActor
final class PlanEditModelTests: XCTestCase {

    /// Thread-safe capture of the writer calls (the closures are `@Sendable`).
    private final class WriterSpy: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var adds = 0
        private(set) var moves = 0
        private(set) var removes = 0
        private(set) var clubSets = 0
        private(set) var setPrimaries = 0
        private(set) var lastAddClubId: String?
        private(set) var lastAddParentShotId: String?
        private(set) var lastAddSortOrder: Int?
        /// Wind writes, in order: (holeNumber — nil for the plan-level wind,
        /// speed, direction). A nil speed/direction pair is a clear.
        private(set) var windWrites: [(holeNumber: Int?, speedMps: Double?, directionDeg: Double?)] = []
        func add(_ clubId: String?, parentShotId: String?, sortOrder: Int) {
            lock.lock()
            adds += 1
            lastAddClubId = clubId
            lastAddParentShotId = parentShotId
            lastAddSortOrder = sortOrder
            lock.unlock()
        }
        func move() { lock.lock(); moves += 1; lock.unlock() }
        func remove() { lock.lock(); removes += 1; lock.unlock() }
        func setClub() { lock.lock(); clubSets += 1; lock.unlock() }
        func setPrimary() { lock.lock(); setPrimaries += 1; lock.unlock() }
        func wind(_ holeNumber: Int?, _ speedMps: Double?, _ directionDeg: Double?) {
            lock.lock(); windWrites.append((holeNumber, speedMps, directionDeg)); lock.unlock()
        }
        func winds() -> [(holeNumber: Int?, speedMps: Double?, directionDeg: Double?)] {
            lock.lock(); defer { lock.unlock() }; return windWrites
        }
    }

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "PlanEditModelTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private let clubs: [ClubRecord] = [
        ClubRecord(id: "dr", name: "Driver", carryM: 235, dispersionM: 40, sortOrder: 0),
        ClubRecord(id: "7i", name: "7 iron", carryM: 155, dispersionM: 25, sortOrder: 1),
        ClubRecord(id: "pw", name: "PW", carryM: 115, dispersionM: 20, sortOrder: 2),
    ]

    private func makeModel(spy: WriterSpy) -> OnCourseModel {
        let course = CourseRecord(
            id: "course-1", name: "Testville GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 7)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, sortOrder: 0)]
        let greens = [GreenRecord(id: "g1", holeId: "h1", centerLat: 58.3660, centerLon: 15.7100)]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let model = OnCourseModel(
            furniture: CourseFurniture(
                course: course, holes: holes, tees: tees, greens: greens,
                pins: [], aimPoints: [], manifest: manifest
            ),
            defaults: defaults
        )
        model.setClubs(clubs)
        model.planWriter = OnCourseModel.PlanEditWriter(
            addShot: { _, _, sortOrder, parentShotId, _, _, _, clubId in
                spy.add(clubId, parentShotId: parentShotId, sortOrder: sortOrder)
            },
            moveShot: { _, _, _, _ in spy.move() },
            setShotClub: { _, _ in spy.setClub() },
            removeShot: { _ in spy.remove() },
            setPrimaryShot: { _ in spy.setPrimary() },
            setPlanWind: { speed, direction in spy.wind(nil, speed, direction) },
            setHoleWind: { hole, speed, direction in spy.wind(hole, speed, direction) }
        )
        return model
    }

    /// Lets the model's fire-and-forget persistence Tasks run.
    private func drainTasks() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    // MARK: - Tests

    func testAddShotAutoClubsFromLegPlaysLike() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        // Aim ~150 m up the hole from the tee (roughly a 7-iron leg) and
        // place at the reticle.
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        let p = Sweref99TM.fromWGS84(tee)
        let placement = Sweref99TM.toWGS84(x: p.x, y: p.y + 150)
        model.reticleMoved(placement, panning: true)
        model.addPlanShotAtReticle()

        let shots = model.planEditShots
        XCTAssertEqual(shots.count, 1)

        // Independently compute the expected closest club to the leg distance.
        let legDist = Distance.planarMeters(tee, placement)
        let expected = clubs.min { abs($0.carryM - legDist) < abs($1.carryM - legDist) }
        XCTAssertEqual(shots[0].clubId, expected?.id)
        XCTAssertEqual(model.selectedPlanShotId, shots[0].id)

        await drainTasks()
        XCTAssertEqual(spy.adds, 1)
        XCTAssertEqual(spy.lastAddClubId, expected?.id)
    }

    func testDragUpdatesGeometryPerFrameWithoutEnrichingThenEnrichesOnDrop() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        let p = Sweref99TM.fromWGS84(tee)
        model.reticleMoved(Sweref99TM.toWGS84(x: p.x, y: p.y + 150), panning: true)
        model.addPlanShotAtReticle()
        await drainTasks()
        let shotId = try XCTUnwrap(model.planEditShots.first).id
        let handle = OnCourseModel.planShotHandleID(shotId)

        // Prime the aim-enrichment memo.
        _ = model.planOverlay
        let enrichAfterPrime = model.strategyEnrichCount
        XCTAssertGreaterThan(enrichAfterPrime, 0)
        let movesBefore = spy.moves

        // Drag frames: pure geometry, no enrichment, no persistence.
        model.beginPlanShotDrag(handleID: handle)
        for dy in stride(from: 152.0, through: 160.0, by: 2.0) {
            model.movePlanShot(handleID: handle, to: Sweref99TM.toWGS84(x: p.x, y: p.y + dy))
            let overlay = model.planOverlay
            XCTAssertNotNil(overlay, "geometry follows the finger")
            XCTAssertTrue(overlay?.ghosts.isEmpty ?? true, "no ghost aim mid-drag")
        }
        XCTAssertEqual(model.strategyEnrichCount, enrichAfterPrime,
                       "aim enrichment never runs on the per-frame drag path")
        XCTAssertEqual(spy.moves, movesBefore, "no persistence per frame")

        // Drop: re-enrich (one pass) + persist once.
        model.endPlanShotDrag(handleID: handle)
        _ = model.planOverlay
        XCTAssertEqual(model.strategyEnrichCount, enrichAfterPrime + 1,
                       "release re-enriches exactly once")
        await drainTasks()
        XCTAssertEqual(spy.moves, movesBefore + 1, "drop persists once")
    }

    func testRemoveShot() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        let p = Sweref99TM.fromWGS84(tee)
        model.reticleMoved(Sweref99TM.toWGS84(x: p.x, y: p.y + 150), panning: true)
        model.addPlanShotAtReticle()
        await drainTasks()
        let shotId = try XCTUnwrap(model.planEditShots.first).id

        model.selectPlanShot(handleID: OnCourseModel.planShotHandleID(shotId))
        XCTAssertEqual(model.selectedPlanShotId, shotId)
        model.removeSelectedPlanShot()

        XCTAssertTrue(model.planEditShots.isEmpty, "shot removed from the local plan")
        XCTAssertNil(model.selectedPlanShotId, "selection cleared")
        await drainTasks()
        XCTAssertEqual(spy.removes, 1)
    }

    // MARK: - Smart caddy wiring

    /// Places a shot far enough up the hole that the shot→green leg is an
    /// approach, primes the aim memo, and returns the model + shot id.
    private func modelWithApproachShot(spy: WriterSpy) async throws -> (OnCourseModel, String) {
        let model = makeModel(spy: spy)
        model.enterTool(.plan)
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        let p = Sweref99TM.fromWGS84(tee)
        model.reticleMoved(Sweref99TM.toWGS84(x: p.x, y: p.y + 150), panning: true)
        model.addPlanShotAtReticle()
        await drainTasks()
        _ = model.planOverlay // prime the aim-enrichment memo (legPlans)
        let shotId = try XCTUnwrap(model.planEditShots.first).id
        return (model, shotId)
    }

    func testPlanCaddyAdviceFiresAndHidesInCompetition() async throws {
        let spy = WriterSpy()
        let (model, _) = try await modelWithApproachShot(spy: spy)

        let advice = model.planCaddyAdvice
        XCTAssertFalse(advice.isEmpty, "the approach leg to the green yields caddy advice")
        XCTAssertTrue(advice.contains { $0.ruleId == "specific-target" },
                      "specific-target commits the approach line")

        model.competitionMode = true
        XCTAssertTrue(model.planCaddyAdvice.isEmpty, "advice is withheld in competition mode")
    }

    func testAdvisedClubDiffersFromWrongClubAndApplies() async throws {
        let spy = WriterSpy()
        let (model, shotId) = try await modelWithApproachShot(spy: spy)

        // Force a wrong club; the wind/plays-like advised club should differ.
        model.setPlanShotClub(shotId: shotId, clubId: "dr")
        let advised = try XCTUnwrap(model.advisedClub(forShotId: shotId))
        XCTAssertEqual(advised.id, "7i", "a ~150 m leg → 7 iron is the plays-like fit")
        XCTAssertNotEqual(advised.id, "dr")

        // Applying the chip sets the shot's club.
        model.setPlanShotClub(shotId: shotId, clubId: advised.id)
        XCTAssertEqual(model.planEditShots.first?.clubId, "7i")
    }

    func testApplyRecommendedAimMovesTheSelectedShot() async throws {
        let spy = WriterSpy()
        let (model, shotId) = try await modelWithApproachShot(spy: spy)
        let before = try XCTUnwrap(model.planEditShots.first).position

        model.selectPlanShot(handleID: OnCourseModel.planShotHandleID(shotId))
        XCTAssertTrue(model.selectedShotHasRecommendedAim,
                      "the selected shot has a recommended aim line")

        let movesBefore = spy.moves
        model.applyRecommendedAimForSelectedShot()
        let after = try XCTUnwrap(model.planEditShots.first).position
        XCTAssertNotEqual(before, after, "the shot snaps onto the recommended aim landing point")
        await drainTasks()
        XCTAssertEqual(spy.moves, movesBefore + 1, "the snap persists once")
    }

    func testSetPlanShotClubPersists() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        let p = Sweref99TM.fromWGS84(tee)
        model.reticleMoved(Sweref99TM.toWGS84(x: p.x, y: p.y + 150), panning: true)
        model.addPlanShotAtReticle()
        await drainTasks()
        let shotId = try XCTUnwrap(model.planEditShots.first).id

        model.setPlanShotClub(shotId: shotId, clubId: "dr")
        XCTAssertEqual(model.planEditShots.first?.clubId, "dr")
        XCTAssertEqual(model.planEditShots.first?.clubName, "Driver")
        await drainTasks()
        XCTAssertEqual(spy.clubSets, 1)
    }

    // MARK: - Option trees (shot alternatives)

    private let tee = LatLon(lat: 58.3600, lon: 15.7100)

    private func place(_ model: OnCourseModel, dy: Double, dx: Double = 0) {
        let p = Sweref99TM.fromWGS84(tee)
        model.reticleMoved(Sweref99TM.toWGS84(x: p.x + dx, y: p.y + dy), panning: true)
    }

    /// "Add option" places a SIBLING of the selected shot (same parent, next
    /// sortOrder) — not a continuation.
    func testAddOptionPlacesSiblingOfSelectedShot() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle() // P1, selected
        let first = try XCTUnwrap(model.planEditShots.first)
        XCTAssertEqual(model.selectedPlanShotId, first.id)

        place(model, dy: 120, dx: 40)
        model.addPlanOptionAtReticle() // sibling of P1 (tee root)

        let all = model.plan?.allShots(holeNumber: 1) ?? []
        XCTAssertEqual(all.count, 2)
        let option = try XCTUnwrap(all.first { $0.id != first.id })
        XCTAssertEqual(option.parentShotId, first.parentShotId, "same parent — a true sibling")
        XCTAssertEqual(option.sortOrder, 1, "appended after the existing option")
        XCTAssertEqual(model.selectedPlanShotId, option.id, "the new option is selected")

        await drainTasks()
        XCTAssertEqual(spy.adds, 2)
        XCTAssertEqual(spy.lastAddSortOrder, 1)
        XCTAssertNil(spy.lastAddParentShotId, "root sibling — parent is the tee")
    }

    /// "Add at aim" with a selection continues FROM the selected shot (child),
    /// so building a branch is: select the option, then add continuations.
    func testAddAtAimContinuesFromSelectedShot() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle()
        let first = try XCTUnwrap(model.planEditShots.first)

        place(model, dy: 280)
        model.addPlanShotAtReticle() // child of the selected first shot

        let all = model.plan?.allShots(holeNumber: 1) ?? []
        let child = try XCTUnwrap(all.first { $0.id != first.id })
        XCTAssertEqual(child.parentShotId, first.id)
        await drainTasks()
        XCTAssertEqual(spy.lastAddParentShotId, first.id)
        XCTAssertEqual(spy.lastAddSortOrder, 0, "first child of its parent")
    }

    /// Sibling groups label as P<depth>A/P<depth>B; single options stay plain
    /// P<depth>. Branch rows are marked and offer "make primary".
    func testTreeLabelsAndRowFlags() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle() // P1A-to-be (rank 0)
        place(model, dy: 120, dx: 40)
        model.addPlanOptionAtReticle() // P1B (rank 1), now selected
        place(model, dy: 240, dx: 40)
        model.addPlanShotAtReticle() // P2 under the branch option

        let rows = model.planEditRows
        XCTAssertEqual(rows.map(\.label), ["P1A", "P1B", "P2"])
        XCTAssertEqual(rows.map(\.isBranch), [false, true, true],
                       "rank-0 root is the primary line; the B option and its continuation are branch")
        XCTAssertEqual(rows.map(\.canMakePrimary), [false, true, false],
                       "only a non-primary option in a sibling group can be promoted")
    }

    /// Set-primary reorders the sibling group: the promoted option becomes the
    /// primary line (and its continuation with it), labels swap, writer pushes.
    func testSetPrimaryPromotesOptionAndItsContinuation() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle()
        place(model, dy: 120, dx: 40)
        model.addPlanOptionAtReticle()
        place(model, dy: 240, dx: 40)
        model.addPlanShotAtReticle() // continuation of the B option
        let bOption = try XCTUnwrap(model.planEditRows.first { $0.label == "P1B" })

        model.setPrimaryPlanShot(id: bOption.shotId)

        let rows = model.planEditRows
        let promoted = try XCTUnwrap(rows.first { $0.shotId == bOption.shotId })
        XCTAssertEqual(promoted.label, "P1A", "rank 0 now")
        XCTAssertEqual(rows.map(\.isBranch).filter { $0 }.count, 1,
                       "only the demoted option remains a branch")
        let primaryLine = model.plan?.shots(holeNumber: 1) ?? []
        XCTAssertEqual(primaryLine.count, 2,
                       "the primary-line projection follows the promoted option + its continuation")
        XCTAssertEqual(primaryLine.first?.id, bOption.shotId)
        await drainTasks()
        XCTAssertEqual(spy.setPrimaries, 1)
    }

    /// The branch trash removes the option AND its continuation (cascade); each
    /// doomed shot goes through the writer as a plain remove, child-first.
    func testRemoveBranchCascades() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle()
        place(model, dy: 120, dx: 40)
        model.addPlanOptionAtReticle()
        place(model, dy: 240, dx: 40)
        model.addPlanShotAtReticle() // continuation of the option
        let bOption = try XCTUnwrap(model.planEditRows.first { $0.label == "P1B" })

        model.removePlanBranch(id: bOption.shotId)

        let all = model.plan?.allShots(holeNumber: 1) ?? []
        XCTAssertEqual(all.count, 1, "the option and its continuation are gone")
        XCTAssertNil(model.selectedPlanShotId, "selection was inside the doomed branch")
        await drainTasks()
        XCTAssertEqual(spy.removes, 2, "one writer remove per doomed shot")
    }

    /// Splice remove on the primary line: the removed shot's child is promoted
    /// into its slot, keeping the continuation.
    func testRemovePrimaryShotSplicesChildUp() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle()
        let first = try XCTUnwrap(model.planEditShots.first)
        place(model, dy: 280)
        model.addPlanShotAtReticle() // P2, child of P1

        model.removePlanShot(id: first.id)

        let all = model.plan?.allShots(holeNumber: 1) ?? []
        XCTAssertEqual(all.count, 1)
        XCTAssertNil(all.first?.parentShotId, "the child was re-parented to the root")
        XCTAssertEqual(model.planEditRows.first?.label, "P1")
    }

    /// The reticle origin follows the selection: selecting P1 mid-tree aims
    /// from P1, clearing aims from the primary tail, and the label says which.
    func testReticleOriginFollowsSelection() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle()
        let first = try XCTUnwrap(model.planEditShots.first)
        place(model, dy: 280)
        model.addPlanShotAtReticle()
        let second = try XCTUnwrap(model.planEditShots.last)

        XCTAssertEqual(model.planPlacementOrigin?.shot?.id, second.id, "new shot is selected")
        XCTAssertEqual(model.planPlacementOriginLabel, "P2")

        model.selectPlanShot(handleID: OnCourseModel.planShotHandleID(first.id))
        XCTAssertEqual(model.planPlacementOrigin?.shot?.id, first.id)
        XCTAssertEqual(model.planPlacementOriginLabel, "P1")

        model.selectPlanShot(handleID: nil)
        XCTAssertEqual(model.planPlacementOrigin?.shot?.id, second.id,
                       "no selection → the primary-line tail")
    }

    /// Row meters measure the leg from the PARENT (tee for roots), not from
    /// the previous row in the list.
    func testRowMetersMeasureFromParent() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.enterTool(.plan)

        place(model, dy: 150)
        model.addPlanShotAtReticle()
        place(model, dy: 120, dx: 40)
        model.addPlanOptionAtReticle() // root sibling — also measured from the tee

        let rows = model.planEditRows
        let bRow = try XCTUnwrap(rows.first { $0.label == "P1B" })
        let bShot = try XCTUnwrap(model.plan?.allShots(holeNumber: 1).first { $0.id == bRow.shotId })
        let expected = Int(Distance.planarMeters(tee, bShot.position).rounded())
        XCTAssertEqual(bRow.meters, expected,
                       "the option measures its own tee leg, not a chained P1A→P1B leg")
    }

    // MARK: - Wind editing (on-course wind editor)

    func testSetPlanWindOnACourseWithNoPlanCreatesOneAndPersists() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        XCTAssertNil(model.effectiveWind, "no plan cached → no wind")

        model.setPlanWind(speedMps: 6, directionDeg: 200)

        let wind = try XCTUnwrap(model.effectiveWind)
        XCTAssertEqual(wind.speedMps, 6)
        XCTAssertEqual(wind.directionDeg, 200)
        XCTAssertNil(model.currentHoleWindOverride, "a plan-level edit sets no hole override")
        await drainTasks()
        let writes = spy.winds()
        XCTAssertEqual(writes.count, 1)
        XCTAssertNil(writes[0].holeNumber, "written at the plan level")
        XCTAssertEqual(writes[0].speedMps, 6)
        XCTAssertEqual(writes[0].directionDeg, 200)
    }

    func testHoleWindOverrideWinsOverThePlanWindAndClearingRestoresIt() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.setPlanWind(speedMps: 4, directionDeg: 0)

        model.setCurrentHoleWind(speedMps: 9, directionDeg: 180)
        var wind = try XCTUnwrap(model.effectiveWind)
        XCTAssertEqual(wind.speedMps, 9, "the hole override wins on this hole")
        XCTAssertEqual(wind.directionDeg, 180)
        XCTAssertEqual(model.planWind?.speedMps, 4, "the plan wind is untouched underneath")

        model.setCurrentHoleWind(speedMps: nil, directionDeg: nil)
        XCTAssertNil(model.currentHoleWindOverride)
        wind = try XCTUnwrap(model.effectiveWind)
        XCTAssertEqual(wind.speedMps, 4, "clearing the override falls back to the plan wind")

        await drainTasks()
        let writes = spy.winds()
        XCTAssertEqual(writes.count, 3)
        XCTAssertEqual(writes[1].holeNumber, 1)
        XCTAssertEqual(writes[1].speedMps, 9)
        XCTAssertEqual(writes[2].holeNumber, 1)
        XCTAssertNil(writes[2].speedMps, "the clear pushes a nil pair, not an unchanged edit")
        XCTAssertNil(writes[2].directionDeg)
    }

    func testWindStaysLiveInCompetitionMode() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.setPlanWind(speedMps: 8, directionDeg: 30)

        model.competitionMode = true
        let wind = try XCTUnwrap(
            model.effectiveWind,
            "wind survives competition mode — it is a weather report, not a device reading of the course"
        )
        XCTAssertEqual(wind.speedMps, 8)

        // And it can still be EDITED there (the chip opens the sheet either way).
        model.setPlanWind(speedMps: 3, directionDeg: 120)
        XCTAssertEqual(model.effectiveWind?.speedMps, 3)
    }

    func testClearingThePlanWindLeavesTheHoleCalm() async throws {
        let spy = WriterSpy()
        let model = makeModel(spy: spy)
        model.setPlanWind(speedMps: 7, directionDeg: 90)

        model.setPlanWind(speedMps: nil, directionDeg: nil)

        XCTAssertNil(model.effectiveWind)
        XCTAssertNil(model.planWind)
        await drainTasks()
        let writes = spy.winds()
        XCTAssertEqual(writes.count, 2)
        XCTAssertNil(writes[1].speedMps)
        XCTAssertNil(writes[1].directionDeg)
    }
}
