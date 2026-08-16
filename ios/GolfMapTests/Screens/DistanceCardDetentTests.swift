import XCTest
@testable import GolfMap

/// D-HF5 — the distance card's two fixed detents on `OnCourseModel`: compact
/// by default, what expands/collapses it, the compact row's content, and the
/// hard rule that toggling it NEVER touches the camera (the solve reads the
/// compact card's insets always — see `CourseScreen.syncSolveGeometry`).
@MainActor
final class DistanceCardDetentTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "DistanceCardDetentTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    /// Two holes. Hole 1's green sits ~144 m north of the tee and 15 m above
    /// it — inside the bag, so the compact row gets a club, a carry, and a
    /// positive plays-like delta. Hole 2 is a second short hole to navigate to.
    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-d", name: "Detent GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-d", number: 1, par: 3, strokeIndex: 7),
            HoleRecord(id: "h2", courseId: "course-d", number: 2, par: 3, strokeIndex: 15),
        ]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2", holeId: "h2", name: "default", lat: 58.3640, lon: 15.7100, elevation: 10, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: 58.3613, centerLon: 15.7100,
                frontLat: 58.3611, frontLon: 15.7100,
                backLat: 58.3615, backLon: 15.7100,
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
            courseId: "course-d", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
    }

    private func makeModel(competition: Bool = false) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setGPSEnabled(false)
        model.competitionMode = competition
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

    // MARK: - Detent state

    func testCardStartsCompact() {
        let model = makeModel()
        XCTAssertEqual(model.distanceCardDetent, .compact, "compact is the default (D-HF5)")
        XCTAssertFalse(model.isDistanceCardExpanded)
    }

    func testExpandAndCollapse() {
        let model = makeModel()
        model.expandDistanceCard()
        XCTAssertTrue(model.isDistanceCardExpanded)
        model.collapseDistanceCard()
        XCTAssertFalse(model.isDistanceCardExpanded)
        // Collapsing an already-compact card is a no-op, not a toggle.
        model.collapseDistanceCard()
        XCTAssertFalse(model.isDistanceCardExpanded)
    }

    func testCompletingAnActionCollapses() {
        let model = makeModel()
        model.expandDistanceCard()
        // Tee picked / Laser or Pin sheet opened / Browse toggled.
        model.distanceCardActionCompleted()
        XCTAssertEqual(model.distanceCardDetent, .compact)
    }

    func testMapTapCollapsesExpandedCardAndConsumesTheTap() {
        let model = makeModel()
        model.expandDistanceCard()

        // Expanded: the tap is spent collapsing — immersive must NOT toggle.
        XCTAssertTrue(model.collapseDistanceCardOnMapTap())
        XCTAssertFalse(model.isDistanceCardExpanded)

        // Already compact: the tap falls through to the immersive toggle.
        XCTAssertFalse(model.collapseDistanceCardOnMapTap())
        XCTAssertFalse(model.isDistanceCardExpanded)
    }

    func testHoleChangeNeverAutoExpands() {
        let model = makeModel()
        model.mapViewportSize = CGSize(width: 390, height: 844)
        model.goToHole(number: 2)
        XCTAssertEqual(model.distanceCardDetent, .compact,
                       "hole entry is exactly when the map matters most")
    }

    // MARK: - Camera is untouched by the detent

    func testExpandCollapseIssuesNoCameraCommand() throws {
        let model = makeModel()
        model.mapViewportSize = CGSize(width: 390, height: 844)
        // The COMPACT card's inset — the only one the solve ever sees.
        model.distanceCameraInsets = MapEdgeInsets(top: 60, left: 8, bottom: 120, right: 8)
        model.goToHole(number: 2)

        let before = try XCTUnwrap(model.cameraCommand)
        model.expandDistanceCard()
        XCTAssertEqual(model.cameraCommand, before, "expanding never re-frames")
        XCTAssertEqual(model.cameraCommand?.token, before.token)
        let solveOrigin = model.holeEntrySolveOrigin
        let solveAim = model.holeEntrySolveAim
        model.collapseDistanceCard()
        XCTAssertEqual(model.cameraCommand, before, "collapsing never re-frames")
        XCTAssertEqual(model.cameraCommand?.token, before.token)
        XCTAssertEqual(model.holeEntrySolveOrigin, solveOrigin, "solve inputs are untouched")
        XCTAssertEqual(model.holeEntrySolveAim, solveAim)
    }

    // MARK: - Compact row content

    func testCompactLineCarriesDistanceClubCarryAndPlaysLikeDelta() throws {
        let model = makeModel()
        let line = model.compactCardLine

        let distance = try XCTUnwrap(line.distanceM)
        XCTAssertEqual(Double(distance),
                       Distance.planarMeters(
                           LatLon(lat: 58.3600, lon: 15.7100),
                           LatLon(lat: 58.3613, lon: 15.7100)
                       ),
                       accuracy: 1, "the big figure is the straight to-green distance")

        // +15 m of climb → plays-like leads the actual, and the advised club
        // is chosen against the plays-like figure.
        let playsLike = try XCTUnwrap(line.playsLikeM)
        XCTAssertGreaterThan(playsLike, distance)
        XCTAssertEqual(try XCTUnwrap(line.deltaM), playsLike - distance)
        XCTAssertEqual(line.clubName, "6i")
        XCTAssertEqual(line.clubCarryM, 160)
    }

    /// Device bug (Linkan hole 2): with the green beyond the bag the compact
    /// row showed the to-green LAYUP club ("7I" against a 220 m aim line) —
    /// contradicting the aim the map draws. The compact club must follow the
    /// AIM leg: here the default aim lands at 150 m (the fairway ends at
    /// 150 m), so the club is the 6i, not the layup's Dr.
    func testCompactClubFollowsTheAimLegNotTheLayupWhenGreenIsBeyondTheBag() throws {
        let longBase = Sweref99TM.fromWGS84(LatLon(lat: 58.3600, lon: 15.7100))
        func ll(_ dx: Double, _ dy: Double) -> LatLon {
            Sweref99TM.toWGS84(x: longBase.x + dx, y: longBase.y + dy)
        }
        let course = CourseRecord(
            id: "course-long", name: "Long GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let hole = HoleRecord(id: "h1", courseId: "course-long", number: 1, par: 5, strokeIndex: 1)
        let tee = TeeRecord(
            id: "t1", holeId: "h1", name: "default",
            lat: ll(0, 0).lat, lon: ll(0, 0).lon, elevation: 10, sortOrder: 0
        )
        let g = ll(0, 480), gf = ll(0, 470), gb = ll(0, 490)
        let green = GreenRecord(
            id: "g1", holeId: "h1",
            centerLat: g.lat, centerLon: g.lon,
            frontLat: gf.lat, frontLon: gf.lon,
            backLat: gb.lat, backLon: gb.lon,
            elevation: 10
        )
        let manifest = TileManifestRecord(
            courseId: "course-long", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let model = OnCourseModel(
            furniture: CourseFurniture(
                course: course, holes: [hole], tees: [tee], greens: [green],
                pins: [], aimPoints: [], manifest: manifest
            ),
            defaults: defaults
        )
        model.setGPSEnabled(false)
        model.setClubs(bag())
        model.reticleSettleSleep = {}
        // Fairway ends at 150 m: the D-HF2 walk steps down to the 150 ring,
        // so the default aim leg is 150 m — the 6i, two clubs under the Dr.
        model.setSurfaces([
            FlatRing(
                points: [
                    Vec2(x: longBase.x - 30, y: longBase.y + 40),
                    Vec2(x: longBase.x + 30, y: longBase.y + 40),
                    Vec2(x: longBase.x + 30, y: longBase.y + 150),
                    Vec2(x: longBase.x - 30, y: longBase.y + 150),
                ],
                kind: "fairway"
            ),
        ])

        let line = model.compactCardLine
        XCTAssertEqual(line.clubName, "6i", "club follows the aim leg the map draws")
        XCTAssertEqual(line.clubCarryM, 160)
        // The layup toward the green is a different figure — the old wrong one.
        XCTAssertEqual(model.distances?.layup?.club, "Dr",
                       "layup still exists (green beyond bag) but no longer leaks into the compact row")
    }

    func testCompactLineIsDistanceOnlyInCompetitionMode() throws {
        let model = makeModel(competition: true)
        let line = model.compactCardLine
        XCTAssertNotNil(line.distanceM, "measurement is always allowed")
        XCTAssertNil(line.clubName, "club advice is gated off")
        XCTAssertNil(line.clubCarryM)
        XCTAssertNil(line.playsLikeM, "slope-adjusted figures are gated off")
        XCTAssertNil(line.deltaM)
    }
}
