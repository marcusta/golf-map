import XCTest
@testable import GolfMap

/// Fixture-based decode tests — the drift protection. Each server response
/// snapshot in `Fixtures/` is decoded into its model and key fields asserted.
/// If the server shapes change, these break.
final class ModelDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ type: T.Type, _ fixture: String) throws -> T {
        let data = try FixtureLoader.data(fixture)
        return try decoder.decode(T.self, from: data)
    }

    func testMeta() throws {
        let meta = try decode(Meta.self, "meta.json")
        XCTAssertEqual(meta.name, "golf-map")
        XCTAssertEqual(meta.version, "0.1.0")
    }

    func testAuthLoginAndMe() throws {
        let login = try decode(AuthUser.self, "auth-login.json")
        XCTAssertEqual(login.username, "marcus")
        XCTAssertEqual(login.id, "ea9562cc-dee3-4705-8444-9ca0a76a5687")

        let me = try decode(AuthUser.self, "auth-me.json")
        XCTAssertEqual(me, login)
    }

    func testCoursesList() throws {
        let page = try decode(CoursePage.self, "courses-list.json")
        XCTAssertEqual(page.total, 20)
        XCTAssertEqual(page.items.count, 20)
        // Every fixture course is published.
        XCTAssertTrue(page.items.allSatisfy { $0.status == "published" })
        // The Masters course is present with holeCount 18.
        let masters = page.items.first { $0.name == "Landeryd Masters" }
        XCTAssertNotNil(masters)
        XCTAssertEqual(masters?.holeCount, 18)
        XCTAssertEqual(masters?.revision, 2)
        // A course with 0 holes exists (verifies Int decode of holeCount == 0).
        XCTAssertTrue(page.items.contains { $0.holeCount == 0 })
    }

    func testCourseGet() throws {
        let course = try decode(Course.self, "course-get.json")
        XCTAssertEqual(course.name, "Landeryd Masters")
        XCTAssertEqual(course.status, "published")
        XCTAssertEqual(course.revision, 2)
        XCTAssertEqual(course.version, 5)
        XCTAssertEqual(course.crs, "EPSG:3006")
        XCTAssertNil(course.notes)
        XCTAssertNotNil(course.georeferenceJson)
        XCTAssertEqual(course.homeLat ?? 0, 58.361893571209315, accuracy: 1e-9)
    }

    func testHoles() throws {
        let holes = try decode([Hole].self, "holes.json")
        XCTAssertEqual(holes.count, 18)
        // Ordered by number 1...18.
        XCTAssertEqual(holes.map(\.number), Array(1...18))
        let first = holes[0]
        XCTAssertEqual(first.par, 4)
        XCTAssertNil(first.strokeIndex) // strokeIndex is null in the fixture.
        XCTAssertNotNil(first.savedRegionJson)
    }

    func testTees() throws {
        let tees = try decode([Tee].self, "tees-by-course.json")
        // 32 tees across 18 holes (several holes have multiple named tees).
        XCTAssertEqual(tees.count, 32)
        XCTAssertEqual(Set(tees.map(\.holeId)).count, 18)
        // Fixture contains a mix of tee names (default + colour tees).
        let names = Set(tees.map(\.name))
        XCTAssertTrue(names.contains("default"))
        XCTAssertTrue(names.contains("Black"))
        let first = tees[0]
        XCTAssertEqual(first.name, "default")
        XCTAssertNil(first.color)
        XCTAssertEqual(first.sortOrder, 0)
        XCTAssertEqual(first.lat, 58.361676784359815, accuracy: 1e-9)
        XCTAssertNotNil(first.elevation)
    }

    func testGreen() throws {
        let green = try decode(Green.self, "green-by-hole.json")
        XCTAssertEqual(green.centerLat, 58.363947160867994, accuracy: 1e-9)
        XCTAssertEqual(green.centerLon, 15.70735740618441, accuracy: 1e-9)
        XCTAssertNotNil(green.frontLat)
        XCTAssertNotNil(green.backLat)
        XCTAssertNil(green.boundaryJson)
        XCTAssertEqual(green.elevation ?? 0, 78.28551483154297, accuracy: 1e-6)
    }

    func testPinsByGreenEmpty() throws {
        let pins = try decode([Pin].self, "pins-by-green.json")
        XCTAssertTrue(pins.isEmpty)
    }

    func testPinsByCourse() throws {
        let pins = try decode([Pin].self, "pins-by-course.json")
        XCTAssertEqual(pins.count, 1)
        let pin = pins[0]
        XCTAssertEqual(pin.name, "Front-left")
        XCTAssertEqual(pin.difficulty, "easy")
        XCTAssertFalse(pin.active)
    }

    func testAimPoints() throws {
        let points = try decode([AimPoint].self, "aim-points.json")
        XCTAssertEqual(points.count, 1)
        let p = points[0]
        XCTAssertEqual(p.sortOrder, 0)
        XCTAssertNil(p.label)
        XCTAssertNotNil(p.elevation)
        XCTAssertEqual(p.lat, 58.36326966168596, accuracy: 1e-9)
    }

    func testErrorEnvelope() throws {
        let env = try decode(APIErrorEnvelope.self, "error-401.json")
        XCTAssertEqual(env.error, "Unauthorized")
    }
}
