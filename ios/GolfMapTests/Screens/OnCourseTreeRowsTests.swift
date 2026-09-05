import XCTest
@testable import GolfMap

/// `OnCourseModel.treeClearanceRows`: the "Trees" readout rows on the ladder
/// rail. Flat ground by default; terrain sampled asynchronously when an
/// elevation sampler is installed.
@MainActor
final class OnCourseTreeRowsTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "OnCourseTreeRowsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private let teeLL = LatLon(lat: 58.3600, lon: 15.7100)
    private let greenLL = LatLon(lat: 58.3640, lon: 15.7080)

    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "c1", name: "T", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "c1", number: 1, par: 4, strokeIndex: 1)]
        let tees = [TeeRecord(id: "t1", holeId: "h1", name: "default", lat: teeLL.lat, lon: teeLL.lon, elevation: 10, sortOrder: 0)]
        let greens = [GreenRecord(id: "g1", holeId: "h1", centerLat: greenLL.lat, centerLon: greenLL.lon, elevation: 25)]
        let manifest = TileManifestRecord(
            courseId: "c1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(course: course, holes: holes, tees: tees, greens: greens, pins: [], aimPoints: [], manifest: manifest)
    }

    private func makeModel() -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setGPSEnabled(false) // origin = tee, primary target = green center
        return model
    }

    /// A tree ring straddling the tee→green line at `alongM` metres from the
    /// tee, `halfM` half-width, with the given attributes.
    private func treeOnLine(alongM: Double, halfM: Double = 10, attributes: [String: FeatureAttributeValue]?, id: String) -> TreeFeatureInput {
        let o = Sweref99TM.fromWGS84(teeLL)
        let g = Sweref99TM.fromWGS84(greenLL)
        let len = hypot(g.x - o.x, g.y - o.y)
        let dir = Vec2(x: (g.x - o.x) / len, y: (g.y - o.y) / len)
        let n = Vec2(x: -dir.y, y: dir.x)
        let c = Vec2(x: o.x + dir.x * alongM, y: o.y + dir.y * alongM)
        func p(_ a: Double, _ b: Double) -> Vec2 { Vec2(x: c.x + dir.x * a + n.x * b, y: c.y + dir.y * a + n.y * b) }
        return TreeFeatureInput(
            type: "trees",
            points: [p(-halfM, -20), p(halfM, -20), p(halfM, 20), p(-halfM, 20)],
            attributes: attributes, id: id
        )
    }

    func testNoTreesNoRows() {
        let model = makeModel()
        XCTAssertEqual(model.treeClearanceRows, [])
        model.setTrees(TreeFeatureStore(features: [treeOnLine(alongM: 200, attributes: nil, id: "off")].map {
            var f = $0
            f.points = f.points.map { Vec2(x: $0.x + 500, y: $0.y) } // move it off the line
            return f
        }))
        XCTAssertEqual(model.treeClearanceRows, [])
    }

    func testRowsClearsBlockedUnknownOrderedByEntry() {
        let model = makeModel()
        model.setClubs([ClubRecord(id: "dr", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0)])
        model.setTrees(TreeFeatureStore(features: [
            treeOnLine(alongM: 150, attributes: ["heightP90M": .number(10)], id: "low"),
            treeOnLine(alongM: 30, attributes: ["heightP90M": .number(18)], id: "wall"),
            treeOnLine(alongM: 100, attributes: nil, id: "hand"),
        ]))

        let rows = model.treeClearanceRows
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.map(\.entryM), [20, 90, 140])

        XCTAssertEqual(rows[0].status, .blocked)
        XCTAssertEqual(rows[0].label, "Trees 18 m")
        XCTAssertTrue(rows[0].detail.hasPrefix("blocked (ball "), rows[0].detail)
        XCTAssertTrue(rows[0].detail.hasSuffix(" m)"), rows[0].detail)

        XCTAssertEqual(rows[1].status, .unknown)
        XCTAssertEqual(rows[1].label, "Trees")
        XCTAssertEqual(rows[1].detail, "height unknown")

        XCTAssertEqual(rows[2].status, .clears)
        XCTAssertEqual(rows[2].label, "Trees 10 m")
        XCTAssertTrue(rows[2].detail.hasPrefix("clears by "), rows[2].detail)

        // Entry position lies on the line, ~20 m from the tee.
        let pos = try! XCTUnwrap(rows[0].position)
        XCTAssertEqual(Distance.planarMeters(teeLL, pos), 20, accuracy: 1.0)
    }

    func testRowsMemoisedUntilInputsChange() {
        let model = makeModel()
        model.setTrees(TreeFeatureStore(features: [treeOnLine(alongM: 150, attributes: ["heightP90M": .number(10)], id: "low")]))
        _ = model.treeClearanceRows
        _ = model.treeClearanceRows
        XCTAssertEqual(model.treeClearanceBuildCount, 1)
        model.setTrees(TreeFeatureStore(features: [treeOnLine(alongM: 150, attributes: ["heightP90M": .number(25)], id: "tall")]))
        XCTAssertEqual(model.treeClearanceRows.first?.label, "Trees 25 m")
        XCTAssertEqual(model.treeClearanceBuildCount, 2)
    }

    func testTreesBeyondLongestClubCarryAreNotRows() {
        let model = makeModel()
        model.setClubs([ClubRecord(id: "7i", name: "7 iron", carryM: 120, dispersionM: 20, sortOrder: 0)])
        model.setTrees(TreeFeatureStore(features: [
            treeOnLine(alongM: 60, attributes: ["heightP90M": .number(5)], id: "near"),
            treeOnLine(alongM: 300, attributes: ["heightP90M": .number(25)], id: "far"),
        ]))
        XCTAssertEqual(model.treeClearanceRows.map(\.entryM), [50])
    }

    func testCompetitionModeDoesNotHideTreeRows() {
        let model = makeModel()
        model.setTrees(TreeFeatureStore(features: [treeOnLine(alongM: 150, attributes: ["heightP90M": .number(10)], id: "low")]))
        model.competitionMode = true
        XCTAssertEqual(model.treeClearanceRows.count, 1, "tree crossings are measured geometry, not advice")
    }

    func testTerrainProfileTurnsAClearIntoABlock() async {
        let model = makeModel()
        model.setClubs([ClubRecord(id: "dr", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0)])
        // 20 m trees at 150 m: flat ground clears (ball ~28 m up at 150 of 230).
        model.setTrees(TreeFeatureStore(features: [treeOnLine(alongM: 150, attributes: ["heightP90M": .number(20)], id: "t")]))
        XCTAssertEqual(model.treeClearanceRows.first?.status, .clears)

        // Ground rises 15 m by 150 m out (10% grade from the tee).
        let tee = teeLL
        model.elevationSampler = { @Sendable p in 10 + Distance.planarMeters(tee, p) * 0.1 }
        let sampled = await model.refreshTreeGroundProfileAwaiting()
        XCTAssertTrue(sampled)

        let rows = model.treeClearanceRows
        XCTAssertEqual(rows.first?.status, .blocked, rows.first?.detail ?? "no row")
    }
}
