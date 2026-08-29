import XCTest
@testable import GolfMap

/// The Green view's hole marker as today's pin, and the pin set the watch is
/// told about. Course furniture mirrors `OnCourseModelTests` (hole h1, green
/// center 58.3640/15.7080, furniture pin "Front-left" active).
@MainActor
final class OnCoursePinSyncTests: XCTestCase {

    private var defaults: UserDefaults!
    private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "OnCoursePinSyncTests-\(UUID().uuidString)")
    }

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
            TeeRecord(id: "t1d", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2d", holeId: "h2", name: "default", lat: 58.3660, lon: 15.7060, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: 58.3640, centerLon: 15.7080,
                frontLat: 58.3638, frontLon: 15.7080,
                backLat: 58.3642, backLon: 15.7080,
                elevation: 25
            ),
            GreenRecord(id: "g2", holeId: "h2", centerLat: 58.3670, centerLon: 15.7050),
        ]
        let pins = [
            PinRecord(id: "p1", greenId: "g1", name: "Front-left", lat: 58.3639, lon: 15.7079, active: true),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: pins, aimPoints: [], manifest: manifest
        )
    }

    private func makeModel() -> OnCourseModel {
        OnCourseModel(furniture: makeFurniture(), defaults: defaults, now: { self.fixedNow })
    }

    func testGreenReadHoleBecomesTodaysPin() {
        let model = makeModel()
        // A point on hole 1's green, in the putt model's planar frame.
        let placed = LatLon(lat: 58.36415, lon: 15.70808)
        let planar = Sweref99TM.fromWGS84(placed)

        model.setPinFromGreenRead(Vec2(x: planar.x, y: planar.y))

        let pin = try! XCTUnwrap(model.targets.activePin)
        XCTAssertEqual(Distance.planarMeters(pin, placed), 0, accuracy: 0.01,
                       "the marker the player set on the green is the pin measured to")
        XCTAssertEqual(model.targets.activePinName, "Visual")
        XCTAssertEqual(model.pinOverrides["h1"]?.source, .visual)
        // Front/center/back keep their stored positions.
        XCTAssertEqual(model.targets.greenCenter, LatLon(lat: 58.3640, lon: 15.7080))
        XCTAssertEqual(model.targets.greenFront, LatLon(lat: 58.3638, lon: 15.7080))
        XCTAssertEqual(model.targets.greenBack, LatLon(lat: 58.3642, lon: 15.7080))
    }

    func testGreenReadPinPersistsForTheDay() {
        let placed = LatLon(lat: 58.36415, lon: 15.70808)
        let planar = Sweref99TM.fromWGS84(placed)
        makeModel().setPinFromGreenRead(Vec2(x: planar.x, y: planar.y))

        let reloaded = makeModel()
        XCTAssertEqual(reloaded.pinOverrides["h1"]?.source, .visual,
                       "the pin survives leaving the green view and the screen")
    }

    func testPinsPublishToTheWatchOnPlaceAndClear() {
        let model = makeModel()
        var published: [(String, [Int: LatLon])] = []
        model.onPinsChanged = { published.append(($0, $1)) }
        XCTAssertEqual(published.count, 1, "wiring publishes the loaded set")
        XCTAssertTrue(published[0].1.isEmpty)

        let placed = LatLon(lat: 58.36415, lon: 15.70808)
        model.setPinOverride(placed, source: .sheet, forHole: "h1")
        XCTAssertEqual(published.last?.0, "course-1")
        XCTAssertEqual(published.last?.1, [1: placed], "keyed by hole NUMBER — the watch's key")

        model.clearPinOverride(forHole: "h1")
        XCTAssertEqual(published.last?.1, [:], "a cleared pin is published too")
    }

    func testRePlacingTheSamePointDoesNotRepublish() {
        let model = makeModel()
        let placed = LatLon(lat: 58.36415, lon: 15.70808)
        let planar = Vec2(
            x: Sweref99TM.fromWGS84(placed).x, y: Sweref99TM.fromWGS84(placed).y
        )
        model.setPinFromGreenRead(planar)

        var published = 0
        model.onPinsChanged = { _, _ in published += 1 }
        XCTAssertEqual(published, 1, "the initial publish on wiring")
        model.setPinFromGreenRead(planar)
        XCTAssertEqual(published, 1, "an unmoved marker is not a new pin")
    }
}
