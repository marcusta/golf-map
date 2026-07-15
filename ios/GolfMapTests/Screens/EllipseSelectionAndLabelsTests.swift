import XCTest
@testable import GolfMap

/// Selection-driven plan-leg ellipses + on-map ellipse labels + the advice
/// club chip's adjusted carry: the two on-green patterns must be identifiable
/// (labeled) and the violet plan ellipses must draw only for the selected plan
/// waypoint's incoming/outgoing legs. Built on a TWO-shot plan so the two legs
/// around a waypoint are distinct.
@MainActor
final class EllipseSelectionAndLabelsTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "EllipseSelectionAndLabelsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // A straight par 5: tee → s1 (driver) → s2 (7 iron) → green. Flat (all
    // elevations 0) and CALM (no plan wind), so every adjusted carry equals
    // the club's nominal carry — deterministic label figures.
    private let tee = LatLon(lat: 58.3500, lon: 15.7000)
    private let shot1 = LatLon(lat: 58.3518, lon: 15.7000)
    private let shot2 = LatLon(lat: 58.3531, lon: 15.7000)
    private let green = LatLon(lat: 58.3543, lon: 15.7000)

    private let bag = [
        ClubRecord(id: "dr", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0),
        ClubRecord(id: "7i", name: "7 iron", carryM: 150, dispersionM: 22, sortOrder: 1),
    ]

    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-el", name: "Labelville", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "course-el", number: 1, par: 5)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default",
                              lat: tee.lat, lon: tee.lon, elevation: 0, sortOrder: 0)]
        let greens = [GreenRecord(id: "g1", holeId: "h1",
                                  centerLat: green.lat, centerLon: green.lon, elevation: 0)]
        let manifest = TileManifestRecord(
            courseId: "course-el", west: 15.69, south: 58.34, east: 15.71, north: 58.36,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
    }

    private func makePlan() -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-el", courseId: "course-el",
                                     windSpeedMps: nil, windDirectionDeg: nil),
                holes: [GamePlanHoleRecord(id: "ph1", gamePlanId: "plan-el", holeNumber: 1, teeId: "t1")],
                shots: [
                    PlanShotRecord(id: "s1", gamePlanHoleId: "ph1", sortOrder: 0,
                                   lat: shot1.lat, lon: shot1.lon, clubId: "dr"),
                    PlanShotRecord(id: "s2", gamePlanHoleId: "ph1", sortOrder: 1,
                                   lat: shot2.lat, lon: shot2.lon, clubId: "7i"),
                ],
                gates: []
            ),
            clubs: bag
        )
    }

    private func makeModel() -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setPlan(makePlan())
        model.setClubs(bag)
        return model
    }

    private func focusPlanRow(_ model: OnCourseModel, index: Int) throws {
        let row = try XCTUnwrap(
            model.ladderRows.first { $0.kind == .plan && $0.id == "plan-\(index)" },
            "plan row \(index) exists"
        )
        model.focusMap(on: try XCTUnwrap(row.position), ladderId: row.id)
    }

    // MARK: - Selection matrix

    func testDefaultGreenSelectionShowsAdviceEllipseAndZeroPlanEllipses() throws {
        let model = makeModel()
        let overlays = model.overlays
        // Default selection is the green row → the cyan advice ellipse draws…
        XCTAssertNotNil(overlays.selectedEllipse, "advice ellipse for the green row")
        // …and NO violet plan leg ellipses ride along.
        XCTAssertEqual(overlays.plan?.ellipses.count, 0, "green selection → no plan ellipses")
        // Base plan geometry is untouched by the ellipse gate.
        XCTAssertEqual(overlays.plan?.nodes.count, 2)
        XCTAssertFalse(overlays.plan?.line.isEmpty ?? true)
    }

    func testPlanRowSelectionShowsExactlyItsIncomingAndOutgoingLegEllipses() throws {
        let model = makeModel()

        // P1 selected: incoming tee→s1 (lands on s1) + outgoing s1→s2.
        try focusPlanRow(model, index: 1)
        let p1 = try XCTUnwrap(model.planOverlay).ellipses
        XCTAssertEqual(p1.count, 2, "exactly the two legs adjacent to P1")
        XCTAssertTrue(p1.contains { $0.toShotId == "s1" && $0.fromShotId == nil },
                      "incoming: departs the tee, lands on s1")
        XCTAssertTrue(p1.contains { $0.fromShotId == "s1" && $0.toShotId == "s2" },
                      "outgoing: departs s1, lands on s2")

        // P2 (the LAST plan shot): incoming s1→s2 + the approach-to-green.
        try focusPlanRow(model, index: 2)
        let p2 = try XCTUnwrap(model.planOverlay).ellipses
        XCTAssertEqual(p2.count, 2)
        XCTAssertTrue(p2.contains { $0.fromShotId == "s1" && $0.toShotId == "s2" },
                      "incoming: departs s1, lands on s2")
        XCTAssertTrue(p2.contains { $0.fromShotId == "s2" && $0.toShotId == nil },
                      "outgoing: the approach — departs s2, lands on the green")

        // Selecting a non-plan row again (the green) drops them all.
        let greenRow = try XCTUnwrap(model.ladderRows.first { $0.kind == .green })
        model.focusMap(on: try XCTUnwrap(greenRow.position), ladderId: greenRow.id)
        XCTAssertEqual(model.planOverlay?.ellipses.count, 0, "green re-selected → none")
    }

    // MARK: - Labels

    func testAdviceEllipseLabelMatchesChipAndEllipseGeometry() throws {
        let model = makeModel()
        let advice = try XCTUnwrap(model.selectedTargetAdvice)
        let club = try XCTUnwrap(advice.club)
        let carry = try XCTUnwrap(advice.clubCarryM, "chip carry populated")
        // Flat + calm → the adjusted ground carry is the nominal club carry.
        let expected = try XCTUnwrap(bag.first { $0.name == club })
        XCTAssertEqual(carry, Int(expected.carryM.rounded()))

        let overlays = model.overlays
        let label = try XCTUnwrap(overlays.ellipseLabels.first, "advice ellipse label present")
        XCTAssertEqual(label.text, "\(club) · \(carry)", "label shows club · adjusted carry")
        // Label figure == the ellipse geometry's own center distance: the
        // anchor (the ellipse center) sits exactly `carry` meters from the
        // origin — label and drawn pattern can never disagree.
        let origin = try XCTUnwrap(model.origin)
        XCTAssertEqual(Distance.planarMeters(origin, label.position), Double(carry), accuracy: 0.5)
    }

    func testPlanLegEllipseLabelsCarryLegClubAndLegMeters() throws {
        let model = makeModel()
        try focusPlanRow(model, index: 1)
        let overlays = model.overlays
        let ellipses = try XCTUnwrap(overlays.plan).ellipses
        XCTAssertEqual(ellipses.count, 2)

        // The leg ENDING at a shot adopts that shot's club (same rule as the
        // web planner): tee→s1 is the Driver leg, s1→s2 the 7 iron leg.
        let teeLeg = try XCTUnwrap(ellipses.first { $0.toShotId == "s1" })
        XCTAssertEqual(teeLeg.clubName, "Driver")
        XCTAssertEqual(teeLeg.legMeters, Int(Distance.planarMeters(tee, shot1).rounded()))
        let midLeg = try XCTUnwrap(ellipses.first { $0.toShotId == "s2" })
        XCTAssertEqual(midLeg.clubName, "7 iron")
        XCTAssertEqual(midLeg.legMeters, Int(Distance.planarMeters(shot1, shot2).rounded()))

        // Each visible plan ellipse gets its "<club> · <meters>" label at its
        // center (plus the advice label for the selected plan row itself).
        for ellipse in ellipses {
            let clubName = try XCTUnwrap(ellipse.clubName)
            let text = "\(clubName) · \(ellipse.legMeters)"
            XCTAssertTrue(
                overlays.ellipseLabels.contains { $0.text == text && $0.position == ellipse.center },
                "label '\(text)' anchored at its ellipse center"
            )
        }
    }

    // MARK: - Chip carry gating

    func testClubCarryMNilInCompetitionMode() throws {
        let model = makeModel()
        XCTAssertNotNil(model.selectedTargetAdvice?.clubCarryM)
        model.competitionMode = true
        let advice = try XCTUnwrap(model.selectedTargetAdvice)
        XCTAssertNil(advice.club, "competition hides the club")
        XCTAssertNil(advice.clubCarryM, "…and with it the chip carry")
        XCTAssertTrue(model.overlays.ellipseLabels.isEmpty, "no ellipses → no labels")
    }
}
